// Graphical console: noVNC talking to the panel's authenticated VNC bridge.
import RFB from '/vendor/novnc/core/rfb.js';

const screen = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const say = (text) => { overlay.hidden = false; overlay.firstElementChild.textContent = text; };

if (screen.dataset.running === '1') {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const rfb = new RFB(screen, `${proto}://${location.host}/ws/vnc/${screen.dataset.vm}`, { wsProtocols: ['binary'] });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = '#000';
  rfb.addEventListener('connect', () => { overlay.hidden = true; rfb.focus(); });
  rfb.addEventListener('disconnect', (e) => say(e.detail.clean ? 'The console was closed.' : 'Could not stay connected to the console. Reload the page to retry.'));
  document.getElementById('cad').addEventListener('click', () => rfb.sendCtrlAltDel());
  document.getElementById('fs').addEventListener('click', () => screen.requestFullscreen && screen.requestFullscreen());
} else {
  document.getElementById('cad').disabled = true;
}
