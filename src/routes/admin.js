'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, allSettings, saveSettings, audit } = require('../db');
const nodes = require('../services/nodes');
const { PANEL_USER_RE, SSHX_SERVER_RE, isIPv4, randomToken, sha256 } = require('../util');
const router = express.Router();

// ---- users ---------------------------------------------------------------------------------
const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND disabled = 0").get().c;

router.get('/users', (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM vms WHERE owner_id = u.id) AS vm_count FROM users u ORDER BY u.id`).all();
  res.render('admin/users', { title: 'Users', users });
});
router.get('/users/new', (req, res) => res.render('admin/user-form', { title: 'Create user', u: { role: 'user', max_vms: 3 }, isNew: true, error: null }));

router.post('/users', async (req, res) => {
  const { username = '', email = '', password = '', role = 'user', max_vms = 3 } = req.body;
  const back = (error) => res.status(422).render('admin/user-form', { title: 'Create user', u: { username, email, role, max_vms }, isNew: true, error });
  if (!PANEL_USER_RE.test(username)) return back('Usernames are 3 to 32 characters: letters, numbers, dot, dash or underscore.');
  if (password.length < 8) return back('Use a password of at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return back('That username is taken.');
  db.prepare('INSERT INTO users (username, email, password_hash, role, max_vms) VALUES (?,?,?,?,?)')
    .run(username, email.trim() || null, await bcrypt.hash(password, 12), role === 'admin' ? 'admin' : 'user', Math.max(0, parseInt(max_vms, 10) || 0));
  audit(req.user.id, 'user.create', username);
  req.flash('ok', `${username} was created.`);
  res.redirect('/admin/users');
});

router.param('uid', (req, res, next, id) => {
  req.target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!req.target) return res.status(404).render('error', { title: 'User not found', message: 'That user does not exist.' });
  next();
});
router.get('/users/:uid/edit', (req, res) => res.render('admin/user-form', { title: `Edit ${req.target.username}`, u: req.target, isNew: false, error: null }));

router.post('/users/:uid/edit', async (req, res) => {
  const t = req.target;
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const disabled = req.body.disabled ? 1 : 0;
  const lastAdmin = t.role === 'admin' && !t.disabled && adminCount() <= 1;
  if (lastAdmin && (role !== 'admin' || disabled)) {
    req.flash('err', 'This is the only active administrator. Create another admin first.');
    return res.redirect(`/admin/users/${t.id}/edit`);
  }
  if (t.id === req.user.id && disabled) { req.flash('err', 'You cannot disable your own account.'); return res.redirect(`/admin/users/${t.id}/edit`); }
  db.prepare('UPDATE users SET email = ?, role = ?, max_vms = ?, disabled = ? WHERE id = ?')
    .run(String(req.body.email || '').trim() || null, role, Math.max(0, parseInt(req.body.max_vms, 10) || 0), disabled, t.id);
  if (req.body.password) {
    if (req.body.password.length < 8) { req.flash('err', 'Saved, but the new password was too short (minimum 8).'); return res.redirect('/admin/users'); }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await bcrypt.hash(req.body.password, 12), t.id);
  }
  audit(req.user.id, 'user.edit', t.username);
  req.flash('ok', `${t.username} was updated.`);
  res.redirect('/admin/users');
});

router.post('/users/:uid/delete', async (req, res) => {
  const t = req.target;
  if (t.id === req.user.id) { req.flash('err', 'You cannot delete your own account.'); return res.redirect('/admin/users'); }
  if (t.role === 'admin' && !t.disabled && adminCount() <= 1) { req.flash('err', 'You cannot delete the only administrator.'); return res.redirect('/admin/users'); }
  for (const vm of db.prepare('SELECT * FROM vms WHERE owner_id = ?').all(t.id)) {
    await nodes.exec(vm.node_id).destroy(vm).catch(() => {});
    nodes.touch(vm.node_id);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(t.id);
  audit(req.user.id, 'user.delete', t.username);
  req.flash('ok', `${t.username} and their VMs were deleted.`);
  res.redirect('/admin/users');
});

// ---- OS templates ----------------------------------------------------------------------------
const tplUsage = () => Object.fromEntries(db.prepare('SELECT template_id, COUNT(*) c FROM vms GROUP BY template_id').all().map((r) => [r.template_id, r.c]));
const allNodes = () => db.prepare('SELECT * FROM nodes ORDER BY id').all().map((n) => ({ ...n, online: nodes.isOnline(n.id) }));

router.get('/templates', async (req, res) => {
  const nodeRows = allNodes();
  const invs = {};
  for (const n of nodeRows) invs[n.id] = n.online ? await nodes.inventory(n.id) : null;
  res.render('admin/templates', { title: 'OS templates', templates: db.prepare('SELECT * FROM templates ORDER BY name').all(), usage: tplUsage(), nodes: nodeRows, invs });
});
router.get('/templates/new', (req, res) => res.render('admin/template-form', { title: 'Add OS template', t: { family: 'linux', enabled: 1 }, isNew: true, error: null }));

function parseTemplate(body) {
  const t = {
    name: String(body.name || '').trim(), family: String(body.family || 'linux').trim(), url: String(body.url || '').trim(),
    filename: String(body.filename || '').trim(), enabled: body.enabled ? 1 : 0,
  };
  let error = null;
  if (!t.name) error = 'Give the template a name.';
  else if (!/^https?:\/\/.+/.test(t.url)) error = 'The image URL must start with http:// or https://.';
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(qcow2|img)$/.test(t.filename)) error = 'File name must be simple and end in .qcow2 or .img.';
  return { t, error };
}
router.post('/templates', (req, res) => {
  const { t, error } = parseTemplate(req.body);
  if (!error && db.prepare('SELECT 1 FROM templates WHERE filename = ?').get(t.filename)) return res.status(422).render('admin/template-form', { title: 'Add OS template', t, isNew: true, error: 'That file name is already used by another template.' });
  if (error) return res.status(422).render('admin/template-form', { title: 'Add OS template', t, isNew: true, error });
  db.prepare('INSERT INTO templates (name, family, url, filename, enabled) VALUES (?,?,?,?,?)').run(t.name, t.family, t.url, t.filename, t.enabled);
  req.flash('ok', 'Template added. Download the image to a node to make it available.');
  res.redirect('/admin/templates');
});

router.param('tid', (req, res, next, id) => {
  req.tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  if (!req.tpl) return res.status(404).render('error', { title: 'Template not found', message: 'That template does not exist.' });
  next();
});
router.get('/templates/:tid/edit', (req, res) => res.render('admin/template-form', { title: `Edit ${req.tpl.name}`, t: req.tpl, isNew: false, error: null }));
router.post('/templates/:tid/edit', (req, res) => {
  const { t, error } = parseTemplate({ ...req.body, filename: req.tpl.filename });
  if (error) return res.status(422).render('admin/template-form', { title: `Edit ${req.tpl.name}`, t: { ...t, id: req.tpl.id }, isNew: false, error });
  db.prepare('UPDATE templates SET name = ?, family = ?, url = ?, enabled = ? WHERE id = ?').run(t.name, t.family, t.url, t.enabled, req.tpl.id);
  req.flash('ok', 'Template saved.');
  res.redirect('/admin/templates');
});

// Download an image to one node, or to every online node that does not have it yet.
router.post('/templates/:tid/download', async (req, res) => {
  const target = String(req.body.node_id || 'all');
  const rows = allNodes().filter((n) => target === 'all' || String(n.id) === target);
  if (!rows.length) { req.flash('err', 'That node does not exist.'); return res.redirect('/admin/templates'); }
  const started = [];
  const problems = [];
  for (const n of rows) {
    if (!n.online) { problems.push(`${n.name} is offline`); continue; }
    try {
      if (target === 'all' && (await nodes.inventory(n.id))?.templates[req.tpl.filename]) continue;
      await nodes.exec(n.id).downloadTemplate({ filename: req.tpl.filename, url: req.tpl.url });
      started.push(n.name);
    } catch (e) { problems.push(`${n.name}: ${e.message}`); }
  }
  if (started.length) req.flash('ok', `Downloading ${req.tpl.name} to ${started.join(', ')}. This can take a few minutes.`);
  if (problems.length) req.flash('err', problems.join('. ') + '.');
  if (!started.length && !problems.length) req.flash('ok', `${req.tpl.name} is already on every online node.`);
  res.redirect('/admin/templates');
});

// Progress of every template download on every online node.
router.get('/templates/progress', async (req, res) => {
  const out = {};
  for (const n of allNodes()) {
    if (!n.online) continue;
    const inv = await nodes.inventory(n.id);
    out[n.id] = { jobs: Object.fromEntries(Object.entries(inv?.jobs || {}).filter(([k]) => k.startsWith('tpl:'))), ready: Object.keys(inv?.templates || {}) };
  }
  res.json(out);
});

router.post('/templates/:tid/delete', async (req, res) => {
  if (tplUsage()[req.tpl.id]) { req.flash('err', 'VMs still use this template. Reinstall or delete them first.'); return res.redirect('/admin/templates'); }
  const offline = [];
  for (const n of allNodes()) {
    if (!n.online) { offline.push(n.name); continue; }
    await nodes.exec(n.id).deleteTemplate(req.tpl.filename).catch(() => {});
  }
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.tpl.id);
  req.flash('ok', `${req.tpl.name} was removed.${offline.length ? ` Its image file may remain on offline nodes: ${offline.join(', ')}.` : ''}`);
  res.redirect('/admin/templates');
});

// ---- ISO library (one per node) --------------------------------------------------------------
const isoNode = (req) => {
  const id = Number(req.query.node || req.body?.node_id) || nodes.LOCAL_ID;
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) || db.prepare('SELECT * FROM nodes WHERE id = 1').get();
};
const isoBack = (n) => `/admin/isos?node=${n.id}`;

router.get('/isos', async (req, res) => {
  const node = isoNode(req);
  const online = nodes.isOnline(node.id);
  const inv = online ? await nodes.inventory(node.id) : null;
  const used = Object.fromEntries(db.prepare('SELECT iso, COUNT(*) c FROM vms WHERE iso IS NOT NULL AND node_id = ? GROUP BY iso').all(node.id).map((r) => [r.iso, r.c]));
  res.render('admin/isos', { title: 'ISO library', node, nodes: allNodes(), online, isos: inv?.isos || [], used });
});
router.post('/isos/download', async (req, res) => {
  const node = isoNode(req);
  try { const name = await nodes.exec(node.id).downloadIso(String(req.body.url || '').trim()); req.flash('ok', `Downloading ${name} to ${node.name}.`); }
  catch (e) { req.flash('err', e.message); }
  res.redirect(isoBack(node));
});
router.get('/isos/progress', async (req, res) => {
  const node = isoNode(req);
  const inv = nodes.isOnline(node.id) ? await nodes.inventory(node.id) : null;
  const out = {};
  for (const [k, j] of Object.entries(inv?.jobs || {})) if (k.startsWith('iso:')) out[k.slice(4)] = j;
  res.json(out);
});
router.post('/isos/delete', async (req, res) => {
  const node = isoNode(req);
  try {
    const name = String(req.body.name || '');
    if (db.prepare('SELECT 1 FROM vms WHERE iso = ? AND node_id = ?').get(name, node.id)) throw new Error('A VM still has this ISO attached. Detach it first.');
    await nodes.exec(node.id).deleteIso(name);
    req.flash('ok', `${name} was deleted from ${node.name}.`);
  } catch (e) { req.flash('err', e.message); }
  res.redirect(isoBack(node));
});

// ---- locations -------------------------------------------------------------------------------
const LOC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
router.get('/locations', (req, res) => {
  const rows = db.prepare('SELECT l.*, (SELECT COUNT(*) FROM nodes n WHERE n.location_id = l.id) AS node_count FROM locations l ORDER BY l.id').all();
  res.render('admin/locations', { title: 'Locations', locations: rows });
});
router.post('/locations', (req, res) => {
  const short = String(req.body.short || '').trim();
  if (!LOC_RE.test(short)) req.flash('err', 'A location code is 1 to 30 characters: letters, numbers, dot, dash or underscore (for example fra or us-east).');
  else if (db.prepare('SELECT 1 FROM locations WHERE short = ?').get(short)) req.flash('err', `A location named "${short}" already exists.`);
  else {
    db.prepare('INSERT INTO locations (short, long) VALUES (?, ?)').run(short, String(req.body.long || '').trim().slice(0, 100) || null);
    audit(req.user.id, 'location.create', short);
    req.flash('ok', `Location ${short} was added.`);
  }
  res.redirect('/admin/locations');
});
router.post('/locations/:lid/edit', (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.lid);
  const short = String(req.body.short || '').trim();
  if (!l) req.flash('err', 'That location does not exist.');
  else if (!LOC_RE.test(short)) req.flash('err', 'A location code is 1 to 30 characters: letters, numbers, dot, dash or underscore.');
  else if (db.prepare('SELECT 1 FROM locations WHERE short = ? AND id != ?').get(short, l.id)) req.flash('err', `A location named "${short}" already exists.`);
  else {
    db.prepare('UPDATE locations SET short = ?, long = ? WHERE id = ?').run(short, String(req.body.long || '').trim().slice(0, 100) || null, l.id);
    req.flash('ok', 'Location saved.');
  }
  res.redirect('/admin/locations');
});
router.post('/locations/:lid/delete', (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.lid);
  if (!l) req.flash('err', 'That location does not exist.');
  else if (db.prepare('SELECT COUNT(*) c FROM locations').get().c <= 1) req.flash('err', 'You need at least one location.');
  else if (db.prepare('SELECT 1 FROM nodes WHERE location_id = ?').get(l.id)) req.flash('err', `Nodes are still assigned to ${l.short}. Move them first.`);
  else { db.prepare('DELETE FROM locations WHERE id = ?').run(l.id); req.flash('ok', `Location ${l.short} was removed.`); }
  res.redirect('/admin/locations');
});

// ---- nodes -----------------------------------------------------------------------------------
const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,39}$/;
const TABS = ['about', 'settings', 'configuration', 'servers'];
const panelUrl = (req) => `${req.protocol}://${req.get('host')}`;
const gib = (b) => Math.round(b / 1073741824);

router.get('/nodes', async (req, res) => {
  const rows = [];
  for (const n of db.prepare('SELECT n.*, l.short AS location FROM nodes n JOIN locations l ON l.id = n.location_id ORDER BY n.id').all()) {
    const i = await nodes.info(n.id);
    rows.push({ ...n, online: i.online, stats: i.stats, meta: i.meta, cap: await nodes.capacity(n.id) });
  }
  res.render('admin/nodes', { title: 'Nodes', nodes: rows });
});

// Reads and validates the node settings form. Missing fields keep their current value, so
// older forms (and API-style posts) that only send a few fields still work.
function readNodeForm(body, cur = {}) {
  const num = (v, dflt, lo, hi) => { if (v === undefined || v === '') return dflt; const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN; };
  const n = {
    name: body.name === undefined ? cur.name : String(body.name).trim(),
    description: body.description === undefined ? cur.description : String(body.description).trim().slice(0, 200),
    location_id: num(body.location_id, cur.location_id || 1, 1, 1e9),
    memory_mb: num(body.memory_mb, cur.memory_mb || 0, 0, 1e9),
    memory_over: num(body.memory_over, cur.memory_over || 0, -1, 1000),
    disk_gb: num(body.disk_gb, cur.disk_gb || 0, 0, 1e9),
    disk_over: num(body.disk_over, cur.disk_over || 0, -1, 1000),
    allow_users: body._form === 'node' ? (body.allow_users ? 1 : 0) : (body.allow_users !== undefined ? 1 : (cur.allow_users ?? 1)),
    enabled: body._form === 'node' && cur.id ? (body.enabled ? 1 : 0) : (body.enabled !== undefined ? 1 : (cur.enabled ?? 1)),
  };
  let error = null;
  if (!NODE_NAME_RE.test(n.name || '')) error = 'Node names are 2 to 40 characters: letters, numbers, spaces, dot, dash or underscore.';
  else if ([n.location_id, n.memory_mb, n.memory_over, n.disk_gb, n.disk_over].some(Number.isNaN)) error = 'Memory and disk need whole numbers. Over-allocation is a percentage from 0 to 1000, or -1 for unlimited.';
  else if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(n.location_id)) error = 'Choose a valid location.';
  else if (db.prepare('SELECT 1 FROM nodes WHERE name = ? AND id != ?').get(n.name, cur.id || 0)) error = 'Another node already has that name.';
  return { n, error };
}
const locations = () => db.prepare('SELECT * FROM locations ORDER BY short').all();

