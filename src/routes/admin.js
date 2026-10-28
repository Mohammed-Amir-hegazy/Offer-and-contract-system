const path = require('node:path');
const { asyncRouter } = require('../router');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const mammoth = require('mammoth');
const { db, getSettings, setSetting, unitsFromCsv, importUnits, listUnits, listCompanies, getCompany, defaultCompanyId } = require('../db');
const { PLACEHOLDERS, sanitizeTemplate } = require('../template');
const { DEFAULT_CONTRACT_TEMPLATE } = require('../default-template');
const f = require('../format');
const { saveUpload } = require('../storage');

const router = asyncRouter();

const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const FONT_TYPES = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const fontExt = (file) => path.extname(file.originalname).toLowerCase();
const isFont = (file) => file.fieldname === 'font';

// Files are kept in memory and then stored (Vercel Blob or local disk). Vercel limits request bodies to 4.5 MB.
const MAX_UPLOAD = 4 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (r, file, cb) => cb(null, isFont(file) ? !!FONT_TYPES[fontExt(file)] : !!IMAGE_TYPES[file.mimetype]),
});
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });

// Turn upload errors (e.g. a file that is too large) into a message on the page instead of an error screen.
const friendly = (mw) => (req, res, next) => mw(req, res, (err) => {
  if (!(err instanceof multer.MulterError)) return next(err);
  req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من 4 ميجا — صغّر الصورة وحاول مرة أخرى' : 'تعذر رفع الملف');
  res.redirect(req.get('referer') || '/admin');
});
const withImage = (field) => friendly(upload.single(field));
const identityUpload = friendly(upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'font', maxCount: 1 }, { name: 'stamp', maxCount: 1 }, { name: 'master_plan', maxCount: 1 }]));

function storeFile(file) {
  if (!file) return null;
  return isFont(file)
    ? saveUpload(file.buffer, fontExt(file), FONT_TYPES[fontExt(file)])
    : saveUpload(file.buffer, IMAGE_TYPES[file.mimetype], file.mimetype);
}
const uploaded = (req, field) => storeFile(req.files?.[field]?.[0]);

const numOrNull = (v) => (v == null || String(v).trim() === '' ? null : Number(String(v).replace(/,/g, '')));
const pct = (v) => {
  const n = numOrNull(v);
  return n == null || !Number.isFinite(n) ? null : Math.min(100, Math.max(0, n));
};

// ---------- Overview
router.get('/', async (req, res) => {
  const stats = await db.get(`SELECT
    (SELECT COUNT(*) FROM users WHERE tenant_id = :t) AS users,
    (SELECT COUNT(*) FROM units WHERE tenant_id = :t) AS units,
    (SELECT COUNT(*) FROM units WHERE tenant_id = :t AND (price IS NULL OR price = 0)) AS unpriced,
    (SELECT COUNT(*) FROM units WHERE tenant_id = :t AND status = 'available') AS available,
    (SELECT COUNT(*) FROM units WHERE tenant_id = :t AND status = 'reserved') AS reserved,
    (SELECT COUNT(*) FROM units WHERE tenant_id = :t AND status = 'sold') AS sold,
    (SELECT COUNT(*) FROM quotes WHERE tenant_id = :t) AS quotes,
    (SELECT COUNT(*) FROM contracts WHERE tenant_id = :t AND status != 'cancelled') AS contracts,
    (SELECT COUNT(*) FROM contracts WHERE tenant_id = :t AND status = 'signed') AS signed,
    (SELECT COUNT(*) FROM models WHERE tenant_id = :t AND image IS NULL) AS modelsNoImage,
    (SELECT COUNT(*) FROM companies WHERE tenant_id = :t) AS companies`.replace(/:t/g, '?1'), req.tenantId);
  res.render('admin/index', { title: 'لوحة الأدمن', stats });
});

// ---------- Users
router.get('/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users WHERE tenant_id = ? ORDER BY role, full_name', req.tenantId);
  res.render('admin/users', { title: 'المستخدمون', users });
});

function userFields(body) {
  return {
    full_name: String(body.full_name || '').trim(),
    role: body.role === 'admin' ? 'admin' : 'user',
    active: body.active ? 1 : 0,
    can_quote: body.can_quote ? 1 : 0,
    can_contract: body.can_contract ? 1 : 0,
    max_discount_pct: pct(body.max_discount_pct),
    min_down_payment_pct: pct(body.min_down_payment_pct),
    max_years: numOrNull(body.max_years),
  };
}

