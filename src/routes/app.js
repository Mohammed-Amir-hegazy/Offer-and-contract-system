const crypto = require('node:crypto');
const { asyncRouter } = require('../router');
const { db, getSettings, getUnitByCode, getUnitById, nextNumber, getCompany, companySnapshot } = require('../db');
const { requirePermission } = require('../auth');
const { buildPlan, limitsFor, defaultsFor } = require('../plans');
const { contractValues, renderTemplate, applySignatures, hashBody } = require('../template');
const f = require('../format');
const { uploadUrl } = require('../storage');
const { contractDocx, quoteXlsx } = require('../exports');

const router = asyncRouter();

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
    image: uploadUrl(unit.image),
    notes: unit.notes,
    company_id: unit.company_id,
    company_name: unit.company_name,
    project_name: unit.project_name,
  };
}

// Identity printed on a quote/contract: the snapshot taken when it was issued
// (falls back to the unit's current company for documents without one).
async function docCompany(row, unitCompanyId) {
  if (row.company) return typeof row.company === 'string' ? JSON.parse(row.company) : row.company;
  return companySnapshot(await getCompany(row.tenant_id, unitCompanyId)) || {};
}

function canSee(req, row) {
  return row.tenant_id === req.tenantId && (req.user.role === 'admin' || row.created_by === req.user.id);
}

// Quotes/contracts a user may list: the client's own, and only their own unless they are an admin.
function visible(req, alias) {
  if (req.user.role === 'admin') return { where: `${alias}.tenant_id = ?`, args: [req.tenantId] };
  return { where: `${alias}.tenant_id = ? AND ${alias}.created_by = ?`, args: [req.tenantId, req.user.id] };
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Dashboard
router.get('/', async (req, res) => {
  const { where, args } = visible(req, 'q');
  const quotes = await db.all(`SELECT q.*, u.code AS unit_code FROM quotes q JOIN units u ON u.id = q.unit_id WHERE ${where} ORDER BY q.id DESC LIMIT 5`, ...args);
  const c = visible(req, 'c');
  const contracts = (await db.all(`SELECT c.id, c.number, c.status, c.created_at, c.client, u.code AS unit_code FROM contracts c JOIN units u ON u.id = c.unit_id WHERE ${c.where} ORDER BY c.id DESC LIMIT 5`, ...c.args))
    .map((row) => parse(row, 'client'));
  const stats = (await db.all('SELECT status, COUNT(*) AS c FROM units WHERE tenant_id = ? GROUP BY status', req.tenantId))
    .reduce((a, r) => ({ ...a, [r.status]: r.c }), { available: 0, reserved: 0, sold: 0 });
  res.render('dashboard', { title: 'الرئيسية', quotes, contracts, stats });
});

// ---------- API
router.get('/api/units/:code', async (req, res) => {
  const unit = await getUnitByCode(req.tenantId, req.params.code);
  if (!unit) return res.status(404).json({ error: 'لا توجد وحدة بهذا الكود' });
  res.json({ unit: unitPublic(unit) });
});

router.get('/api/units', async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = await db.all('SELECT code, status FROM units WHERE tenant_id = ? AND code LIKE ? ORDER BY code LIMIT 20', req.tenantId, q);
  res.json({ units: rows });
});

router.post('/api/plan', async (req, res) => {
  const settings = await getSettings(req.tenantId);
  const unit = await getUnitByCode(req.tenantId, req.body.code);
  const { plan, errors, inputs } = buildPlan({ body: req.body, unit, user: req.user, settings, startDate: req.body.startDate || f.todayIso() });
  res.json({ plan, errors, inputs });
});

async function formContext(req, extra = {}) {
  const settings = await getSettings(req.tenantId);
  return {
    limits: limitsFor(req.user, settings),
    defaults: defaultsFor(settings, null),
    ...extra,
  };
}

// ---------- Quotes
router.get('/quotes', requirePermission('can_quote'), async (req, res) => {
  const { where, args } = visible(req, 'q');
  const quotes = (await db.all(`SELECT q.*, u.code AS unit_code, us.full_name AS creator FROM quotes q
    JOIN units u ON u.id = q.unit_id JOIN users us ON us.id = q.created_by WHERE ${where} ORDER BY q.id DESC LIMIT 500`, ...args))
    .map((q) => parse(q, 'plan'));
  res.render('quotes', { title: 'عروض الأسعار', quotes });
});

