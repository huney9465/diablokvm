'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, audit, setting } = require('../db');
const nodes = require('../services/nodes');
const V = require('../services/vmdata');
const { hashPassword } = require('../host/cloudinit');
const { ISO_RE } = require('../host/images');
const cmdhistory = require('../services/cmdhistory');
const mining = require('../services/mining');
const sshx = require('../services/sshx');
const { parseForwards, isPort, isHostIp, randomToken } = require('../util');
const { requireAdmin } = require('../middleware/auth');
const { VM_MAX } = require('../upload');

const router = express.Router();
const ex = (vm) => nodes.exec(vm.node_id);

// ---- Auto port forwarding helpers ------------------------------------------------------------
// Every host port used by any VM on the same node, so a new forward never collides.
function usedHostPorts(nodeId, vmId, hostIp, proto) {
  const used = new Set();
  const rows = db.prepare('SELECT id, port_forwards FROM vms WHERE node_id = ? AND id != ?').all(nodeId, vmId);
  for (const r of rows) for (const f of parseForwards(r.port_forwards)) {
    if (f.proto === proto && (f.host_ip || '0.0.0.0') === (hostIp || '0.0.0.0')) used.add(f.host_port);
  }
  return used;
}

// The first free public port in [from, to] for this node/address/protocol, or null if none is free.
function findFreePort(nodeId, vmId, hostIp, proto, from, to) {
  const used = usedHostPorts(nodeId, vmId, hostIp, proto);
  for (let p = from; p <= to; p++) if (!used.has(p)) return p;
  return null;
}

