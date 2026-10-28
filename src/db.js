const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { DEFAULT_CONTRACT_TEMPLATE } = require('./default-template');

// Storage: Turso / libSQL in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN),
// a local SQLite file otherwise. The SQL is the same in both cases.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// Vercel's storage integrations may add a custom prefix to variable names (e.g. STORAGE_TURSO_DATABASE_URL),
// so look the values up by suffix.
function envBySuffix(suffixes, accept = () => true) {
  for (const suffix of suffixes) {
    if (process.env[suffix] && accept(process.env[suffix])) return process.env[suffix];
    const key = Object.keys(process.env).find((k) => k.endsWith(`_${suffix}`) && process.env[k] && accept(process.env[k]));
    if (key) return process.env[key];
  }
  return null;
}
const isLibsqlUrl = (v) => /^(libsql|https?|wss?|file):/.test(v);
const DB_URL = envBySuffix(['TURSO_DATABASE_URL', 'LIBSQL_URL', 'TURSO_URL', 'DATABASE_URL'], isLibsqlUrl);
const DB_TOKEN = envBySuffix(['TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN', 'TURSO_TOKEN']);

class ConfigError extends Error {}

function createDbClient() {
  if (DB_URL && !DB_URL.startsWith('file:')) {
    const { createClient } = require('@libsql/client/web');
    return createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });
  }
  // Serverless platforms have a read-only, throw-away disk: a local file would lose every write.
  if (process.env.VERCEL && !DB_URL) {
    const related = Object.keys(process.env).filter((k) => /TURSO|LIBSQL|DATABASE/i.test(k));
    throw new ConfigError('لم يتم ربط قاعدة البيانات: اربط قاعدة Turso بالمشروع من تبويب Storage في Vercel ثم اعمل Redeploy'
      + (related.length ? ` — المتغيرات الموجودة: ${related.join('، ')}` : ' — لا توجد أي متغيرات لقاعدة البيانات في هذا النشر'));
  }
  const url = DB_URL || `file:${path.join(DATA_DIR, 'app.db')}`;
  fs.mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true });
  const { createClient } = require('@libsql/client');
  return createClient({ url });
}

let client = null;
function getClient() {
  if (!client) client = createDbClient();
  return client;
}

const toObject = (rs, row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]]));
const stmt = (sql, args) => ({ sql, args: args.map((a) => (a === undefined ? null : a)) });

// Thin async helpers mirroring the get/all/run style used throughout the app.
const db = {
  async get(sql, ...args) {
    const rs = await getClient().execute(stmt(sql, args));
    return rs.rows.length ? toObject(rs, rs.rows[0]) : null;
  },
  async all(sql, ...args) {
    const rs = await getClient().execute(stmt(sql, args));
    return rs.rows.map((r) => toObject(rs, r));
  },
  async run(sql, ...args) {
    const rs = await getClient().execute(stmt(sql, args));
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
  },
  async exec(sql) {
    await getClient().executeMultiple(sql);
  },
  // Runs several statements atomically: [[sql, ...args], ...]
  async batch(statements) {
    if (!statements.length) return [];
    return getClient().batch(statements.map(([sql, ...args]) => stmt(sql, args)), 'write');
  },
};

const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  project_name TEXT,
  address TEXT,
  phone TEXT,
  logo TEXT,
  owner_name TEXT,
  owner_phone TEXT,
  primary_color TEXT NOT NULL DEFAULT '#1f2937',
  contract_template TEXT,
  quote_terms TEXT,
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
`;

// Columns added after the first release.
const MIGRATIONS = [
  ['units', 'company_id', 'INTEGER REFERENCES companies(id)'],
  ['quotes', 'company', 'TEXT'],
  ['contracts', 'company', 'TEXT'],
  ['companies', 'secondary_color', 'TEXT'],
  ['companies', 'font_family', 'TEXT'],
  ['companies', 'font_file', 'TEXT'],
  ['companies', 'stamp', 'TEXT'],
  ['companies', 'master_plan', 'TEXT'],
  ['contracts', 'extras', 'TEXT'],
];

async function addColumn(table, column, type) {
  const cols = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (!cols.includes(column)) {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e; // another instance migrated first
    }
  }
}

const DEFAULT_SETTINGS = {
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

async function getSettings() {
  const out = {};
  for (const row of await db.all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

async function setSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, value == null ? '' : String(value));
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
// Unit codes are unique across the whole system; a code already owned by another company is skipped.
async function importUnits(units, companyId) {
  const existing = new Map((await db.all('SELECT id, code, company_id FROM units')).map((u) => [u.code.toUpperCase(), u]));
  const statements = [];
  let added = 0, updated = 0;
  const skipped = [];
  for (const u of units) {
    const row = existing.get(u.code);
    if (row && companyId && row.company_id && row.company_id !== companyId) { skipped.push(u.code); continue; }
    if (u.model_no) statements.push(['INSERT OR IGNORE INTO models (model_no) VALUES (?)', u.model_no]);
    if (row) {
      statements.push([`UPDATE units SET building = ?, entrance = ?, floor = ?, model_no = ?, area = ?, garden_area = ?,
        rooms = COALESCE(?, rooms), bathrooms = COALESCE(?, bathrooms), price = COALESCE(?, price), status = COALESCE(?, status),
        updated_at = datetime('now') WHERE id = ?`,
      u.building, u.entrance, u.floor, u.model_no, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.status, row.id]);
      updated++;
    } else {
      statements.push([`INSERT OR IGNORE INTO units (code, building, entrance, floor, model_no, area, garden_area, rooms, bathrooms, price, status, company_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.code, u.building, u.entrance, u.floor, u.model_no, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.status || 'available', companyId || null]);
      added++;
    }
  }
  await db.batch(statements);
  return { added, updated, skipped };
}

