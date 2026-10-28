const crypto = require('node:crypto');
const express = require('express');
const { db, getSettings, getUnitByCode, getUnitById, nextNumber, getCompany, companySnapshot } = require('../db');
const { requirePermission } = require('../auth');
const { buildPlan, limitsFor, defaultsFor } = require('../plans');
const { contractValues, renderTemplate, applySignatures, hashBody } = require('../template');
const f = require('../format');

const router = express.Router();

// Forms send a hidden "0" before the checkbox so an unchecked box is still reported; keep the last value.
router.use((req, res, next) => {
  if (req.body && Array.isArray(req.body.includeGarage)) req.body.includeGarage = req.body.includeGarage.at(-1);
  next();
});

const parse = (row, ...keys) => {
  if (!row) return row;
  const out = { ...row };
  for (const k of keys) out[k] = JSON.parse(row[k]);
  return out;
};

function unitPublic(unit) {
  return {
    id: unit.id,
    code: unit.code,
    building: unit.building,
    entrance: unit.entrance,
    floor: unit.floor,
    floorLabel: f.floorLabel(unit.floor),
    model_no: unit.model_no,
    area: unit.area,
    garden_area: unit.garden_area,
    rooms: unit.rooms,
    bathrooms: unit.bathrooms,
    price: unit.price,
    garage_price: unit.garage_price,
    status: unit.status,
    statusLabel: f.STATUS_LABELS[unit.status],
    image: unit.image ? `/uploads/${unit.image}` : null,
    notes: unit.notes,
    company_id: unit.company_id,
    company_name: unit.company_name,
    project_name: unit.project_name,
  };
}

// Identity printed on a quote/contract: the snapshot taken when it was issued
// (falls back to the unit's current company for documents without one).
function docCompany(row, unitCompanyId) {
  if (row.company) return typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
  return companySnapshot(getCompany(unitCompanyId)) || {};
}

function canSee(user, row) {
  return user.role === 'admin' || row.created_by === user.id;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Dashboard
router.get('/', (req, res) => {
  const mine = req.user.role === 'admin' ? '' : 'WHERE q.created_by = ?';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const quotes = db.prepare(`SELECT q.*, u.code AS unit_code FROM quotes q JOIN units u ON u.id = q.unit_id ${mine} ORDER BY q.id DESC LIMIT 5`).all(...args);
  const contracts = db.prepare(`SELECT c.id, c.number, c.status, c.created_at, c.client, u.code AS unit_code FROM contracts c JOIN units u ON u.id = c.unit_id ${mine.replace('q.', 'c.')} ORDER BY c.id DESC LIMIT 5`).all(...args)
    .map((c) => parse(c, 'client'));
  const stats = db.prepare("SELECT status, COUNT(*) AS c FROM units GROUP BY status").all()
    .reduce((a, r) => ({ ...a, [r.status]: r.c }), { available: 0, reserved: 0, sold: 0 });
  res.render('dashboard', { title: 'الرئيسية', quotes, contracts, stats });
});

// ---------- API
router.get('/api/units/:code', (req, res) => {
  const unit = getUnitByCode(req.params.code);
  if (!unit) return res.status(404).json({ error: 'لا توجد وحدة بهذا الكود' });
  res.json({ unit: unitPublic(unit) });
});

router.get('/api/units', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare('SELECT code, status FROM units WHERE code LIKE ? ORDER BY code LIMIT 20').all(q);
  res.json({ units: rows });
});

router.post('/api/plan', (req, res) => {
  const settings = getSettings();
  const unit = getUnitByCode(req.body.code);
  const { plan, errors, inputs } = buildPlan({ body: req.body, unit, user: req.user, settings, startDate: req.body.startDate || f.todayIso() });
  res.json({ plan, errors, inputs });
});

function formContext(req, extra = {}) {
  const settings = getSettings();
  return {
    limits: limitsFor(req.user, settings),
    defaults: defaultsFor(settings, null),
    ...extra,
  };
}

// ---------- Quotes
router.get('/quotes', requirePermission('can_quote'), (req, res) => {
  const where = req.user.role === 'admin' ? '' : 'WHERE q.created_by = ?';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const quotes = db.prepare(`SELECT q.*, u.code AS unit_code, us.full_name AS creator FROM quotes q
    JOIN units u ON u.id = q.unit_id JOIN users us ON us.id = q.created_by ${where} ORDER BY q.id DESC LIMIT 500`).all(...args)
    .map((q) => parse(q, 'plan'));
  res.render('quotes', { title: 'عروض الأسعار', quotes });
});

router.get('/quotes/new', requirePermission('can_quote'), (req, res) => {
  res.render('quote-form', { title: 'عرض سعر جديد', mode: 'quote', ...formContext(req), prefill: { code: req.query.code || '' }, errors: [] });
});

