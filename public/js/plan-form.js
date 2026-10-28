(function () {
  const form = document.getElementById('plan-form');
  const codeInput = document.getElementById('code');
  const unitPanel = document.getElementById('unit-panel');
  const planPanel = document.getElementById('plan-panel');
  const planErrors = document.getElementById('plan-errors');
  const submitBtn = document.getElementById('submit-btn');
  const datalist = document.getElementById('codes');

  const STATUS_CLASS = { available: 'badge-available', reserved: 'badge-reserved', sold: 'badge-sold' };
  const money = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  const num = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const date = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let currentUnit = null;
  let unitTimer = null;
  let planTimer = null;
  let unitReq = 0;
  let planReq = 0;

  function fact(label, value) {
    return `<div class="fact"><span>${label}</span><b>${value}</b></div>`;
  }

  function renderUnit(unit) {
    const sold = unit.status === 'sold';
    unitPanel.innerHTML = `
      <hr style="border:none;border-top:1px solid var(--border);margin:6px 0 16px">
      ${sold ? '<div class="sold-banner" style="margin-bottom:14px">⛔ هذه الوحدة مباعة ولا يمكن عمل عرض سعر أو عقد عليها</div>' : ''}
      ${unit.status === 'reserved' ? '<div class="alert alert-warning">⚠️ هذه الوحدة محجوزة حالياً</div>' : ''}
      <div class="unit-card">
        <div>
          <div class="row" style="margin-bottom:10px">
            <h3 style="margin:0" class="ltr">${esc(unit.code)}</h3>
            <span class="badge ${STATUS_CLASS[unit.status]}">${esc(unit.statusLabel)}</span>
          </div>
          <div class="unit-facts">
            ${unit.company_name ? fact('الشركة', esc(unit.company_name)) : ''}
            ${fact('العمارة', esc(unit.building))}
            ${fact('المدخل', esc(unit.entrance))}
            ${fact('الدور', esc(unit.floorLabel))}
            ${fact('النموذج', esc(unit.model_no || '—'))}
            ${fact('المساحة', `${num(unit.area)} م²`)}
            ${unit.garden_area ? fact('الحديقة', `${num(unit.garden_area)} م²`) : ''}
            ${fact('عدد الغرف', unit.rooms ?? '—')}
            ${unit.bathrooms ? fact('الحمامات', unit.bathrooms) : ''}
            ${fact('السعر', unit.price ? `${money(unit.price)} ج.م` : '<span style="color:var(--danger)">لم يحدد</span>')}
          </div>
          ${unit.notes ? `<p class="muted" style="margin-bottom:0">${esc(unit.notes)}</p>` : ''}
        </div>
        <div class="unit-image${unit.image ? '' : ' empty'}">${unit.image ? `<a href="${esc(unit.image)}" target="_blank"><img src="${esc(unit.image)}" alt="مسقط الوحدة"></a>` : '<span class="muted">لا توجد صورة للنموذج</span>'}</div>
      </div>`;
  }

  async function lookupUnit() {
    const code = codeInput.value.trim().toUpperCase();
    const id = ++unitReq;
    ++planReq; // drop any in-flight calculation for the previous unit
    planErrors.innerHTML = '';
    if (code.length < 3) {
      currentUnit = null;
      unitPanel.innerHTML = '<p class="muted" style="margin:0">اكتب كود الوحدة لعرض بياناتها</p>';
      planPanel.innerHTML = '';
      updateSubmit([]);
      return;
    }
    // Suggestions for partial codes
    fetch(`/api/units?q=${encodeURIComponent(code)}`).then((r) => r.json()).then((d) => {
      datalist.innerHTML = (d.units || []).map((u) => `<option value="${esc(u.code)}">`).join('');
    }).catch(() => {});

    const res = await fetch(`/api/units/${encodeURIComponent(code)}`);
    if (id !== unitReq) return;
    if (!res.ok) {
      currentUnit = null;
      unitPanel.innerHTML = '<div class="alert alert-error" style="margin:12px 0 0">لا توجد وحدة بهذا الكود</div>';
      planPanel.innerHTML = '';
      updateSubmit(['no unit']);
      return;
    }
    currentUnit = (await res.json()).unit;
    renderUnit(currentUnit);
    schedulePlan(0);
  }

  function payload() {
    const fd = new FormData(form);
    return {
      code: codeInput.value.trim(),
      discountPct: fd.get('discountPct'),
      downPaymentPct: fd.get('downPaymentPct'),
      years: fd.get('years'),
      frequencyMonths: fd.get('frequencyMonths'),
      includeGarage: document.getElementById('includeGarage').checked,
    };
  }

  function renderPlan(plan) {
    const showGarage = plan.garagePrice > 0;
    const rows = plan.installments.map((i) => `
      <tr${i.maintenance ? ' style="background:#fffaf0"' : ''}>
        <td>${i.no}</td><td>${date(i.date)}</td><td class="num">${money(i.unit)}</td>
        ${showGarage ? `<td class="num">${money(i.garage)}</td>` : ''}
        <td class="num">${money(i.maintenance)}</td><td class="num"><b>${money(i.total)}</b></td>
      </tr>`).join('');
    planPanel.innerHTML = `
      <div class="summary">
        ${fact('سعر الوحدة', `${money(plan.unitPrice)} ج.م`)}
        ${plan.discountAmount ? fact(`الخصم (${plan.discountPct}%)`, `${money(plan.discountAmount)} ج.م`) : ''}
        ${fact('السعر بعد الخصم', `${money(plan.netPrice)} ج.م`)}
        ${fact(`المقدم (${plan.downPaymentPct}%)`, `${money(plan.downPayment)} ج.م`)}
        ${showGarage ? fact('الجراج', `${money(plan.garagePrice)} ج.م`) : ''}
        ${fact(`وديعة الصيانة (${plan.maintenancePct}%)`, `${money(plan.maintenanceAmount)} ج.م`)}
        ${fact('عدد الأقساط', `${plan.count} قسط`)}
        <div class="fact total"><span>الإجمالي</span><b>${money(plan.grandTotal)} ج.م</b></div>
      </div>
      ${plan.count ? `<p class="muted" style="margin:0 0 8px">وديعة الصيانة تبدأ من القسط رقم ${Math.min(plan.maintenanceSkip + 1, plan.count)} (الصفوف المظللة)</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>القسط</th><th>تاريخ الاستحقاق</th><th>قيمة الوحدة</th>${showGarage ? '<th>الجراج</th>' : ''}<th>وديعة الصيانة</th><th>الإجمالي</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p>سداد كامل المبلغ نقداً</p>'}`;
  }

  async function calcPlan() {
    if (!currentUnit) return;
    const id = ++planReq;
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    if (id !== planReq) return;
    const data = await res.json();
    planErrors.innerHTML = data.errors && data.errors.length
      ? `<div class="alert alert-error"><ul>${data.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '';
    if (data.plan) renderPlan(data.plan);
    else planPanel.innerHTML = '';
    updateSubmit(data.errors || []);
  }

  function updateSubmit(errors) {
    submitBtn.disabled = !currentUnit || errors.length > 0;
  }

  function schedulePlan(delay = 300) {
    clearTimeout(planTimer);
    planTimer = setTimeout(calcPlan, delay);
  }

  codeInput.addEventListener('input', () => {
    clearTimeout(unitTimer);
    unitTimer = setTimeout(lookupUnit, 250);
  });
  ['discountPct', 'downPaymentPct', 'years', 'frequencyMonths', 'includeGarage'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => schedulePlan());
    el.addEventListener('change', () => schedulePlan(0));
  });

  if (codeInput.value.trim()) lookupUnit();
})();