// --- Companies
// Each company has its own print identity (logo, colour, details, signatory, contract wording).
const COMPANY_FIELDS = ['name', 'project_name', 'address', 'phone', 'logo', 'owner_name', 'owner_phone', 'primary_color', 'secondary_color',
  'font_family', 'font_file', 'stamp', 'master_plan', 'contract_template', 'quote_terms'];

function listCompanies() {
  return db.all(`SELECT c.*, (SELECT COUNT(*) FROM units u WHERE u.company_id = c.id) AS units
    FROM companies c ORDER BY c.id`);
}

function getCompany(id) {
  if (id == null || id === '') return Promise.resolve(null);
  return db.get('SELECT * FROM companies WHERE id = ?', id);
}

async function defaultCompanyId() {
  return (await db.get('SELECT id FROM companies ORDER BY id LIMIT 1'))?.id ?? null;
}

// The identity frozen on a quote/contract when it is issued.
function companySnapshot(company) {
  if (!company) return null;
  const { contract_template: _t, created_at: _c, units: _u, ...rest } = company;
  return rest;
}

// --- Schema, migrations and first-run data. Every step is idempotent, so concurrent
// cold starts (several serverless instances at once) cannot create duplicates.
async function initialize() {
  const c = getClient();
  if (!DB_URL || DB_URL.startsWith('file:')) await c.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  await db.exec(SCHEMA);
  for (const m of MIGRATIONS) await addColumn(...m);
  await db.batch(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ['INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v]));

  // Carry over the single-company settings of earlier versions, if any.
  const old = await getSettings();
  await db.run(`INSERT INTO companies (name, project_name, address, phone, logo, owner_name, owner_phone)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM companies)`,
  old.company_name || 'عمر نجم جروب', old.project_name || 'كمباوند شرفات', old.company_address || '',
  old.company_phone || '', old.company_logo || null, old.owner_name || '', old.owner_phone || '');

  if ((await db.get('SELECT COUNT(*) AS c FROM units')).c === 0) {
    const csvPath = path.join(__dirname, '..', 'data', 'units.csv');
    if (fs.existsSync(csvPath)) await importUnits(unitsFromCsv(fs.readFileSync(csvPath, 'utf8')));
  }
  await db.run('UPDATE units SET company_id = ? WHERE company_id IS NULL', await defaultCompanyId());

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = (process.env.ADMIN_PASSWORD || 'admin123').trim();
  if ((await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")).c === 0) {
    const r = await db.run(`INSERT OR IGNORE INTO users (username, password_hash, full_name, role, must_change_password)
      VALUES (?, ?, 'مدير النظام', 'admin', 1)`, username, bcrypt.hashSync(password, 10));
    if (r.changes) console.log(`[setup] تم إنشاء حساب الأدمن: ${username} / ${process.env.ADMIN_PASSWORD ? '(من ADMIN_PASSWORD)' : password} — سيُطلب تغيير كلمة المرور عند أول دخول.`);
  }

  // ADMIN_USERNAME / ADMIN_PASSWORD may be set or changed after the first run created the admin.
  // Until that first admin picks their own password, keep the account in line with them.
  if (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD) {
    const admin = await db.get("SELECT id, username, password_hash, must_change_password FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    if (admin && admin.must_change_password) {
      if (process.env.ADMIN_USERNAME && admin.username.toLowerCase() !== username.toLowerCase()
        && !(await db.get('SELECT id FROM users WHERE username = ?', username))) {
        await db.run('UPDATE users SET username = ? WHERE id = ?', username, admin.id);
      }
      if (process.env.ADMIN_PASSWORD && !bcrypt.compareSync(password, admin.password_hash)) {
        await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), admin.id);
      }
    }
  }
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = initialize().catch((e) => {
      readyPromise = null; // retry on the next request
      throw e;
    });
  }
  return readyPromise;
}

// Unit with model data merged in (unit values override model values).
const UNIT_SELECT = `SELECT u.*, m.rooms AS model_rooms, m.bathrooms AS model_bathrooms, m.image AS model_image, m.description AS model_description,
  c.name AS company_name, c.project_name AS project_name
  FROM units u LEFT JOIN models m ON m.model_no = u.model_no LEFT JOIN companies c ON c.id = u.company_id`;

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

async function getUnitByCode(code) {
  return hydrateUnit(await db.get(`${UNIT_SELECT} WHERE u.code = ?`, String(code || '').trim()));
}

async function getUnitById(id) {
  return hydrateUnit(await db.get(`${UNIT_SELECT} WHERE u.id = ?`, id));
}

async function listUnits() {
  return (await db.all(`${UNIT_SELECT} ORDER BY u.building, u.entrance, u.code`)).map(hydrateUnit);
}

async function nextNumber(table, prefix) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const row = await db.get(`SELECT number FROM ${table} WHERE number LIKE ? ORDER BY id DESC LIMIT 1`, like);
  const last = row ? Number(row.number.split('-').pop()) : 0;
  return `${prefix}-${year}-${String(last + 1).padStart(4, '0')}`;
}

module.exports = {
  db, DATA_DIR, ConfigError, envBySuffix, ready, getSettings, setSetting, unitsFromCsv, importUnits,
  getUnitByCode, getUnitById, listUnits, nextNumber,
  COMPANY_FIELDS, listCompanies, getCompany, defaultCompanyId, companySnapshot,
};
