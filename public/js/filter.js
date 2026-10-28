function filterRows(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#list tbody tr').forEach((tr) => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