router.get('/nodes/new', (req, res) => res.render('admin/node-form', {
  title: 'Add node', n: { allow_users: 1, memory_over: 0, disk_over: 0, memory_mb: 0, disk_gb: 0, location_id: 1 }, locations: locations(), error: null,
}));

// Creating a node also issues its first deploy command, so the next screen is the setup screen.
router.post('/nodes', (req, res) => {
  const { n, error } = readNodeForm({ ...req.body, _form: 'node' });
  if (error) return res.status(422).render('admin/node-form', { title: 'Add node', n, locations: locations(), error });
  const info = db.prepare('INSERT INTO nodes (name, description, allow_users, enabled, location_id, memory_mb, memory_over, disk_gb, disk_over, uuid) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(n.name, n.description || null, n.allow_users, 1, n.location_id, n.memory_mb, n.memory_over, n.disk_gb, n.disk_over, require('crypto').randomUUID());
  audit(req.user.id, 'node.create', n.name);
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(info.lastInsertRowid);
  renderNode(req, res, node, 'configuration', { reveal: newDeploy(req, node), justCreated: true });
});

router.param('nid', (req, res, next, id) => {
  req.node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!req.node) return res.status(404).render('error', { title: 'Node not found', message: 'That node does not exist.' });
  next();
});

// Deploy codes: 15 minutes, one use. Only a hash is stored.
function newDeploy(req, node) {
  const code = require('crypto').randomBytes(16).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;
  db.prepare('UPDATE nodes SET deploy_hash = ?, deploy_expires = ? WHERE id = ?').run(sha256(code), expires, node.id);
  return { kind: 'deploy', url: `${panelUrl(req)}/node-deploy/${code}`, expires };
}

