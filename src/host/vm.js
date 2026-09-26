'use strict';
// VM lifecycle on THIS machine: QEMU command line, QMP, disks, cloud-init seed.
// Pure host logic with no database, so the panel (for its local node) and the node agent share it.
const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('../config');
const { run, sleep, parseForwards, forwardArg } = require('../util');
const network = require('./network');
const cloudinit = require('./cloudinit');
const images = require('./images');

const HAS_KVM = fs.existsSync('/dev/kvm');

function assertVm(vm) {
  const bad = (m) => { throw new Error(`Invalid VM data: ${m}`); };
  if (!vm || !Number.isInteger(vm.id) || vm.id < 1) bad('id');
  if (!/^[0-9a-f-]{36}$/i.test(String(vm.uuid || ''))) bad('uuid');
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(vm.mac || ''))) bad('mac');
  if (!Number.isInteger(vm.cpu) || vm.cpu < 1 || !Number.isInteger(vm.ram_mb) || vm.ram_mb < 64) bad('resources');
  if (vm.iso && !images.ISO_RE.test(vm.iso)) bad('iso');
  if (vm.net_mode === 'bridge' && !/^[a-zA-Z0-9_.-]{1,15}$/.test(String(vm.bridge || ''))) bad('bridge');
}

function paths(vm) {
  if (!vm || !Number.isInteger(vm.id) || vm.id < 1) throw new Error('Invalid VM id');
  const dir = path.join(config.vmDir, String(vm.id));
  return {
    dir,
    disk: path.join(dir, 'disk.qcow2'),
    seed: path.join(dir, 'seed.iso'),
    pid: path.join(dir, 'qemu.pid'),
    qmp: path.join(dir, 'qmp.sock'),
    serial: path.join(dir, 'serial.log'),    // everything the guest prints on its serial port
    vnc: path.join(dir, 'vnc.sock'),         // graphical console (Unix socket, no TCP port)
    console: path.join(dir, 'console.sock'), // interactive serial console (Unix socket, no TCP port)
  };
}

// ---- process state ----
function readPid(vm) {
  try { return parseInt(fs.readFileSync(paths(vm).pid, 'utf8'), 10) || null; } catch { return null; }
}
function isRunning(vm) {
  const pid = readPid(vm);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    // Guard against PID reuse: the qemu command line must carry this VM's uuid.
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(vm.uuid);
  } catch { return false; }
}
const status = (vm) => (isRunning(vm) ? 'running' : 'stopped');

