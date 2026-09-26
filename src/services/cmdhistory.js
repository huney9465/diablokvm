'use strict';
// Per-VM command history. Keystrokes arrive from the browser terminal (SSH or the serial
// console) one burst at a time, so we rebuild the current line and only store a command once
// the user presses Enter. Escape codes, arrow keys and other control bytes are ignored, so the
// history holds readable commands, not raw terminal noise. Only admins can read it back.
const { db } = require('../db');

const MAX_LINE = 4000;   // stop a runaway paste from growing without bound
const MAX_STORE = 2000;  // longest command we keep

class LineRecorder {
  constructor(vmId, user, kind) {
    this.vmId = vmId;
    this.userId = user ? user.id : null;
    this.username = user ? user.username : null;
    this.kind = kind; // 'ssh' or 'console'
    this.buf = '';
    this.esc = 0; // 0 none, 1 just saw ESC, 2 inside a CSI/SS3 sequence (arrow keys etc.)
  }

  // Feed one chunk of input as it is typed. Handles Enter, Backspace and Ctrl-C / Ctrl-U.
  push(data) {
    for (const ch of String(data)) {
      const code = ch.codePointAt(0);
      if (this.esc === 1) { this.esc = (ch === '[' || ch === 'O') ? 2 : 0; continue; }
      if (this.esc === 2) { if (code >= 0x40 && code <= 0x7e) this.esc = 0; continue; } // final byte
      if (code === 0x1b) { this.esc = 1; continue; }
      if (ch === '\r' || ch === '\n') { this.commit(); continue; }
      if (code === 0x7f || code === 0x08) { this.buf = this.buf.slice(0, -1); continue; }
      if (code === 0x03 || code === 0x15) { this.buf = ''; continue; } // Ctrl-C / Ctrl-U
      if (code < 0x20) continue; // ignore tab and other control bytes
      if (this.buf.length < MAX_LINE) this.buf += ch;
    }
  }

  commit() {
    const line = this.buf.trim();
    this.buf = '';
    if (!line) return;
    try {
      db.prepare('INSERT INTO vm_commands (vm_id, user_id, username, kind, command) VALUES (?, ?, ?, ?, ?)')
        .run(this.vmId, this.userId, this.username, this.kind, line.slice(0, MAX_STORE));
    } catch { /* history is best-effort; never break a live terminal over it */ }
  }
}

// Newest first. Capped so a very chatty VM cannot return an unbounded page.
function list(vmId, limit = 500) {
  const n = Math.max(1, Math.min(2000, limit | 0 || 500));
  return db.prepare('SELECT * FROM vm_commands WHERE vm_id = ? ORDER BY id DESC LIMIT ?').all(vmId, n);
}

function count(vmId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM vm_commands WHERE vm_id = ?').get(vmId);
  return row ? row.n : 0;
}

module.exports = { LineRecorder, list, count };