async function renderNode(req, res, node, tab, extra = {}) {
  const fresh = db.prepare('SELECT n.*, l.short AS location, l.long AS location_long FROM nodes n JOIN locations l ON l.id = n.location_id WHERE n.id = ?').get(node.id);
  const i = await nodes.info(node.id);
  const cap = await nodes.capacity(node.id);
  const vms = db.prepare('SELECT v.*, u.username AS owner_name, t.name AS template_name FROM vms v JOIN users u ON u.id = v.owner_id LEFT JOIN templates t ON t.id = v.template_id WHERE v.node_id = ? ORDER BY v.id').all(node.id)
    .map((v) => ({ ...v, status: nodes.status(v) }));
  res.status(extra.error ? 422 : 200).render('admin/node', {
    title: fresh.name, node: fresh, tab, tabs: TABS, info: i, cap, vms, locations: locations(), panel: panelUrl(req),
    reveal: null, error: null, justCreated: false, form: fresh, ...extra,
  });
}

router.get('/nodes/:nid', (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'about';
  return renderNode(req, res, req.node, tab);
});
router.get('/nodes/:nid/edit', (req, res) => res.redirect(`/admin/nodes/${req.node.id}?tab=settings`));

router.post('/nodes/:nid/edit', (req, res) => {
  const cur = req.node;
  const { n, error } = readNodeForm(req.body, cur);
  if (error) return renderNode(req, res, cur, 'settings', { error, form: { ...cur, ...n } });
  db.prepare('UPDATE nodes SET name = ?, description = ?, location_id = ?, memory_mb = ?, memory_over = ?, disk_gb = ?, disk_over = ?, allow_users = ?, enabled = ? WHERE id = ?')
    .run(n.name, n.description || null, n.location_id, n.memory_mb, n.memory_over, n.disk_gb, n.disk_over, n.allow_users, n.enabled, cur.id);
  audit(req.user.id, 'node.edit', n.name);
  req.flash('ok', `${n.name} was updated.`);
  res.redirect(`/admin/nodes/${cur.id}?tab=settings`);
});