// Build the forwards a brand-new NAT VM should start with when auto port forwarding is on.
function autoForwards(vm, hostIp) {
  if (setting('port_forward_enabled') === '0' || setting('port_forward_auto') !== '1') return [];
  const ports = String(setting('port_forward_auto_ports') || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(isPort);
  const from = parseInt(setting('port_forward_auto_from'), 10) || 20000;
  const to = parseInt(setting('port_forward_auto_to'), 10) || 30000;
  const list = [];
  const taken = new Set();
  for (const vmPort of ports) {
    const hostPort = findFreePort(vm.node_id, vm.id, hostIp, 'tcp', from, to);
    if (!hostPort || taken.has(hostPort)) continue;
    taken.add(hostPort);
    list.push({ id: randomToken(4), host_ip: hostIp, host_port: hostPort, vm_port: vmPort, proto: 'tcp', label: vmPort === 22 ? 'SSH' : vmPort === 80 ? 'HTTP' : vmPort === 443 ? 'HTTPS' : '' });
  }
  return list;
}

const owners = () => db.prepare('SELECT id, username FROM users WHERE disabled = 0 ORDER BY username').all();
const formDefaults = (user) => ({
  name: '', cpu: 2, ram_mb: 2048, disk_gb: 20, guest_user: 'root', ssh_key: '', template_id: '', owner_id: user.id, node_id: '',
  net_mode: setting('default_net_mode'), bridge: setting('default_bridge'), ip: '', prefix: 24, gateway: '',
  dns: setting('default_dns'), vlan: '', autostart: false,
});

// Templates that at least one node this person may use has downloaded, with the nodes that have them.
async function templateChoices(user) {
  const admin = user.role === 'admin';
  const usable = db.prepare('SELECT n.*, l.short AS location FROM nodes n JOIN locations l ON l.id = n.location_id WHERE n.enabled = 1 ORDER BY l.short, n.name').all().filter((n) => (admin || n.allow_users) && nodes.isOnline(n.id));
  const invs = {};
  for (const n of usable) invs[n.id] = await nodes.inventory(n.id);
  const templates = db.prepare('SELECT * FROM templates WHERE enabled = 1 ORDER BY name').all()
    .map((t) => ({ ...t, nodes: usable.filter((n) => invs[n.id]?.templates[t.filename]).map((n) => n.id) }))
    .filter((t) => t.nodes.length);
  return { usable, templates };
}

async function renderNew(res, user, values, errors = []) {
  const { usable, templates } = await templateChoices(user);
  res.status(errors.length ? 422 : 200).render('vm-new', {
    title: 'Create VM', errors, values: { ...formDefaults(user), ...values },
    templates, nodeChoices: user.role === 'admin' ? usable : [], owners: user.role === 'admin' ? owners() : [],
  });
}

// Load + authorize :id once for every route below.
router.param('id', (req, res, next, id) => {
  const vm = /^\d+$/.test(id) ? V.getVm(Number(id)) : null;
  if (!vm || !V.canAccess(req.user, vm)) {
    return res.status(404).render('error', { title: 'VM not found', message: 'That VM does not exist or belongs to someone else.' });
  }
  req.vm = vm;
  next();
});

router.get('/vms', (req, res) => {
  const all = req.user.role === 'admin' && req.query.scope !== 'mine';
  res.render('vms', { title: all ? 'All virtual machines' : 'My virtual machines', vms: V.listVms(req.user, all), all });
});

router.get('/vms/status', (req, res) => {
  const out = {};
  for (const vm of V.listVms(req.user, true)) out[vm.id] = vm.status;
  res.json(out);
});

router.get('/vms/new', requireAdmin, async (req, res) => renderNew(res, req.user, {}));

router.post('/vms', requireAdmin, async (req, res) => {
  const { errors, v } = await V.parseVmForm(req.body, req.user);
  const quota = !errors.length && V.quotaError(req.user, v.owner_id);
  if (quota) errors.push(quota);
  const again = () => ({ ...req.body, autostart: !!req.body.autostart });
  if (errors.length) return renderNew(res, req.user, again(), errors);

  const vm = V.insertVm(v);
  const sx = await sshx.provisionOpts(vm.node_id);
  try {
    await ex(vm).provision(vm, v.tpl.filename, await hashPassword(v.password), { sshx: sx });
  } catch (e) {
    await ex(vm).destroy(vm).catch(() => {});
    db.prepare('DELETE FROM vms WHERE id = ?').run(vm.id);
    return renderNew(res, req.user, again(), [`Could not build the VM: ${e.message}`]);
  }
  // Remember which sshx server this VM was built for (NULL = no SSHX on this VM).
  db.prepare('UPDATE vms SET sshx_server = ?, sshx_cancelled = 0, sshx_link = NULL, sshx_created_at = NULL WHERE id = ?')
    .run(sx.enabled ? sx.server : null, vm.id);
  // Auto port forwarding: give a fresh NAT VM its default forwards right away.
  if (vm.net_mode === 'user') {
    const list = autoForwards(vm, setting('port_forward_host_ip') || '');
    if (list.length) db.prepare('UPDATE vms SET port_forwards = ? WHERE id = ?').run(JSON.stringify(list), vm.id);
  }
  nodes.touch(vm.node_id);
  audit(req.user.id, 'vm.create', `${vm.id}:${vm.name}@${vm.node_name}`);
  req.flash('ok', `${vm.name} is ready. Start it when you want it to boot for the first time.`);
  res.redirect(`/vms/${vm.id}`);
});

router.get('/vms/:id', async (req, res) => {
  const vm = req.vm;
  const inv = await nodes.inventory(vm.node_id);
  const templates = db.prepare('SELECT * FROM templates WHERE enabled = 1 ORDER BY name').all().filter((t) => inv?.templates[t.filename]);
  const forwards = parseForwards(vm.port_forwards);
  const hostIp = setting('port_forward_host_ip') || '';
  res.render('vm-detail', {
    title: vm.name, vm,
    isos: inv?.isos || [],
    templates,
    owners: req.user.role === 'admin' ? owners() : [],
    nodeOnline: nodes.isOnline(vm.node_id),
    forwards, hostIp,
    pfEnabled: setting('port_forward_enabled') !== '0',
    pfAuto: setting('port_forward_auto') === '1',
    pfDefaultIp: hostIp,
    mining: mining.status(vm.id),
  });
});

router.get('/vms/:id/state', (req, res) => res.json({ status: V.getVm(req.vm.id).status }));

router.post('/vms/:id/power', async (req, res) => {
  const vm = req.vm;
  const action = req.body.action;
  const labels = { start: 'Starting', stop: 'Shutting down', 'force-stop': 'Powered off', reboot: 'Rebooting', suspend: 'Suspended', resume: 'Resumed' };
  const methods = { start: 'start', stop: 'stop', 'force-stop': 'forceStop', reboot: 'reboot', suspend: 'suspend', resume: 'resume' };
  try {
    if (!methods[action]) throw new Error('Unknown action');
    await ex(vm)[methods[action]](vm);
    if (action === 'suspend') db.prepare('UPDATE vms SET suspended = 1 WHERE id = ?').run(vm.id);
    else if (action === 'resume') db.prepare('UPDATE vms SET suspended = 0, mining_suspect = 0 WHERE id = ?').run(vm.id);
    else if (['start', 'stop', 'force-stop'].includes(action)) db.prepare('UPDATE vms SET suspended = 0 WHERE id = ?').run(vm.id);
    mining.clear(vm.id);
    audit(req.user.id, `vm.${action}`, `${vm.id}:${vm.name}`);
    req.flash('ok', `${labels[action]} ${vm.name}.`);
  } catch (e) { req.flash('err', e.message); }
  res.redirect(`/vms/${vm.id}`);
});

router.post('/vms/:id/iso', async (req, res) => {
  const vm = req.vm;
  const name = String(req.body.iso || '');
  try {
    if (name) {
      if (!ISO_RE.test(name)) throw new Error('Invalid ISO name');
      await ex(vm).attachIso(vm, name);
      db.prepare('UPDATE vms SET iso = ? WHERE id = ?').run(name, vm.id);
      req.flash('ok', vm.status === 'running' ? `Attached ${name}. Reboot the VM to boot from it.` : `${name} will be attached when the VM starts and used as the first boot device.`);
    } else {
      await ex(vm).detachIso(vm);
      db.prepare('UPDATE vms SET iso = NULL WHERE id = ?').run(vm.id);
      req.flash('ok', 'ISO removed.');
    }
    nodes.touch(vm.node_id);
    audit(req.user.id, 'vm.iso', `${vm.id}:${name || 'eject'}`);
  } catch (e) { req.flash('err', e.message); }
  res.redirect(`/vms/${vm.id}`);
});

// ---- Port forwarding (NAT VMs) ---------------------------------------------------------------
// Maps a public host address:port to a port inside a NAT VM so users can reach the VM from the
// internet. The rules live in the VM's port_forwards JSON column and become QEMU hostfwd options.
function forwardConflict(nodeId, vmId, hostIp, hostPort, proto) {
  const rows = db.prepare('SELECT id, name, port_forwards FROM vms WHERE node_id = ? AND id != ?').all(nodeId, vmId);
  for (const r of rows) {
    for (const f of parseForwards(r.port_forwards)) {
      if (f.proto === proto && f.host_port === hostPort && (f.host_ip || '0.0.0.0') === (hostIp || '0.0.0.0')) return r.name;
    }
  }
  return null;
}

router.post('/vms/:id/forwards', (req, res) => {
  const vm = req.vm;
  const back = () => res.redirect(`/vms/${vm.id}`);
  if (setting('port_forward_enabled') === '0') { req.flash('err', 'Port forwarding is turned off in Settings.'); return back(); }
  if (vm.net_mode !== 'user') { req.flash('err', 'Port forwarding only applies to NAT VMs. This VM uses a bridge, so it already has its own address.'); return back(); }
  const host_ip = String(req.body.host_ip || '').trim();
  const host_port = Number(req.body.host_port);
  const vm_port = Number(req.body.vm_port);
  const proto = req.body.proto === 'udp' ? 'udp' : 'tcp';
  const label = String(req.body.label || '').trim().slice(0, 40);
  if (!isHostIp(host_ip)) { req.flash('err', 'The public IP must be a valid IPv4 address, or blank for every address.'); return back(); }
  if (!isPort(host_port)) { req.flash('err', 'The public port must be between 1 and 65535.'); return back(); }
  if (!isPort(vm_port)) { req.flash('err', 'The VM port must be between 1 and 65535.'); return back(); }
  const clash = forwardConflict(vm.node_id, vm.id, host_ip, host_port, proto);
  if (clash) { req.flash('err', `Port ${host_port}/${proto} on that address is already used by "${clash}".`); return back(); }
  const list = parseForwards(vm.port_forwards);
  if (list.some((f) => f.proto === proto && f.host_port === host_port && (f.host_ip || '0.0.0.0') === (host_ip || '0.0.0.0'))) {
    req.flash('err', `This VM already forwards ${host_port}/${proto} on that address.`); return back();
  }
  list.push({ id: randomToken(4), host_ip, host_port, vm_port, proto, label });
  db.prepare('UPDATE vms SET port_forwards = ? WHERE id = ?').run(JSON.stringify(list), vm.id);
  nodes.touch(vm.node_id);
  audit(req.user.id, 'vm.forward.add', `${vm.id}:${proto}/${host_port}->${vm_port}`);
  req.flash('ok', vm.status === 'running' ? 'Port forward added. Restart the VM for it to take effect.' : 'Port forward added. It applies when the VM starts.');
  back();
});

router.post('/vms/:id/forwards/:fid/delete', (req, res) => {
  const vm = req.vm;
  const list = parseForwards(vm.port_forwards).filter((f) => f.id !== req.params.fid);
  db.prepare('UPDATE vms SET port_forwards = ? WHERE id = ?').run(list.length ? JSON.stringify(list) : null, vm.id);
  nodes.touch(vm.node_id);
  audit(req.user.id, 'vm.forward.del', `${vm.id}:${req.params.fid}`);
  req.flash('ok', vm.status === 'running' ? 'Port forward removed. Restart the VM for it to take effect.' : 'Port forward removed.');
  res.redirect(`/vms/${vm.id}`);
});

// Only administrators may change a VM's resources (CPU, memory, disk). Regular users cannot
// resize their own VM.
router.post('/vms/:id/resize', requireAdmin, async (req, res) => {
  const vm = req.vm;
  const gb = Number(req.body.disk_gb);
  const max = 8192;
  try {
    if (!Number.isInteger(gb) || gb < 5 || gb > max) throw new Error(`Disk must be between 5 GB and ${max} GB.`);
    const full = await nodes.checkCapacity(vm.node_id, { addDiskGb: gb - vm.disk_gb });
    if (full) throw new Error(full);
    await ex(vm).resizeDisk(vm, gb);
    db.prepare('UPDATE vms SET disk_gb = ? WHERE id = ?').run(gb, vm.id);
    audit(req.user.id, 'vm.resize', `${vm.id}:${gb}G`);
    req.flash('ok', `Disk is now ${gb} GB. The guest grows its filesystem on next boot.`);
  } catch (e) { req.flash('err', e.message); }
  res.redirect(`/vms/${vm.id}`);
});

// Only administrators may change a VM's CPU or memory. Regular users cannot edit their own VM.
router.post('/vms/:id/edit', requireAdmin, async (req, res) => {
  const vm = req.vm;
  const admin = req.user.role === 'admin';
  const cpu = Number(req.body.cpu), ram = Number(req.body.ram_mb);
  const maxCpu = admin ? 128 : parseInt(setting('user_max_cpu'), 10);
  const maxRam = admin ? 1048576 : parseInt(setting('user_max_ram_mb'), 10);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > maxCpu) req.flash('err', `CPU cores must be between 1 and ${maxCpu}.`);
  else if (!Number.isInteger(ram) || ram < 256 || ram > maxRam) req.flash('err', `Memory must be between 256 MB and ${maxRam} MB.`);
  else {
    const full = await nodes.checkCapacity(vm.node_id, { addRamMb: ram - vm.ram_mb });
    if (full) { req.flash('err', full); return res.redirect(`/vms/${vm.id}`); }
    const ownerId = admin && Number(req.body.owner_id) ? Number(req.body.owner_id) : vm.owner_id;
    db.prepare('UPDATE vms SET cpu = ?, ram_mb = ?, autostart = ?, owner_id = ? WHERE id = ?')
      .run(cpu, ram, admin ? (req.body.autostart ? 1 : 0) : vm.autostart, ownerId, vm.id);
    nodes.touch(vm.node_id);
    audit(req.user.id, 'vm.edit', `${vm.id}:${vm.name}`);
    req.flash('ok', vm.status === 'running' ? 'Saved. CPU and memory changes apply after the next full stop and start.' : 'Saved.');
  }
  res.redirect(`/vms/${vm.id}`);
});