router.post('/users', async (req, res) => {
  const u = userFields({ ...req.body, active: 1 });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !u.full_name || password.length < 8) {
    req.flash('error', 'اسم المستخدم والاسم الكامل مطلوبان، وكلمة المرور 8 أحرف على الأقل');
    return res.redirect('/admin/users');
  }
  try {
    await db.run(`INSERT INTO users (tenant_id, username, password_hash, full_name, role, can_quote, can_contract, max_discount_pct, min_down_payment_pct, max_years, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, req.tenantId, username, bcrypt.hashSync(password, 10), u.full_name, u.role, u.can_quote, u.can_contract,
      u.max_discount_pct, u.min_down_payment_pct, u.max_years);
    req.flash('success', `تم إنشاء حساب ${u.full_name} — سيُطلب منه تغيير كلمة المرور عند أول دخول`);
  } catch (e) {
    req.flash('error', String(e.message).includes('UNIQUE') ? 'اسم المستخدم مستخدم بالفعل' : 'تعذر إنشاء المستخدم');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id', async (req, res) => {
  const target = await db.get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', req.params.id, req.tenantId);
  if (!target) return res.redirect('/admin/users');
  const u = userFields(req.body);
  if (target.id === req.user.id) { u.role = 'admin'; u.active = 1; } // an admin cannot lock themself out
  const username = String(req.body.username || '').trim();
  if (username && username.toLowerCase() !== target.username.toLowerCase()) {
    if (await db.get('SELECT id FROM users WHERE username = ? AND id != ?', username, target.id)) {
      req.flash('error', `اسم المستخدم "${username}" مستخدم بالفعل`);
      return res.redirect('/admin/users');
    }
    await db.run('UPDATE users SET username = ? WHERE id = ?', username, target.id);
  }
  await db.run(`UPDATE users SET full_name = ?, role = ?, active = ?, can_quote = ?, can_contract = ?, max_discount_pct = ?, min_down_payment_pct = ?, max_years = ?
    WHERE id = ?`, u.full_name || target.full_name, u.role, u.active, u.can_quote, u.can_contract, u.max_discount_pct, u.min_down_payment_pct, u.max_years, target.id);
  const password = String(req.body.password || '');
  if (password) {
    if (password.length < 8) req.flash('error', 'كلمة المرور يجب ألا تقل عن 8 أحرف — لم يتم تغييرها');
    else await db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(password, 10), target.id);
  }
  if (!req.session.flash) req.flash('success', 'تم حفظ بيانات المستخدم');
  res.redirect('/admin/users');
});

// ---------- Units
router.get('/units', async (req, res) => {
  const units = await listUnits(req.tenantId);
  const buildings = [...new Set(units.map((u) => u.building))].sort();
  res.render('admin/units', { title: 'الوحدات', units, buildings, floors: f.FLOOR_LABELS, companies: await listCompanies(req.tenantId) });
});

router.post('/units/:id(\\d+)', withImage('image'), async (req, res) => {
  const unit = await db.get('SELECT * FROM units WHERE id = ? AND tenant_id = ?', req.params.id, req.tenantId);
  if (!unit) return res.redirect('/admin/units');
  const status = ['available', 'reserved', 'sold'].includes(req.body.status) ? req.body.status : unit.status;
  let image = unit.image;
  if (req.file) image = await storeFile(req.file);
  if (req.body.remove_image) image = null;
  const companyId = (await getCompany(req.tenantId, req.body.company_id))?.id ?? unit.company_id;
  await db.run(`UPDATE units SET area = ?, garden_area = ?, rooms = ?, bathrooms = ?, price = ?, garage_price = ?, status = ?, notes = ?, image = ?,
    company_id = ?, updated_at = datetime('now') WHERE id = ?`, numOrNull(req.body.area) ?? unit.area, numOrNull(req.body.garden_area) ?? 0, numOrNull(req.body.rooms), numOrNull(req.body.bathrooms),
    numOrNull(req.body.price), numOrNull(req.body.garage_price), status, String(req.body.notes || '').trim() || null, image, companyId, unit.id);
  req.flash('success', `تم حفظ الوحدة ${unit.code}`);
  res.redirect(`/admin/units#u${unit.id}`);
});

// Bulk pricing: price = area × price/m² + garden × garden price/m² (+ fixed amount), for a filtered set of units.
router.post('/units/bulk-price', async (req, res) => {
  const ppm = numOrNull(req.body.price_per_m2);
  const gpm = numOrNull(req.body.garden_price_per_m2) || 0;
  const fixed = numOrNull(req.body.fixed_amount) || 0;
  const garage = numOrNull(req.body.garage_price);
  const onlyUnpriced = !!req.body.only_unpriced;
  const where = ['tenant_id = ?'];
  const args = [req.tenantId];
  if (req.body.company_id) { where.push('company_id = ?'); args.push(Number(req.body.company_id)); }
  if (req.body.building) { where.push('building = ?'); args.push(req.body.building); }
  if (req.body.floor) { where.push('floor = ?'); args.push(req.body.floor); }
  if (req.body.model_no) { where.push('model_no = ?'); args.push(String(req.body.model_no).trim()); }
  if (onlyUnpriced) where.push('(price IS NULL OR price = 0)');
  where.push("status != 'sold'");
  const units = await db.all(`SELECT id, area, garden_area FROM units WHERE ${where.join(' AND ')}`, ...args);
  await db.batch(units.map((u) => [
    "UPDATE units SET price = COALESCE(?, price), garage_price = COALESCE(?, garage_price), updated_at = datetime('now') WHERE id = ?",
    ppm == null ? null : Math.round(u.area * ppm + (u.garden_area || 0) * gpm + fixed), garage, u.id,
  ]));
  req.flash('success', `تم تحديث أسعار ${units.length} وحدة (الوحدات المباعة لا تتأثر)`);
  res.redirect('/admin/units');
});

// Move a group of units (by building / floor / model) to a company.
router.post('/units/assign-company', async (req, res) => {
  const company = await getCompany(req.tenantId, req.body.target_company_id);
  if (!company) { req.flash('error', 'اختر الشركة'); return res.redirect('/admin/units'); }
  const where = ['tenant_id = ?'];
  const args = [req.tenantId];
  if (req.body.building) { where.push('building = ?'); args.push(req.body.building); }
  if (req.body.floor) { where.push('floor = ?'); args.push(req.body.floor); }
  if (req.body.model_no) { where.push('model_no = ?'); args.push(String(req.body.model_no).trim()); }
  const r = await db.run(`UPDATE units SET company_id = ?, updated_at = datetime('now') WHERE ${where.join(' AND ')}`, company.id, ...args);
  req.flash('success', `تم نقل ${r.changes} وحدة إلى ${company.name}`);
  res.redirect('/admin/units');
});

router.post('/units/import', friendly(memoryUpload.single('csv')), async (req, res) => {
  if (!req.file) { req.flash('error', 'برجاء اختيار ملف CSV'); return res.redirect('/admin/units'); }
  try {
    const units = unitsFromCsv(req.file.buffer.toString('utf8'));
    const companyId = (await getCompany(req.tenantId, req.body.company_id))?.id ?? await defaultCompanyId(req.tenantId);
    const r = await importUnits(req.tenantId, units, companyId);
    let msg = `تم الاستيراد: ${r.added} وحدة جديدة، ${r.updated} وحدة محدثة`;
    if (r.skipped.length) msg += ` — تم تخطي ${r.skipped.length} كود مسجل لشركة أخرى: ${r.skipped.slice(0, 10).join('، ')}`;
    req.flash(r.skipped.length ? 'warning' : 'success', msg);
  } catch (e) {
    req.flash('error', `تعذر قراءة الملف: ${e.message}`);
  }
  res.redirect('/admin/units');
});

router.get('/units/export.csv', async (req, res) => {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = ['MODEL NO.,FLOOR,CODE,AREA,GARDEN AREA,ROOMS,BATHROOMS,PRICE,GARAGE PRICE,STATUS,COMPANY,NOTES'];
  for (const u of await listUnits(req.tenantId)) {
    lines.push([u.model_no, `${u.floor} FLOOR`, u.code, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.garage_price, u.status, u.company_name, u.notes].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="units.csv"');
  res.send(`﻿${lines.join('\n')}`);
});

// ---------- Models (floor plans)
router.get('/models', async (req, res) => {
  const models = await db.all(`SELECT m.*, COUNT(u.id) AS units, GROUP_CONCAT(u.code, '، ') AS codes,
    MIN(u.area) AS min_area, MAX(u.area) AS max_area FROM models m LEFT JOIN units u ON u.tenant_id = m.tenant_id AND u.model_no = m.model_no
    WHERE m.tenant_id = ? GROUP BY m.id ORDER BY CAST(m.model_no AS INTEGER)`, req.tenantId);
  res.render('admin/models', { title: 'النماذج وصورها', models });
});

router.post('/models/:no', withImage('image'), async (req, res) => {
  const model = await db.get('SELECT * FROM models WHERE tenant_id = ? AND model_no = ?', req.tenantId, req.params.no);
  if (!model) return res.redirect('/admin/models');
  let image = model.image;
  if (req.file) image = await storeFile(req.file);
  if (req.body.remove_image) image = null;
  await db.run('UPDATE models SET rooms = ?, bathrooms = ?, description = ?, image = ? WHERE id = ?', numOrNull(req.body.rooms), numOrNull(req.body.bathrooms), String(req.body.description || '').trim() || null, image, model.id);
  req.flash('success', `تم حفظ النموذج ${model.model_no}`);
  res.redirect(`/admin/models#m${model.model_no}`);
});

// ---------- Settings
const SETTING_KEYS = [
  'default_discount_pct', 'max_discount_pct', 'default_down_payment_pct', 'min_down_payment_pct',
  'maintenance_pct', 'maintenance_skip_installments', 'default_years', 'default_frequency_months', 'max_years',
  'allowed_frequencies', 'default_garage_price', 'quote_validity_days', 'quote_terms',
];
const CHECKBOX_KEYS = ['garage_included_by_default', 'auto_status_on_contract', 'sign_every_page'];

router.get('/settings', async (req, res) => {
  res.render('admin/settings', { title: 'الإعدادات والأسعار' });
});

router.post('/settings', async (req, res) => {
  for (const k of SETTING_KEYS) if (k in req.body) await setSetting(req.tenantId, k, String(req.body[k]).trim());
  for (const k of CHECKBOX_KEYS) await setSetting(req.tenantId, k, req.body[k] ? '1' : '0');
  req.flash('success', 'تم حفظ الإعدادات');
  res.redirect('/admin/settings');
});

// ---------- Companies (print identity)
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function companyFields(body) {
  const s = (k) => String(body[k] || '').trim();
  return {
    name: s('name'), project_name: s('project_name'), address: s('address'), phone: s('phone'),
    owner_name: s('owner_name'), owner_phone: s('owner_phone'),
    primary_color: HEX_COLOR.test(s('primary_color')) ? s('primary_color') : '#1f2937',
    secondary_color: HEX_COLOR.test(s('secondary_color')) ? s('secondary_color') : null,
    font_family: f.COMPANY_FONTS.includes(s('font_family')) ? s('font_family') : 'Cairo',
    quote_terms: s('quote_terms') || null,
  };
}

router.get('/companies', async (req, res) => {
  res.render('admin/companies', { title: 'الشركات', companies: await listCompanies(req.tenantId) });
});

router.post('/companies', identityUpload, async (req, res) => {
  const c = companyFields(req.body);
  if (!c.name) { req.flash('error', 'اسم الشركة مطلوب'); return res.redirect('/admin/companies'); }
  await db.run(`INSERT INTO companies (tenant_id, name, project_name, address, phone, owner_name, owner_phone, primary_color, secondary_color, font_family, quote_terms,
    logo, font_file, stamp, master_plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.tenantId, c.name, c.project_name, c.address, c.phone, c.owner_name,
    c.owner_phone, c.primary_color, c.secondary_color, c.font_family, c.quote_terms, await uploaded(req, 'logo'), await uploaded(req, 'font'),
    await uploaded(req, 'stamp'), await uploaded(req, 'master_plan'));
  req.flash('success', `تمت إضافة ${c.name} — انقل وحداتها إليها من صفحة الوحدات أو استورد ملف وحداتها`);
  res.redirect('/admin/companies');
});

router.post('/companies/:id(\\d+)', identityUpload, async (req, res) => {
  const company = await getCompany(req.tenantId, req.params.id);
  if (!company) return res.redirect('/admin/companies');
  const c = companyFields(req.body);
  const logo = req.body.remove_logo ? null : (await uploaded(req, 'logo')) || company.logo;
  const font = req.body.remove_font ? null : (await uploaded(req, 'font')) || company.font_file;
  const stamp = req.body.remove_stamp ? null : (await uploaded(req, 'stamp')) || company.stamp;
  const masterPlan = req.body.remove_master_plan ? null : (await uploaded(req, 'master_plan')) || company.master_plan;
  await db.run(`UPDATE companies SET name = ?, project_name = ?, address = ?, phone = ?, owner_name = ?, owner_phone = ?, primary_color = ?, secondary_color = ?,
    font_family = ?, quote_terms = ?, logo = ?, font_file = ?, stamp = ?, master_plan = ? WHERE id = ?`, c.name || company.name, c.project_name, c.address,
    c.phone, c.owner_name, c.owner_phone, c.primary_color, c.secondary_color, c.font_family, c.quote_terms, logo, font, stamp, masterPlan, company.id);
  req.flash('success', `تم حفظ بيانات ${c.name || company.name} — تنطبق على العروض والعقود الجديدة`);
  res.redirect(`/admin/companies#c${company.id}`);
});

router.post('/companies/:id(\\d+)/delete', async (req, res) => {
  const company = await getCompany(req.tenantId, req.params.id);
  if (!company) return res.redirect('/admin/companies');
  const units = (await db.get('SELECT COUNT(*) AS c FROM units WHERE company_id = ?', company.id)).c;
  if (units) req.flash('error', `لا يمكن حذف الشركة — مرتبط بها ${units} وحدة. انقل الوحدات لشركة أخرى أولاً`);
  else {
    await db.run('DELETE FROM companies WHERE id = ?', company.id);
    req.flash('success', `تم حذف ${company.name}`);
  }
  res.redirect('/admin/companies');
});

// ---------- Contract template
// The general template is used by every company that has no wording of its own.
async function templateTarget(req) {
  const company = req.body?.company_id || req.query.company ? await getCompany(req.tenantId, req.body?.company_id || req.query.company) : null;
  return { company, back: company ? `/admin/template?company=${company.id}` : '/admin/template' };
}

async function saveTemplate(req, company, html) {
  if (company) await db.run('UPDATE companies SET contract_template = ? WHERE id = ?', html, company.id);
  else await setSetting(req.tenantId, 'contract_template', html ?? DEFAULT_CONTRACT_TEMPLATE);
}

router.get('/template', async (req, res) => {
  const { company } = await templateTarget(req);
  const settings = await getSettings(req.tenantId);
  res.render('admin/template', {
    title: 'صيغة العقد', placeholders: PLACEHOLDERS, companies: await listCompanies(req.tenantId), company,
    usesGeneral: company && !company.contract_template,
    template: (company && company.contract_template) || settings.contract_template,
  });
});

router.post('/template', async (req, res) => {
  const { company, back } = await templateTarget(req);
  if (req.body.reset) await saveTemplate(req, company, company ? null : DEFAULT_CONTRACT_TEMPLATE);
  else await saveTemplate(req, company, sanitizeTemplate(req.body.template));
  req.flash('success', req.body.reset && company
    ? `${company.name} ستستخدم الصيغة العامة`
    : 'تم حفظ صيغة العقد — العقود الجديدة ستُصاغ بها');
  res.redirect(back);
});

// Import the company's Word contract. Placeholders typed in the document as {{client_name}} are kept.
router.post('/template/docx', friendly(memoryUpload.single('docx')), async (req, res) => {
  const { company, back } = await templateTarget(req);
  if (!req.file) { req.flash('error', 'برجاء اختيار ملف Word (.docx)'); return res.redirect(back); }
  try {
    const result = await mammoth.convertToHtml({ buffer: req.file.buffer }, {
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Heading 1'] => h2:fresh", "p[style-name='Heading 2'] => h3:fresh"],
    });
    await saveTemplate(req, company, sanitizeTemplate(result.value));
    req.flash('success', 'تم استيراد العقد من ملف Word — راجع الصيغة وأضف أماكن البيانات والتوقيعات');
  } catch (e) {
    req.flash('error', 'تعذر قراءة ملف Word — تأكد أنه بصيغة .docx');
  }
  res.redirect(back);
});

module.exports = router;
