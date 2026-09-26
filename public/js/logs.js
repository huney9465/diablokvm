// Streams the VM's serial console log into the <pre id="serial-log"> block.
(() => {
  const pre = document.getElementById('serial-log');
  if (!pre) return;
  const MAX = 200000;
  // Strip ANSI escapes and stray control characters that a serial console emits.
  const clean = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\r(?!\n)/g, '');
  let ws;
  let retry = 1000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/logs/${pre.dataset.vm}`);
    ws.onopen = () => { retry = 1000; };
    ws.onmessage = (ev) => {
      const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.textContent += clean(String(ev.data));
      if (pre.textContent.length > MAX) pre.textContent = pre.textContent.slice(-MAX);
      if (stick) pre.scrollTop = pre.scrollHeight;
    };
    ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
  }
  connect();
  window.addEventListener('pagehide', () => { ws.onclose = null; ws.close(); });
})();
