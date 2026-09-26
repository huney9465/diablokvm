// Per-VM file upload with a live progress bar. We send the form with XHR so a large (up to 1 GB)
// upload shows real progress instead of a frozen page, and so the shared submit-lock in app.js
// does not disable the button while the browser is still streaming.
(() => {
  const form = document.getElementById('vm-upload');
  if (!form) return;
  const prog = document.getElementById('up-progress');
  const fill = document.getElementById('up-fill');
  const text = document.getElementById('up-text');
  const btn = form.querySelector('button[type=submit]');
  const mb = (n) => (n / 1048576).toFixed(1);

  form.addEventListener('submit', (e) => {
    const input = form.querySelector('#file');
    if (!input || !input.files || !input.files[0]) return; // let the browser show "required"
    e.preventDefault();
    e.stopPropagation();

    const fd = new FormData(form);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action, true);
    xhr.upload.addEventListener('progress', (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      prog.hidden = false;
      fill.style.width = `${pct}%`;
      text.textContent = `Uploading… ${pct}% (${mb(ev.loaded)} / ${mb(ev.total)} MB)`;
    });
    xhr.addEventListener('load', () => {
      // The server answers with a redirect back to the files page; follow it.
      window.location.href = xhr.responseURL || form.action.replace(/\/upload$/, '');
    });
    xhr.addEventListener('error', () => {
      prog.hidden = false;
      fill.style.width = '100%';
      text.textContent = 'Upload failed. Check your connection and try again.';
      if (btn) btn.disabled = false;
    });
    prog.hidden = false;
    fill.style.width = '0%';
    text.textContent = 'Starting upload…';
    if (btn) btn.disabled = true;
    xhr.send(fd);
  }, true);
})();
