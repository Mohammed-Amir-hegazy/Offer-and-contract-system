// Platform owner (Ebtikar): manages client accounts and can step into any of them.
const { asyncRouter } = require('../router');
const { db, listTenants, getTenant, createTenant } = require('../db');

const router = asyncRouter();

router.get('/', async (req, res) => {
  const tenants = await listTenants();
  const admins = await db.all("SELECT tenant_id, username, full_name FROM users WHERE role = 'admin' AND tenant_id IS NOT NULL ORDER BY id");
  res.render('owner/index', { title: 'لوحة مالك النظام', tenants, admins });
});

router.post('/tenants', async (req, res) => {
  const s = (k) => String(req.body[k] || '').trim();
  const name = s('name');
  const username = s('admin_username');
  const password = String(req.body.admin_password || '');
  if (!name) {
    req.flash('error', 'اسم العميل مطلوب');
    return res.redirect('/owner');
  }
  if (username && (password.length < 8 || !s('admin_name'))) {
    req.flash('error', 'لحساب أدمن العميل: الاسم الكامل مطلوب وكلمة المرور 8 أحرف على الأقل');
    return res.redirect('/owner');
  }
  if (username && await db.get('SELECT id FROM users WHERE username = ?', username)) {
    req.flash('error', `اسم المستخدم "${username}" مستخدم بالفعل`);
    return res.redirect('/owner');
  }
  await createTenant({
    name,
    projectName: s('project_name'),
    admin: username ? { username, password, fullName: s('admin_name') } : null,
  });
  req.flash('success', `تم إنشاء حساب ${name}${username ? ` — أدمن العميل يدخل بـ ${username} وسيُطلب منه تغيير كلمة المرور` : ''}`);
  res.redirect('/owner');
});

router.post('/tenants/:id(\\d+)', async (req, res) => {
  const tenant = await getTenant(req.params.id);
  if (!tenant) return res.redirect('/owner');
  const name = String(req.body.name || '').trim() || tenant.name;
  await db.run('UPDATE tenants SET name = ?, active = ?, notes = ? WHERE id = ?',
    name, req.body.active ? 1 : 0, String(req.body.notes || '').trim() || null, tenant.id);
  req.flash('success', `تم حفظ بيانات ${name}${req.body.active ? '' : ' — الحساب موقوف ولا يمكن لمستخدميه الدخول'}`);
  res.redirect('/owner');
});

// Work inside a client account with full admin rights.
router.post('/tenants/:id(\\d+)/manage', async (req, res) => {
  const tenant = await getTenant(req.params.id);
  if (!tenant) return res.redirect('/owner');
  req.session.tenantId = tenant.id;
  req.flash('success', `أنت الآن داخل حساب ${tenant.name}`);
  res.redirect('/admin');
});

router.post('/exit', async (req, res) => {
  req.session.tenantId = null;
  res.redirect('/owner');
});

module.exports = router;
