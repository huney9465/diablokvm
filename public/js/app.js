// Shared behaviour: confirm dialogs, double-click protection, busy buttons, live status lamps.
(() => {
  // ---- Confirm dialogs. Done on click (works in every browser, including Enter-key submits)
  // for buttons and links, and on submit for forms that carry data-confirm themselves.
  document.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-confirm]') : null;
    if (!el || el.tagName === 'FORM') return;
    if (!window.confirm(el.dataset.confirm)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- One submit per page view. A second click while the request is in flight is ignored,
  // so a double click cannot start a VM twice or create two VMs.
  const lock = (form, submitter) => {
    form.dataset.submitting = '1';
    setTimeout(() => { // after the browser has collected the form data
      form.querySelectorAll('button[type=submit], button:not([type])').forEach((b) => {
        if (b.disabled) return;
        b.dataset.wasEnabled = '1';
        if (b === submitter || (!submitter && b.dataset.busy)) {
          if (b.dataset.busy) { b.dataset.label = b.textContent; b.textContent = b.dataset.busy; }
        }
        b.disabled = true;
      });
    }, 0);
  };
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) { e.preventDefault(); return; }
    if (form.dataset.submitting === '1') { e.preventDefault(); return; }
    lock(form, e.submitter || null);
  });
  // Coming back with the Back button restores the page as it was, including disabled buttons.
  window.addEventListener('pageshow', () => {
    document.querySelectorAll('form[data-submitting]').forEach((f) => { delete f.dataset.submitting; });
    document.querySelectorAll('button[data-was-enabled]').forEach((b) => {
      b.disabled = false;
      if (b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.label; }
      delete b.dataset.wasEnabled;
    });
  });

  document.addEventListener('change', (e) => { if (e.target.matches('[data-autosubmit]') && e.target.form) e.target.form.submit(); });

  // ---- Skeleton loading: show placeholder shapes while the next page is on its way.
  // Full page loads leave the old page on screen until the new one paints; this covers that gap
  // with a shimmer skeleton so navigation feels instant.
  const skel = document.createElement('div');
  skel.className = 'skeleton-overlay';
  skel.setAttribute('aria-hidden', 'true');
  skel.innerHTML = '<div class="sk-head"></div><div class="sk-card"></div><div class="sk-card"></div>'
    + '<div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div>';
  document.body.appendChild(skel);
  let skelTimer = null;
  const showSkeleton = () => {
    document.body.classList.add('navigating');
    clearTimeout(skelTimer);
    skelTimer = setTimeout(() => document.body.classList.remove('navigating'), 12000);
  };
  window.addEventListener('load', () => document.body.classList.remove('navigating'));
  window.addEventListener('pageshow', () => document.body.classList.remove('navigating'));
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest ? e.target.closest('a') : null;
    if (!a || !a.href) return;
    if (a.target === '_blank' || a.hasAttribute('download') || a.dataset.noSkeleton !== undefined) return;
    let url; try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin !== location.origin || url.pathname === location.pathname && url.search === location.search) return;
    if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/api/')) return;
    showSkeleton();
  });

  // ---- Sign-in: play a short success transition while the credentials are checked.
  const loginForm = document.querySelector('form[data-login]');
  if (loginForm) {
    loginForm.addEventListener('submit', () => {
      const btn = loginForm.querySelector('button[type=submit]');
      if (btn) btn.classList.add('is-busy');
      document.body.classList.add('logging-in');
    });
  }

  // ---- Settings niceties: live Discord accent + background upload preview
  const discordSwitch = document.getElementById('discord_enabled');
  if (discordSwitch) {
    const block = discordSwitch.closest('.panel')?.querySelector('.discord-block');
    const sync = () => { if (block) block.classList.toggle('is-on', discordSwitch.checked); };
    discordSwitch.addEventListener('change', sync);
  }
  const bgFile = document.getElementById('background_file');
  if (bgFile) {
    bgFile.addEventListener('change', () => {
      const f = bgFile.files && bgFile.files[0];
      if (!f) return;
      const box = bgFile.closest('.panel');
      let img = box.querySelector('.bg-preview img');
      if (!img) {
        const wrap = document.createElement('div');
        wrap.className = 'bg-preview';
        wrap.style.margin = '.4rem 0 .8rem';
        wrap.innerHTML = '<span class="small muted">Selected file</span>';
        img = document.createElement('img');
        wrap.appendChild(img);
        bgFile.closest('.row').insertAdjacentElement('afterend', wrap);
      }
      img.src = URL.createObjectURL(f);
    });
  }

  // ---- Ripple + press feedback on buttons (only when animations are enabled)
  if (document.body.classList.contains('anim')) {
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest ? e.target.closest('.btn') : null;
      if (!btn || btn.disabled) return;
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = `${size}px`;
      span.style.left = `${e.clientX - rect.left - size / 2}px`;
      span.style.top = `${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(span);
      setTimeout(() => span.remove(), 650);
    });
  }

  // ---- Animated counters + meters on the dashboard (only when animations are on)
  if (document.body.classList.contains('anim')) {
    const countUp = (el) => {
      if (el.children.length) return; // keep elements with markup (e.g. "1 of 1") intact
      const m = el.textContent.match(/(\d[\d,]*)/);
      if (!m) return;
      const target = parseInt(m[1].replace(/,/g, ''), 10);
      if (!Number.isFinite(target) || target === 0 || target > 1000000) return;
      const prefix = el.textContent.slice(0, m.index);
      const suffix = el.textContent.slice(m.index + m[1].length);
      const dur = 750; const start = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = prefix + Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    document.querySelectorAll('.gauge .n').forEach(countUp);
    // Meters sweep from zero to their value.
    document.querySelectorAll('meter[value]').forEach((mt) => {
      const v = Number(mt.getAttribute('value'));
      if (!Number.isFinite(v)) return;
      mt.setAttribute('value', '0');
      const dur = 700; const start = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        mt.setAttribute('value', String(v * eased));
        if (p < 1) requestAnimationFrame(step); else mt.setAttribute('value', String(v));
      };
      requestAnimationFrame(step);
    });
  }

  // ---- Live status lamps
  if (!document.querySelector('[data-lamp-for]')) return;
  const faceplate = document.querySelector('.faceplate[data-vm-id]');
  const label = { running: 'Running', stopped: 'Stopped', unknown: 'Node offline' };
  let notified = false;

  // Never reload under someone who is typing or has a form open.
  const userIsBusy = () => {
    const a = document.activeElement;
    return !!document.querySelector('details[open]') || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  };
  function notifyChanged() {
    if (notified) return;
    notified = true;
    const bar = document.createElement('div');
    bar.className = 'note info';
    bar.setAttribute('role', 'status');
    bar.append('This VM changed state. ');
    const a = document.createElement('a');
    a.href = window.location.href;
    a.textContent = 'Refresh the page';
    bar.append(a, ' when you are done here.');
    const main = document.querySelector('.main') || document.body;
    main.prepend(bar);
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const res = await fetch('/vms/status', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return;
      const map = await res.json();
      if (faceplate && map[faceplate.dataset.vmId] && map[faceplate.dataset.vmId] !== faceplate.dataset.status) {
        if (userIsBusy()) notifyChanged(); else window.location.reload();
        return;
      }
      document.querySelectorAll('[data-lamp-for]').forEach((el) => {
        const s = map[el.dataset.lampFor];
        if (s) el.className = `lamp ${s === 'running' ? 'running' : 'off'}`;
      });
      document.querySelectorAll('[data-state-for]').forEach((el) => {
        if (faceplate && faceplate.contains(el)) return;
        const s = map[el.dataset.stateFor];
        if (s) { el.textContent = label[s] || 'Stopped'; el.className = `state ${s}`; }
      });
    } catch { /* offline: try again next tick */ }
  }
  const timer = setInterval(poll, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('pagehide', () => clearInterval(timer));
})();
