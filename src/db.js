const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { DEFAULT_CONTRACT_TEMPLATE, NEGM_CONTRACT_TEMPLATE } = require('./default-template');

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

// --- Schema
// The platform owner (Ebtikar) manages client accounts ("tenants"). Everything a client works with —
// users, print identities (companies), units, models, quotes, contracts and settings — belongs to one tenant.
// The owner is an admin user without a tenant.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
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

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  project_name TEXT,
  address TEXT,
  phone TEXT,
  logo TEXT,
  owner_name TEXT,
  owner_phone TEXT,
  primary_color TEXT NOT NULL DEFAULT '#1f2937',
  secondary_color TEXT,
  font_family TEXT,
  font_file TEXT,
  stamp TEXT,
  master_plan TEXT,
  contract_template TEXT,
  quote_terms TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  model_no TEXT NOT NULL,
  rooms INTEGER,
  bathrooms INTEGER,
  image TEXT,
  description TEXT,
  UNIQUE (tenant_id, model_no)
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  company_id INTEGER,
  code TEXT NOT NULL COLLATE NOCASE,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_phone TEXT,
  unit_id INTEGER NOT NULL,
  unit_snapshot TEXT NOT NULL,
  inputs TEXT NOT NULL,
  plan TEXT NOT NULL,
  offer_date TEXT NOT NULL,
  valid_until TEXT,
  company TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  quote_id INTEGER,
  unit_id INTEGER NOT NULL,
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
  company TEXT,
  extras TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, number)
);

