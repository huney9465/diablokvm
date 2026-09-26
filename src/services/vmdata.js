'use strict';
const crypto = require('crypto');
const { db, setting, audit } = require('../db');
const nodes = require('./nodes');
const { HOSTNAME_RE, LINUX_USER_RE, isIPv4, isPrefix, isSshKey, randomMac } = require('../util');

const BASE = `SELECT v.*, u.username AS owner_name, t.name AS template_name, t.filename AS template_file, n.name AS node_name
  FROM vms v JOIN users u ON u.id = v.owner_id LEFT JOIN templates t ON t.id = v.template_id
  LEFT JOIN nodes n ON n.id = v.node_id`;

// status is 'running', 'stopped', or 'unknown' when the VM's node is offline.
const decorate = (vm) => (vm ? { ...vm, status: nodes.status(vm) } : null);
const getVm = (id) => decorate(db.prepare(`${BASE} WHERE v.id = ?`).get(id));
const listVms = (user, all) => {
  const rows = all && user.role === 'admin'
    ? db.prepare(`${BASE} ORDER BY v.id DESC`).all()
    : db.prepare(`${BASE} WHERE v.owner_id = ? ORDER BY v.id DESC`).all(user.id);
  return rows.map(decorate);
};
const canAccess = (user, vm) => !!vm && (user.role === 'admin' || vm.owner_id === user.id);

const newUuid = () => crypto.randomUUID();

// Validates create/reinstall input. Returns { errors: [...], v: {...clean values} }.
// Non-admins cannot pick networking or an owner: those come from panel settings.
async function parseVmForm(body, user, { vmId = null, reinstall = false, nodeId = null } = {}) {
  const errors = [];
  const admin = user.role === 'admin';
  const num = (x) => (x === undefined || x === '' ? NaN : Number(x));
  const v = {};

  if (!reinstall) {
    v.name = String(body.name || '').trim().toLowerCase();
    if (!HOSTNAME_RE.test(v.name)) errors.push('Name must be a valid hostname: letters, numbers and dashes, up to 63 characters.');
    v.cpu = num(body.cpu); v.ram_mb = num(body.ram_mb);
    const maxCpu = admin ? 128 : parseInt(setting('user_max_cpu'), 10);
    const maxRam = admin ? 1048576 : parseInt(setting('user_max_ram_mb'), 10);
    if (!Number.isInteger(v.cpu) || v.cpu < 1 || v.cpu > maxCpu) errors.push(`CPU cores must be between 1 and ${maxCpu}.`);
    if (!Number.isInteger(v.ram_mb) || v.ram_mb < 256 || v.ram_mb > maxRam) errors.push(`Memory must be between 256 MB and ${maxRam} MB.`);
  }
  v.disk_gb = num(body.disk_gb);
  const maxDisk = admin ? 8192 : parseInt(setting('user_max_disk_gb'), 10);
  if (!Number.isInteger(v.disk_gb) || v.disk_gb < 5 || v.disk_gb > maxDisk) errors.push(`Disk must be between 5 GB and ${maxDisk} GB.`);

  v.template_id = num(body.template_id);
  const tpl = Number.isInteger(v.template_id) && db.prepare("SELECT * FROM templates WHERE id = ? AND enabled = 1").get(v.template_id);
  if (!tpl) errors.push('Choose an operating system.');
  v.tpl = tpl || null;

  // Where the VM runs. Reinstalls stay on the VM's node; new VMs are placed by the scheduler.
  v.node_id = nodeId;
  if (tpl) {
    if (reinstall) {
      const inv = await nodes.inventory(nodeId);
      if (!nodes.isOnline(nodeId)) errors.push(`Node "${nodes.nodeRow(nodeId)?.name}" is offline. Try again when it is back.`);
      else if (!inv?.templates[tpl.filename]) errors.push(`${tpl.name} has not been downloaded to this VM's node yet.`);
    } else {
      const requested = admin ? Number(body.node_id) || null : null;
      const pick = await nodes.pickNode(tpl, { requestedId: requested, admin, need: { ramMb: Number.isInteger(v.ram_mb) ? v.ram_mb : 0, diskGb: Number.isInteger(v.disk_gb) ? v.disk_gb : 0 } });
      if (pick.error) errors.push(pick.error); else v.node_id = pick.node.id;
    }
  }

  v.guest_user = String(body.guest_user || '').trim() || 'root';
  if (!LINUX_USER_RE.test(v.guest_user)) errors.push('Login user must be lowercase letters, numbers, dash or underscore, up to 32 characters.');
  v.password = String(body.password || '');
  // Admins may set short passwords (down to 3 characters); everyone else follows the panel minimum.
  const minPw = admin ? 3 : Math.max(3, parseInt(setting('min_password_length'), 10) || 8);
  if (v.password.length < minPw) errors.push(`The login password needs at least ${minPw} character${minPw === 1 ? '' : 's'}.`);
  v.ssh_key = String(body.ssh_key || '').trim();
  if (v.ssh_key && !v.ssh_key.split('\n').every((l) => !l.trim() || isSshKey(l))) errors.push('That does not look like a valid SSH public key.');

  // Networking + ownership
  if (admin) {
    v.owner_id = num(body.owner_id) || user.id;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(v.owner_id)) errors.push('Choose a valid owner.');
    v.net_mode = body.net_mode === 'bridge' ? 'bridge' : 'user';
    v.autostart = body.autostart ? 1 : 0;
  } else {
    v.owner_id = user.id;
    v.net_mode = setting('default_net_mode') === 'bridge' ? 'bridge' : 'user';
    v.autostart = 0;
  }
  v.bridge = v.net_mode === 'bridge' ? (String(body.bridge || '').trim() || setting('default_bridge')) : null;
  v.ip = v.prefix = v.gateway = v.dns = v.vlan = null;
  if (admin && v.net_mode === 'bridge') {
    if (v.bridge && !/^[a-zA-Z0-9_.-]{1,15}$/.test(v.bridge)) errors.push('Bridge name is not valid.');
    const ip = String(body.ip || '').trim();
    if (ip) {
      v.ip = ip; v.prefix = num(body.prefix) || 24;
      v.gateway = String(body.gateway || '').trim() || null;
      v.dns = String(body.dns || '').trim() || setting('default_dns');
      if (!isIPv4(v.ip)) errors.push('IPv4 address is not valid.');
      if (!isPrefix(v.prefix)) errors.push('Prefix length must be between 1 and 32.');
      if (v.gateway && !isIPv4(v.gateway)) errors.push('Gateway is not a valid IPv4 address.');
      if (v.dns.split(',').map((s) => s.trim()).some((d) => !isIPv4(d))) errors.push('DNS servers must be comma-separated IPv4 addresses.');
      const clash = db.prepare('SELECT name FROM vms WHERE ip = ? AND id IS NOT ?').get(v.ip, vmId);
      if (clash) errors.push(`${v.ip} is already assigned to "${clash.name}".`);
    }
    if (body.vlan) {
      v.vlan = num(body.vlan);
      if (!Number.isInteger(v.vlan) || v.vlan < 1 || v.vlan > 4094) errors.push('VLAN ID must be between 1 and 4094.');
    }
  }
  return { errors, v };
}

