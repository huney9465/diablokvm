'use strict';
// SSHX: every VM gets a browser terminal. The panel side lives here; the in-guest side is
// src/host/guest-sshx.sh and the cloud-init wiring is in src/host/cloudinit.js.
const { setting } = require('../db');
const nodes = require('./nodes');
const { SSHX_SERVER_RE, SSHX_DEFAULT_SERVER } = require('../util');

// Agents older than this cannot build the SSHX service into a VM or read its link.
const MIN_AGENT = [1, 1];

async function nodeSupports(nodeId) {
  if (nodeId === nodes.LOCAL_ID) return true;
  const { meta } = await nodes.info(nodeId);
  const [major, minor] = String(meta?.version || '0').split('.').map((n) => parseInt(n, 10) || 0);
  return major > MIN_AGENT[0] || (major === MIN_AGENT[0] && minor >= MIN_AGENT[1]);
}

// What to pass to provision(): SSHX on or off for this VM, and which sshx server it talks to.
async function provisionOpts(nodeId) {
  if (setting('sshx_enabled') !== '1' || !(await nodeSupports(nodeId))) return { enabled: false };
  const server = setting('sshx_server') || SSHX_DEFAULT_SERVER;
  return SSHX_SERVER_RE.test(server) ? { enabled: true, server } : { enabled: false };
}

// The link comes from inside the guest, so before sending a browser there it must be exactly an
// sshx session URL on the server this VM was built for. Nothing else is ever redirected to.
function isSafeLink(link, server) {
  let u;
  let base;
  try { u = new URL(link); base = new URL(server); } catch { return false; }
  return u.protocol === base.protocol && u.host === base.host && !u.username && !u.password
    && /^\/s\/[A-Za-z0-9_-]{1,64}$/.test(u.pathname) && !u.search && /^#[A-Za-z0-9_+=,-]{1,200}$/.test(u.hash);
}

module.exports = { provisionOpts, isSafeLink, nodeSupports };