CREATE INDEX IF NOT EXISTS users_tenant ON users (tenant_id);
CREATE INDEX IF NOT EXISTS companies_tenant ON companies (tenant_id);
CREATE INDEX IF NOT EXISTS units_tenant ON units (tenant_id);
CREATE INDEX IF NOT EXISTS quotes_tenant ON quotes (tenant_id);
CREATE INDEX IF NOT EXISTS contracts_tenant ON contracts (tenant_id);
`;
const SCHEMA_VERSION = '2';

// --- Upgrade from the single-company version (schema 1): its data becomes the first client account.
const V1_COLUMNS = [
  ['units', 'company_id', 'INTEGER'], ['quotes', 'company', 'TEXT'], ['contracts', 'company', 'TEXT'],
  ['companies', 'secondary_color', 'TEXT'], ['companies', 'font_family', 'TEXT'], ['companies', 'font_file', 'TEXT'],
  ['companies', 'stamp', 'TEXT'], ['companies', 'master_plan', 'TEXT'], ['contracts', 'extras', 'TEXT'],
];

async function addColumn(table, column, type) {
  const cols = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
  if (cols.includes(column)) return;
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e; // another instance migrated first
  }
}

const tableSql = (name) => SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))[0];
const asNew = (name) => tableSql(name).replace(`CREATE TABLE IF NOT EXISTS ${name} (`, `CREATE TABLE ${name}_v2 (`);

async function migrateFromV1() {
  for (const c of V1_COLUMNS) await addColumn(...c);
  const firstCompany = await db.get('SELECT name FROM companies ORDER BY id LIMIT 1');
  const UNIT_COLS = 'id, company_id, code, building, entrance, floor, model_no, area, garden_area, rooms, bathrooms, price, garage_price, status, image, notes, updated_at';
  const QUOTE_COLS = 'id, number, client_name, client_phone, unit_id, unit_snapshot, inputs, plan, offer_date, valid_until, company, created_by, created_at';
  const CONTRACT_COLS = `id, number, quote_id, unit_id, client, unit_snapshot, inputs, plan, contract_date, body_html, status, client_token, company_token,
    client_signature, client_signer_name, client_signed_at, client_signed_ip, company_signature, company_signer_name, company_signed_at,
    company_signed_ip, body_hash, company, extras, created_by, created_at`;
  // One atomic batch: either the whole upgrade happens or nothing does.
  await db.batch([
    [tableSql('tenants')],
    ['INSERT INTO tenants (id, name) VALUES (1, ?)', firstCompany?.name || 'عمر نجم جروب'],
    ['ALTER TABLE users ADD COLUMN tenant_id INTEGER'],
    // The first admin becomes the platform owner; everyone else belongs to the first client.
    ["UPDATE users SET tenant_id = 1 WHERE id != (SELECT MIN(id) FROM users WHERE role = 'admin')"],
    ['ALTER TABLE companies ADD COLUMN tenant_id INTEGER'],
    ['UPDATE companies SET tenant_id = 1'],
    [tableSql('tenant_settings')],
    ["INSERT INTO tenant_settings (tenant_id, key, value) SELECT 1, key, value FROM settings WHERE key NOT IN ('session_secret', 'schema_version')"],
    ["DELETE FROM settings WHERE key NOT IN ('session_secret')"],
    [asNew('models')],
    ['INSERT INTO models_v2 (tenant_id, model_no, rooms, bathrooms, image, description) SELECT 1, model_no, rooms, bathrooms, image, description FROM models'],
    [asNew('units')],
    [`INSERT INTO units_v2 (tenant_id, ${UNIT_COLS}) SELECT 1, ${UNIT_COLS} FROM units`],
    [asNew('quotes')],
    [`INSERT INTO quotes_v2 (tenant_id, ${QUOTE_COLS}) SELECT 1, ${QUOTE_COLS} FROM quotes`],
    [asNew('contracts')],
    [`INSERT INTO contracts_v2 (tenant_id, ${CONTRACT_COLS}) SELECT 1, ${CONTRACT_COLS} FROM contracts`],
    ['DROP TABLE contracts'], ['DROP TABLE quotes'], ['DROP TABLE units'], ['DROP TABLE models'],
    ['ALTER TABLE models_v2 RENAME TO models'], ['ALTER TABLE units_v2 RENAME TO units'],
    ['ALTER TABLE quotes_v2 RENAME TO quotes'], ['ALTER TABLE contracts_v2 RENAME TO contracts'],
    ["INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION],
  ]);
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
  sign_every_page: '1',
  quote_terms: 'هذا العرض استرشادي وصالح للمدة الموضحة أعلاه، ولا يُعد حجزاً للوحدة إلا بعد سداد مقدم الحجز وتوقيع العقد.',
  contract_template: DEFAULT_CONTRACT_TEMPLATE,
};

// Settings are per client; values not set yet fall back to the defaults above.
async function getSettings(tenantId) {
  const out = { ...DEFAULT_SETTINGS };
  if (tenantId == null) return out;
  for (const row of await db.all('SELECT key, value FROM tenant_settings WHERE tenant_id = ?', tenantId)) out[row.key] = row.value;
  return out;
}

async function setSetting(tenantId, key, value) {
  await db.run(`INSERT INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`, tenantId, key, value == null ? '' : String(value));
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

// Upsert units for one client: inserts new codes; for existing codes updates physical data and
// only overwrites optional columns (rooms/price/status) when the CSV provides them.
async function importUnits(tenantId, units, companyId) {
  const existing = new Map((await db.all('SELECT id, code FROM units WHERE tenant_id = ?', tenantId)).map((u) => [u.code.toUpperCase(), u]));
  const statements = [];
  let added = 0, updated = 0;
  for (const u of units) {
    const row = existing.get(u.code);
    if (u.model_no) statements.push(['INSERT OR IGNORE INTO models (tenant_id, model_no) VALUES (?, ?)', tenantId, u.model_no]);
    if (row) {
      statements.push([`UPDATE units SET building = ?, entrance = ?, floor = ?, model_no = ?, area = ?, garden_area = ?,
        rooms = COALESCE(?, rooms), bathrooms = COALESCE(?, bathrooms), price = COALESCE(?, price), status = COALESCE(?, status),
        company_id = COALESCE(?, company_id), updated_at = datetime('now') WHERE id = ?`,
      u.building, u.entrance, u.floor, u.model_no, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.status, companyId || null, row.id]);
      updated++;
    } else {
      statements.push([`INSERT OR IGNORE INTO units (tenant_id, code, building, entrance, floor, model_no, area, garden_area, rooms, bathrooms, price, status, company_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tenantId, u.code, u.building, u.entrance, u.floor, u.model_no, u.area, u.garden_area, u.rooms, u.bathrooms, u.price, u.status || 'available', companyId || null]);
      added++;
    }
  }
  await db.batch(statements);
  return { added, updated, skipped: [] };
}

// --- Companies (print identities) of a client
const COMPANY_FIELDS = ['name', 'project_name', 'address', 'phone', 'logo', 'owner_name', 'owner_phone', 'primary_color', 'secondary_color',
  'font_family', 'font_file', 'stamp', 'master_plan', 'contract_template', 'quote_terms'];

