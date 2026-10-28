const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { ready, getSettings, getTenant, db, ConfigError } = require('./src/db');
const { UPLOAD_DIR } = require('./src/storage');
const f = require('./src/format');
const { loadUser, requireAuth, requireAdmin, requireOwner, requireTenant, sameOrigin } = require('./src/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// On Vercel the public/ folder is served by the CDN at the site root; locally Express does the same.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '4mb' }));
app.use(express.json({ limit: '2mb' }));

// The session secret comes from SESSION_SECRET, or is generated once and kept in the database.
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  await db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', 'session_secret', crypto.randomBytes(32).toString('hex'));
  return (await db.get('SELECT value FROM settings WHERE key = ?', 'session_secret')).value;
}

let session = null;
app.use(async (req, res, next) => {
  try {
    await ready();
    if (!session) {
      session = cookieSession({
        name: 'oc_session',
        keys: [await sessionSecret()],
        maxAge: 12 * 60 * 60 * 1000,
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === '1' || !!process.env.VERCEL,
      });
    }
    session(req, res, next);
  } catch (err) {
    next(err);
  }
});
app.use(sameOrigin);
app.use((req, res, next) => {
  res.locals.f = f;
  res.locals.path = req.path;
  res.locals.user = null;
  res.locals.settings = {};
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;
  req.flash = (type, message) => { req.session.flash = { type, message }; };
  next();
});
app.use(loadUser);

// Which client account this request works in: a client's own users always work in their account;
// the platform owner works in the account they chose to manage (or in the owner panel).
app.use(async (req, res, next) => {
  try {
    const user = req.user;
    req.isOwner = !!user && user.role === 'admin' && user.tenant_id == null;
    req.tenantId = user ? (req.isOwner ? req.session.tenantId || null : user.tenant_id) : null;
    req.tenant = req.tenantId ? await getTenant(req.tenantId) : null;
    if (user && !req.isOwner && (!req.tenant || !req.tenant.active)) {
      req.session = null;
      return res.redirect('/login?suspended=1');
    }
    if (req.isOwner && req.tenantId && !req.tenant) {
      req.session.tenantId = null;
      req.tenantId = null;
    }
    res.locals.isOwner = req.isOwner;
    res.locals.tenant = req.tenant;
    res.locals.settings = await getSettings(req.tenantId);
    next();
  } catch (err) {
    next(err);
  }
});

app.use(require('./src/routes/auth'));
app.use('/sign', require('./src/routes/sign'));
app.use('/owner', requireAuth, requireOwner, require('./src/routes/owner'));
app.use('/admin', requireAuth, requireTenant, requireAdmin, require('./src/routes/admin'));
app.use(requireAuth, requireTenant, require('./src/routes/app'));

app.use((req, res) => {
  // Logged so a "page not found" report can be traced in the hosting logs.
  console.warn(`[404] ${req.method} ${req.originalUrl} user=${req.user ? req.user.id : '-'} tenant=${req.tenantId || '-'}`);
  res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة المطلوبة غير موجودة', detail: `${req.method} ${req.originalUrl}`, user: res.locals.user || null });
});
app.use((err, req, res, next) => {
  console.error(err);
  // Missing database / file storage configuration: say exactly what to set up instead of a bare 500.
  const setup = err instanceof ConfigError;
  res.status(setup ? 503 : 500).render('error', {
    title: setup ? 'السيستم محتاج إعداد' : 'خطأ',
    message: setup || err.expose ? err.message : 'حدث خطأ غير متوقع',
    user: res.locals.user || null,
    f, settings: res.locals.settings || {}, path: req.path, flash: null,
  });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Offer & contract system running on http://localhost:${PORT}`));
}

module.exports = app;
