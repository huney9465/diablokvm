'use strict';
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { randomToken } = require('./util');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  discord_id TEXT UNIQUE,
  max_vms INTEGER NOT NULL DEFAULT 3,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'linux',
  url TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL DEFAULT 'qcow2',
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','downloading','ready')),
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS vms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES templates(id),
  cpu INTEGER NOT NULL,
  ram_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  net_mode TEXT NOT NULL DEFAULT 'user' CHECK (net_mode IN ('user','bridge')),
  bridge TEXT,
  mac TEXT NOT NULL,
  ip TEXT,
  prefix INTEGER,
  gateway TEXT,
  dns TEXT,
  vlan INTEGER,
  ssh_port INTEGER,
  vnc_port INTEGER NOT NULL,
  guest_user TEXT NOT NULL,
  ssh_key TEXT,
  iso TEXT,
  autostart INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  token_hash TEXT UNIQUE,
  allow_users INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short TEXT NOT NULL UNIQUE COLLATE NOCASE,
  long TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vm_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  kind TEXT NOT NULL DEFAULT 'ssh',
  command TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vm_commands_vm ON vm_commands (vm_id, id);
`);

const DEFAULT_SETTINGS = {
  panel_name: 'Diablo',
  default_net_mode: 'user',      // 'user' (NAT, no inbound ports) or 'bridge'
  default_bridge: 'br0',
  default_dns: '1.1.1.1,8.8.8.8',
  user_max_cpu: '4',
  user_max_ram_mb: '8192',
  user_max_disk_gb: '100',
  allow_registration: '0',
  allow_discord_signup: '0',

  // Branding / credit
  credit_text: 'created by - lord_diablo_009 , Devabyss',
  credit_url: '',              // optional link for the credit line
  logo_image: '',              // panel logo: a URL or /branding/<file> (replaces the old green dot)

  // Background (image or GIF), applied to the whole panel
  background_enabled: '0',
  background_image: '',        // a URL or /branding/<file> for an uploaded image/GIF
  background_dim: '45',        // 0-90: how much the dark overlay hides the picture
  background_blur: '0',        // 0-30 px
  background_fixed: '1',       // keep the picture fixed while scrolling

  // Look and feel
  ui_animations: '1',          // button textures, ripples, reveal animations
  button_shape: 'rounded',     // 'rounded' (curved) or 'pill'

  // Guest login password length. Admins may always use as few as 3 characters.
  min_password_length: '8',

  // Port forwarding: the public IP users should connect to (shown in connect commands)
  port_forward_host_ip: '',
  port_forward_enabled: '1',
  // Auto port forwarding: give every new NAT VM a set of forwards automatically.
  port_forward_auto: '0',
  port_forward_auto_ports: '22,80,443',
  port_forward_auto_from: '20000',
  port_forward_auto_to: '30000',

  // Mining guard: watch each VM's CPU use and suspend VMs that look like they are mining.
  mining_guard_enabled: '1',
  mining_cpu_threshold: '85',
  mining_suspend_minutes: '5',
  mining_auto_suspend: '0',

  // SSHX: give every new VM a browser terminal (a link that opens in a new tab).
  sshx_enabled: '1',           // put an SSHX browser terminal in every new or reinstalled VM
  sshx_server: '',             // empty = the public https://sshx.io

  // Discord sign-in (can also be set with environment variables)
  discord_enabled: '0',
  discord_client_id: '',
  discord_client_secret: '',
  discord_redirect_uri: '',
};

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function setting(key) {
  const row = getSetting.get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function saveSettings(obj) {
  const tx = db.transaction((o) => { for (const [k, v] of Object.entries(o)) if (k in DEFAULT_SETTINGS) putSetting.run(k, String(v)); });
  tx(obj);
}

// Default cloud images. Vendors rotate file names, so admins can edit these URLs in the panel.
const DEFAULT_TEMPLATES = [
  ['Ubuntu 24.04 LTS', 'ubuntu', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', 'ubuntu-24.04.qcow2'],
  ['Ubuntu 22.04 LTS', 'ubuntu', 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', 'ubuntu-22.04.qcow2'],
  ['Debian 12', 'debian', 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2', 'debian-12.qcow2'],
  ['AlmaLinux 9', 'rhel', 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', 'almalinux-9.qcow2'],
  ['CentOS Stream 9', 'rhel', 'https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2', 'centos-stream-9.qcow2'],
  ['Fedora Cloud (check URL)', 'rhel', 'https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2', 'fedora-42.qcow2'],
];

// Upgrade older databases: VMs belong to a node (1 = the built-in Local node).
// No REFERENCES clause: SQLite cannot add one to an existing table with a non-null default.
if (!db.prepare('PRAGMA table_info(vms)').all().some((c) => c.name === 'node_id')) {
  db.exec('ALTER TABLE vms ADD COLUMN node_id INTEGER NOT NULL DEFAULT 1');
}
db.prepare("INSERT OR IGNORE INTO nodes (id, name, description) VALUES (1, 'Local', 'The server running the panel')").run();

// Node settings modelled on Pterodactyl: location, memory/disk limits with over-allocation
// (0 = none, -1 = unlimited, N = percent), and a deploy code for one-line setup.
// A limit of 0 means "use what the node reports".
function addColumn(table, name, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
addColumn('nodes', 'location_id', 'INTEGER NOT NULL DEFAULT 1');
addColumn('nodes', 'memory_mb', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nodes', 'memory_over', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nodes', 'disk_gb', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nodes', 'disk_over', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nodes', 'uuid', 'TEXT');
addColumn('nodes', 'deploy_hash', 'TEXT');
addColumn('nodes', 'deploy_expires', 'INTEGER');
// Force a password change on the next sign-in (used for the default admin/admin account).
addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
// Port forwards for NAT VMs, stored as a JSON array so they travel with the VM row to every node.
// Example: [{"id":"ab12","host_ip":"203.0.113.5","host_port":2222,"vm_port":22,"proto":"tcp","label":"SSH"}]
addColumn('vms', 'port_forwards', 'TEXT');
// A user's own logo and banner (shown on their profile / dashboard). A URL or /branding/<file>.
addColumn('users', 'logo_image', 'TEXT');
addColumn('users', 'banner_image', 'TEXT');
// Mining guard state. mining_suspect is set while a VM's CPU use looks like crypto mining;
// suspended is 1 while the VM is paused (by the guard or by an admin/user).
addColumn('vms', 'mining_suspect', 'INTEGER NOT NULL DEFAULT 0');
addColumn('vms', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
// The sshx server a VM was built to use. NULL = this VM has no SSHX (created before it existed, or it was off).
addColumn('vms', 'sshx_server', 'TEXT');
// The last SSHX link a VM reported. Persisted so the SSHX button keeps working even after the
// serial log scrolls, and stays valid until the owner cancels the session.
addColumn('vms', 'sshx_link', 'TEXT');
addColumn('vms', 'sshx_created_at', 'TEXT');
// Set to 1 when the owner cancels their SSHX session, so the panel stops offering it until they
// start a fresh one. Reset to 0 on create/reinstall or when they press "Start SSHX" again.
addColumn('vms', 'sshx_cancelled', 'INTEGER NOT NULL DEFAULT 0');
// One-time: move the old default credit line to the new one (only if it was never customised).
db.prepare("UPDATE settings SET value = ? WHERE key = 'credit_text' AND value = 'Created by DiabloKVM'")
  .run(DEFAULT_SETTINGS.credit_text);
db.prepare("INSERT OR IGNORE INTO locations (id, short, long) VALUES (1, 'default', 'Default location')").run();
for (const n of db.prepare('SELECT id FROM nodes WHERE uuid IS NULL').all()) {
  db.prepare('UPDATE nodes SET uuid = ? WHERE id = ?').run(require('crypto').randomUUID(), n.id);
}

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM templates').get().c === 0) {
    const ins = db.prepare('INSERT INTO templates (name, family, url, filename) VALUES (?,?,?,?)');
    for (const t of DEFAULT_TEMPLATES) ins.run(...t);
  }
  const noUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  // Also recover if every admin account got disabled or deleted (e.g. by hand, or by a bad
  // migration) — otherwise the panel is only ever seeded once (when the table was totally empty)
  // and a broken admin account has no way back in short of editing the database by hand.
  const noUsableAdmin = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND disabled = 0").get().c === 0;
  if (noUsers || noUsableAdmin) {
    // Out of the box the panel ships with admin / admin and forces a change on first sign-in.
    // Set ADMIN_PASSWORD in the environment to start with your own password instead.
    const usingDefault = !config.adminPassword;
    const pw = config.adminPassword || 'admin';
    const hash = bcrypt.hashSync(pw, 12);
    const email = config.adminEmail || null;
    const existing = noUsers ? null : db.prepare('SELECT * FROM users WHERE username = ?').get(config.adminUser);
    if (existing) {
      // A user with the admin username exists but is disabled, or not an admin: repair it in
      // place rather than failing the UNIQUE(username) constraint on a fresh insert. Only touch
      // the email if one was actually supplied, so a repair never wipes an email set by hand.
      db.prepare('UPDATE users SET password_hash = ?, role = ?, disabled = 0, must_change_password = ?, email = COALESCE(?, email) WHERE id = ?')
        .run(hash, 'admin', usingDefault ? 1 : 0, email, existing.id);
      console.log('\n  No usable admin account was found: reset the existing account instead');
    } else {
      db.prepare("INSERT INTO users (username, email, password_hash, role, max_vms, must_change_password) VALUES (?, ?, ?, 'admin', 1000, ?)")
        .run(config.adminUser, email, hash, usingDefault ? 1 : 0);
      console.log(noUsers ? '\n  First run: created admin account' : '\n  No usable admin account was found: created a new one');
    }
    console.log(`  username: ${config.adminUser}`);
    if (email) console.log(`  email: ${email}`);
    console.log(usingDefault
      ? `  password: ${pw}   (you will be asked to change it after signing in)\n`
      : '  password: taken from ADMIN_PASSWORD\n');
  }
}
seed();

function audit(userId, action, target) {
  db.prepare('INSERT INTO audit (user_id, action, target) VALUES (?,?,?)').run(userId || null, action, target || null);
}

// Discord sign-in: values saved in Settings win, environment variables are the fallback.
function discordConfig() {
  const s = allSettings();
  const clientId = s.discord_client_id || config.discord.clientId;
  const clientSecret = s.discord_client_secret || config.discord.clientSecret;
  const redirectUri = s.discord_redirect_uri || config.discord.redirectUri;
  const enabled = s.discord_enabled === '1' || (!s.discord_client_id && !!(config.discord.clientId && config.discord.clientSecret));
  return { clientId, clientSecret, redirectUri, enabled: enabled && !!(clientId && clientSecret && redirectUri) };
}

module.exports = { db, setting, allSettings, saveSettings, audit, discordConfig, DEFAULT_SETTINGS };