function quotaError(user, ownerId) {
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId);
  const count = db.prepare('SELECT COUNT(*) c FROM vms WHERE owner_id = ?').get(ownerId).c;
  if (owner && count >= owner.max_vms) return `${owner.id === user.id ? 'You have' : owner.username + ' has'} reached the limit of ${owner.max_vms} VMs.`;
  return null;
}

// Inserts the VM row (ports allocated in the same tick so they cannot collide) and returns it.
function insertVm(v) {
  const info = db.prepare(`INSERT INTO vms (uuid, name, owner_id, template_id, node_id, cpu, ram_mb, disk_gb, net_mode, bridge, mac, ip, prefix,
      gateway, dns, vlan, ssh_port, vnc_port, guest_user, ssh_key, autostart)
    VALUES (@uuid,@name,@owner_id,@template_id,@node_id,@cpu,@ram_mb,@disk_gb,@net_mode,@bridge,@mac,@ip,@prefix,@gateway,@dns,@vlan,@ssh_port,@vnc_port,@guest_user,@ssh_key,@autostart)`)
    .run({
      uuid: newUuid(), name: v.name, owner_id: v.owner_id, template_id: v.template_id, node_id: v.node_id, cpu: v.cpu, ram_mb: v.ram_mb,
      disk_gb: v.disk_gb, net_mode: v.net_mode, bridge: v.bridge, mac: randomMac(), ip: v.ip, prefix: v.prefix,
      gateway: v.gateway, dns: v.dns, vlan: v.vlan, ssh_port: null,
      vnc_port: 0, /* legacy column, unused: no host ports are opened */ guest_user: v.guest_user, ssh_key: v.ssh_key || null,
      autostart: v.autostart,
    });
  return getVm(info.lastInsertRowid);
}

module.exports = { getVm, listVms, canAccess, parseVmForm, quotaError, insertVm, decorate, audit };
