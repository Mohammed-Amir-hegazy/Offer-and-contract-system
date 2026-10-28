// On phones, tables marked "responsive" are shown as cards: every cell gets its column title as a label.
(function () {
  function label(table) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
    });
  }
  function run() { document.querySelectorAll('table.responsive').forEach(label); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