function listCompanies(tenantId) {
  return db.all(`SELECT c.*, (SELECT COUNT(*) FROM units u WHERE u.company_id = c.id) AS units
    FROM companies c WHERE c.tenant_id = ? ORDER BY c.id`, tenantId);
}

function getCompany(tenantId, id) {
  if (id == null || id === '') return Promise.resolve(null);
  return db.get('SELECT * FROM companies WHERE id = ? AND tenant_id = ?', id, tenantId);
}

async function defaultCompanyId(tenantId) {
  return (await db.get('SELECT id FROM companies WHERE tenant_id = ? ORDER BY id LIMIT 1', tenantId))?.id ?? null;
}

// The identity frozen on a quote/contract when it is issued.
function companySnapshot(company) {
  if (!company) return null;
  const { contract_template: _t, created_at: _c, units: _u, tenant_id: _tn, ...rest } = company;
  return rest;
}

// --- Client accounts
function listTenants() {
  return db.all(`SELECT t.*,
    (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS users,
    (SELECT COUNT(*) FROM units u WHERE u.tenant_id = t.id) AS units,
    (SELECT COUNT(*) FROM quotes q WHERE q.tenant_id = t.id) AS quotes,
    (SELECT COUNT(*) FROM contracts c WHERE c.tenant_id = t.id AND c.status != 'cancelled') AS contracts
    FROM tenants t ORDER BY t.id`);
}

function getTenant(id) {
  if (id == null || id === '') return Promise.resolve(null);
  return db.get('SELECT * FROM tenants WHERE id = ?', id);
}

// A new client starts with its own print identity and, optionally, its first admin account.
async function createTenant({ name, projectName, admin }) {
  const { lastInsertRowid: tenantId } = await db.run('INSERT INTO tenants (name) VALUES (?)', name);
  await db.run('INSERT INTO companies (tenant_id, name, project_name) VALUES (?, ?, ?)', tenantId, name, projectName || null);
  if (admin) {
    await db.run(`INSERT INTO users (tenant_id, username, password_hash, full_name, role, must_change_password)
      VALUES (?, ?, ?, ?, 'admin', 1)`, tenantId, admin.username, bcrypt.hashSync(admin.password, 10), admin.fullName);
  }
  return tenantId;
}

