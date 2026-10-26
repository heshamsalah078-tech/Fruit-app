'use strict';
// Staff accounts (self-set passwords via one-time activation codes), ops-manager order assignment,
// SMS on/off switch, audit log.
// Mounted from server.js:  const staffAdmin = require('./staffAdmin').init({ pool, requireAuth, express, withItems });

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROLES = ['prep', 'delivery', 'admin', 'finance', 'ops'];
const ALL_STAFF = ROLES;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_TTL_HOURS = 72;
const MAX_ATTEMPTS = 5;
const DUMMY_HASH = bcrypt.hashSync('dummy-value-for-timing', 10);

function genCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function init({ pool, requireAuth, express, withItems }) {
  const router = express.Router();

  async function audit(db, action, actorId, targetId, details) {
    try {
      await db.query('INSERT INTO staff_audit (action, actor_id, target_id, details) VALUES ($1,$2,$3,$4)',
        [action, actorId || null, targetId || null, details ? JSON.stringify(details) : null]);
    } catch (e) { console.error('audit failed', e.message); }
  }

  async function smsEnabled(db = pool) {
    const r = await db.query(`SELECT value FROM app_settings WHERE key='sms_enabled'`);
    return !!(r.rows[0] && r.rows[0].value === 'true');
  }

  // >>> Plug the real Egyptian SMS gateway in here when you subscribe. Until then it throws. <<<
  async function sendViaProvider(phone, text) {
    throw new Error('SMS provider not implemented yet');
  }

  // Delivers an activation code to the EMPLOYEE (never returned to the manager's screen).
  // SMS switch OFF (test mode): the code is written to the server log only.
  async function deliverCode(phone, code) {
    const text = 'كود تفعيل حسابك في سوق الطازج: ' + code;
    if (await smsEnabled()) {
      try { await sendViaProvider(phone, text); return { sent: true }; }
      catch (e) {
        console.error('[ACTIVATION] SMS is ON but sending failed (' + e.message + '). Falling back to log.');
      }
    }
    console.log('[ACTIVATION-CODE] phone=' + phone + ' code=' + code + ' (valid ' + CODE_TTL_HOURS + 'h)');
    return { sent: false };
  }

  // Wipes any password and issues a fresh one-time code. The account stays locked until it is used.
  async function issueActivation(db, staffId, phone, actorId, action) {
    const code = genCode();
    const hash = await bcrypt.hash(code, 10);
    await db.query(
      `UPDATE staff SET password_hash=NULL, activation_code_hash=$1,
              activation_expires_at = now() + ($2 || ' hours')::interval, activation_attempts=0
        WHERE id=$3`, [hash, String(CODE_TTL_HOURS), staffId]);
    await audit(db, action, actorId, staffId, null);
    return deliverCode(phone, code);
  }

  // ---------- activation (public) ----------
  router.post('/auth/staff-activate', async (req, res) => {
    const phone = String(req.body.phone || '').trim();
    const code = String(req.body.code || '').toUpperCase().replace(/[\s-]/g, '');
    const password = String(req.body.password || '');
    const fail = () => res.status(400).json({ error: 'invalid_code', message: 'كود التفعيل غير صحيح أو انتهت صلاحيته. اطلب من الإدارة كود جديد.' });
    if (password.length < 6) return res.status(400).json({ error: 'short_password', message: 'كلمة السر لازم تكون 6 أحرف على الأقل.' });
    try {
      const r = await pool.query(
        'SELECT id, active, activation_code_hash, activation_expires_at, activation_attempts FROM staff WHERE phone=$1', [phone]);
      const s = r.rows[0];
      if (!s || !s.active || !s.activation_code_hash) { await bcrypt.compare(code, DUMMY_HASH); return fail(); }
      if (new Date(s.activation_expires_at) < new Date() || s.activation_attempts >= MAX_ATTEMPTS) return fail();
      const ok = await bcrypt.compare(code, s.activation_code_hash);
      if (!ok) {
        await pool.query('UPDATE staff SET activation_attempts = activation_attempts + 1 WHERE id=$1', [s.id]);
        return fail();
      }
      const hash = await bcrypt.hash(password, 10);
      const u = await pool.query(
        `UPDATE staff SET password_hash=$1, activation_code_hash=NULL, activation_expires_at=NULL, activation_attempts=0
          WHERE id=$2 AND activation_code_hash IS NOT NULL RETURNING id`, [hash, s.id]);
      if (!u.rows.length) return fail();
      await audit(pool, 'activated', s.id, s.id, null);
      res.json({ ok: true, message: 'تم تفعيل حسابك. سجّل الدخول بكلمة السر الجديدة.' });
    } catch (e) {
      console.error('activate failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التفعيل.' });
    }
  });

  // ---------- manager: create / edit / reset (admin only) ----------
  router.post('/auth/staff-create', requireAuth('admin'), async (req, res) => {
    const { name, phone, role, job_title, address, phone2, settlement_mode } = req.body;
    if (!ROLES.includes(role) || !name || !String(name).trim() || !phone || !String(phone).trim()) {
      return res.status(400).json({ error: 'invalid', message: 'البيانات غير مكتملة.' });
    }
    if (settlement_mode && !['per_order', 'daily', 'weekly', 'suspended'].includes(settlement_mode)) {
      return res.status(400).json({ error: 'invalid_settlement_mode' });
    }
    try {
      const dup = await pool.query('SELECT id FROM staff WHERE phone=$1', [String(phone).trim()]);
      if (dup.rows.length) return res.status(409).json({ error: 'phone_taken', message: 'رقم الموبايل مستخدم بالفعل.' });
      let col = null;
      if (role === 'delivery') {
        const f = await pool.query(`SELECT id FROM staff WHERE role='finance' AND active=true ORDER BY id LIMIT 1`);
        col = f.rows[0] ? f.rows[0].id : null;
      }
      const r = await pool.query(
        `INSERT INTO staff (name, phone, phone2, address, password_hash, role, job_title, settlement_mode, collector_id)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8) RETURNING id, name, phone, role, job_title, settlement_mode`,
        [String(name).trim(), String(phone).trim(), phone2 ? String(phone2).trim() : null, address ? String(address).trim() : null,
         role, job_title ? String(job_title).trim() : null, role === 'delivery' ? (settlement_mode || 'per_order') : null, col]);
      await audit(pool, 'staff_created', req.user.id, r.rows[0].id, { role });
      const d = await issueActivation(pool, r.rows[0].id, r.rows[0].phone, req.user.id, 'activation_issued');
      res.json({ ...r.rows[0], activation_sent: d.sent });
    } catch (e) {
      console.error('staff-create failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّرت الإضافة.' });
    }
  });

  // Name and password can NOT be changed here. Name is fixed at creation; password is the employee's alone.
  router.patch('/staff/:id', requireAuth('admin'), async (req, res) => {
    const { job_title, role, address, phone2, settlement_mode } = req.body;
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid' });
    if (Number(req.params.id) === req.user.id && role !== 'admin') return res.status(400).json({ error: 'self' });
    if (settlement_mode && !['per_order', 'daily', 'weekly', 'suspended'].includes(settlement_mode)) {
      return res.status(400).json({ error: 'invalid_settlement_mode' });
    }
    try {
      const r = await pool.query(
        `UPDATE staff SET job_title=$1, role=$2, address=$3, phone2=$4,
                settlement_mode = CASE WHEN $2='delivery' THEN COALESCE($5, settlement_mode, 'per_order') ELSE NULL END
          WHERE id=$6 RETURNING id`,
        [job_title ? String(job_title).trim() : null, role, address ? String(address).trim() : null,
         phone2 ? String(phone2).trim() : null, settlement_mode || null, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
      await audit(pool, 'staff_edited', req.user.id, Number(req.params.id), { role });
      res.json({ ok: true });
    } catch (e) {
      console.error('staff patch failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' });
    }
  });

  // Wipes the password and issues a code to the EMPLOYEE (the manager never sees it, and cannot log in meanwhile).
  router.post('/staff/:id/reset-password', requireAuth('admin'), async (req, res) => {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'self', message: 'غيّر كلمة سرك من شاشة "حسابي".' });
    }
    try {
      const t = await pool.query('SELECT id, phone FROM staff WHERE id=$1', [req.params.id]);
      if (!t.rows.length) return res.status(404).json({ error: 'not_found' });
      const d = await issueActivation(pool, t.rows[0].id, t.rows[0].phone, req.user.id, 'password_reset');
      res.json({ ok: true, activation_sent: d.sent });
    } catch (e) {
      console.error('reset failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّرت إعادة التعيين.' });
    }
  });

  router.get('/staff-list', requireAuth('admin'), async (req, res) => {
    const r = await pool.query(
      `SELECT id, name, phone, phone2, address, role, job_title, active, settlement_mode,
              (password_hash IS NOT NULL) AS activated
         FROM staff ORDER BY id`);
    res.json(r.rows);
  });

  // Staff the ops manager may assign orders to: right role, active, activated, not suspended.
  router.get('/staff/assignable', requireAuth('admin', 'ops'), async (req, res) => {
    const r = await pool.query(
      `SELECT id, name, role, job_title FROM staff
        WHERE role IN ('prep','delivery') AND active=true AND password_hash IS NOT NULL
          AND settlement_mode IS DISTINCT FROM 'suspended'
        ORDER BY role, name`);
    res.json({ prep: r.rows.filter((x) => x.role === 'prep'), delivery: r.rows.filter((x) => x.role === 'delivery') });
  });

  // ---------- the employee himself ----------
  router.get('/staff/me', requireAuth(...ALL_STAFF), async (req, res) => {
    const r = await pool.query('SELECT id, name, phone, phone2, address, job_title, role FROM staff WHERE id=$1', [req.user.id]);
    res.json(r.rows[0] || {});
  });

  router.post('/staff/me/password', requireAuth(...ALL_STAFF), async (req, res) => {
    const oldPw = String(req.body.old_password || ''), newPw = String(req.body.new_password || '');
    if (newPw.length < 6) return res.status(400).json({ error: 'short_password', message: 'كلمة السر الجديدة لازم تكون 6 أحرف على الأقل.' });
    try {
      const r = await pool.query('SELECT password_hash FROM staff WHERE id=$1', [req.user.id]);
      const h = r.rows[0] && r.rows[0].password_hash;
      if (!h || !(await bcrypt.compare(oldPw, h))) {
        return res.status(400).json({ error: 'wrong_password', message: 'كلمة السر الحالية غير صحيحة.' });
      }
      await pool.query('UPDATE staff SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPw, 10), req.user.id]);
      await audit(pool, 'password_changed', req.user.id, req.user.id, null);
      res.json({ ok: true });
    } catch (e) {
      console.error('change password failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التغيير.' });
    }
  });

  // ---------- SMS switch (admin) ----------
  router.get('/settings/sms', requireAuth('admin'), async (req, res) => {
    res.json({ enabled: await smsEnabled() });
  });
  router.put('/settings/sms', requireAuth('admin'), async (req, res) => {
    const on = req.body.enabled === true;
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('sms_enabled',$1)
                      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [on ? 'true' : 'false']);
    await audit(pool, 'sms_switch', req.user.id, null, { enabled: on });
    res.json({ ok: true, enabled: on });
  });

  // ---------- ops manager: assign orders ----------
  router.get('/orders/ops', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address,
                ps.name AS assigned_prep_name, ds.name AS assigned_delivery_name
           FROM orders o
           JOIN customers c ON c.id = o.customer_id
           LEFT JOIN staff ps ON ps.id = o.assigned_prep_id
           LEFT JOIN staff ds ON ds.id = o.assigned_delivery_id
          WHERE o.status IN ('awaiting_prep','preparing','awaiting_delivery','on_the_way')
          ORDER BY o.created_at`);
      res.json(await withItems(r.rows));
    } catch (e) {
      console.error('orders/ops failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر تحميل الطلبات.' });
    }
  });

  // body: { order_ids:[...], prep_staff_id?: id|null, delivery_staff_id?: id|null }  (a key left out = unchanged)
  router.patch('/orders/assign', requireAuth('admin', 'ops'), async (req, res) => {
    const ids = Array.isArray(req.body.order_ids) ? req.body.order_ids.map(Number).filter(Number.isInteger) : [];
    const hasP = Object.prototype.hasOwnProperty.call(req.body, 'prep_staff_id');
    const hasD = Object.prototype.hasOwnProperty.call(req.body, 'delivery_staff_id');
    if (hasD) return res.status(400).json({ error: 'use_trips', message: 'تعيين الدليفري بقى من شاشة الرحلات.' });
    if (!ids.length || (!hasP && !hasD)) return res.status(400).json({ error: 'invalid', message: 'بيانات غير صحيحة.' });
    try {
      async function check(id, role) {
        if (id === null || id === undefined || id === '') return null;
        const r = await pool.query(
          `SELECT id FROM staff WHERE id=$1 AND role=$2 AND active=true AND password_hash IS NOT NULL
              AND settlement_mode IS DISTINCT FROM 'suspended'`, [Number(id), role]);
        if (!r.rows.length) throw Object.assign(new Error('bad_target'), { code: 'bad_target' });
        return r.rows[0].id;
      }
      let updated = 0, prevPrep;
      if (hasP) {
        const pid = await check(req.body.prep_staff_id, 'prep');
        const before = await pool.query('SELECT id, assigned_prep_id FROM orders WHERE id = ANY($1::int[])', [ids]);
        prevPrep = Object.fromEntries(before.rows.map(x => [x.id, x.assigned_prep_id]));
        const r = await pool.query(
          `UPDATE orders SET assigned_prep_id=$2,
                            prep_assigned_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() END,
                            prep_assignment_mode = CASE WHEN $2::int IS NULL THEN NULL ELSE 'manual' END
           WHERE id=ANY($1::int[]) AND status IN ('awaiting_prep','preparing') RETURNING id`, [ids, pid]);
        updated += r.rows.length;
      }
      if (hasD) {
        const did = await check(req.body.delivery_staff_id, 'delivery');
        const r = await pool.query(
          `UPDATE orders SET assigned_delivery_id=$2 WHERE id=ANY($1::int[])
              AND status IN ('awaiting_prep','preparing','awaiting_delivery') RETURNING id`, [ids, did]);
        updated += r.rows.length;
      }
      await audit(pool, 'orders_assigned', req.user.id, null, {
        order_ids: ids, prep: hasP ? (req.body.prep_staff_id === undefined ? null : req.body.prep_staff_id) : undefined, previous_prep: prevPrep,
        delivery: hasD ? req.body.delivery_staff_id : undefined });
      res.json({ ok: true, updated });
    } catch (e) {
      if (e.code === 'bad_target') return res.status(400).json({ error: 'bad_target', message: 'الموظف المختار غير مؤهل لهذا الدور.' });
      console.error('assign failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التعيين.' });
    }
  });

  return { router, issueActivation };
}

module.exports = { init };
