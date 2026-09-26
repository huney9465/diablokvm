'use strict';
const { WebSocketServer } = require('ws');
const { db } = require('../db');
const nodes = require('../services/nodes');
const V = require('../services/vmdata');
const cmdhistory = require('../services/cmdhistory');
const { sha256 } = require('../util');

// Browser endpoints, all bound to the panel session cookie. Each works for a VM on this server
// or on any node: the stream is opened through services/nodes, which tunnels to remote nodes.
//   /ws/vnc/:id     graphical console (noVNC)
//   /ws/serial/:id  interactive serial console
//   /ws/ssh/:id     SSH terminal (bridge VMs; the connection is made from the VM's node)
//   /ws/logs/:id    live tail of the serial log
// Node agents connect to /ws/node with their token.
function attachWebSockets(server, sessionParser) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const pathOnly = (req.url || '').split('?')[0];

    if (pathOnly === '/ws/node') {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      const node = token && db.prepare('SELECT * FROM nodes WHERE token_hash = ? AND id != 1').get(sha256(token));
      if (!node) return setTimeout(() => reject(401, 'Unauthorized'), 500); // slow down guessing
      return agentWss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        nodes.attachAgent(ws, node);
      });
    }

    const m = /^\/ws\/(vnc|ssh|logs|serial)\/(\d+)$/.exec(pathOnly);
    if (!m) return reject(404, 'Not Found');

    // Block cross-site WebSocket hijacking: the Origin host must match the Host header.
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return reject(403, 'Forbidden'); } catch { return reject(403, 'Forbidden'); }
    }

    sessionParser(req, {}, () => {
      const uid = req.session && req.session.uid;
      const user = uid && db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(uid);
      const vm = user && V.getVm(Number(m[2]));
      if (!user) return reject(401, 'Unauthorized');
      if (!vm || !V.canAccess(user, vm)) return reject(404, 'Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ({ vnc: raw('vnc'), serial: raw('serial'), logs: logs, ssh: ssh })[m[1]](ws, vm, user);
      });
    });
  });

  const beat = setInterval(() => {
    for (const set of [wss.clients, agentWss.clients]) {
      for (const ws of set) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
    }
  }, 30000);
  beat.unref();
}

const reason = (e) => String(e.message || 'Error').slice(0, 100);

// Byte-for-byte bridge (VNC and serial console). For the serial console we also rebuild the
// typed line and store it as command history (admins only can read it back).
const raw = (kind) => async (ws, vm, user) => {
  let stream;
  try { stream = await nodes.openStream(vm, kind); } catch (e) { return ws.close(1011, reason(e)); }
  const recorder = kind === 'serial' ? new cmdhistory.LineRecorder(vm.id, user, 'console') : null;
  stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  stream.on('event', (ev) => { if (ev.type === 'error') ws.close(1011, reason(ev)); });
  stream.on('close', () => ws.close());
  ws.on('message', (d) => {
    if (recorder) recorder.push(d.toString('utf8'));
    stream.write(d);
  });
  ws.on('close', () => stream.close());
  if (stream.closed) ws.close();
};

async function logs(ws, vm) {
  let stream;
  try { stream = await nodes.openStream(vm, 'logs'); } catch (e) { return ws.close(1011, reason(e)); }
  stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d.toString('utf8')); });
  stream.on('close', () => ws.close());
  ws.on('close', () => stream.close());
}

// SSH: the browser sends JSON control messages, the shell's output comes back as binary.
function ssh(ws, vm, user) {
  const send = (o) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
  let stream = null;
  let size = { cols: 80, rows: 24 };
  let opening = false;
  const recorder = new cmdhistory.LineRecorder(vm.id, user, 'ssh');

  ws.on('message', async (rawMsg) => {
    let msg;
    try { msg = JSON.parse(rawMsg.toString()); } catch { return; }
    if (msg.type === 'resize') {
      size = { cols: Math.min(500, msg.cols | 0 || 80), rows: Math.min(200, msg.rows | 0 || 24) };
      if (stream) stream.control({ type: 'resize', ...size });
    } else if (msg.type === 'input') {
      recorder.push(String(msg.data));
      if (stream) stream.write(String(msg.data));
    } else if (msg.type === 'connect' && !stream && !opening) {
      opening = true;
      try {
        // Only admins may name an address, and only for DHCP bridge VMs whose address the panel does not know.
        stream = await nodes.openStream(vm, 'ssh', {
          username: String(msg.username || vm.guest_user || 'root'), password: String(msg.password || ''),
          host: user.role === 'admin' ? String(msg.host || '') : '', ...size,
        });
      } catch (e) { opening = false; return send({ type: 'error', message: e.message }); }
      stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
      stream.on('event', (ev) => send(ev));
      stream.on('close', () => send({ type: 'closed' }));
    }
  });
  ws.on('close', () => { if (stream) stream.close(); });
}

module.exports = { attachWebSockets };
