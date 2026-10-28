const { asyncRouter } = require('../router');
const { db, getSettings, getCompany, companySnapshot } = require('../db');
const { applySignatures, hashBody } = require('../template');
const { nowLocal } = require('../format');

const router = asyncRouter();

// A signature must be a reasonably sized PNG data URL produced by the signature pad.
const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_SIGNATURE_LENGTH = 1_500_000;

async function findByToken(token) {
  if (!token || token.length < 20) return null;
  const c = await db.get('SELECT * FROM contracts WHERE client_token = ? OR company_token = ?', token, token);
  if (!c) return null;
  const party = c.client_token === token ? 'client' : 'company';
  const unit = JSON.parse(c.unit_snapshot);
  const company = c.company ? JSON.parse(c.company) : companySnapshot(await getCompany(c.tenant_id, unit.company_id)) || {};
  return { contract: { ...c, client: JSON.parse(c.client), company }, party };
}

async function render(res, found, extra = {}) {
  const { contract, party } = found;
  res.locals.settings = await getSettings(contract.tenant_id);
  res.render('sign', {
    title: `توقيع العقد ${contract.number}`,
    contract,
    company: contract.company,
    party,
    alreadySigned: !!contract[`${party}_signed_at`],
    body: applySignatures(contract.body_html, contract),
    error: null,
    ...extra,
  });
}

router.get('/:token', async (req, res) => {
  const found = await findByToken(req.params.token);
  if (!found || found.contract.status === 'cancelled') {
    return res.status(404).render('error', { title: 'رابط غير صالح', message: 'رابط التوقيع غير صالح أو تم إلغاؤه' });
  }
  await render(res, found);
});

router.post('/:token', async (req, res) => {
  const found = await findByToken(req.params.token);
  if (!found || found.contract.status === 'cancelled') {
    return res.status(404).render('error', { title: 'رابط غير صالح', message: 'رابط التوقيع غير صالح أو تم إلغاؤه' });
  }
  const { contract, party } = found;
  if (contract[`${party}_signed_at`]) return res.redirect(`/sign/${req.params.token}`);

  const signature = String(req.body.signature || '');
  const name = String(req.body.signerName || '').trim();
  const fail = (error) => render(res.status(400), found, { error });

  if (contract.body_hash && contract.body_hash !== hashBody(contract.body_html)) return fail('تم تعديل نص العقد بعد إرسال الرابط — برجاء طلب رابط جديد');
  if (!req.body.agree) return fail('يجب الموافقة على بنود العقد قبل التوقيع');
  if (!name) return fail('برجاء كتابة الاسم بالكامل');
  if (!SIGNATURE_RE.test(signature) || signature.length > MAX_SIGNATURE_LENGTH) return fail('برجاء رسم التوقيع في المربع المخصص');
  if (party === 'client') {
    const nid = String(req.body.nationalId || '').replace(/\s/g, '');
    if (contract.client.national_id && nid !== contract.client.national_id.replace(/\s/g, '')) {
      return fail('الرقم القومي غير مطابق للرقم المسجل في العقد');
    }
  }

  const ip = (req.ip || '').replace(/^::ffff:/, '');
  const now = nowLocal();
  // Guard against a double submit: only sign if this party has not signed yet.
  const result = await db.run(`UPDATE contracts SET ${party}_signature = ?, ${party}_signer_name = ?, ${party}_signed_at = ?, ${party}_signed_ip = ?
    WHERE id = ? AND ${party}_signed_at IS NULL`, signature, name, now, ip, contract.id);

  if (result.changes) {
    const updated = await db.get('SELECT * FROM contracts WHERE id = ?', contract.id);
    if (updated.client_signed_at && updated.company_signed_at) {
      await db.run("UPDATE contracts SET status = 'signed' WHERE id = ?", contract.id);
      if ((await getSettings(contract.tenant_id)).auto_status_on_contract === '1') {
        await db.run("UPDATE units SET status = 'sold', updated_at = datetime('now') WHERE id = ?", contract.unit_id);
      }
    }
  }
  res.redirect(`/sign/${req.params.token}`);
});

module.exports = router;
