// Payment-plan calculation shared by quotes and contracts.
//
// Rules (from the business requirements):
//  - Discount is a percentage of the unit price.
//  - Down payment is a percentage of the net price (after discount), due on the offer date.
//  - The rest of the net price is split equally over the installments.
//  - Installments: every `frequencyMonths` months for `years` years (default 20 × 3 months),
//    counted from the offer date.
//  - Maintenance deposit is a percentage of the net price. It is NOT charged on the first
//    `maintenanceSkip` installments (default 8); it is spread over the remaining ones.
//  - The garage price (if included) is spread over all installments.

function round(n) {
  return Math.round(n);
}

function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// Split `total` into `count` integer parts that sum exactly to `total` (remainder on the last part).
function split(total, count) {
  if (count <= 0) return [];
  const each = Math.floor(total / count);
  const parts = Array(count).fill(each);
  parts[count - 1] += total - each * count;
  return parts;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} p
 * @param {number} p.unitPrice
 * @param {number} p.discountPct
 * @param {number} p.downPaymentPct
 * @param {number} p.years
 * @param {number} p.frequencyMonths
 * @param {number} p.maintenancePct
 * @param {number} p.maintenanceSkip
 * @param {boolean} p.includeGarage
 * @param {number} p.garagePrice
 * @param {string} p.startDate  ISO yyyy-mm-dd
 */
function calculatePlan(p) {
  const unitPrice = round(toNum(p.unitPrice));
  const discountPct = toNum(p.discountPct);
  const downPaymentPct = toNum(p.downPaymentPct);
  const years = toNum(p.years);
  const frequencyMonths = Math.max(1, Math.round(toNum(p.frequencyMonths, 3)));
  const maintenancePct = toNum(p.maintenancePct);
  const maintenanceSkip = Math.max(0, Math.round(toNum(p.maintenanceSkip)));
  const garagePrice = p.includeGarage ? round(toNum(p.garagePrice)) : 0;
  const startDate = p.startDate || new Date().toISOString().slice(0, 10);

  const count = Math.max(0, Math.floor((years * 12) / frequencyMonths));

  const discountAmount = round((unitPrice * discountPct) / 100);
  const netPrice = unitPrice - discountAmount;
  const downPayment = count === 0 ? netPrice : round((netPrice * downPaymentPct) / 100);
  const remaining = netPrice - downPayment;
  const maintenanceAmount = round((netPrice * maintenancePct) / 100);

  // Maintenance goes on installments after the first `maintenanceSkip`.
  // If the plan is too short for that, it is all put on the last installment.
  const maintCount = count > maintenanceSkip ? count - maintenanceSkip : Math.min(count, 1);
  const maintStart = count - maintCount; // zero-based index of first installment carrying maintenance

  const baseParts = split(remaining, count);
  const garageParts = split(garagePrice, count);
  const maintParts = split(maintenanceAmount, maintCount);

  const installments = [];
  for (let i = 0; i < count; i++) {
    const maintenance = i >= maintStart ? maintParts[i - maintStart] : 0;
    const unit = baseParts[i];
    const garage = garageParts[i];
    installments.push({
      no: i + 1,
      date: addMonths(startDate, (i + 1) * frequencyMonths),
      unit,
      garage,
      maintenance,
      total: unit + garage + maintenance,
    });
  }

  // With no installments, garage and maintenance are due with the down payment.
  const upfrontExtras = count === 0 ? garagePrice + maintenanceAmount : 0;

  return {
    startDate,
    unitPrice,
    discountPct,
    discountAmount,
    netPrice,
    downPaymentPct,
    downPayment: downPayment + upfrontExtras,
    remaining,
    years,
    frequencyMonths,
    count,
    maintenancePct,
    maintenanceSkip,
    maintenanceAmount,
    includeGarage: !!p.includeGarage,
    garagePrice,
    totalContract: netPrice + garagePrice,
    grandTotal: netPrice + garagePrice + maintenanceAmount,
    installments,
  };
}

module.exports = { calculatePlan, addMonths, split };
