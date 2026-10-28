const { asyncRouter } = require('../router');
const bcrypt = require('bcryptjs');
const { db, getTenant } = require('../db');
const { requireAuth } = require('../auth');

const router = asyncRouter();

// Simple in-memory throttle against password guessing.
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const a = attempts.get(key) || { count: 0, first: now };
  if (now - a.first > 15 * 60 * 1000) { attempts.delete(key); return false; }
  return a.count >= 10;
}
function recordFailure(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.first > 15 * 60 * 1000) attempts.set(key, { count: 1, first: now });
  else a.count++;
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

router.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const error = req.query.suspended ? 'حساب الشركة موقوف — تواصل مع إدارة المنصة' : null;
  res.render('login', { title: 'تسجيل الدخول', error, next: safeNext(req.query.next), username: '' });
});

router.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const key = `${req.ip}:${username.toLowerCase()}`;
  const fail = (error) => res.status(401).render('login', { title: 'تسجيل الدخول', error, next, username });

  if (tooManyAttempts(key)) return fail('محاولات كثيرة غير صحيحة — حاول مرة أخرى بعد 15 دقيقة');
  const user = await db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(key);
    return fail('اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  if (!user.active) return fail('هذا الحساب موقوف — تواصل مع الأدمن');
  if (user.tenant_id != null && !(await getTenant(user.tenant_id))?.active) return fail('حساب الشركة موقوف — تواصل مع إدارة المنصة');
  attempts.delete(key);
  req.session.userId = user.id;
  req.session.tenantId = null;
  const home = user.role === 'admin' && user.tenant_id == null && next === '/' ? '/owner' : next;
  res.redirect(user.must_change_password ? '/account/password' : home);
});

router.post('/logout', async (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/account/password', requireAuth, async (req, res) => {
  res.render('password', { title: 'تغيير كلمة المرور', error: null });
});

router.post('/account/password', requireAuth, async (req, res) => {
  const { current, password, confirm } = req.body;
  const render = (error) => res.status(400).render('password', { title: 'تغيير كلمة المرور', error });
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return render('كلمة المرور الحالية غير صحيحة');
  if (String(password || '').length < 8) return render('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
  if (password !== confirm) return render('تأكيد كلمة المرور غير مطابق');
  if (password === current) return render('اختر كلمة مرور مختلفة عن الحالية');
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', bcrypt.hashSync(password, 10), req.user.id);
  req.flash('success', 'تم تغيير كلمة المرور بنجاح');
  res.redirect(req.isOwner ? '/owner' : '/');
});

module.exports = router;
