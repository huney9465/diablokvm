'use strict';
// Mining guard. The panel samples the CPU time of every running VM's QEMU process on a timer.
// A VM that stays above the configured threshold for long enough is flagged as a mining suspect,
// and (optionally) suspended automatically. Owners and admins can resume it from the VM page.
const { db, setting } = require('../db');
const nodes = require('./nodes');

// Linux USER_HZ. The value only needs to be close for a heuristic, and 100 is right on every
// mainstream distribution.
const CLK_TCK = 100;
const INTERVAL_MS = 15000;

// Per-VM sampling state. In memory only: it is rebuilt within one interval after a restart.
// { lastTicks, lastAt, highSince, cpu }
const state = new Map();

function status(vmId) {
  const s = state.get(vmId);
  const row = db.prepare('SELECT mining_suspect, suspended FROM vms WHERE id = ?').get(vmId);
  return {
    cpu: s ? s.cpu : 0,
    suspect: !!(row && row.mining_suspect),
    suspended: !!(row && row.suspended),
  };
}

// Called when a VM is started/stopped/resumed so a stale flag clears immediately.
function clear(vmId) {
  const s = state.get(vmId);
  if (s) { s.highSince = null; s.cpu = 0; }
  db.prepare('UPDATE vms SET mining_suspect = 0 WHERE id = ?').run(vmId);
}

async function tick() {
  if (setting('mining_guard_enabled') !== '1') return;
  const threshold = parseInt(setting('mining_cpu_threshold'), 10) || 85;
  const suspendAfterMs = (parseInt(setting('mining_suspend_minutes'), 10) || 5) * 60000;
  const autoSuspend = setting('mining_auto_suspend') === '1';
  const now = Date.now();

  for (const vm of db.prepare('SELECT * FROM vms').all()) {
    let running = false;
    try { running = nodes.status(vm) === 'running'; } catch { running = false; }
    if (!running) { state.delete(vm.id); continue; }

    const st = state.get(vm.id) || { lastTicks: null, lastAt: 0, highSince: null, cpu: 0 };
    let ticks = null;
    try { ticks = await nodes.exec(vm.node_id).vmCpuTicks(vm); } catch { ticks = null; }
    if (ticks == null) { state.set(vm.id, st); continue; }

    if (st.lastTicks != null && now > st.lastAt) {
      const dt = (now - st.lastAt) / 1000;
      const dTicks = ticks - st.lastTicks;
      const cores = Math.max(1, vm.cpu || 1);
      const pct = Math.max(0, Math.min(100, (dTicks / (dt * CLK_TCK * cores)) * 100));
      st.cpu = Math.round(pct);
      if (pct >= threshold) {
        if (!st.highSince) st.highSince = now;
        if (now - st.highSince >= suspendAfterMs) {
          if (!vm.mining_suspect) db.prepare('UPDATE vms SET mining_suspect = 1 WHERE id = ?').run(vm.id);
          if (autoSuspend && !vm.suspended) {
            try {
              await nodes.exec(vm.node_id).suspend(vm);
              db.prepare('UPDATE vms SET suspended = 1, mining_suspect = 1 WHERE id = ?').run(vm.id);
              console.log(`mining guard: suspended VM ${vm.id} (${vm.name}) at ${st.cpu}% CPU`);
            } catch (e) { console.error(`mining guard: could not suspend VM ${vm.id}: ${e.message}`); }
          }
        }
      } else {
        st.highSince = null;
        if (vm.mining_suspect) db.prepare('UPDATE vms SET mining_suspect = 0 WHERE id = ?').run(vm.id);
      }
    }
    st.lastTicks = ticks;
    st.lastAt = now;
    state.set(vm.id, st);
  }
}

let timer = null;
function start() {
  if (timer) return;
  // The first pass only records a baseline; the next one computes CPU use.
  tick().catch((e) => console.error('mining guard:', e.message));
  timer = setInterval(() => tick().catch((e) => console.error('mining guard:', e.message)), INTERVAL_MS);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { status, clear, start, stop, tick };