router.post('/quotes', requirePermission('can_quote'), (req, res) => {
  const settings = getSettings();
  const clientName = String(req.body.clientName || '').trim();
  const unit = getUnitByCode(req.body.code);
  const offerDate = f.todayIso();
  const { inputs, plan, errors } = buildPlan({ body: req.body, unit, user: req.user, settings, startDate: offerDate });
  if (!clientName) errors.unshift('اسم العميل مطلوب');
  if (errors.length) {
    return res.status(400).render('quote-form', { title: 'عرض سعر جديد', mode: 'quote', ...formContext(req), prefill: req.body, errors });
  }
  const number = nextNumber('quotes', 'Q');
  const validDays = Number(settings.quote_validity_days) || 0;
  const info = db.prepare(`INSERT INTO quotes (number, client_name, client_phone, unit_id, unit_snapshot, inputs, plan, offer_date, valid_until, created_by, company)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    number, clientName, String(req.body.clientPhone || '').trim(), unit.id, JSON.stringify(unitPublic(unit)),
    JSON.stringify(inputs), JSON.stringify(plan), offerDate, validDays ? addDays(offerDate, validDays) : null, req.user.id,
    JSON.stringify(companySnapshot(getCompany(unit.company_id))),
  );
  res.redirect(`/quotes/${info.lastInsertRowid}`);
});

router.get('/quotes/:id', requirePermission('can_quote'), (req, res, next) => {
  const quote = parse(db.prepare(`SELECT q.*, us.full_name AS creator FROM quotes q JOIN users us ON us.id = q.created_by WHERE q.id = ?`).get(req.params.id), 'plan', 'inputs', 'unit_snapshot');
  if (!quote || !canSee(req.user, quote)) return next();
  const contract = db.prepare('SELECT id, number, status FROM contracts WHERE quote_id = ? AND status != ? ORDER BY id DESC').get(quote.id, 'cancelled');
  const company = docCompany(quote, quote.unit_snapshot.company_id);
  res.render('quote', { title: `عرض سعر ${quote.number}`, quote, unit: quote.unit_snapshot, plan: quote.plan, contract, company });
});

// ---------- Contracts
router.get('/contracts', requirePermission('can_contract'), (req, res) => {
  const where = req.user.role === 'admin' ? '' : 'WHERE c.created_by = ?';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const contracts = db.prepare(`SELECT c.id, c.number, c.status, c.created_at, c.client, c.plan, c.client_signed_at, c.company_signed_at,
    u.code AS unit_code, us.full_name AS creator FROM contracts c JOIN units u ON u.id = c.unit_id JOIN users us ON us.id = c.created_by
    ${where} ORDER BY c.id DESC LIMIT 500`).all(...args).map((c) => parse(c, 'client', 'plan'));
  res.render('contracts', { title: 'العقود', contracts });
});

router.get('/contracts/new', requirePermission('can_contract'), (req, res) => {
  let prefill = { code: req.query.code || '' };
  if (req.query.quote) {
    const q = parse(db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.query.quote), 'inputs', 'unit_snapshot');
    if (q && canSee(req.user, q)) {
      prefill = { quoteId: q.id, quoteNumber: q.number, code: q.unit_snapshot.code, clientName: q.client_name, clientPhone: q.client_phone, ...q.inputs };
    }
  }
  res.render('quote-form', { title: 'عقد جديد', mode: 'contract', ...formContext(req), prefill, errors: [] });
});

function readClient(body) {
  const s = (k) => String(body[k] || '').trim();
  return {
    name: s('clientName'), national_id: s('clientNationalId'), nationality: s('clientNationality') || 'مصري',
    address: s('clientAddress'), phone: s('clientPhone'), email: s('clientEmail'),
  };
}

// Uses the company's own contract wording, or the general template if it has none.
function renderContractBody(settings, company, contract, client, unit, plan, quoteNumber) {
  const values = contractValues({ company, contract, client, unit, plan, quoteNumber });
  return renderTemplate(company?.contract_template || settings.contract_template || '', values, plan);
}

router.post('/contracts', requirePermission('can_contract'), (req, res) => {
  const settings = getSettings();
  const client = readClient(req.body);
  const unit = getUnitByCode(req.body.code);
  const contractDate = f.todayIso();
  const { inputs, plan, errors } = buildPlan({ body: req.body, unit, user: req.user, settings, startDate: contractDate });
  if (!client.name) errors.unshift('اسم العميل مطلوب');
  if (!client.national_id) errors.push('الرقم القومي للعميل مطلوب');
  if (unit) {
    const open = db.prepare("SELECT number FROM contracts WHERE unit_id = ? AND status IN ('draft','pending','signed')").get(unit.id);
    if (open) errors.push(`يوجد عقد قائم على هذه الوحدة (${open.number})`);
  }
  if (errors.length) {
    return res.status(400).render('quote-form', { title: 'عقد جديد', mode: 'contract', ...formContext(req), prefill: req.body, errors });
  }
  let quoteId = Number(req.body.quoteId) || null;
  let quoteNumber = null;
  if (quoteId) {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    if (q && canSee(req.user, q)) quoteNumber = q.number;
    else quoteId = null;
  }
  const number = nextNumber('contracts', 'C');
  const snapshot = unitPublic(unit);
  const company = getCompany(unit.company_id);
  const body = renderContractBody(settings, company, { number, contract_date: contractDate }, client, snapshot, plan, quoteNumber);
  const info = db.prepare(`INSERT INTO contracts (number, quote_id, unit_id, client, unit_snapshot, inputs, plan, contract_date, body_html, created_by, company)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    number, quoteId, unit.id, JSON.stringify(client), JSON.stringify(snapshot), JSON.stringify(inputs), JSON.stringify(plan), contractDate, body, req.user.id,
    JSON.stringify(companySnapshot(company)),
  );
  if (settings.auto_status_on_contract === '1' && unit.status === 'available') {
    db.prepare("UPDATE units SET status = 'reserved', updated_at = datetime('now') WHERE id = ?").run(unit.id);
  }
  res.redirect(`/contracts/${info.lastInsertRowid}`);
});

