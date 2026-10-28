const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const cookieSession = require('cookie-session');
const { getSettings, setSetting, DATA_DIR } = require('./src/db');
const f = require('./src/format');
const { loadUser, requireAuth, requireAdmin, sameOrigin } = require('./src/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Session secret is generated once and kept in the data directory unless provided.
let secret = process.env.SESSION_SECRET || getSettings().session_secret;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting('session_secret', secret);
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.locals.UPLOAD_DIR = UPLOAD_DIR;

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieSession({
  name: 'oc_session',
  keys: [secret],
  maxAge: 12 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === '1',
}));
app.use(sameOrigin);
app.use((req, res, next) => {
  res.locals.f = f;
  const { session_secret: _secret, ...settings } = getSettings();
  res.locals.settings = settings;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;
  req.flash = (type, message) => { req.session.flash = { type, message }; };
  next();
});
app.use(loadUser);

app.use(require('./src/routes/auth'));
app.use('/sign', require('./src/routes/sign'));
app.use('/admin', requireAuth, requireAdmin, require('./src/routes/admin'));
app.use(requireAuth, require('./src/routes/app'));

app.use((req, res) => res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة المطلوبة غير موجودة' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'خطأ', message: err.expose ? err.message : 'حدث خطأ غير متوقع' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Offer & contract system running on http://localhost:${PORT}`));
}

module.exports = app;
