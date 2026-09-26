// Download progress for OS templates (per node) and ISO files.
(() => {
  const mb = (n) => (n / 1048576).toFixed(0) + ' MB';

  const bars = document.querySelectorAll('progress[data-tpl-file]');
  if (bars.length) {
    const tick = async () => {
      try {
        const data = await (await fetch('/admin/templates/progress', { credentials: 'same-origin' })).json();
        let running = 0;
        for (const bar of bars) {
          const job = data[bar.dataset.node]?.jobs[`tpl:${bar.dataset.tplFile}`];
          if (!job || job.status !== 'running') { window.location.reload(); return; }
          running++;
          bar.max = job.total || 100;
          bar.value = job.total ? job.received : 0;
          const label = document.querySelector(`[data-tpl-text="${bar.dataset.tplFile}-${bar.dataset.node}"]`);
          if (label) label.textContent = job.total ? ` ${mb(job.received)} of ${mb(job.total)}` : ` ${mb(job.received)}`;
        }
        if (running) setTimeout(tick, 1500);
      } catch { setTimeout(tick, 3000); }
    };
    tick();
  }

  const box = document.querySelector('[data-poll-isos]');
  if (box) {
    let hadRunning = false;
    const tick = async () => {
      try {
        const jobs = await (await fetch(`/admin/isos/progress?node=${box.dataset.pollIsos}`, { credentials: 'same-origin' })).json();
        const names = Object.keys(jobs);
        const running = names.filter((n) => jobs[n].status === 'running');
        if (hadRunning && !running.length) { window.location.reload(); return; }
        hadRunning = running.length > 0;
        box.replaceChildren();
        for (const n of names) {
          const j = jobs[n];
          if (j.status === 'done') continue;
          const row = document.createElement('div');
          row.className = j.status === 'failed' ? 'note err' : 'note info';
          const text = document.createElement('div');
          text.textContent = j.status === 'failed' ? `${n} failed: ${j.error}` : `Downloading ${n}: ${mb(j.received)}${j.total ? ' of ' + mb(j.total) : ''}`;
          row.append(text);
          if (j.status === 'running') { const p = document.createElement('progress'); p.max = j.total || 100; p.value = j.total ? j.received : 0; row.append(p); }
          box.append(row);
        }
      } catch { /* retry */ }
      setTimeout(tick, 2000);
    };
    tick();
  }
})();
