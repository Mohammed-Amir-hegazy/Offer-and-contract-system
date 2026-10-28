const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const mammoth = require('mammoth');
const { db, getSettings, setSetting, unitsFromCsv, importUnits, listUnits, listCompanies, getCompany, defaultCompanyId } = require('../db');
const { PLACEHOLDERS, sanitizeTemplate } = require('../template');
const { DEFAULT_CONTRACT_TEMPLATE } = require('../default-template');
const f = require('../format');

const router = express.Router();

const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function imageUpload(req) {
  const dir = req.app.locals.UPLOAD_DIR;
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (r, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${IMAGE_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (r, file, cb) => cb(null, !!IMAGE_TYPES[file.mimetype]),
  });
}
const withImage = (field) => (req, res, next) => imageUpload(req).single(field)(req, res, next);

// Company identity uploads: logo, stamp and master-plan images, and an optional font file.
const FONT_EXTS = ['.ttf', '.otf', '.woff', '.woff2'];
function identityUpload(req, res, next) {
  const ext = (file) => (file.fieldname === 'font' ? path.extname(file.originalname).toLowerCase() : IMAGE_TYPES[file.mimetype]);
  multer({
    storage: multer.diskStorage({
      destination: req.app.locals.UPLOAD_DIR,
      filename: (r, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${ext(file)}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (r, file, cb) => cb(null, file.fieldname === 'font' ? FONT_EXTS.includes(ext(file)) : !!IMAGE_TYPES[file.mimetype]),
  }).fields([{ name: 'logo', maxCount: 1 }, { name: 'font', maxCount: 1 }, { name: 'stamp', maxCount: 1 }, { name: 'master_plan', maxCount: 1 }])(req, res, next);
}
const uploaded = (req, field) => req.files?.[field]?.[0]?.filename || null;
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function removeUpload(req, name) {
  if (!name) return;
  const p = path.join(req.app.locals.UPLOAD_DIR, path.basename(name));
  fs.rm(p, { force: true }, () => {});
}

const numOrNull = (v) => (v == null || String(v).trim() === '' ? null : Number(String(v).replace(/,/g, '')));
const pct = (v) => {
  const n = numOrNull(v);
  return n == null || !Number.isFinite(n) ? null : Math.min(100, Math.max(0, n));
};

// ---------- Overview
router.get('/', (req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  const stats = {
    users: count('SELECT COUNT(*) AS c FROM users'),
    units: count('SELECT COUNT(*) AS c FROM units'),
    unpriced: count('SELECT COUNT(*) AS c FROM units WHERE price IS NULL OR price = 0'),
    available: count("SELECT COUNT(*) AS c FROM units WHERE status = 'available'"),
    reserved: count("SELECT COUNT(*) AS c FROM units WHERE status = 'reserved'"),
    sold: count("SELECT COUNT(*) AS c FROM units WHERE status = 'sold'"),
    quotes: count('SELECT COUNT(*) AS c FROM quotes'),
    contracts: count("SELECT COUNT(*) AS c FROM contracts WHERE status != 'cancelled'"),
    signed: count("SELECT COUNT(*) AS c FROM contracts WHERE status = 'signed'"),
    modelsNoImage: count('SELECT COUNT(*) AS c FROM models WHERE image IS NULL'),
    companies: count('SELECT COUNT(*) AS c FROM companies'),
  };
  res.render('admin/index', { title: 'لوحة الأدمن', stats });
});

// ---------- Users
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY role, full_name').all();
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

router.post('/users', (req, res) => {
  const u = userFields({ ...req.body, active: 1 });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !u.full_name || password.length < 8) {
    req.flash('error', 'اسم المستخدم والاسم الكامل مطلوبان، وكلمة المرور 8 أحرف على الأقل');
    return res.redirect('/admin/users');
  }
  try {
    db.prepare(`INSERT INTO users (username, password_hash, full_name, role, can_quote, can_contract, max_discount_pct, min_down_payment_pct, max_years, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(username, bcrypt.hashSync(password, 10), u.full_name, u.role, u.can_quote, u.can_contract,
      u.max_discount_pct, u.min_down_payment_pct, u.max_years);
    req.flash('success', `تم إنشاء حساب ${u.full_name} — سيُطلب منه تغيير كلمة المرور عند أول دخول`);
  } catch (e) {
    req.flash('error', String(e.message).includes('UNIQUE') ? 'اسم المستخدم مستخدم بالفعل' : 'تعذر إنشاء المستخدم');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const u = userFields(req.body);
  if (target.id === req.user.id) { u.role = 'admin'; u.active = 1; } // an admin cannot lock themself out
  db.prepare(`UPDATE users SET full_name = ?, role = ?, active = ?, can_quote = ?, can_contract = ?, max_discount_pct = ?, min_down_payment_pct = ?, max_years = ?
    WHERE id = ?`).run(u.full_name || target.full_name, u.role, u.active, u.can_quote, u.can_contract, u.max_discount_pct, u.min_down_payment_pct, u.max_years, target.id);
  const password = String(req.body.password || '');
  if (password) {
    if (password.length < 8) req.flash('error', 'كلمة المرور يجب ألا تقل عن 8 أحرف — لم يتم تغييرها');
    else db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(password, 10), target.id);
  }
  if (!req.session.flash) req.flash('success', 'تم حفظ بيانات المستخدم');
  res.redirect('/admin/users');
});

// ---------- Units
router.get('/units', (req, res) => {
  const units = listUnits();
  const buildings = [...new Set(units.map((u) => u.building))].sort();
  res.render('admin/units', { title: 'الوحدات', units, buildings, floors: f.FLOOR_LABELS, companies: listCompanies() });
});

router.post('/units/:id(\\d+)', withImage('image'), (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  if (!unit) return res.redirect('/admin/units');
  const status = ['available', 'reserved', 'sold'].includes(req.body.status) ? req.body.status : unit.status;
  let image = unit.image;
  if (req.file) { removeUpload(req, unit.image); image = req.file.filename; }
  if (req.body.remove_image) { removeUpload(req, unit.image); image = null; }
  const companyId = getCompany(req.body.company_id)?.id ?? unit.company_id;
  db.prepare(`UPDATE units SET area = ?, garden_area = ?, rooms = ?, bathrooms = ?, price = ?, garage_price = ?, status = ?, notes = ?, image = ?,
    company_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    numOrNull(req.body.area) ?? unit.area, numOrNull(req.body.garden_area) ?? 0, numOrNull(req.body.rooms), numOrNull(req.body.bathrooms),
    numOrNull(req.body.price), numOrNull(req.body.garage_price), status, String(req.body.notes || '').trim() || null, image, companyId, unit.id,
  );
  req.flash('success', `تم حفظ الوحدة ${unit.code}`);
  res.redirect(`/admin/units#u${unit.id}`);
});

// Bulk pricing: price = area × price/m² + garden × garden price/m² (+ fixed amount), for a filtered set of units.
router.post('/units/bulk-price', (req, res) => {
  const ppm = numOrNull(req.body.price_per_m2);
  const gpm = numOrNull(req.body.garden_price_per_m2) || 0;
  const fixed = numOrNull(req.body.fixed_amount) || 0;
  const garage = numOrNull(req.body.garage_price);
  const onlyUnpriced = !!req.body.only_unpriced;
  const where = ['1=1'];
  const args = [];
  if (req.body.company_id) { where.push('company_id = ?'); args.push(Number(req.body.company_id)); }
  if (req.body.building) { where.push('building = ?'); args.push(req.body.building); }
  if (req.body.floor) { where.push('floor = ?'); args.push(req.body.floor); }
  if (req.body.model_no) { where.push('model_no = ?'); args.push(String(req.body.model_no).trim()); }
  if (onlyUnpriced) where.push('(price IS NULL OR price = 0)');
  where.push("status != 'sold'");
  const units = db.prepare(`SELECT id, area, garden_area FROM units WHERE ${where.join(' AND ')}`).all(...args);
  const upd = db.prepare("UPDATE units SET price = COALESCE(?, price), garage_price = COALESCE(?, garage_price), updated_at = datetime('now') WHERE id = ?");
  db.exec('BEGIN');
  for (const u of units) {
    const price = ppm == null ? null : Math.round(u.area * ppm + (u.garden_area || 0) * gpm + fixed);
    upd.run(price, garage, u.id);
  }
  db.exec('COMMIT');
  req.flash('success', `تم تحديث أسعار ${units.length} وحدة (الوحدات المباعة لا تتأثر)`);
  res.redirect('/admin/units');
});

// Move a group of units (by building / floor / model) to a company.
router.post('/units/assign-company', (req, res) => {
  const company = getCompany(req.body.target_company_id);
  if (!company) { req.flash('error', 'اختر الشركة'); return res.redirect('/admin/units'); }
  const where = ['1=1'];
  const args = [];
  if (req.body.building) { where.push('building = ?'); args.push(req.body.building); }
  if (req.body.floor) { where.push('floor = ?'); args.push(req.body.floor); }
  if (req.body.model_no) { where.push('model_no = ?'); args.push(String(req.body.model_no).trim()); }
  const r = db.prepare(`UPDATE units SET company_id = ?, updated_at = datetime('now') WHERE ${where.join(' AND ')}`).run(company.id, ...args);
  req.flash('success', `تم نقل ${r.changes} وحدة إلى ${company.name}`);
  res.redirect('/admin/units');
});

router.post('/units/import', memoryUpload.single('csv'), (req, res) => {
  if (!req.file) { req.flash('error', 'برجاء اختيار ملف CSV'); return res.redirect('/admin/units'); }
  try {
    const units = unitsFromCsv(req.file.buffer.toString('utf8'));
    const companyId = getCompany(req.body.company_id)?.id ?? defaultCompanyId();
    const r = importUnits(units, companyId);
    let msg = `تم الاستيراد: ${r.added} وحدة جديدة، ${r.updated} وحدة محدثة`;
    if (r.skipped.length) msg += ` — تم تخطي ${r.skipped.length} كود مسجل لشركة أخرى: ${r.skipped.slice(0, 10).join('، ')}`;
    req.flash(r.skipped.length ? 'warning' : 'success', msg);
  } catch (e) {
    req.flash('error', `تعذر قراءة الملف: ${e.message}`);
  }
  res.redirect('/admin/units');
});

router.get('/units/export.csv', (req, res) => {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = ['MODEL NO.,FLOOR,CODE,AREA,GARDEN AREA,ROOMS,BATHROOMS,PRICE,GARAGE PRICE,STATUS,COMPANY,NOTES'];
  for (const u of listUnits()) {
    lines.push([u.model_no, `${u.floor} FLOOR`, u.code, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.garage_price, u.status, u.company_name, u.notes].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="units.csv"');
  res.send(`﻿${lines.join('\n')}`);
});

// ---------- Models (floor plans)
router.get('/models', (req, res) => {
  const models = db.prepare(`SELECT m.*, COUNT(u.id) AS units, GROUP_CONCAT(u.code, '، ') AS codes,
    MIN(u.area) AS min_area, MAX(u.area) AS max_area FROM models m LEFT JOIN units u ON u.model_no = m.model_no
    GROUP BY m.model_no ORDER BY CAST(m.model_no AS INTEGER)`).all();
  res.render('admin/models', { title: 'النماذج وصورها', models });
});

router.post('/models/:no', withImage('image'), (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE model_no = ?').get(req.params.no);
  if (!model) return res.redirect('/admin/models');
  let image = model.image;
  if (req.file) { removeUpload(req, model.image); image = req.file.filename; }
  if (req.body.remove_image) { removeUpload(req, model.image); image = null; }
  db.prepare('UPDATE models SET rooms = ?, bathrooms = ?, description = ?, image = ? WHERE model_no = ?')
    .run(numOrNull(req.body.rooms), numOrNull(req.body.bathrooms), String(req.body.description || '').trim() || null, image, model.model_no);
  req.flash('success', `تم حفظ النموذج ${model.model_no}`);
  res.redirect(`/admin/models#m${model.model_no}`);
});

// ---------- Settings
const SETTING_KEYS = [
  'default_discount_pct', 'max_discount_pct', 'default_down_payment_pct', 'min_down_payment_pct',
  'maintenance_pct', 'maintenance_skip_installments', 'default_years', 'default_frequency_months', 'max_years',
  'allowed_frequencies', 'default_garage_price', 'quote_validity_days', 'quote_terms',
];
const CHECKBOX_KEYS = ['garage_included_by_default', 'auto_status_on_contract'];

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'الإعدادات والأسعار' });
});

router.post('/settings', (req, res) => {
  for (const k of SETTING_KEYS) if (k in req.body) setSetting(k, String(req.body[k]).trim());
  for (const k of CHECKBOX_KEYS) setSetting(k, req.body[k] ? '1' : '0');
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

router.get('/companies', (req, res) => {
  res.render('admin/companies', { title: 'الشركات', companies: listCompanies() });
});

// Logo and font files are kept on disk when replaced: issued quotes and contracts still reference them.
router.post('/companies', identityUpload, (req, res) => {
  const c = companyFields(req.body);
  if (!c.name) { req.flash('error', 'اسم الشركة مطلوب'); return res.redirect('/admin/companies'); }
  db.prepare(`INSERT INTO companies (name, project_name, address, phone, owner_name, owner_phone, primary_color, secondary_color, font_family, quote_terms,
    logo, font_file, stamp, master_plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.name, c.project_name, c.address, c.phone, c.owner_name,
    c.owner_phone, c.primary_color, c.secondary_color, c.font_family, c.quote_terms, uploaded(req, 'logo'), uploaded(req, 'font'),
    uploaded(req, 'stamp'), uploaded(req, 'master_plan'));
  req.flash('success', `تمت إضافة ${c.name} — انقل وحداتها إليها من صفحة الوحدات أو استورد ملف وحداتها`);
  res.redirect('/admin/companies');
});

router.post('/companies/:id(\\d+)', identityUpload, (req, res) => {
  const company = getCompany(req.params.id);
  if (!company) return res.redirect('/admin/companies');
  const c = companyFields(req.body);
  const logo = req.body.remove_logo ? null : uploaded(req, 'logo') || company.logo;
  const font = req.body.remove_font ? null : uploaded(req, 'font') || company.font_file;
  const stamp = req.body.remove_stamp ? null : uploaded(req, 'stamp') || company.stamp;
  const masterPlan = req.body.remove_master_plan ? null : uploaded(req, 'master_plan') || company.master_plan;
  db.prepare(`UPDATE companies SET name = ?, project_name = ?, address = ?, phone = ?, owner_name = ?, owner_phone = ?, primary_color = ?, secondary_color = ?,
    font_family = ?, quote_terms = ?, logo = ?, font_file = ?, stamp = ?, master_plan = ? WHERE id = ?`).run(c.name || company.name, c.project_name, c.address,
    c.phone, c.owner_name, c.owner_phone, c.primary_color, c.secondary_color, c.font_family, c.quote_terms, logo, font, stamp, masterPlan, company.id);
  req.flash('success', `تم حفظ بيانات ${c.name || company.name} — تنطبق على العروض والعقود الجديدة`);
  res.redirect(`/admin/companies#c${company.id}`);
});

router.post('/companies/:id(\\d+)/delete', (req, res) => {
  const company = getCompany(req.params.id);
  if (!company) return res.redirect('/admin/companies');
  const units = db.prepare('SELECT COUNT(*) AS c FROM units WHERE company_id = ?').get(company.id).c;
  if (units) req.flash('error', `لا يمكن حذف الشركة — مرتبط بها ${units} وحدة. انقل الوحدات لشركة أخرى أولاً`);
  else {
    db.prepare('DELETE FROM companies WHERE id = ?').run(company.id);
    req.flash('success', `تم حذف ${company.name}`);
  }
  res.redirect('/admin/companies');
});

// ---------- Contract template
// The general template is used by every company that has no wording of its own.
function templateTarget(req) {
  const company = req.body?.company_id || req.query.company ? getCompany(req.body?.company_id || req.query.company) : null;
  return { company, back: company ? `/admin/template?company=${company.id}` : '/admin/template' };
}

function saveTemplate(company, html) {
  if (company) db.prepare('UPDATE companies SET contract_template = ? WHERE id = ?').run(html, company.id);
  else setSetting('contract_template', html ?? DEFAULT_CONTRACT_TEMPLATE);
}

router.get('/template', (req, res) => {
  const { company } = templateTarget(req);
  const settings = getSettings();
  res.render('admin/template', {
    title: 'صيغة العقد', placeholders: PLACEHOLDERS, companies: listCompanies(), company,
    usesGeneral: company && !company.contract_template,
    template: (company && company.contract_template) || settings.contract_template,
  });
});

router.post('/template', (req, res) => {
  const { company, back } = templateTarget(req);
  if (req.body.reset) saveTemplate(company, company ? null : DEFAULT_CONTRACT_TEMPLATE);
  else saveTemplate(company, sanitizeTemplate(req.body.template));
  req.flash('success', req.body.reset && company
    ? `${company.name} ستستخدم الصيغة العامة`
    : 'تم حفظ صيغة العقد — العقود الجديدة ستُصاغ بها');
  res.redirect(back);
});

// Import the company's Word contract. Placeholders typed in the document as {{client_name}} are kept.
router.post('/template/docx', memoryUpload.single('docx'), async (req, res) => {
  const { company, back } = templateTarget(req);
  if (!req.file) { req.flash('error', 'برجاء اختيار ملف Word (.docx)'); return res.redirect(back); }
  try {
    const result = await mammoth.convertToHtml({ buffer: req.file.buffer }, {
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Heading 1'] => h2:fresh", "p[style-name='Heading 2'] => h3:fresh"],
    });
    saveTemplate(company, sanitizeTemplate(result.value));
    req.flash('success', 'تم استيراد العقد من ملف Word — راجع الصيغة وأضف أماكن البيانات والتوقيعات');
  } catch (e) {
    req.flash('error', 'تعذر قراءة ملف Word — تأكد أنه بصيغة .docx');
  }
  res.redirect(back);
});

module.exports = router;
