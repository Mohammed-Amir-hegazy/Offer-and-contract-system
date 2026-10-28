const test = require('node:test');
const assert = require('node:assert');
const { calculatePlan, addMonths } = require('../src/calc');
const { tafqeet } = require('../src/tafqeet');

const base = {
  unitPrice: 3_000_000, discountPct: 10, downPaymentPct: 10, years: 5, frequencyMonths: 3,
  maintenancePct: 8, maintenanceSkip: 8, includeGarage: true, garagePrice: 300_000, startDate: '2026-10-28',
};

test('default plan: 20 quarterly installments with maintenance after the 8th', () => {
  const p = calculatePlan(base);
  assert.strictEqual(p.count, 20);
  assert.strictEqual(p.discountAmount, 300_000);
  assert.strictEqual(p.netPrice, 2_700_000);
  assert.strictEqual(p.downPayment, 270_000);
  assert.strictEqual(p.maintenanceAmount, 216_000);
  assert.ok(p.installments.slice(0, 8).every((i) => i.maintenance === 0));
  assert.ok(p.installments.slice(8).every((i) => i.maintenance === 18_000));
  assert.ok(p.installments.every((i) => i.garage === 15_000));
  const sum = (k) => p.installments.reduce((a, i) => a + i[k], 0);
  assert.strictEqual(sum('unit'), 2_430_000);
  assert.strictEqual(sum('garage'), 300_000);
  assert.strictEqual(sum('maintenance'), 216_000);
  assert.strictEqual(p.downPayment + sum('total'), p.grandTotal);
});

test('installment dates are counted from the offer date', () => {
  const p = calculatePlan(base);
  assert.strictEqual(p.installments[0].date, '2027-01-28');
  assert.strictEqual(p.installments[19].date, '2031-10-28');
});

test('rounding remainders land on the last installment so totals stay exact', () => {
  const p = calculatePlan({ ...base, unitPrice: 2_345_679, discountPct: 7.5, garagePrice: 123_457, maintenancePct: 9 });
  const total = p.installments.reduce((a, i) => a + i.total, 0) + p.downPayment;
  assert.strictEqual(total, p.grandTotal);
});

test('custom terms: 3 years monthly', () => {
  const p = calculatePlan({ ...base, years: 3, frequencyMonths: 1 });
  assert.strictEqual(p.count, 36);
  assert.strictEqual(p.installments.filter((i) => i.maintenance > 0).length, 28);
});

test('short plan puts maintenance on the last installment; cash plan pays everything upfront', () => {
  const short = calculatePlan({ ...base, years: 1, frequencyMonths: 3 });
  assert.strictEqual(short.count, 4);
  assert.deepStrictEqual(short.installments.map((i) => i.maintenance > 0), [false, false, false, true]);
  const cash = calculatePlan({ ...base, years: 0 });
  assert.strictEqual(cash.count, 0);
  assert.strictEqual(cash.downPayment, cash.grandTotal);
});

test('addMonths clamps to month end', () => {
  assert.strictEqual(addMonths('2026-11-30', 3), '2027-02-28');
  assert.strictEqual(addMonths('2027-08-31', 6), '2028-02-29');
});

test('tafqeet', () => {
  assert.strictEqual(tafqeet(0), 'صفر');
  assert.strictEqual(tafqeet(15), 'خمسة عشر');
  assert.strictEqual(tafqeet(2000), 'ألفان');
  assert.strictEqual(tafqeet(5000), 'خمسة آلاف');
  assert.strictEqual(tafqeet(250000), 'مائتان وخمسون ألف');
  assert.strictEqual(tafqeet(1250000), 'مليون ومائتان وخمسون ألف');
  assert.strictEqual(tafqeet(2_700_321), 'مليونان وسبعمائة ألف وثلاثمائة وواحد وعشرون');
});
