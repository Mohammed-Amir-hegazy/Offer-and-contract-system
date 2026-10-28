const crypto = require('node:crypto');
const f = require('./format');
const { amountInWords } = require('./tafqeet');

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// Placeholders available to contract templates, shown to the admin in the template editor.
const PLACEHOLDERS = [
  ['company_name', 'اسم الشركة'], ['company_address', 'عنوان الشركة'], ['company_phone', 'تليفون الشركة'], ['owner_name', 'اسم ممثل الشركة'],
  ['project_name', 'اسم المشروع'], ['contract_number', 'رقم العقد'], ['contract_date', 'تاريخ العقد'],
  ['contract_day', 'يوم تحرير العقد'], ['quote_number', 'رقم عرض السعر'],
  ['client_name', 'اسم العميل'], ['client_national_id', 'الرقم القومي'], ['client_nationality', 'الجنسية'],
  ['client_address', 'عنوان العميل'], ['client_correspondence_address', 'عنوان المراسلات'], ['client_phone', 'هاتف العميل'], ['client_email', 'البريد الإلكتروني'],
  ['unit_code', 'كود الوحدة'], ['unit_number', 'رقم الوحدة'], ['building', 'العمارة'], ['entrance', 'المدخل'], ['floor', 'الدور'],
  ['model_no', 'رقم النموذج'], ['area', 'المساحة'], ['garden_area', 'مساحة الحديقة'], ['rooms', 'عدد الغرف'],
  ['bathrooms', 'عدد الحمامات'], ['has_garden', 'حديقة (نعم/لا)'], ['has_roof', 'سطح (نعم/لا)'],
  ['has_parking', 'مكان انتظار سيارة (نعم/لا)'], ['parking_count', 'عدد أماكن الانتظار'], ['has_storage', 'مخزن (نعم/لا)'], ['storage_count', 'عدد المخازن'],
  ['total_price', 'ثمن الوحدة الإجمالي (شامل الجراج)'], ['total_price_words', 'الثمن الإجمالي بالحروف'],
  ['contract_down_payment', 'المقدم المسدد'], ['contract_down_payment_words', 'المقدم المسدد بالحروف'],
  ['contract_remaining', 'باقي الثمن على أقساط'], ['contract_remaining_words', 'باقي الثمن بالحروف'],
  ['unit_price', 'سعر الوحدة قبل الخصم'], ['unit_price_words', 'سعر الوحدة بالحروف'],
  ['discount_pct', 'نسبة الخصم'], ['discount_amount', 'قيمة الخصم'],
  ['net_price', 'سعر الوحدة بعد الخصم'], ['net_price_words', 'سعر الوحدة بعد الخصم بالحروف'],
  ['down_payment', 'المقدم'], ['down_payment_pct', 'نسبة المقدم'], ['down_payment_words', 'المقدم بالحروف'],
  ['remaining', 'الباقي بعد المقدم'], ['remaining_words', 'الباقي بالحروف'],
  ['installments_count', 'عدد الأقساط'], ['installment_frequency', 'دورية القسط'], ['years', 'مدة التقسيط بالسنوات'],
  ['first_installment_date', 'تاريخ أول قسط'], ['last_installment_date', 'تاريخ آخر قسط'],
  ['maintenance_pct', 'نسبة وديعة الصيانة'], ['maintenance_amount', 'قيمة وديعة الصيانة'],
  ['maintenance_amount_words', 'وديعة الصيانة بالحروف'], ['maintenance_start_installment', 'أول قسط تُضاف له الصيانة'],
  ['garage_price', 'سعر الجراج'], ['garage_price_words', 'سعر الجراج بالحروف'],
  ['total_contract', 'إجمالي العقد (وحدة + جراج)'], ['total_contract_words', 'إجمالي العقد بالحروف'],
  ['grand_total', 'الإجمالي شامل الصيانة'], ['grand_total_words', 'الإجمالي شامل الصيانة بالحروف'],
  ['installments_table', 'جدول الأقساط (جدول كامل)'],
  ['company_signature', 'مكان توقيع الشركة'], ['client_signature', 'مكان توقيع العميل'],
  ['company_signer_name', 'اسم من وقّع عن الشركة'], ['company_stamp', 'مكان ختم الشركة'], ['client_signed_date', 'تاريخ توقيع العميل'],
  ['master_plan_image', 'صورة المخطط العام للمشروع'], ['unit_plan_image', 'صورة مخطط الوحدة'],
];

const yesNo = (v) => (v ? 'نعم' : 'لا');

