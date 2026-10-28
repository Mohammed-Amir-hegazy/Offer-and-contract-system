const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { DEFAULT_CONTRACT_TEMPLATE } = require('./default-template');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  can_quote INTEGER NOT NULL DEFAULT 1,
  can_contract INTEGER NOT NULL DEFAULT 1,
  max_discount_pct REAL,
  min_down_payment_pct REAL,
  max_years REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  model_no TEXT PRIMARY KEY,
  rooms INTEGER,
  bathrooms INTEGER,
  image TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  building TEXT NOT NULL,
  entrance TEXT,
  floor TEXT NOT NULL,
  model_no TEXT,
  area REAL NOT NULL DEFAULT 0,
  garden_area REAL NOT NULL DEFAULT 0,
  rooms INTEGER,
  bathrooms INTEGER,
  price REAL,
  garage_price REAL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','sold')),
  image TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  client_phone TEXT,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  unit_snapshot TEXT NOT NULL,
  inputs TEXT NOT NULL,
  plan TEXT NOT NULL,
  offer_date TEXT NOT NULL,
  valid_until TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  quote_id INTEGER REFERENCES quotes(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  client TEXT NOT NULL,
  unit_snapshot TEXT NOT NULL,
  inputs TEXT NOT NULL,
  plan TEXT NOT NULL,
  contract_date TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','signed','cancelled')),
  client_token TEXT UNIQUE,
  company_token TEXT UNIQUE,
  client_signature TEXT,
  client_signer_name TEXT,
  client_signed_at TEXT,
  client_signed_ip TEXT,
  company_signature TEXT,
  company_signer_name TEXT,
  company_signed_at TEXT,
  company_signed_ip TEXT,
  body_hash TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const DEFAULT_SETTINGS = {
  company_name: 'شركة التطوير العقاري',
  project_name: 'نجم كمبوند 5',
  company_address: '',
  company_phone: '',
  company_logo: '',
  owner_name: '',
  owner_phone: '',
  currency: 'ج.م',
  default_discount_pct: '0',
  max_discount_pct: '10',
  default_down_payment_pct: '10',
  min_down_payment_pct: '5',
  maintenance_pct: '8',
  maintenance_skip_installments: '8',
  default_years: '5',
  default_frequency_months: '3',
  max_years: '10',
  allowed_frequencies: '1,3,6,12',
  default_garage_price: '0',
  garage_included_by_default: '1',
  quote_validity_days: '7',
  auto_status_on_contract: '1',
  quote_terms: 'هذا العرض استرشادي وصالح للمدة الموضحة أعلاه، ولا يُعد حجزاً للوحدة إلا بعد سداد مقدم الحجز وتوقيع العقد.',
  contract_template: DEFAULT_CONTRACT_TEMPLATE,
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

// --- Units CSV parsing (MODEL NO., FLOOR, CODE, AREA, GARDEN AREA [, ROOMS, BATHROOMS, PRICE, STATUS])
const FLOOR_KEYS = {
  'GROUND FLOOR': 'GROUND', GROUND: 'GROUND', 'الأرضي': 'GROUND', 'ارضي': 'GROUND', 'أرضي': 'GROUND',
  'FIRST FLOOR': 'FIRST', FIRST: 'FIRST', 'الأول': 'FIRST', 'اول': 'FIRST',
  'SECOND FLOOR': 'SECOND', SECOND: 'SECOND', 'الثاني': 'SECOND', 'ثاني': 'SECOND',
  'THIRD FLOOR': 'THIRD', THIRD: 'THIRD', 'الثالث': 'THIRD', 'ثالث': 'THIRD',
  'FOURTH FLOOR': 'FOURTH', FOURTH: 'FOURTH', 'الرابع': 'FOURTH', 'رابع': 'FOURTH',
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function unitsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toUpperCase().replace(/\.$/, ''));
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const col = {
    model: idx(['MODEL NO', 'MODEL', 'النموذج']),
    floor: idx(['FLOOR', 'الدور']),
    code: idx(['CODE', 'الكود']),
    area: idx(['AREA', 'المساحة']),
    garden: idx(['GARDEN AREA', 'GARDEN', 'الحديقة']),
    rooms: idx(['ROOMS', 'الغرف']),
    baths: idx(['BATHROOMS', 'الحمامات']),
    price: idx(['PRICE', 'السعر']),
    status: idx(['STATUS', 'الحالة']),
  };
  if (col.code < 0) throw new Error('ملف CSV لا يحتوي على عمود CODE');
  const units = [];
  for (const r of rows.slice(1)) {
    const code = (r[col.code] || '').trim().toUpperCase();
    if (!code) continue;
    const floorRaw = (r[col.floor] || '').trim();
    const floor = FLOOR_KEYS[floorRaw.toUpperCase()] || FLOOR_KEYS[floorRaw] || floorRaw.toUpperCase() || 'GROUND';
    const [building, entrance] = code.split('-');
    let status = col.status >= 0 ? (r[col.status] || '').trim().toLowerCase() : '';
    if (['sold', 'مباعة', 'مباع'].includes(status)) status = 'sold';
    else if (['reserved', 'محجوزة', 'محجوز'].includes(status)) status = 'reserved';
    else status = col.status >= 0 && status === 'available' ? 'available' : null;
    units.push({
      code,
      building: building || '',
      entrance: entrance || '',
      floor,
      model_no: col.model >= 0 ? (r[col.model] || '').trim() || null : null,
      area: num(r[col.area]) || 0,
      garden_area: col.garden >= 0 ? num(r[col.garden]) || 0 : 0,
      rooms: col.rooms >= 0 ? num(r[col.rooms]) : null,
      bathrooms: col.baths >= 0 ? num(r[col.baths]) : null,
      price: col.price >= 0 ? num(r[col.price]) : null,
      status,
    });
  }
  return units;
}

// Upsert units: inserts new codes; for existing codes updates physical data and
// only overwrites optional columns (rooms/price/status) when the CSV provides them.
function importUnits(units) {
  const existing = db.prepare('SELECT id FROM units WHERE code = ?');
  const insert = db.prepare(`INSERT INTO units (code, building, entrance, floor, model_no, area, garden_area, rooms, bathrooms, price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE units SET building = ?, entrance = ?, floor = ?, model_no = ?, area = ?, garden_area = ?,
    rooms = COALESCE(?, rooms), bathrooms = COALESCE(?, bathrooms), price = COALESCE(?, price), status = COALESCE(?, status),
    updated_at = datetime('now') WHERE id = ?`);
  const insertModel = db.prepare('INSERT OR IGNORE INTO models (model_no) VALUES (?)');
  let added = 0, updated = 0;
  db.exec('BEGIN');
  try {
    for (const u of units) {
      if (u.model_no) insertModel.run(u.model_no);
      const row = existing.get(u.code);
      if (row) {
        update.run(u.building, u.entrance, u.floor, u.model_no, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.status, row.id);
        updated++;
      } else {
        insert.run(u.code, u.building, u.entrance, u.floor, u.model_no, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.status || 'available');
        added++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, updated };
}

// --- Seed
if (db.prepare('SELECT COUNT(*) AS c FROM units').get().c === 0) {
  const csvPath = path.join(__dirname, '..', 'data', 'units.csv');
  if (fs.existsSync(csvPath)) importUnits(unitsFromCsv(fs.readFileSync(csvPath, 'utf8')));
}

if (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role, must_change_password)
    VALUES (?, ?, 'مدير النظام', 'admin', 1)`).run(username, bcrypt.hashSync(password, 10));
  console.log(`[setup] تم إنشاء حساب الأدمن: ${username} / ${process.env.ADMIN_PASSWORD ? '(من ADMIN_PASSWORD)' : password} — سيُطلب تغيير كلمة المرور عند أول دخول.`);
}

// Unit with model data merged in (unit values override model values).
const UNIT_SELECT = `SELECT u.*, m.rooms AS model_rooms, m.bathrooms AS model_bathrooms, m.image AS model_image, m.description AS model_description
  FROM units u LEFT JOIN models m ON m.model_no = u.model_no`;

function hydrateUnit(u) {
  if (!u) return null;
  return {
    ...u,
    own_rooms: u.rooms,
    own_bathrooms: u.bathrooms,
    own_image: u.image,
    rooms: u.rooms ?? u.model_rooms ?? null,
    bathrooms: u.bathrooms ?? u.model_bathrooms ?? null,
    image: u.image || u.model_image || null,
  };
}

function getUnitByCode(code) {
  return hydrateUnit(db.prepare(`${UNIT_SELECT} WHERE u.code = ?`).get(String(code || '').trim()));
}

function getUnitById(id) {
  return hydrateUnit(db.prepare(`${UNIT_SELECT} WHERE u.id = ?`).get(id));
}

function listUnits() {
  return db.prepare(`${UNIT_SELECT} ORDER BY u.building, u.entrance, u.code`).all().map(hydrateUnit);
}

function nextNumber(table, prefix) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const row = db.prepare(`SELECT number FROM ${table} WHERE number LIKE ? ORDER BY id DESC LIMIT 1`).get(like);
  const last = row ? Number(row.number.split('-').pop()) : 0;
  return `${prefix}-${year}-${String(last + 1).padStart(4, '0')}`;
}

module.exports = {
  db, DATA_DIR, getSettings, setSetting, unitsFromCsv, importUnits,
  getUnitByCode, getUnitById, listUnits, nextNumber,
};