router.post('/nodes/:nid/deploy', (req, res) => {
  if (req.node.id === nodes.LOCAL_ID) { req.flash('err', 'The Local node is the panel host and needs no setup.'); return res.redirect('/admin/nodes'); }
  audit(req.user.id, 'node.deploy-code', req.node.name);
  renderNode(req, res, req.node, 'configuration', { reveal: newDeploy(req, req.node) });
});

// Manual setup: issues a new token and shows the config.yml to place on the node.
router.post('/nodes/:nid/token', (req, res) => {
  const n = req.node;
  if (n.id === nodes.LOCAL_ID) { req.flash('err', 'The Local node has no token.'); return res.redirect('/admin/nodes'); }
  const token = `knode_${randomToken(24)}`;
  db.prepare('UPDATE nodes SET token_hash = ?, deploy_hash = NULL, deploy_expires = NULL WHERE id = ?').run(sha256(token), n.id);
  nodes.disconnect(n.id);
  audit(req.user.id, 'node.token', n.name);
  const url = panelUrl(req);
  const config = `# Diablo node configuration for ${JSON.stringify(n.name)}\n# Save as /etc/diablo-node/config.yml (readable by root only)\nuuid: ${n.uuid}\npanel_url: ${url}\ntoken: ${token}\ndata_dir: /var/lib/kvmpanel-node\n`;
  renderNode(req, res, n, 'configuration', { reveal: { kind: 'manual', url, token, config } });
});