function installmentsTable(plan) {
  const rows = [
    `<tr><td>مقدم</td><td>${f.date(plan.startDate)}</td><td>${f.money(plan.downPayment)}</td><td>—</td><td>—</td><td>${f.money(plan.downPayment)}</td></tr>`,
    ...plan.installments.map((i) => `<tr><td>${i.no}</td><td>${f.date(i.date)}</td><td>${f.money(i.unit)}</td><td>${f.money(i.garage)}</td><td>${f.money(i.maintenance)}</td><td>${f.money(i.total)}</td></tr>`),
  ];
  const totals = plan.installments.reduce((a, i) => ({ unit: a.unit + i.unit, garage: a.garage + i.garage, maintenance: a.maintenance + i.maintenance, total: a.total + i.total }), { unit: plan.downPayment, garage: 0, maintenance: 0, total: plan.downPayment });
  return `<table class="installments"><thead><tr><th>القسط</th><th>تاريخ الاستحقاق</th><th>قيمة الوحدة</th><th>الجراج</th><th>وديعة الصيانة</th><th>الإجمالي</th></tr></thead>
<tbody>${rows.join('')}</tbody>
<tfoot><tr><td colspan="2">الإجمالي</td><td>${f.money(totals.unit)}</td><td>${f.money(totals.garage)}</td><td>${f.money(totals.maintenance)}</td><td>${f.money(totals.total)}</td></tr></tfoot></table>`;
}

function contractValues({ company, contract, client, unit, plan, quoteNumber, extras }) {
  company = company || {};
  extras = extras || {};
  // The contract price includes the garage; with no installments everything is paid upfront.
  const priceDown = plan.count === 0 ? plan.totalContract : plan.downPayment;
  const priceRemaining = plan.totalContract - priceDown;
  const parkingCount = Number(extras.parking_count) || 0;
  const storageCount = Number(extras.storage_count) || 0;
  const d = new Date(`${contract.contract_date}T12:00:00`);
  const first = plan.installments[0];
  const last = plan.installments[plan.installments.length - 1];
  return {
    company_name: company.name,
    company_address: company.address,
    company_phone: company.phone,
    owner_name: company.owner_name,
    project_name: company.project_name,
    contract_number: contract.number,
    contract_date: f.date(contract.contract_date),
    contract_day: DAYS[d.getDay()],
    quote_number: quoteNumber || '',
    client_name: client.name,
    client_national_id: client.national_id,
    client_nationality: client.nationality,
    client_address: client.address,
    client_correspondence_address: client.correspondence_address || client.address,
    client_phone: client.phone,
    client_email: client.email,
    unit_code: unit.code,
    unit_number: String(unit.code || '').split('-').pop(),
    has_garden: yesNo(Number(unit.garden_area) > 0),
    has_roof: yesNo(extras.has_roof),
    has_parking: yesNo(parkingCount > 0),
    parking_count: parkingCount || '-',
    has_storage: yesNo(storageCount > 0),
    storage_count: storageCount || '-',
    total_price: f.money(plan.totalContract),
    total_price_words: amountInWords(plan.totalContract),
    contract_down_payment: f.money(priceDown),
    contract_down_payment_words: amountInWords(priceDown),
    contract_remaining: f.money(priceRemaining),
    contract_remaining_words: amountInWords(priceRemaining),
    master_plan_image: f.upload(company.master_plan),
    unit_plan_image: unit.image || null,
    building: unit.building,
    entrance: unit.entrance,
    floor: f.floorLabel(unit.floor),
    model_no: unit.model_no,
    area: f.area(unit.area),
    garden_area: Number(unit.garden_area) > 0 ? f.area(unit.garden_area) : '-',
    rooms: unit.rooms ?? '—',
    bathrooms: unit.bathrooms ?? '—',
    unit_price: f.money(plan.unitPrice),
    unit_price_words: amountInWords(plan.unitPrice),
    discount_pct: plan.discountPct,
    discount_amount: f.money(plan.discountAmount),
    net_price: f.money(plan.netPrice),
    net_price_words: amountInWords(plan.netPrice),
    down_payment: f.money(plan.downPayment),
    down_payment_pct: plan.downPaymentPct,
    down_payment_words: amountInWords(plan.downPayment),
    remaining: f.money(plan.remaining),
    remaining_words: amountInWords(plan.remaining),
    installments_count: plan.count,
    installment_frequency: f.frequencyLabel(plan.frequencyMonths),
    years: plan.years,
    first_installment_date: first ? f.date(first.date) : '—',
    last_installment_date: last ? f.date(last.date) : '—',
    maintenance_pct: plan.maintenancePct,
    maintenance_amount: f.money(plan.maintenanceAmount),
    maintenance_amount_words: amountInWords(plan.maintenanceAmount),
    maintenance_start_installment: Math.min(plan.maintenanceSkip + 1, Math.max(plan.count, 1)),
    garage_price: f.money(plan.garagePrice),
    garage_price_words: amountInWords(plan.garagePrice),
    total_contract: f.money(plan.totalContract),
    total_contract_words: amountInWords(plan.totalContract),
    grand_total: f.money(plan.grandTotal),
    grand_total_words: amountInWords(plan.grandTotal),
  };
}