function loadContract(req) {
  const c = parse(db.prepare('SELECT c.*, us.full_name AS creator FROM contracts c JOIN users us ON us.id = c.created_by WHERE c.id = ?').get(req.params.id), 'client', 'plan', 'unit_snapshot');
  if (!c || !canSee(req.user, c)) return null;
  c.company = docCompany(c, c.unit_snapshot.company_id);
  return c;
}

function baseUrl(req) {
  return process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
}

router.get('/contracts/:id', requirePermission('can_contract'), (req, res, next) => {
  const contract = loadContract(req);
  if (!contract) return next();
  const links = contract.client_token ? {
    client: `${baseUrl(req)}/sign/${contract.client_token}`,
    company: `${baseUrl(req)}/sign/${contract.company_token}`,
  } : null;
  res.render('contract', { title: `عقد ${contract.number}`, contract, company: contract.company, body: applySignatures(contract.body_html, contract), links });
});

router.get('/contracts/:id/print', requirePermission('can_contract'), (req, res, next) => {
  const contract = loadContract(req);
  if (!contract) return next();
  res.render('contract-print', { title: `عقد ${contract.number}`, contract, company: contract.company, body: applySignatures(contract.body_html, contract) });
});

router.post('/contracts/:id/links', requirePermission('can_contract'), (req, res, next) => {
  const contract = loadContract(req);
  if (!contract) return next();
  if (contract.status === 'cancelled' || contract.status === 'signed') return res.redirect(`/contracts/${contract.id}`);
  if (!contract.client_token) {
    const token = () => crypto.randomBytes(24).toString('base64url');
    db.prepare("UPDATE contracts SET client_token = ?, company_token = ?, status = 'pending', body_hash = ? WHERE id = ?")
      .run(token(), token(), hashBody(contract.body_html), contract.id);
    req.flash('success', 'تم إنشاء روابط التوقيع — أرسل كل رابط للطرف الخاص به');
  }
  res.redirect(`/contracts/${contract.id}`);
});

router.post('/contracts/:id/regenerate', requirePermission('can_contract'), (req, res, next) => {
  const contract = loadContract(req);
  if (!contract) return next();
  if (contract.client_signed_at || contract.company_signed_at || contract.status === 'cancelled') {
    req.flash('error', 'لا يمكن إعادة صياغة عقد بدأ توقيعه أو ملغي');
    return res.redirect(`/contracts/${contract.id}`);
  }
  const settings = getSettings();
  const quote = contract.quote_id ? db.prepare('SELECT number FROM quotes WHERE id = ?').get(contract.quote_id) : null;
  // Re-drafting also refreshes the company identity from the unit's current company.
  const company = getCompany(getUnitById(contract.unit_id)?.company_id);
  const body = renderContractBody(settings, company, contract, contract.client, contract.unit_snapshot, contract.plan, quote?.number);
  db.prepare('UPDATE contracts SET body_html = ?, company = ?, body_hash = CASE WHEN client_token IS NULL THEN NULL ELSE ? END WHERE id = ?')
    .run(body, JSON.stringify(companySnapshot(company)), hashBody(body), contract.id);
  req.flash('success', 'تمت إعادة صياغة العقد من القالب الحالي');
  res.redirect(`/contracts/${contract.id}`);
});

router.post('/contracts/:id/cancel', requirePermission('can_contract'), (req, res, next) => {
  const contract = loadContract(req);
  if (!contract) return next();
  if (contract.status === 'signed' && req.user.role !== 'admin') {
    req.flash('error', 'إلغاء العقد الموقّع متاح للأدمن فقط');
    return res.redirect(`/contracts/${contract.id}`);
  }
  db.prepare("UPDATE contracts SET status = 'cancelled', client_token = NULL, company_token = NULL WHERE id = ?").run(contract.id);
  const unit = getUnitById(contract.unit_id);
  if (getSettings().auto_status_on_contract === '1' && unit && unit.status !== 'available') {
    db.prepare("UPDATE units SET status = 'available', updated_at = datetime('now') WHERE id = ?").run(unit.id);
  }
  req.flash('success', 'تم إلغاء العقد');
  res.redirect(`/contracts/${contract.id}`);
});

module.exports = router;