router.get('/quotes/new', requirePermission('can_quote'), async (req, res) => {
  res.render('quote-form', { title: 'عرض سعر جديد', mode: 'quote', ...(await formContext(req)), prefill: { code: req.query.code || '' }, errors: [] });
});

router.post('/quotes', requirePermission('can_quote'), async (req, res) => {
  const settings = await getSettings(req.tenantId);
  const clientName = String(req.body.clientName || '').trim();
  const unit = await getUnitByCode(req.tenantId, req.body.code);
  const offerDate = f.todayIso();
  const { inputs, plan, errors } = buildPlan({ body: req.body, unit, user: req.user, settings, startDate: offerDate });
  if (!clientName) errors.unshift('اسم العميل مطلوب');
  if (errors.length) {
    return res.status(400).render('quote-form', { title: 'عرض سعر جديد', mode: 'quote', ...(await formContext(req)), prefill: req.body, errors });
  }
  const number = await nextNumber(req.tenantId, 'quotes', 'Q');
  const validDays = Number(settings.quote_validity_days) || 0;
  const info = await db.run(`INSERT INTO quotes (tenant_id, number, client_name, client_phone, unit_id, unit_snapshot, inputs, plan, offer_date, valid_until, created_by, company)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.tenantId, number, clientName, String(req.body.clientPhone || '').trim(), unit.id, JSON.stringify(unitPublic(unit)),
    JSON.stringify(inputs), JSON.stringify(plan), offerDate, validDays ? addDays(offerDate, validDays) : null, req.user.id,
    JSON.stringify(companySnapshot(await getCompany(req.tenantId, unit.company_id))));
  res.redirect(`/quotes/${info.lastInsertRowid}`);
});

router.get('/quotes/:id', requirePermission('can_quote'), async (req, res, next) => {
  const quote = parse(await db.get(`SELECT q.*, us.full_name AS creator FROM quotes q JOIN users us ON us.id = q.created_by WHERE q.id = ? AND q.tenant_id = ?`, req.params.id, req.tenantId), 'plan', 'inputs', 'unit_snapshot');
  if (!quote || !canSee(req, quote)) return next();
  const contract = await db.get('SELECT id, number, status FROM contracts WHERE quote_id = ? AND status != ? ORDER BY id DESC', quote.id, 'cancelled');
  const company = await docCompany(quote, quote.unit_snapshot.company_id);
  res.render('quote', { title: `عرض سعر ${quote.number}`, quote, unit: quote.unit_snapshot, plan: quote.plan, contract, company });
});

// Excel copy of a quote.
router.get('/quotes/:id/export.xlsx', requirePermission('can_quote'), async (req, res, next) => {
  const quote = parse(await db.get('SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', req.params.id, req.tenantId), 'plan', 'inputs', 'unit_snapshot');
  if (!quote || !canSee(req, quote)) return next();
  const company = await docCompany(quote, quote.unit_snapshot.company_id);
  const settings = await getSettings(req.tenantId);
  const buffer = await quoteXlsx({ quote, unit: quote.unit_snapshot, plan: quote.plan, company, terms: company.quote_terms || settings.quote_terms });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${quote.number}.xlsx"`);
  res.send(Buffer.from(buffer));
});

// ---------- Contracts
router.get('/contracts', requirePermission('can_contract'), async (req, res) => {
  const { where, args } = visible(req, 'c');
  const contracts = (await db.all(`SELECT c.id, c.number, c.status, c.created_at, c.client, c.plan, c.client_signed_at, c.company_signed_at,
    u.code AS unit_code, us.full_name AS creator FROM contracts c JOIN units u ON u.id = c.unit_id JOIN users us ON us.id = c.created_by
    WHERE ${where} ORDER BY c.id DESC LIMIT 500`, ...args)).map((c) => parse(c, 'client', 'plan'));
  res.render('contracts', { title: 'العقود', contracts });
});

router.get('/contracts/new', requirePermission('can_contract'), async (req, res) => {
  let prefill = { code: req.query.code || '' };
  if (req.query.quote) {
    const q = parse(await db.get('SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', req.query.quote, req.tenantId), 'inputs', 'unit_snapshot');
    if (q && canSee(req, q)) {
      prefill = { quoteId: q.id, quoteNumber: q.number, code: q.unit_snapshot.code, clientName: q.client_name, clientPhone: q.client_phone, ...q.inputs };
    }
  }
  res.render('quote-form', { title: 'عقد جديد', mode: 'contract', ...(await formContext(req)), prefill, errors: [] });
});

