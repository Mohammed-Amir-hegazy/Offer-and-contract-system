const { calculatePlan } = require('./calc');

function n(v) {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// Effective limits for a user: per-user values set by the admin, falling back to global settings.
// Admins are not limited.
function limitsFor(user, settings) {
  const allowedFrequencies = String(settings.allowed_frequencies || '3')
    .split(',').map((s) => Number(s.trim())).filter((x) => x > 0);
  if (user.role === 'admin') {
    return { maxDiscountPct: 100, minDownPaymentPct: 0, maxYears: 30, allowedFrequencies: [...new Set([...allowedFrequencies, 1, 3, 6, 12])].sort((a, b) => a - b) };
  }
  return {
    maxDiscountPct: user.max_discount_pct ?? n(settings.max_discount_pct) ?? 0,
    minDownPaymentPct: user.min_down_payment_pct ?? n(settings.min_down_payment_pct) ?? 0,
    maxYears: user.max_years ?? n(settings.max_years) ?? 10,
    allowedFrequencies,
  };
}

function defaultsFor(settings, unit) {
  return {
    discountPct: n(settings.default_discount_pct) ?? 0,
    downPaymentPct: n(settings.default_down_payment_pct) ?? 0,
    years: n(settings.default_years) ?? 5,
    frequencyMonths: n(settings.default_frequency_months) ?? 3,
    includeGarage: settings.garage_included_by_default === '1',
    garagePrice: unit?.garage_price ?? n(settings.default_garage_price) ?? 0,
  };
}

/**
 * Build validated plan inputs from a request body. Price, garage price and maintenance
 * always come from admin-controlled data; the user only picks the commercial terms.
 * Returns { inputs, plan, errors }.
 */
function buildPlan({ body, unit, user, settings, startDate }) {
  const errors = [];
  const limits = limitsFor(user, settings);
  const d = defaultsFor(settings, unit);

  const inputs = {
    discountPct: n(body.discountPct) ?? d.discountPct,
    downPaymentPct: n(body.downPaymentPct) ?? d.downPaymentPct,
    years: n(body.years) ?? d.years,
    frequencyMonths: n(body.frequencyMonths) ?? d.frequencyMonths,
    includeGarage: body.includeGarage === undefined ? d.includeGarage : [true, 'true', '1', 'on', 1].includes(body.includeGarage),
    garagePrice: d.garagePrice,
    maintenancePct: n(settings.maintenance_pct) ?? 0,
    maintenanceSkip: n(settings.maintenance_skip_installments) ?? 8,
  };

  if (!unit) errors.push('كود الوحدة غير موجود');
  else {
    if (unit.status === 'sold') errors.push('هذه الوحدة مباعة');
    if (!unit.price) errors.push('لم يتم تحديد سعر لهذه الوحدة بعد — برجاء التواصل مع الأدمن');
  }
  if (inputs.discountPct < 0 || inputs.discountPct > limits.maxDiscountPct) errors.push(`نسبة الخصم يجب أن تكون بين 0 و ${limits.maxDiscountPct}%`);
  if (inputs.downPaymentPct < limits.minDownPaymentPct || inputs.downPaymentPct > 100) errors.push(`نسبة المقدم يجب أن تكون بين ${limits.minDownPaymentPct}% و 100%`);
  if (inputs.years < 0 || inputs.years > limits.maxYears) errors.push(`مدة التقسيط يجب ألا تزيد عن ${limits.maxYears} سنوات`);
  if (!limits.allowedFrequencies.includes(inputs.frequencyMonths)) errors.push('دورية السداد غير مسموح بها');
  if (inputs.years > 0 && (inputs.years * 12) % inputs.frequencyMonths !== 0) errors.push('مدة التقسيط لا تقبل القسمة على دورية السداد');

  const plan = unit && unit.price ? calculatePlan({ ...inputs, unitPrice: unit.price, startDate }) : null;
  return { inputs, plan, errors, limits };
}

module.exports = { limitsFor, defaultsFor, buildPlan };
