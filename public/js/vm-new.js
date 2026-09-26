// Create-VM form helpers: only offer OSes the chosen node has, and only show bridge settings for bridge mode.
(() => {
  document.querySelectorAll('select[data-net-mode]').forEach((sel) => {
    const boxes = sel.form.querySelectorAll('[data-bridge-only]');
    const apply = () => boxes.forEach((b) => { b.hidden = sel.value !== 'bridge'; b.querySelectorAll('input').forEach((i) => { i.disabled = sel.value !== 'bridge'; }); });
    sel.addEventListener('change', apply);
    apply();
  });

  const node = document.getElementById('node_id');
  const tpl = document.getElementById('template_id');
  if (!tpl) return;
  const apply = () => {
    const n = node ? node.value : '';
    for (const o of tpl.options) {
      if (!o.value) continue;
      const show = !n || (o.dataset.nodes || '').split(',').includes(n);
      o.hidden = !show;
      o.disabled = !show;
    }
    if (tpl.selectedOptions[0] && tpl.selectedOptions[0].disabled) tpl.value = '';
  };
  if (node) node.addEventListener('change', apply);
  apply();
})();
