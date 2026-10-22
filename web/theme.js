// Run before styles load to avoid a flash of the wrong theme. Storage may be blocked.
(() => {
  let preference = 'system';
  try { preference = localStorage.getItem('formwright-theme') || 'system'; } catch {}
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  document.documentElement.dataset.theme = preference;
})();
