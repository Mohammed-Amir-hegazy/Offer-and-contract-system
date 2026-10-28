const { db } = require('./db');

async function loadUser(req, res, next) {
  try {
    const id = req.session && req.session.userId;
    if (id) {
      const user = await db.get('SELECT * FROM users WHERE id = ?', id);
      // Deactivated users are logged out immediately.
      if (user && user.active) req.user = user;
      else req.session = null;
    }
    res.locals.user = req.user || null;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
    return res.redirect('/account/password');
  }
  next();
}

// The platform owner must pick a client account before using client pages.
function requireTenant(req, res, next) {
  if (req.tenantId) return next();
  if (req.isOwner) return res.redirect('/owner');
  res.status(403).render('error', { title: 'غير مسموح', message: 'هذا الحساب غير مرتبط بأي شركة' });
}

function requireOwner(req, res, next) {
  if (!req.isOwner) return res.status(403).render('error', { title: 'غير مسموح', message: 'هذه الصفحة متاحة لمالك النظام فقط' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).render('error', { title: 'غير مسموح', message: 'هذه الصفحة متاحة للأدمن فقط' });
  next();
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (req.user.role === 'admin' || req.user[perm]) return next();
    res.status(403).render('error', { title: 'غير مسموح', message: 'ليس لديك صلاحية لهذه العملية — تواصل مع الأدمن' });
  };
}

// Reject cross-site form posts (in addition to SameSite cookies).
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch { /* fall through */ }
  res.status(403).send('Forbidden');
}

module.exports = { loadUser, requireAuth, requireAdmin, requireOwner, requireTenant, requirePermission, sameOrigin };
