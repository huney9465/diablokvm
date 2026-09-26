'use strict';
// Nodes: the servers that actually run VMs.
//   * Node 1 ("Local") is the panel's own machine and is driven by calling the host layer directly.
//   * Every other node runs the agent, which DIALS OUT to the panel over a WebSocket (/ws/node).
//     Nodes therefore need no open port, and all traffic (commands, consoles, logs) shares the
//     panel's single port.
//
// Wire format (WebSocket):
//   text, JSON   panel -> agent  {t:'req', id, method, args} | {t:'open', ch, kind, vm, opts} | {t:'ctl', ch, data} | {t:'close', ch}
//   text, JSON   agent -> panel  {t:'hello', meta} | {t:'state', running, stats, inventory}
//                                {t:'res', id, ok, result|error} | {t:'ch', ch, ev:'opened'|'event'|'close'|'error', data|message}
//   binary       4-byte big-endian channel id followed by the payload, in both directions
const host = require('../host');
const { Stream } = require('../host/streams');
const { db } = require('../db');

const LOCAL_ID = 1;
const conns = new Map(); // node id -> Conn
const nodeRow = (id) => db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
const nodeName = (id) => nodeRow(id)?.name || `#${id}`;
const RPC_TIMEOUT = { provision: 180000, default: 60000 };
const STATE_CHANGING = new Set(['start', 'stop', 'forceStop', 'reboot', 'destroy', 'provision']);

class RemoteStream extends Stream {
  constructor(conn, ch) {
    super();
    this.conn = conn;
    this.ch = ch;
    this._destroy = () => { conn.channels.delete(ch); if (!this.remoteClosed) conn.send({ t: 'close', ch }); };
    this.queue = [];
    this.live = false;
  }
  // Frames can arrive before the consumer has attached its listeners. Hold them until it has.
  emit(ev, ...args) {
    if (!this.live && (ev === 'data' || ev === 'event')) { this.queue.push([ev, args]); return true; }
    return super.emit(ev, ...args);
  }
  on(ev, fn) {
    super.on(ev, fn);
    if (!this.live && !this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.live = true;
        for (const [e, a] of this.queue) super.emit(e, ...a);
        this.queue = [];
      });
    }
    return this;
  }
  write(d) {
    const data = Buffer.isBuffer(d) ? d : Buffer.from(d);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(this.ch, 0);
    if (this.conn.ws.readyState === 1) this.conn.ws.send(Buffer.concat([head, data]));
  }
  control(o) { this.conn.send({ t: 'ctl', ch: this.ch, data: o }); }
}