router.post('/vms/:id/reinstall', async (req, res) => {
  const vm = req.vm;
  const body = { ...req.body, disk_gb: req.body.disk_gb || vm.disk_gb };
  const { errors, v } = await V.parseVmForm(body, req.user, { vmId: vm.id, reinstall: true, nodeId: vm.node_id });
  if (errors.length) { req.flash('err', errors.join(' ')); return res.redirect(`/vms/${vm.id}`); }
  try {
    const full = await nodes.checkCapacity(vm.node_id, { addDiskGb: v.disk_gb - vm.disk_gb });
    if (full) throw new Error(full);
    const next = {
      ...vm, template_id: v.template_id, disk_gb: v.disk_gb, guest_user: v.guest_user, ssh_key: v.ssh_key || null,
      ...(req.user.role === 'admin' ? { net_mode: v.net_mode, bridge: v.bridge, ip: v.ip, prefix: v.prefix, gateway: v.gateway, dns: v.dns, vlan: v.vlan } : {}),
    };
    await ex(vm).provision(next, v.tpl.filename, await hashPassword(v.password));
    db.prepare(`UPDATE vms SET template_id=?, disk_gb=?, guest_user=?, ssh_key=?, net_mode=?, bridge=?, ip=?, prefix=?, gateway=?, dns=?, vlan=?, iso=NULL, suspended=0, mining_suspect=0, sshx_cancelled=0, sshx_link=NULL, sshx_created_at=NULL WHERE id=?`)
      .run(next.template_id, next.disk_gb, next.guest_user, next.ssh_key, next.net_mode, next.bridge, next.ip, next.prefix, next.gateway, next.dns, next.vlan, vm.id);
    nodes.touch(vm.node_id);
    audit(req.user.id, 'vm.reinstall', `${vm.id}:${v.tpl.name}`);
    req.flash('ok', `${vm.name} was reinstalled with ${v.tpl.name}. Start it to boot the fresh system.`);
  } catch (e) { req.flash('err', `Reinstall failed: ${e.message}`); }
  res.redirect(`/vms/${vm.id}`);
});