function readClient(body) {
  const s = (k) => String(body[k] || '').trim();
  return {
    name: s('clientName'), national_id: s('clientNationalId'), nationality: s('clientNationality') || 'مصري',
    address: s('clientAddress'), correspondence_address: s('clientCorrespondenceAddress'), phone: s('clientPhone'), email: s('clientEmail'),
  };
}

// Contract-only unit details not kept on the unit itself (roof, storage, parking spots).
function readExtras(body, plan) {
  const count = (v, d) => {
    const n = Number(v);
    return v === undefined || v === '' || !Number.isFinite(n) ? d : Math.max(0, Math.min(20, Math.round(n)));
  };
  return {
    has_roof: [true, 'true', '1', 'on'].includes(Array.isArray(body.hasRoof) ? body.hasRoof.at(-1) : body.hasRoof),
    parking_count: count(body.parkingCount, plan?.includeGarage ? 1 : 0),
    storage_count: count(body.storageCount, 0),
  };
}

// Uses the company's own contract wording, or the general template if it has none.
function renderContractBody(settings, company, contract, client, unit, plan, quoteNumber, extras) {
  const values = contractValues({ company, contract, client, unit, plan, quoteNumber, extras });
  return renderTemplate(company?.contract_template || settings.contract_template || '', values, plan, {
    logo: f.upload(company?.logo),
    signEveryPage: settings.sign_every_page !== '0',
  });
}

