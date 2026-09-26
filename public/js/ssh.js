// Browser terminal: xterm.js on top of either the VM's serial console or an SSH session.
// Both go through the panel's WebSocket, so the only network port involved is the panel's own.
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-fit/lib/addon-fit.mjs';

const box = document.getElementById('term');
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = (kind) => `${proto}://${location.host}/ws/${kind}/${box.dataset.vm}`;

function makeTerminal() {
  const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 14, theme: { background: '#0e1e26' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  fit.fit();
  window.addEventListener('resize', () => fit.fit());
  return term;
}
const dim = (s) => `\x1b[2m${s}\x1b[0m\r\n`;
const warn = (s) => `\r\n\x1b[33m${s}\x1b[0m\r\n`;

if (box.dataset.mode === 'serial') {
  const term = makeTerminal();
  const ws = new WebSocket(wsUrl('serial'));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    term.write(dim('Connected to the direct root console.'));
    term.focus();
    // Nudge the console so the auto-login root shell prints its prompt right away.
    setTimeout(() => { if (ws.readyState === 1) ws.send('\r'); }, 400);
  };
  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  ws.onclose = () => term.write(warn('[serial console closed]'));
  term.onData((d) => ws.readyState === 1 && ws.send(d));
} else {
  const form = document.getElementById('ssh-form');
  const msg = document.getElementById('ssh-msg');
  const login = document.getElementById('login');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('u').value;
    const password = document.getElementById('p').value;
    const hostEl = document.getElementById('h');
    msg.textContent = 'Connecting...';
    form.querySelector('button').disabled = true;

    const ws = new WebSocket(wsUrl('ssh'));
    ws.binaryType = 'arraybuffer';
    let term = null;
    let opened = false;
    const sendSize = () => ws.readyState === 1 && term && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));

    ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', username, password, host: hostEl ? hostEl.value : undefined }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { if (term) term.write(new Uint8Array(ev.data)); return; }
      const m = JSON.parse(ev.data);
      if (m.type === 'ready') {
        opened = true;
        login.hidden = true;
        box.hidden = false;
        term = makeTerminal();
        sendSize();
        term.onData((d) => ws.send(JSON.stringify({ type: 'input', data: d })));
        term.onResize(sendSize);
        term.focus();
      } else if (m.type === 'error') {
        msg.textContent = m.message;
        form.querySelector('button').disabled = false;
      } else if (m.type === 'closed' && term) {
        term.write(warn('[connection closed]'));
      }
    };
    ws.onclose = () => {
      if (opened && term) term.write(warn('[disconnected]'));
      else if (!msg.textContent || msg.textContent === 'Connecting...') { msg.textContent = 'Could not open the connection.'; form.querySelector('button').disabled = false; }
    };
  });
}