router.post('/vms/:id/delete', async (req, res) => {
  const vm = req.vm;
  if (String(req.body.confirm_name || '') !== vm.name) {
    req.flash('err', 'Type the VM name exactly to confirm deletion.');
    return res.redirect(`/vms/${vm.id}`);
  }
  try {
    await ex(vm).destroy(vm);
    db.prepare('DELETE FROM vms WHERE id = ?').run(vm.id);
    nodes.touch(vm.node_id);
    audit(req.user.id, 'vm.delete', `${vm.id}:${vm.name}`);
    req.flash('ok', `${vm.name} was deleted.`);
    res.redirect('/vms');
  } catch (e) { req.flash('err', e.message); res.redirect(`/vms/${vm.id}`); }
});

// Admin-only: the command history for a VM, rebuilt from SSH and console keystrokes.
router.get('/vms/:id/commands', requireAdmin, (req, res) => {
  const vm = req.vm;
  res.render('vm-commands', { title: `${vm.name} command history`, vm, commands: cmdhistory.list(vm.id, 1000) });
});

router.get('/vms/:id/console', (req, res) => res.render('vm-console', { title: `${req.vm.name} console`, vm: req.vm }));

// ---- Per-VM file manager ---------------------------------------------------------------------
// Each VM has a folder on its node (beside the disk). Owners can browse it, upload files (up to
// 1 GB) and delete them. Files are transferred in 1 MB chunks, so this works for VMs on remote
// nodes too, not just the built-in Local node.
const FILE_CHUNK = 1024 * 1024;