class Conn {
  constructor(ws, node) {
    this.ws = ws;
    this.node = node;
    this.pending = new Map();
    this.channels = new Map();
    this.opening = new Map();
    this.nextId = 1;
    this.nextCh = 1;
    this.lastDb = 0;
    this.state = { running: new Set(), stats: null, inventory: { templates: {}, isos: [], jobs: {} }, meta: {}, seen: false };
    ws.on('message', (d, isBinary) => this.onMessage(d, isBinary));
    ws.on('close', () => this.onClose());
    ws.on('error', () => {});
  }

  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  rpc(method, args = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Node "${this.node.name}" did not answer in time`));
      }, RPC_TIMEOUT[method] || RPC_TIMEOUT.default);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'req', id, method, args });
    });
  }

  openChannel(kind, vm, opts) {
    return new Promise((resolve, reject) => {
      const ch = this.nextCh++;
      const s = new RemoteStream(this, ch);
      const timer = setTimeout(() => { this.opening.delete(ch); this.channels.delete(ch); reject(new Error('Node did not open the stream in time')); }, 10000);
      this.channels.set(ch, s);
      this.opening.set(ch, { resolve: () => { clearTimeout(timer); resolve(s); }, reject: (e) => { clearTimeout(timer); reject(e); }, s });
      this.send({ t: 'open', ch, kind, vm, opts });
    });
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      if (data.length < 4) return;
      const s = this.channels.get(data.readUInt32BE(0));
      if (s) s.emit('data', data.subarray(4));
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'Node error'));
    } else if (m.t === 'state') {
      this.state.running = new Set(m.running || []);
      this.state.stats = m.stats || null;
      if (m.inventory) this.state.inventory = m.inventory;
      this.state.seen = true;
      if (Date.now() - this.lastDb > 30000) { this.lastDb = Date.now(); db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(Date.now(), this.node.id); }
    } else if (m.t === 'hello') {
      this.state.meta = m.meta || {};
    } else if (m.t === 'ch') {
      const op = this.opening.get(m.ch);
      const s = this.channels.get(m.ch);
      if (m.ev === 'opened' && op) { this.opening.delete(m.ch); op.resolve(); }
      else if (m.ev === 'error' && op) { this.opening.delete(m.ch); this.channels.delete(m.ch); op.reject(new Error(m.message || 'Could not open the stream')); }
      else if (m.ev === 'event' && s) s.emit('event', m.data);
      else if (m.ev === 'close' && s) { s.remoteClosed = true; s.close(); }
    }
  }

  onClose() {
    if (conns.get(this.node.id) === this) conns.delete(this.node.id);
    db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(Date.now(), this.node.id);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`Node "${this.node.name}" went offline`)); }
    this.pending.clear();
    for (const [, s] of [...this.channels]) { s.remoteClosed = true; s.close(); }
    for (const [, op] of this.opening) op.reject(new Error('Node went offline'));
    this.opening.clear();
    console.log(`node "${this.node.name}" disconnected`);
  }
}

// ---- registry ----
function attachAgent(ws, node) {
  const old = conns.get(node.id);
  if (old) old.ws.terminate();
  const c = new Conn(ws, node);
  conns.set(node.id, c);
  console.log(`node "${node.name}" connected`);
  syncNode(node.id).catch((e) => console.error(`sync of node ${node.name} failed: ${e.message}`));
}

function disconnect(nodeId) { conns.get(nodeId)?.ws.terminate(); }
const isOnline = (id) => id === LOCAL_ID || conns.has(id);

// Tell a node which VMs it owns (used for status polling and autostart after node reboots).
async function syncNode(id) {
  if (id === LOCAL_ID) return;
  const c = conns.get(id);
  if (!c) return;
  await c.rpc('sync', [db.prepare('SELECT * FROM vms WHERE node_id = ?').all(id)]);
}
const touchTimers = new Map();
function touch(id) { // debounced sync after VM rows change
  if (id === LOCAL_ID || touchTimers.has(id)) return;
  touchTimers.set(id, setTimeout(() => { touchTimers.delete(id); syncNode(id).catch(() => {}); }, 250));
}

// Executor: the same async API for every node, local or remote.
function exec(nodeId) {
  return new Proxy({}, {
    get: (_, method) => async (...args) => {
      if (nodeId === LOCAL_ID) {
        const fn = host.methods[method];
        if (!fn) throw new Error(`Unknown operation ${String(method)}`);
        return fn(...args);
      }
      const c = conns.get(nodeId);
      if (!c) throw new Error(`Node "${nodeName(nodeId)}" is offline`);
      const result = await c.rpc(method, args);
      if (STATE_CHANGING.has(method)) touch(nodeId);
      return result;
    },
  });
}

// Power state of a VM, without I/O: remote nodes report their running set every few seconds.
function status(vm) {
  if (!vm.node_id || vm.node_id === LOCAL_ID) return host.status(vm);
  const c = conns.get(vm.node_id);
  if (!c || !c.state.seen) return 'unknown';
  return c.state.running.has(vm.id) ? 'running' : 'stopped';
}

async function inventory(id) {
  if (id === LOCAL_ID) return host.inventory();
  return conns.get(id)?.state.inventory || null;
}

async function info(id) {
  if (id === LOCAL_ID) return { online: true, stats: host.stats(), meta: { hostname: host.stats().hostname }, lastSeen: Date.now() };
  const c = conns.get(id);
  return { online: !!c, stats: c?.state.stats || null, meta: c?.state.meta || {}, lastSeen: c ? Date.now() : nodeRow(id)?.last_seen || null };
}

async function openStream(vm, kind, opts = {}) {
  if (!vm.node_id || vm.node_id === LOCAL_ID) return host.openStream(kind, vm, opts);
  const c = conns.get(vm.node_id);
  if (!c) throw new Error(`Node "${nodeName(vm.node_id)}" is offline`);
  return c.openChannel(kind, vm, opts);
}

// Capacity, Pterodactyl style: a memory and a disk limit per node, each with an over-allocation
// percentage (0 = none, -1 = unlimited). A limit of 0 means "whatever the node reports".
const fmtMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);
async function capacity(id) {
  const n = nodeRow(id);
  const i = await info(id);
  const memMb = n.memory_mb || (i.stats ? Math.floor(i.stats.memTotal / 1048576) : 0);
  const diskGb = n.disk_gb || (i.stats ? Math.floor(i.stats.diskTotal / 1073741824) : 0);
  const limit = (base, over) => (!base ? null : over < 0 ? Infinity : Math.floor(base * (1 + over / 100)));
  const used = db.prepare('SELECT COALESCE(SUM(ram_mb),0) AS mem, COALESCE(SUM(disk_gb),0) AS disk, COUNT(*) AS vms FROM vms WHERE node_id = ?').get(id);
  return { memMb, diskGb, memLimit: limit(memMb, n.memory_over), diskLimit: limit(diskGb, n.disk_over), usedMem: used.mem, usedDisk: used.disk, vms: used.vms };
}
// Returns an error message when adding these resources would exceed the node's limits, otherwise null.
async function checkCapacity(id, { addRamMb = 0, addDiskGb = 0 } = {}) {
  const c = await capacity(id);
  const name = nodeRow(id)?.name;
  if (addRamMb > 0 && c.memLimit != null && c.usedMem + addRamMb > c.memLimit) {
    return `Node "${name}" does not have enough memory: ${fmtMb(c.usedMem)} of ${fmtMb(c.memLimit)} is already allocated.`;
  }
  if (addDiskGb > 0 && c.diskLimit != null && c.usedDisk + addDiskGb > c.diskLimit) {
    return `Node "${name}" does not have enough disk space: ${c.usedDisk} GB of ${c.diskLimit} GB is already allocated.`;
  }
  return null;
}

// Choose where a new VM goes. Admins may name a node; everyone else is placed automatically
// on the enabled, online node that has the OS image and the most free memory (by allocation).
async function pickNode(tpl, { requestedId = null, admin = false, need = {} } = {}) {
  const rows = db.prepare('SELECT * FROM nodes WHERE enabled = 1').all().filter((n) => admin || n.allow_users);
  if (requestedId) {
    const n = nodeRow(requestedId);
    if (!n) return { error: 'That node does not exist.' };
    if (!n.enabled) return { error: `Node "${n.name}" is disabled for new VMs.` };
    if (!isOnline(n.id)) return { error: `Node "${n.name}" is offline.` };
    const inv = await inventory(n.id);
    if (!inv?.templates[tpl.filename]) return { error: `${tpl.name} has not been downloaded to node "${n.name}" yet.` };
    const full = await checkCapacity(n.id, { addRamMb: need.ramMb, addDiskGb: need.diskGb });
    if (full) return { error: full };
    return { node: n };
  }
  const eligible = [];
  let full = 0;
  for (const n of rows) {
    if (!isOnline(n.id)) continue;
    const inv = await inventory(n.id);
    if (!inv?.templates[tpl.filename]) continue;
    if (await checkCapacity(n.id, { addRamMb: need.ramMb, addDiskGb: need.diskGb })) { full++; continue; }
    const c = await capacity(n.id);
    eligible.push({ n, score: c.usedMem / (c.memLimit && Number.isFinite(c.memLimit) ? c.memLimit : c.memMb || 16384) });
  }
  if (!eligible.length && full) return { error: 'No node has enough free memory or disk for this VM right now. Try a smaller size.' };
  if (!eligible.length) {
    return { error: admin
      ? `${tpl.name} is not available on any online node. Download it under OS templates.`
      : `${tpl.name} is not available right now. Ask an administrator to download it.` };
  }
  eligible.sort((a, b) => a.score - b.score || a.n.id - b.n.id);
  return { node: eligible[0].n };
}

module.exports = { LOCAL_ID, capacity, checkCapacity, attachAgent, disconnect, isOnline, syncNode, touch, exec, status, inventory, info, openStream, pickNode, nodeRow };