router.post('/nodes/:nid/delete', (req, res) => {
  const n = req.node;
  if (n.id === nodes.LOCAL_ID) req.flash('err', 'The Local node cannot be removed. Disable it instead.');
  else if (db.prepare('SELECT 1 FROM vms WHERE node_id = ?').get(n.id)) req.flash('err', `${n.name} still hosts VMs. Delete them first.`);
  else {
    nodes.disconnect(n.id);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(n.id);
    audit(req.user.id, 'node.delete', n.name);
    req.flash('ok', `${n.name} was removed. On that server, stop the agent with: systemctl disable --now kvmpanel-node`);
  }
  res.redirect('/admin/nodes');
});

// ---- settings ------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { isBrandingFile } = require('../upload');

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings', s: allSettings() }));

router.post('/settings', (req, res) => {
  const b = req.body;
  const int = (x, lo, hi, dflt) => { const n = parseInt(x, 10); return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt; };
  const cur = allSettings();
  const dns = String(b.default_dns || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (dns.some((d) => !isIPv4(d))) { req.flash('err', 'Default DNS must be comma-separated IPv4 addresses.'); return res.redirect('/admin/settings'); }
  const pfIp = String(b.port_forward_host_ip || '').trim();
  if (pfIp && !isIPv4(pfIp)) { req.flash('err', 'The port-forward host IP must be a valid IPv4 address.'); return res.redirect('/admin/settings'); }
  const sshxServer = String(b.sshx_server || '').trim().replace(/\/+$/, '');
  if (sshxServer && !SSHX_SERVER_RE.test(sshxServer)) { req.flash('err', 'The SSHX server must look like https://sshx.example.com (no path).'); return res.redirect('/admin/settings'); }

  // Background and logo: a URL, an uploaded file, or blank for none.
  const pickImage = (urlField, fileField, clearField, current) => {
    let val = String(b[urlField] || '').trim().slice(0, 500);
    if (!/^(https?:\/\/|\/branding\/)/.test(val)) val = '';
    const f = (req.files || []).find((x) => x.fieldname === fileField);
    if (f) {
      val = `/branding/${f.filename}`;
      if (current.startsWith('/branding/') && isBrandingFile(path.basename(current))) fs.rm(path.join(config.brandingDir, path.basename(current)), () => {});
    }
    if (b[clearField]) {
      if (current.startsWith('/branding/') && isBrandingFile(path.basename(current))) fs.rm(path.join(config.brandingDir, path.basename(current)), () => {});
      val = '';
    }
    return val;
  };
  const background = pickImage('background_image', 'background_file', 'background_clear', cur.background_image || '');
  const logo = pickImage('logo_image', 'logo_file', 'logo_clear', cur.logo_image || '');

  const discordRedirect = String(b.discord_redirect_uri || '').trim().slice(0, 300);

  saveSettings({
    panel_name: String(b.panel_name || '').trim().slice(0, 40) || cur.panel_name,
    credit_text: String(b.credit_text || '').trim().slice(0, 80),
    credit_url: /^https?:\/\/.+/.test(String(b.credit_url || '').trim()) ? String(b.credit_url).trim().slice(0, 300) : '',
    default_net_mode: b.default_net_mode === 'bridge' ? 'bridge' : 'user',
    default_bridge: /^[a-zA-Z0-9_.-]{1,15}$/.test(b.default_bridge || '') ? b.default_bridge : cur.default_bridge,
    default_dns: dns.join(',') || cur.default_dns,
    user_max_cpu: int(b.user_max_cpu, 1, 128, cur.user_max_cpu),
    user_max_ram_mb: int(b.user_max_ram_mb, 256, 1048576, cur.user_max_ram_mb),
    user_max_disk_gb: int(b.user_max_disk_gb, 5, 8192, cur.user_max_disk_gb),
    allow_registration: b.allow_registration ? '1' : '0',
    allow_discord_signup: b.allow_discord_signup ? '1' : '0',
    background_enabled: b.background_enabled ? '1' : '0',
    background_image: background,
    logo_image: logo,
    background_dim: int(b.background_dim, 0, 90, cur.background_dim),
    background_blur: int(b.background_blur, 0, 30, cur.background_blur),
    background_fixed: b.background_fixed ? '1' : '0',
    ui_animations: b.ui_animations ? '1' : '0',
    button_shape: b.button_shape === 'pill' ? 'pill' : 'rounded',
    min_password_length: int(b.min_password_length, 3, 128, cur.min_password_length),
    port_forward_enabled: b.port_forward_enabled ? '1' : '0',
    port_forward_host_ip: pfIp,
    port_forward_auto: b.port_forward_auto ? '1' : '0',
    port_forward_auto_ports: String(b.port_forward_auto_ports || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535).join(',') || cur.port_forward_auto_ports,
    port_forward_auto_from: int(b.port_forward_auto_from, 1, 65535, cur.port_forward_auto_from),
    port_forward_auto_to: int(b.port_forward_auto_to, 1, 65535, cur.port_forward_auto_to),
    mining_guard_enabled: b.mining_guard_enabled ? '1' : '0',
    mining_cpu_threshold: int(b.mining_cpu_threshold, 10, 100, cur.mining_cpu_threshold),
    mining_suspend_minutes: int(b.mining_suspend_minutes, 1, 1440, cur.mining_suspend_minutes),
    mining_auto_suspend: b.mining_auto_suspend ? '1' : '0',
    sshx_enabled: b.sshx_enabled ? '1' : '0',
    sshx_server: sshxServer,
    discord_enabled: b.discord_enabled ? '1' : '0',
    discord_client_id: String(b.discord_client_id || '').trim().slice(0, 100),
    // Keep the existing secret when the field is left blank so it is never wiped by accident.
    discord_client_secret: String(b.discord_client_secret || '').trim().slice(0, 200) || cur.discord_client_secret,
    discord_redirect_uri: discordRedirect,
  });
  audit(req.user.id, 'settings.save', '');
  req.flash('ok', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