async function transferToNode(vm, localPath, name, size) {
  const exec = ex(vm);
  const token = await exec.beginVmFile(vm, name, size);
  let fd;
  try {
    fd = fs.openSync(localPath, 'r');
    const buf = Buffer.alloc(FILE_CHUNK);
    let pos = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, 0, FILE_CHUNK, pos);
      if (read <= 0) break;
      await exec.chunkVmFile(token, buf.subarray(0, read).toString('base64'));
      pos += read;
    }
    fs.closeSync(fd);
    fd = null;
    return await exec.finishVmFile(token);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    await exec.abortVmFile(token).catch(() => {});
    throw e;
  }
}

const filePage = async (req, res, extra = {}) => {
  const vm = req.vm;
  let files = [];
  let error = null;
  if (nodes.isOnline(vm.node_id)) {
    try { files = await ex(vm).listVmFiles(vm); } catch (e) { error = e.message; }
  } else {
    error = `Node "${vm.node_name}" is offline, so the files cannot be listed right now.`;
  }
  res.render('vm-files', { title: `${vm.name} files`, vm, files, error, maxBytes: VM_MAX, ...extra });
};

router.get('/vms/:id/files', filePage);

router.post('/vms/:id/files/upload', async (req, res) => {
  const vm = req.vm;
  const cleanup = () => { if (req.file?.path) fs.rm(req.file.path, { force: true }, () => {}); };
  // The multipart body (and its _csrf field) is parsed in server.js before the CSRF check,
  // so req.file / req.uploadError are already populated here.
  const err = req.uploadError;
  if (err) {
    cleanup();
    req.flash('err', err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 1 GB limit.' : `Upload failed: ${err.message}`);
    return res.redirect(`/vms/${vm.id}/files`);
  }
  if (!req.file) { req.flash('err', 'Choose a file to upload.'); return res.redirect(`/vms/${vm.id}/files`); }
  try {
    const name = String(req.body.name || req.file.originalname || '').trim() || req.file.originalname;
    const saved = await transferToNode(vm, req.file.path, name, req.file.size);
    audit(req.user.id, 'vm.file.upload', `${vm.id}:${saved.name}`);
    req.flash('ok', `Uploaded ${saved.name}.`);
  } catch (e) {
    req.flash('err', `Upload failed: ${e.message}`);
  } finally { cleanup(); }
  res.redirect(`/vms/${vm.id}/files`);
});

router.post('/vms/:id/files/delete', async (req, res) => {
  const vm = req.vm;
  try {
    await ex(vm).deleteVmFile(vm, String(req.body.name || ''));
    audit(req.user.id, 'vm.file.delete', `${vm.id}:${req.body.name}`);
    req.flash('ok', 'File deleted.');
  } catch (e) { req.flash('err', e.message); }
  res.redirect(`/vms/${vm.id}/files`);
});

router.get('/vms/:id/files/download', async (req, res) => {
  const vm = req.vm;
  const name = String(req.query.name || '');
  const exec = ex(vm);
  let info;
  try { info = await exec.statVmFile(vm, name); } catch (e) {
    return res.status(404).render('error', { title: 'File not found', message: e.message });
  }
  const safe = String(info.name).replace(/[^A-Za-z0-9._-]+/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(info.size));
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  let offset = 0;
  try {
    for (;;) {
      const part = await exec.readVmFileChunk(vm, info.name, offset, FILE_CHUNK);
      if (part.data) { res.write(Buffer.from(part.data, 'base64')); offset += Buffer.byteLength(part.data, 'base64'); }
      if (part.eof) break;
    }
  } catch { /* client went away or node dropped */ }
  res.end();
});

// ---- SSHX: a browser terminal in a new tab ----
// The guest prints its sshx link on the serial console once it is up; the panel stores it so the
// session keeps working (it does not expire) until the owner cancels it, even after the serial log
// scrolls past the link.
router.get('/vms/:id/sshx', async (req, res) => {
  const vm = req.vm;
  res.set('Cache-Control', 'no-store'); // the link is a secret and changes on every boot
  const stop = (message) => res.status(409).render('error', { title: 'SSHX terminal', message });
  if (!vm.sshx_server) return stop('This VM has no SSHX terminal. It is added when a VM is created or reinstalled while SSHX is enabled in Settings, on a node running the current agent.');
  if (vm.sshx_cancelled) return res.status(409).render('sshx-wait', { title: `${vm.name} SSHX`, vm, tries: 0, giveUp: true, cancelled: true });
  if (!nodes.isOnline(vm.node_id)) return stop(`Node "${vm.node_name}" is offline, so the VM cannot be reached right now.`);
  if (vm.status !== 'running') return stop('This VM is not running. Start it, then open SSHX again.');
  let link = null;
  try { link = await ex(vm).sshxLink(vm); } catch (e) { return stop(e.message); }
  if (link && sshx.isSafeLink(link, vm.sshx_server)) {
    // Persist so the session stays available until the owner cancels it.
    if (link !== vm.sshx_link) db.prepare("UPDATE vms SET sshx_link = ?, sshx_created_at = COALESCE(sshx_created_at, datetime('now')) WHERE id = ?").run(link, vm.id);
    audit(req.user.id, 'vm.sshx', `${vm.id}:${vm.name}`);
    return res.redirect(link);
  }
  // Fall back to the stored link so an active session does not disappear when the log scrolls.
  if (vm.sshx_link && sshx.isSafeLink(vm.sshx_link, vm.sshx_server)) {
    audit(req.user.id, 'vm.sshx', `${vm.id}:${vm.name}`);
    return res.redirect(vm.sshx_link);
  }
  const tries = Math.min(1000, Math.max(0, parseInt(req.query.w, 10) || 0));
  res.render('sshx-wait', { title: `${vm.name} SSHX`, vm, tries, giveUp: tries >= 60 });
});

// Cancel the SSHX session: clear the stored link, mark it cancelled (so the panel stops offering
// it) and ask the guest to drop its sshx client.
router.post('/vms/:id/sshx/stop', async (req, res) => {
  const vm = req.vm;
  db.prepare('UPDATE vms SET sshx_link = NULL, sshx_created_at = NULL, sshx_cancelled = 1 WHERE id = ?').run(vm.id);
  if (vm.status === 'running' && nodes.isOnline(vm.node_id)) await ex(vm).sshxStop(vm).catch(() => {});
  audit(req.user.id, 'vm.sshx.stop', `${vm.id}:${vm.name}`);
  req.flash('ok', 'SSHX session cancelled. It will not come back until you start a new one.');
  res.redirect(`/vms/${vm.id}`);
});

// Start a fresh SSHX session after a cancel: clear the flag and forget the old link so the panel
// picks up whatever the guest reports next.
router.post('/vms/:id/sshx/start', (req, res) => {
  const vm = req.vm;
  db.prepare('UPDATE vms SET sshx_cancelled = 0, sshx_link = NULL, sshx_created_at = NULL WHERE id = ?').run(vm.id);
  audit(req.user.id, 'vm.sshx.start', `${vm.id}:${vm.name}`);
  req.flash('ok', 'Starting a new SSHX session. Open SSHX in a moment.');
  res.redirect(`/vms/${vm.id}`);
});

// ---- Guest filesystem browser ----------------------------------------------------------------
// Reads the VM's own disk (read-only, via libguestfs) so users can see the real files inside their
// VM. This is the "full file access" view: it reflects what is actually on the guest's filesystem.
router.get('/vms/:id/guest', async (req, res) => {
  const vm = req.vm;
  const dir = String(req.query.path || '/');
  let entries = [];
  let error = null;
  let available = false;
  if (!nodes.isOnline(vm.node_id)) {
    error = `Node "${vm.node_name}" is offline, so the disk cannot be read right now.`;
  } else {
    try {
      available = await ex(vm).guestfsAvailable();
      if (!available) error = 'The disk file browser needs libguestfs on this VM\'s node. Install libguestfs-tools (apt install libguestfs-tools) and try again.';
      else entries = await ex(vm).listGuestFiles(vm, dir);
    } catch (e) { error = e.message; }
  }
  res.render('vm-guest-files', { title: `${vm.name} disk files`, vm, dir, entries, error, available });
});

router.get('/vms/:id/guest/download', async (req, res) => {
  const vm = req.vm;
  const p = String(req.query.path || '');
  try {
    const r = await ex(vm).readGuestFile(vm, p, 32 * 1024 * 1024);
    const safe = path.basename(p).replace(/[^A-Za-z0-9._-]+/g, '_') || 'file';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.send(Buffer.from(r.data, 'base64'));
  } catch (e) {
    res.status(404).render('error', { title: 'File not found', message: e.message });
  }
});

// Terminal: every VM opens its serial console by default. Cloud-init auto-logs the console in as
// root, so the panel drops the user straight into a root shell with no password (container-like
// access). Bridge VMs can still open an SSH session explicitly with ?mode=ssh.
router.get('/vms/:id/ssh', (req, res) => {
  const vm = req.vm;
  const mode = req.query.mode === 'ssh' ? 'ssh' : 'serial';
  res.render('vm-ssh', { title: `${vm.name} terminal`, vm, mode, host: vm.ip || '', port: 22 });
});

module.exports = router;