router.post('/contracts', requirePermission('can_contract'), async (req, res) => {
  const settings = await getSettings(req.tenantId);
  const client = readClient(req.body);
  const unit = await getUnitByCode(req.tenantId, req.body.code);
  const contractDate = f.todayIso();
  const { inputs, plan, errors } = buildPlan({ body: req.body, unit, user: req.user, settings, startDate: contractDate });
  if (!client.name) errors.unshift('اسم العميل مطلوب');
  if (!client.national_id) errors.push('الرقم القومي للعميل مطلوب');
  if (unit) {
    const open = await db.get("SELECT number FROM contracts WHERE tenant_id = ? AND unit_id = ? AND status IN ('draft','pending','signed')", req.tenantId, unit.id);
    if (open) errors.push(`يوجد عقد قائم على هذه الوحدة (${open.number})`);
  }
  if (errors.length) {
    return res.status(400).render('quote-form', { title: 'عقد جديد', mode: 'contract', ...(await formContext(req)), prefill: req.body, errors });
  }
  let quoteId = Number(req.body.quoteId) || null;
  let quoteNumber = null;
  if (quoteId) {
    const q = await db.get('SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', quoteId, req.tenantId);
    if (q && canSee(req, q)) quoteNumber = q.number;
    else quoteId = null;
  }
  const number = await nextNumber(req.tenantId, 'contracts', 'C');
  const snapshot = unitPublic(unit);
  const company = await getCompany(req.tenantId, unit.company_id);
  const extras = readExtras(req.body, plan);
  const body = renderContractBody(settings, company, { number, contract_date: contractDate }, client, snapshot, plan, quoteNumber, extras);
  const info = await db.run(`INSERT INTO contracts (tenant_id, number, quote_id, unit_id, client, unit_snapshot, inputs, plan, contract_date, body_html, created_by, company, extras)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.tenantId, number, quoteId, unit.id, JSON.stringify(client), JSON.stringify(snapshot), JSON.stringify(inputs), JSON.stringify(plan), contractDate, body, req.user.id,
    JSON.stringify(companySnapshot(company)), JSON.stringify(extras));
  if (settings.auto_status_on_contract === '1' && unit.status === 'available') {
    await db.run("UPDATE units SET status = 'reserved', updated_at = datetime('now') WHERE id = ?", unit.id);
  }
  res.redirect(`/contracts/${info.lastInsertRowid}`);
});

async function loadContract(req) {
  const c = parse(await db.get('SELECT c.*, us.full_name AS creator FROM contracts c JOIN users us ON us.id = c.created_by WHERE c.id = ? AND c.tenant_id = ?', req.params.id, req.tenantId), 'client', 'plan', 'unit_snapshot');
  if (!c || !canSee(req, c)) return null;
  c.company = await docCompany(c, c.unit_snapshot.company_id);
  return c;
}

function baseUrl(req) {
  return process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
}

router.get('/contracts/:id', requirePermission('can_contract'), async (req, res, next) => {
  const contract = await loadContract(req);
  if (!contract) return next();
  const links = contract.client_token ? {
    client: `${baseUrl(req)}/sign/${contract.client_token}`,
    company: `${baseUrl(req)}/sign/${contract.company_token}`,
  } : null;
  res.render('contract', { title: `عقد ${contract.number}`, contract, company: contract.company, body: applySignatures(contract.body_html, contract), links });
});

router.get('/contracts/:id/print', requirePermission('can_contract'), async (req, res, next) => {
  const contract = await loadContract(req);
  if (!contract) return next();
  res.render('contract-print', { title: `عقد ${contract.number}`, contract, company: contract.company, body: applySignatures(contract.body_html, contract) });
});

// Word copy of a contract (with whatever signatures it has so far).
router.get('/contracts/:id/export.docx', requirePermission('can_contract'), async (req, res, next) => {
  const contract = await loadContract(req);
  if (!contract) return next();
  const settings = await getSettings(req.tenantId);
  const buffer = await contractDocx({
    html: applySignatures(contract.body_html, contract),
    contract,
    company: contract.company,
    signEveryPage: settings.sign_every_page !== '0' || contract.body_html.includes('page-sign'),
  });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.set('Content-Disposition', `attachment; filename="${contract.number}.docx"`);
  res.send(buffer);
});

router.post('/contracts/:id/links', requirePermission('can_contract'), async (req, res, next) => {
  const contract = await loadContract(req);
  if (!contract) return next();
  if (contract.status === 'cancelled' || contract.status === 'signed') return res.redirect(`/contracts/${contract.id}`);
  if (!contract.client_token) {
    const token = () => crypto.randomBytes(24).toString('base64url');
    await db.run("UPDATE contracts SET client_token = ?, company_token = ?, status = 'pending', body_hash = ? WHERE id = ?", token(), token(), hashBody(contract.body_html), contract.id);
    req.flash('success', 'تم إنشاء روابط التوقيع — أرسل كل رابط للطرف الخاص به');
  }
  res.redirect(`/contracts/${contract.id}`);
});

router.post('/contracts/:id/regenerate', requirePermission('can_contract'), async (req, res, next) => {
  const contract = await loadContract(req);
  if (!contract) return next();
  if (contract.client_signed_at || contract.company_signed_at || contract.status === 'cancelled') {
    req.flash('error', 'لا يمكن إعادة صياغة عقد بدأ توقيعه أو ملغي');
    return res.redirect(`/contracts/${contract.id}`);
  }
  const settings = await getSettings(req.tenantId);
  const quote = contract.quote_id ? await db.get('SELECT number FROM quotes WHERE id = ?', contract.quote_id) : null;
  // Re-drafting also refreshes the company identity from the unit's current company.
  const company = await getCompany(req.tenantId, (await getUnitById(req.tenantId, contract.unit_id))?.company_id);
  const extras = contract.extras ? JSON.parse(contract.extras) : readExtras({}, contract.plan);
  const body = renderContractBody(settings, company, contract, contract.client, contract.unit_snapshot, contract.plan, quote?.number, extras);
  await db.run('UPDATE contracts SET body_html = ?, company = ?, body_hash = CASE WHEN client_token IS NULL THEN NULL ELSE ? END WHERE id = ?', body, JSON.stringify(companySnapshot(company)), hashBody(body), contract.id);
  req.flash('success', 'تمت إعادة صياغة العقد من القالب الحالي');
  res.redirect(`/contracts/${contract.id}`);
});

router.post('/contracts/:id/cancel', requirePermission('can_contract'), async (req, res, next) => {
  const contract = await loadContract(req);
  if (!contract) return next();
  if (contract.status === 'signed' && req.user.role !== 'admin') {
    req.flash('error', 'إلغاء العقد الموقّع متاح للأدمن فقط');
    return res.redirect(`/contracts/${contract.id}`);
  }
  await db.run("UPDATE contracts SET status = 'cancelled', client_token = NULL, company_token = NULL WHERE id = ?", contract.id);
  const unit = await getUnitById(req.tenantId, contract.unit_id);
  if ((await getSettings(req.tenantId)).auto_status_on_contract === '1' && unit && unit.status !== 'available') {
    await db.run("UPDATE units SET status = 'available', updated_at = datetime('now') WHERE id = ?", unit.id);
  }
  req.flash('success', 'تم إلغاء العقد');
  res.redirect(`/contracts/${contract.id}`);
});

module.exports = router;
