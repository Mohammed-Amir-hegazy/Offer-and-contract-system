const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { ready, getSettings, db, ConfigError } = require('./src/db');
const { UPLOAD_DIR } = require('./src/storage');
const f = require('./src/format');
const { loadUser, requireAuth, requireAdmin, sameOrigin } = require('./src/auth');

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
app.use(async (req, res, next) => {
  try {
    res.locals.f = f;
    const { session_secret: _secret, ...settings } = await getSettings();
    res.locals.settings = settings;
    res.locals.path = req.path;
    res.locals.user = null;
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) req.session.flash = null;
    req.flash = (type, message) => { req.session.flash = { type, message }; };
    next();
  } catch (err) {
    next(err);
  }
});
app.use(loadUser);

app.use(require('./src/routes/auth'));
app.use('/sign', require('./src/routes/sign'));
app.use('/admin', requireAuth, requireAdmin, require('./src/routes/admin'));
app.use(requireAuth, require('./src/routes/app'));

app.use((req, res) => res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة المطلوبة غير موجودة', user: res.locals.user || null }));
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