// Fill a template. Text values are escaped; the installments table and signature slots are HTML.
// Signature slots are kept as markers so the actual signature images are dropped in at view time.
// Page breaks in a template (<div class="page-break"></div>) split the contract into pages that print one per sheet.
// Each page carries the company logo and page number at the top and, optionally, both parties' signatures
// at the bottom — the signatures are the same {{company_signature}} / {{client_signature}} slots as in the body.
const PAGE_BREAK = /<div class="page-break">[\s\S]*?<\/div>/g;

function paginate(template, { logo, signEveryPage }) {
  const pages = template.split(PAGE_BREAK);
  if (pages.length < 2 && !signEveryPage) return template;
  const head = (n) => `<div class="page-top">${logo ? `<img class="page-logo" src="${f.escapeHtml(logo)}" alt="">` : '<span></span>'}<span class="page-no">${n} / ${pages.length}</span></div>`;
  const foot = signEveryPage
    ? `<footer class="page-sign"><div><span>توقيع الطرف الأول (البائع)</span>{{company_signature}}</div><div><span>توقيع الطرف الثاني (المشتري)</span>{{client_signature}}</div></footer>`
    : '';
  return pages.map((body, i) => `<section class="contract-page">${head(i + 1)}<div class="page-body">${body}</div>${foot}</section>`).join('\n');
}

function renderTemplate(template, values, plan, options = {}) {
  return paginate(template, options).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => {
    if (key === 'installments_table') return installmentsTable(plan);
    if (key === 'company_signature' || key === 'client_signature') {
      return `<span class="sig-slot" data-sig="${key === 'company_signature' ? 'company' : 'client'}"></span>`;
    }
    if (key === 'company_signer_name') return '<span class="sig-name" data-sig="company"></span>';
    if (key === 'company_stamp') return '<span class="sig-stamp"></span>';
    if (key === 'client_signed_date') return '<span class="sig-date" data-sig="client"></span>';
    if (key === 'master_plan_image' || key === 'unit_plan_image') {
      const src = values[key];
      return src ? `<img class="plan-img" src="${f.escapeHtml(src)}" alt="">` : '<p class="plan-missing">(يُرفق المخطط)</p>';
    }
    if (!(key in values)) return m;
    const v = values[key];
    return f.escapeHtml(v == null || v === '' ? '..........' : v);
  });
}

// Replace signature markers with the stored signature images (or an empty signing line).
function applySignatures(html, contract) {
  const img = (party) => {
    const data = contract[`${party}_signature`];
    if (data) {
      const at = f.datetime(contract[`${party}_signed_at`]);
      return `<span class="sig-slot signed"><img src="${data}" alt="توقيع"><small>وُقّع إلكترونياً ${at}</small></span>`;
    }
    return '<span class="sig-slot empty">............................</span>';
  };
  // The company stamp is applied together with the company's signature.
  const stamp = contract.company?.stamp && contract.company_signed_at
    ? `<span class="sig-stamp-img"><img src="${f.escapeHtml(f.upload(contract.company.stamp))}" alt="ختم"></span>`
    : '............................';
  return html
    .replace(/<span class="sig-slot" data-sig="(company|client)"><\/span>/g, (m, party) => img(party))
    .replace(/<span class="sig-name" data-sig="company"><\/span>/g, () => f.escapeHtml(contract.company_signer_name || contract.company?.owner_name || '..........'))
    .replace(/<span class="sig-stamp"><\/span>/g, () => stamp)
    .replace(/<span class="sig-date" data-sig="client"><\/span>/g, () => (contract.client_signed_at ? f.date(contract.client_signed_at) : '..........'));
}

function hashBody(html) {
  return crypto.createHash('sha256').update(html).digest('hex');
}

// Basic sanitisation for admin-supplied templates: strip scripts, event handlers and javascript: URLs.
function sanitizeTemplate(html) {
  return String(html || '')
    .replace(/<\s*(script|iframe|object|embed|style|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

module.exports = { paginate, PLACEHOLDERS, contractValues, renderTemplate, applySignatures, installmentsTable, hashBody, sanitizeTemplate };