// --- Schema, upgrades and first-run data. Every step is idempotent, so concurrent
// cold starts (several serverless instances at once) cannot create duplicates.
async function initialize() {
  if (!DB_URL || DB_URL.startsWith('file:')) await getClient().executeMultiple('PRAGMA journal_mode = WAL;');
  await db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);');
  const version = (await db.get("SELECT value FROM settings WHERE key = 'schema_version'"))?.value;
  if (version !== SCHEMA_VERSION && await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'units'")) {
    try {
      await migrateFromV1();
      console.log('[setup] تمت ترقية قاعدة البيانات: البيانات الحالية أصبحت حساب العميل الأول');
    } catch (e) {
      // Another instance may have upgraded at the same moment.
      if ((await db.get("SELECT value FROM settings WHERE key = 'schema_version'"))?.value !== SCHEMA_VERSION) throw e;
    }
  }
  await db.exec(SCHEMA);
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);

  // Platform owner account.
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = (process.env.ADMIN_PASSWORD || 'admin123').trim();
  if (!(await db.get("SELECT id FROM users WHERE role = 'admin' AND tenant_id IS NULL LIMIT 1"))) {
    const r = await db.run(`INSERT OR IGNORE INTO users (tenant_id, username, password_hash, full_name, role, must_change_password)
      VALUES (NULL, ?, ?, 'مالك النظام', 'admin', 1)`, username, bcrypt.hashSync(password, 10));
    if (r.changes) console.log(`[setup] تم إنشاء حساب مالك النظام: ${username} / ${process.env.ADMIN_PASSWORD ? '(من ADMIN_PASSWORD)' : password} — سيُطلب تغيير كلمة المرور عند أول دخول.`);
  }
  // ADMIN_USERNAME / ADMIN_PASSWORD may be set or changed after the first run created the owner.
  // Until the owner picks their own password, keep the account in line with them.
  if (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD) {
    const owner = await db.get("SELECT id, username, password_hash, must_change_password FROM users WHERE role = 'admin' AND tenant_id IS NULL ORDER BY id LIMIT 1");
    if (owner && owner.must_change_password) {
      if (process.env.ADMIN_USERNAME && owner.username.toLowerCase() !== username.toLowerCase()
        && !(await db.get('SELECT id FROM users WHERE username = ?', username))) {
        await db.run('UPDATE users SET username = ? WHERE id = ?', username, owner.id);
      }
      if (process.env.ADMIN_PASSWORD && !bcrypt.compareSync(password, owner.password_hash)) {
        await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), owner.id);
      }
    }
  }

  // First client on a new installation: عمر نجم جروب with its units list and contract.
  const csvPath = path.join(__dirname, '..', 'data', 'units.csv');
  if (fs.existsSync(csvPath)) {
    const created = await db.run("INSERT INTO tenants (id, name) SELECT 1, 'عمر نجم جروب' WHERE NOT EXISTS (SELECT 1 FROM tenants)");
    if (created.changes) {
      await db.run("INSERT INTO companies (tenant_id, name, project_name, font_family) SELECT 1, 'عمر نجم جروب', 'كمباوند شرفات', 'Arial' WHERE NOT EXISTS (SELECT 1 FROM companies WHERE tenant_id = 1)");
      await db.run("INSERT OR IGNORE INTO tenant_settings (tenant_id, key, value) VALUES (1, 'contract_template', ?)", NEGM_CONTRACT_TEMPLATE);
      await importUnits(1, unitsFromCsv(fs.readFileSync(csvPath, 'utf8')), await defaultCompanyId(1));
    }
  }
  await db.run('UPDATE units SET company_id = (SELECT MIN(c.id) FROM companies c WHERE c.tenant_id = units.tenant_id) WHERE company_id IS NULL');

  // The عمر نجم جروب contract was first stored without the original's page layout; bring stored copies of it
  // up to date (only copies of that contract — a client's own wording is never replaced).
  const NEGM_MARK = 'وادينا للاستثمار العقاري';
  const pageCount = (t) => (t.match(/class="page-break"/g) || []).length;
  for (const row of await db.all("SELECT tenant_id, value FROM tenant_settings WHERE key = 'contract_template' AND value LIKE ?", `%${NEGM_MARK}%`)) {
    if (row.value !== NEGM_CONTRACT_TEMPLATE && pageCount(row.value) < pageCount(NEGM_CONTRACT_TEMPLATE)) {
      await setSetting(row.tenant_id, 'contract_template', NEGM_CONTRACT_TEMPLATE);
      await db.run("UPDATE companies SET font_family = 'Arial' WHERE tenant_id = ? AND font_family IS NULL", row.tenant_id);
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
  FROM units u LEFT JOIN models m ON m.tenant_id = u.tenant_id AND m.model_no = u.model_no LEFT JOIN companies c ON c.id = u.company_id`;

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

async function getUnitByCode(tenantId, code) {
  return hydrateUnit(await db.get(`${UNIT_SELECT} WHERE u.tenant_id = ? AND u.code = ?`, tenantId, String(code || '').trim()));
}

async function getUnitById(tenantId, id) {
  return hydrateUnit(await db.get(`${UNIT_SELECT} WHERE u.tenant_id = ? AND u.id = ?`, tenantId, id));
}

async function listUnits(tenantId) {
  return (await db.all(`${UNIT_SELECT} WHERE u.tenant_id = ? ORDER BY u.building, u.entrance, u.code`, tenantId)).map(hydrateUnit);
}

// Quote / contract numbers run per client.
async function nextNumber(tenantId, table, prefix) {
  const year = new Date().getFullYear();
  const row = await db.get(`SELECT number FROM ${table} WHERE tenant_id = ? AND number LIKE ? ORDER BY id DESC LIMIT 1`, tenantId, `${prefix}-${year}-%`);
  const last = row ? Number(row.number.split('-').pop()) : 0;
  return `${prefix}-${year}-${String(last + 1).padStart(4, '0')}`;
}

module.exports = {
  db, DATA_DIR, ConfigError, envBySuffix, ready, DEFAULT_SETTINGS, getSettings, setSetting, unitsFromCsv, importUnits,
  getUnitByCode, getUnitById, listUnits, nextNumber,
  COMPANY_FIELDS, listCompanies, getCompany, defaultCompanyId, companySnapshot,
  listTenants, getTenant, createTenant,
};