// ---- command line ----
function buildArgs(vm, { kvm = HAS_KVM } = {}) {
  const p = paths(vm);
  const args = [
    '-name', `guest=kvmp-${vm.id},process=kvmp-${vm.id}`,
    '-uuid', vm.uuid,
    '-machine', kvm ? 'q35,accel=kvm' : 'q35,accel=tcg',
    '-cpu', kvm ? 'host' : 'max',
    '-smp', String(vm.cpu),
    '-m', String(vm.ram_mb),
    '-rtc', 'base=utc',
    '-boot', vm.iso ? 'order=dc,menu=off' : 'order=c,menu=off',
    '-drive', `file=${p.disk},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
  ];
  if (fs.existsSync(p.seed)) args.push('-drive', `file=${p.seed},if=virtio,format=raw,readonly=on`);
  args.push('-drive', `if=none,id=cd0,media=cdrom,readonly=on${vm.iso ? `,file=${path.join(config.isoDir, vm.iso)}` : ''}`);
  args.push('-device', 'ide-cd,drive=cd0,id=cdrom0');

  if (vm.net_mode === 'bridge') {
    args.push('-netdev', `tap,id=net0,ifname=${network.tapName(vm)},script=no,downscript=no`);
  } else {
    // NAT: outbound internet only, plus any host port forwards the panel has configured.
    // hostfwd maps a public host address:port to a port inside the guest.
    const fwd = parseForwards(vm.port_forwards).map((f) => `,${forwardArg(f)}`).join('');
    args.push('-netdev', `user,id=net0${fwd}`);
  }
  args.push('-device', `virtio-net-pci,netdev=net0,mac=${vm.mac}`);
  args.push(
    '-device', 'virtio-balloon-pci',
    '-object', 'rng-random,id=rng0,filename=/dev/urandom', '-device', 'virtio-rng-pci,rng=rng0',
    '-vga', 'std',
    '-vnc', `unix:${p.vnc}`,
    '-chardev', `socket,id=ser0,path=${p.console},server=on,wait=off,logfile=${p.serial}`,
    '-serial', 'chardev:ser0',
    '-qmp', `unix:${p.qmp},server,nowait`,
    '-pidfile', p.pid,
    '-daemonize',
  );
  return args;
}

// ---- QMP ----
function qmp(vm, execute, args) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(paths(vm).qmp);
    let buf = '';
    let stage = 0;
    const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new Error('Timed out talking to QEMU')), 8000);
    sock.on('error', (e) => fail(new Error(`Cannot reach QEMU (${e.code || e.message}). Is the VM running?`)));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) return fail(new Error(msg.error.desc || 'QMP error'));
        if (msg.QMP && stage === 0) { stage = 1; sock.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n'); }
        else if ('return' in msg && stage === 1) { stage = 2; sock.write(JSON.stringify({ execute, arguments: args }) + '\n'); }
        else if ('return' in msg && stage === 2) { clearTimeout(timer); sock.end(); return resolve(msg.return); }
      }
    });
  });
}

// ---- lifecycle ----
async function start(vm) {
  assertVm(vm);
  if (isRunning(vm)) throw new Error('VM is already running');
  const p = paths(vm);
  if (!fs.existsSync(p.disk)) throw new Error('VM disk is missing. Reinstall the VM to rebuild it.');
  if (Buffer.byteLength(p.console) > 100) throw new Error('DATA_DIR is too deep: Unix socket paths are limited to about 100 characters. Use a shorter DATA_DIR.');
  for (const f of [p.qmp, p.pid, p.vnc, p.console]) fs.rmSync(f, { force: true });
  if (vm.net_mode === 'bridge') await network.setupTap(vm);
  try {
    await run(config.qemuBin, buildArgs(vm), { timeout: 30000 });
  } catch (e) {
    if (vm.net_mode === 'bridge') await network.teardownTap(vm);
    if (e.code === 'ENOENT') throw new Error(`${config.qemuBin} not found. Install QEMU (qemu-system-x86).`);
    throw e;
  }
}

async function cleanupAfterExit(vm, maxWaitMs = 180000) {
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until && isRunning(vm)) await sleep(2000);
  if (!isRunning(vm)) {
    if (vm.net_mode === 'bridge') await network.teardownTap(vm);
    const p = paths(vm);
    for (const f of [p.qmp, p.vnc, p.console]) fs.rmSync(f, { force: true });
  }
}

// ACPI power button: asks the guest OS to shut down cleanly.
async function stop(vm) {
  if (!isRunning(vm)) throw new Error('VM is not running');
  await qmp(vm, 'system_powerdown');
  cleanupAfterExit(vm).catch(() => {});
}

// Pulls the plug. Used when a guest ignores the power button, and before delete/reinstall.
async function forceStop(vm) {
  const pid = readPid(vm);
  if (pid && isRunning(vm)) {
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 20 && isRunning(vm); i++) await sleep(200);
  }
  await cleanupAfterExit(vm, 1000);
}

async function reboot(vm) {
  if (!isRunning(vm)) throw new Error('VM is not running');
  await qmp(vm, 'system_reset');
}

// Suspend (pause) and resume a running VM. This freezes the guest instantly without a shutdown, so
// it is the safe way to stop a VM that is misbehaving (for example while mining). The guest keeps
// its memory; resuming continues exactly where it left off.
async function suspend(vm) {
  if (!isRunning(vm)) throw new Error('VM is not running');
  await qmp(vm, 'stop');
}
async function resume(vm) {
  if (!isRunning(vm)) throw new Error('VM is not running');
  await qmp(vm, 'cont');
}

// Cumulative CPU time (user + system, in clock ticks) of the VM's QEMU process. Two samples taken a
// few seconds apart give the VM's CPU use, which the mining guard watches. Returns null when the
// VM is not running or the process is gone.
function cpuTicks(vm) {
  const pid = readPid(vm);
  if (!pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // utime and stime are fields 14 and 15, after the (possibly spaced) comm field in parentheses.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = parseInt(rest[11], 10);
    const stime = parseInt(rest[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch { return null; }
}

async function attachIso(vm, isoName) {
  if (!images.ISO_RE.test(String(isoName))) throw new Error('Invalid ISO name');
  const full = path.join(config.isoDir, isoName);
  if (!fs.existsSync(full)) throw new Error('That ISO is not on this VM\'s node');
  if (isRunning(vm)) await qmp(vm, 'blockdev-change-medium', { id: 'cdrom0', filename: full, format: 'raw' });
}
async function detachIso(vm) {
  if (isRunning(vm)) await qmp(vm, 'eject', { id: 'cdrom0', force: true });
}

// ---- disks ----
async function createDisk(vm, tplFilename, format) {
  const p = paths(vm);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.rmSync(p.disk, { force: true });
  await run(config.qemuImg, ['create', '-f', 'qcow2', '-F', format || 'qcow2', '-b', images.tplPath(tplFilename), p.disk, `${vm.disk_gb}G`]);
}

async function diskVirtualSize(vm) {
  const { stdout } = await run(config.qemuImg, ['info', '--output=json', paths(vm).disk]);
  return JSON.parse(stdout)['virtual-size'];
}

async function resizeDisk(vm, newGb) {
  if (isRunning(vm)) throw new Error('Stop the VM before resizing its disk');
  const current = await diskVirtualSize(vm);
  if (newGb * 1024 ** 3 <= current) throw new Error('Disks can only grow. Enter a size larger than the current one.');
  await run(config.qemuImg, ['resize', paths(vm).disk, `${newGb}G`]);
}

// Fresh disk + cloud-init seed for a first boot (create or reinstall).
async function provision(vm, tplFilename, passwordHash, opts = {}) {
  assertVm(vm);
  if (isRunning(vm)) await forceStop(vm);
  const p = paths(vm);
  // 0700: the disk, QEMU monitor and console/VNC sockets must not be reachable by other host users.
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(p.dir, 0o700); } catch { /* best effort */ }
  fs.rmSync(p.serial, { force: true });
  const format = await images.templateFormat(tplFilename);
  await createDisk(vm, tplFilename, format);
  await cloudinit.buildSeed(vm, p.dir, passwordHash, opts && opts.sshx);
}

async function destroy(vm) {
  if (isRunning(vm)) await forceStop(vm);
  else if (vm.net_mode === 'bridge') await network.teardownTap(vm);
  fs.rmSync(paths(vm).dir, { recursive: true, force: true });
}

// On start-up: clear stale taps, then boot VMs flagged for autostart.
async function reconcile(vms) {
  for (const vm of vms) {
    try {
      if (isRunning(vm)) continue;
      if (vm.net_mode === 'bridge') await network.teardownTap(vm);
      if (vm.autostart) { await start(vm); console.log(`autostarted VM ${vm.id} (${vm.name})`); }
    } catch (e) { console.error(`autostart failed for VM ${vm.id}: ${e.message}`); }
  }
}

// ---- SSHX ----
// The in-guest service prints "DIABLO-SSHX-URL <link>" on the serial console (see guest-sshx.sh).
// The newest such line wins. "starting" and "stopped" markers mean there is no live link right now.
async function sshxLink(vm) {
  if (!isRunning(vm)) return null;
  let fd;
  try {
    fd = fs.openSync(paths(vm).serial, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let last = null;
    for (const m of buf.toString('utf8').matchAll(/DIABLO-SSHX-URL (\S+)/g)) last = m[1];
    return last && /^https?:\/\//.test(last) ? last : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Cancel an SSHX session. The guest keeps printing its link on the serial console, so we append a
// "stopped" marker (the newest marker wins) to make sshxLink() report nothing, and the panel also
// clears the stored link. This needs no access inside the guest and cannot disturb the running VM.
async function sshxStop(vm) {
  assertVm(vm);
  try { fs.appendFileSync(paths(vm).serial, '\nDIABLO-SSHX-URL stopped\n'); } catch { /* log may not exist yet */ }
}

module.exports = {
  HAS_KVM, paths, status, isRunning, buildArgs, qmp,
  start, stop, forceStop, reboot, suspend, resume, cpuTicks, attachIso, detachIso,
  resizeDisk, diskVirtualSize, provision, destroy, reconcile, sshxLink, sshxStop,
};
