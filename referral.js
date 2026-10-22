// referral.js — referral / rewards system v2 for سوق الطازج
// Mounted from server.js:  const referral = require('./referral').init({ pool, requireAuth, jwt, JWT_SECRET, express });
const crypto = require('crypto');

// ---------- pure helpers (no DB) ----------

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Egyptian mobile numbers: compare by digits only, +20 / 0020 / 20 prefixes folded to a leading 0.
function normPhone(p) {
  let d = String(p || '').replace(/[٠-٩]/g, (x) => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/\D/g, '');
  if (d.startsWith('0020')) d = d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = '0' + d;
  return d;
}
const isEgMobile = (p) => /^01[0125]\d{8}$/.test(p);

// Normalise free-text addresses so "شارع  النيل، عمارة ٥" and "شارع النيل عماره 5" compare equal.
function normAddress(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Share of the sacrifice cap granted on the n-th (0-based) discounted order; the last step repeats.
function stepMultiplier(steps, n) {
  const arr = Array.isArray(steps) && steps.length ? steps : [1];
  const v = Number(arr[Math.min(n, arr.length - 1)]);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function randomCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// SMS sending is a stub until a provider is chosen. 'log' just prints the code to the server log.
async function sendSms(phone, text) {
  const provider = process.env.SMS_PROVIDER || 'log';
  if (provider === 'log') { console.log('[SMS:log] to ' + phone + ': ' + text); return; }
  throw new Error('SMS provider not implemented: ' + provider);
}

// ---------- module ----------

function init({ pool, requireAuth, jwt, JWT_SECRET, express }) {
  const router = express.Router();

  async function getSettings(db = pool) {
    const r = await db.query('SELECT * FROM referral_settings WHERE id=1');
    const s = r.rows[0] || {};
    return {
      sacrifice_pct: Number(s.sacrifice_pct ?? 30), // direct % off price, set entirely by the admin
      window_days: Number(s.window_days ?? 30),
      person_address_cap: Number(s.person_address_cap ?? 3),
      address_cap: Number(s.address_cap ?? 10),
      enforce_address_caps: !!s.enforce_address_caps,
      otp_enforced: !!s.otp_enforced,
      progressive_steps: s.progressive_steps || [0.5, 0.75, 1],
    };
  }

  async function ensureCode(customerId, db = pool) {
    const cur = await db.query('SELECT referral_code FROM customers WHERE id=$1', [customerId]);
    if (cur.rows[0] && cur.rows[0].referral_code) return cur.rows[0].referral_code;
    for (let i = 0; i < 6; i++) {
      const code = randomCode();
      try {
        const r = await db.query(
          'UPDATE customers SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL RETURNING referral_code',
          [code, customerId]
        );
        if (r.rows.length) return code;
        const again = await db.query('SELECT referral_code FROM customers WHERE id=$1', [customerId]);
        return again.rows[0].referral_code;
      } catch (e) { if (e.code !== '23505') throw e; } // unique clash -> retry with a new code
    }
    throw new Error('could not generate referral code');
  }

  // ----- OTP -----
  const otpHash = (phone, code) => crypto.createHash('sha256').update(phone + ':' + code + ':' + JWT_SECRET).digest('hex');

  async function isPhoneVerified(rawPhone, token) {
    const phone = normPhone(rawPhone);
    if (token) {
      try {
        const d = jwt.verify(token, JWT_SECRET);
        if (d.purpose === 'otp' && d.phone === phone) return true;
      } catch (e) { /* fall through */ }
    }
    const r = await pool.query('SELECT 1 FROM phone_verifications WHERE phone=$1', [phone]);
    return r.rows.length > 0;
  }

  // Blocking same-person check: the referred number must differ from the referrer's own number.
  async function referrerByCode(code) {
    if (!code) return null;
    const r = await pool.query('SELECT id, name, phone FROM customers WHERE referral_code=$1', [String(code).trim().toUpperCase()]);
    return r.rows[0] || null;
  }

  router.post('/auth/otp/send', async (req, res) => {
    try {
      const phone = normPhone(req.body.phone);
      if (!isEgMobile(phone)) return res.status(400).json({ error: 'bad_phone', message: 'رقم الموبايل غير صحيح.' });

      if (req.body.referral_code) {
        const ref = await referrerByCode(req.body.referral_code);
        if (ref && normPhone(ref.phone) === phone) {
          return res.status(400).json({ error: 'same_person', message: 'مينفعش تستخدم رقمك أنت كإحالة لنفسك.' });
        }
      }

      if (await isPhoneVerified(phone)) return res.json({ needed: false, verified: true });

      const recent = await pool.query(
        `SELECT created_at FROM otp_codes WHERE phone=$1 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC`,
        [phone]
      );
      if (recent.rows.length >= 5) return res.status(429).json({ error: 'too_many', message: 'حاولت كتير، جرّب بعد شوية.' });
      if (recent.rows.length && Date.now() - new Date(recent.rows[0].created_at + 'Z').getTime() < 30000) {
        return res.status(429).json({ error: 'wait', message: 'استنى نص دقيقة قبل ما تطلب كود جديد.' });
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await pool.query(
        `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2, now() + interval '5 minutes')`,
        [phone, otpHash(phone, code)]
      );
      await sendSms(phone, 'كود التحقق الخاص بك في سوق الطازج: ' + code);
      res.json({ needed: true, sent: true });
    } catch (e) {
      console.error('otp send failed', e.message);
      res.status(500).json({ error: 'otp_failed', message: 'تعذّر إرسال الكود، حاول مرة أخرى.' });
    }
  });

  router.post('/auth/otp/verify', async (req, res) => {
    try {
      const phone = normPhone(req.body.phone);
      const code = String(req.body.code || '').trim();
      const r = await pool.query(
        `SELECT * FROM otp_codes WHERE phone=$1 AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [phone]
      );
      const row = r.rows[0];
      if (!row || row.attempts >= 5) return res.status(400).json({ error: 'invalid_code', message: 'الكود غير صحيح أو انتهت صلاحيته.' });
      const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(otpHash(phone, code)));
      if (!ok) {
        await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [row.id]);
        return res.status(400).json({ error: 'invalid_code', message: 'الكود غير صحيح.' });
      }
      await pool.query('INSERT INTO phone_verifications (phone) VALUES ($1) ON CONFLICT DO NOTHING', [phone]);
      await pool.query('DELETE FROM otp_codes WHERE phone=$1', [phone]);
      const verification_token = jwt.sign({ phone, purpose: 'otp' }, JWT_SECRET, { expiresIn: '30m' });
      res.json({ verified: true, verification_token });
    } catch (e) {
      console.error('otp verify failed', e.message);
      res.status(500).json({ error: 'otp_failed', message: 'تعذّر التحقق، حاول مرة أخرى.' });
    }
  });

  // ----- creating a referral (called right after a NEW customer registers) -----
  async function createReferral({ code, customer, address }) {
    const referrer = await referrerByCode(code);
    if (!referrer) return { ok: false, reason: 'invalid_code' };
    if (referrer.id === customer.id || normPhone(referrer.phone) === normPhone(customer.phone)) {
      return { ok: false, reason: 'same_person' }; // always blocking: binary fact, no false positives
    }
    const s = await getSettings();
    const norm = normAddress(address);

    const per = await pool.query('SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_id=$1 AND referred_address_norm=$2', [referrer.id, norm]);
    const tot = await pool.query('SELECT COUNT(*)::int AS n FROM referrals WHERE referred_address_norm=$1', [norm]);
    const breaches = [];
    if (per.rows[0].n >= s.person_address_cap) breaches.push('person_address_cap');
    if (tot.rows[0].n >= s.address_cap) breaches.push('address_cap');
    for (const kind of breaches) {
      await pool.query(
        'INSERT INTO referral_flags (kind, referrer_id, referred_id, detail) VALUES ($1,$2,$3,$4)',
        [kind, referrer.id, customer.id, JSON.stringify({ address_norm: norm, enforced: s.enforce_address_caps })]
      );
    }
    if (breaches.length && s.enforce_address_caps) return { ok: false, reason: 'address_cap' };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO referrals (referrer_id, referred_id, referred_address_norm, window_ends_at, sacrifice_pct, progressive_steps)
         VALUES ($1,$2,$3, now() + ($4 || ' days')::interval, $5, $6) ON CONFLICT (referred_id) DO NOTHING RETURNING id`,
        [referrer.id, customer.id, norm, String(s.window_days), s.sacrifice_pct, JSON.stringify(s.progressive_steps)]
      );
      if (!ins.rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'already_referred' }; }
      await client.query(
        `INSERT INTO referral_entitlements (referral_id, customer_id, role) VALUES ($1,$2,'referred')`,
        [ins.rows[0].id, customer.id]
      );
      await client.query('COMMIT');
      return { ok: true, referral_id: ins.rows[0].id, referrer_name: String(referrer.name || '').split(' ')[0] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }

  // ----- discount maths (runs inside the order transaction) -----
  // Each entitlement discounts ONE whole category: lineTotal * sacrifice_pct * progressive step.
  // sacrifice_pct is a direct % off the price, set (and fully owned) by the admin — no margin math.
  // NOTE: if sacrifice_pct exceeds the real margin on a category, that order loses money outright;
  // this is an intentional business decision left entirely to the admin, not something this code limits.
  async function computeDiscount(db, customerId, items) {
    const ents = (await db.query(
      `SELECT e.id, e.category, r.sacrifice_pct, r.progressive_steps FROM referral_entitlements e JOIN referrals r ON r.id = e.referral_id
        WHERE e.customer_id=$1 AND e.category IS NOT NULL AND r.window_ends_at > now()`, [customerId]
    )).rows;
    if (!ents.length) return { discount: 0, lines: [] };

    const s = await getSettings(db);
    const ids = items.map((i) => i.product_id);
    const catOf = {};
    (await db.query('SELECT id, category FROM products WHERE id = ANY($1)', [ids])).rows.forEach((p) => { catOf[p.id] = p.category; });

    const lines = [];
    for (const e of ents) {
      const used = (await db.query(
        'SELECT COUNT(DISTINCT order_id)::int AS n FROM referral_reward_log WHERE entitlement_id=$1', [e.id]
      )).rows[0].n;
      const mult = stepMultiplier(e.progressive_steps || s.progressive_steps, used);
      let lineSum = 0;
      for (const it of items) if (catOf[it.product_id] === e.category) lineSum += Number(it.quantity) * Number(it.unit_price);
      if (!lineSum) continue;
      const amt = round2(lineSum * (Number(e.sacrifice_pct ?? s.sacrifice_pct) / 100) * mult);
      if (amt > 0) lines.push({ entitlement_id: e.id, category: e.category, line_total: round2(lineSum), discount_amount: amt });
    }
    return { discount: round2(lines.reduce((a, l) => a + l.discount_amount, 0)), lines };
  }

  async function recordDiscount(db, orderId, customerId, lines) {
    for (const l of lines) {
      await db.query(
        `INSERT INTO referral_reward_log (order_id, entitlement_id, customer_id, category, line_total, discount_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, l.entitlement_id, customerId, l.category, l.line_total, l.discount_amount]
      );
    }
  }

  async function clearOrderRewards(db, orderId) {
    await db.query('DELETE FROM referral_reward_log WHERE order_id=$1', [orderId]);
  }

  // The friend's first delivered & paid order is what "earns" the referrer's own discount.
  // Runs in a savepoint so a referral bug can never break delivering an order.
  async function onDelivered(db, orderId) {
    await db.query('SAVEPOINT ref_delivered');
    try {
      const o = (await db.query('SELECT customer_id FROM orders WHERE id=$1', [orderId])).rows[0];
      const r = o && (await db.query(
        'SELECT id, referrer_id FROM referrals WHERE referred_id=$1 AND first_delivered_at IS NULL AND window_ends_at > now() FOR UPDATE',
        [o.customer_id]
      )).rows[0];
      if (r) {
        await db.query('UPDATE referrals SET first_delivered_at=now() WHERE id=$1', [r.id]);
        await db.query(
          `INSERT INTO referral_entitlements (referral_id, customer_id, role) VALUES ($1,$2,'referrer')
           ON CONFLICT (referral_id, role) DO NOTHING`, [r.id, r.referrer_id]
        );
      }
      await db.query('RELEASE SAVEPOINT ref_delivered');
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT ref_delivered');
      console.error('referral onDelivered failed', e.message);
    }
  }

  // ----- public: welcome screen for someone opening a referral link -----
  router.get('/referral/link/:code', async (req, res) => {
    const ref = await referrerByCode(req.params.code);
    if (!ref) return res.json({ valid: false });
    pool.query('INSERT INTO referral_opens (referrer_id) VALUES ($1)', [ref.id]).catch(() => {});
    const st = await getSettings();
    res.json({
      valid: true,
      referrer_name: String(ref.name || '').split(' ')[0],
      sacrifice_pct: st.sacrifice_pct,
      progressive_steps: st.progressive_steps,
    });
  });

  // ----- customer: my referral dashboard -----
  router.get('/referral/me', requireAuth('customer'), async (req, res) => {
    try {
      const me = req.user.id;
      const code = await ensureCode(me);
      const opens = (await pool.query('SELECT COUNT(*)::int AS n FROM referral_opens WHERE referrer_id=$1', [me])).rows[0].n;

      const friends = (await pool.query(
        `SELECT r.id, r.created_at, r.first_delivered_at, c.name,
                e.id AS entitlement_id, e.category,
                COALESCE((SELECT SUM(discount_amount) FROM referral_reward_log l WHERE l.entitlement_id = e.id), 0) AS my_saving
           FROM referrals r
           JOIN customers c ON c.id = r.referred_id
           LEFT JOIN referral_entitlements e ON e.referral_id = r.id AND e.role = 'referrer'
          WHERE r.referrer_id=$1 ORDER BY r.created_at DESC`, [me]
      )).rows.map((f) => ({
        referral_id: f.id,
        name: String(f.name || '').split(' ')[0],
        status: f.first_delivered_at ? 'rewarded' : 'registered', // rewarded = friend's first order delivered
        entitlement_id: f.entitlement_id,
        category: f.category,
        needs_category: !!f.entitlement_id && !f.category,
        my_saving: round2(f.my_saving),
      }));

      const mine = (await pool.query(
        `SELECT e.id, e.role, e.category, r.window_ends_at,
                COALESCE((SELECT SUM(discount_amount) FROM referral_reward_log l WHERE l.entitlement_id = e.id), 0) AS saved
           FROM referral_entitlements e JOIN referrals r ON r.id = e.referral_id
          WHERE e.customer_id=$1 ORDER BY e.created_at DESC`, [me]
      )).rows.map((e) => ({
        id: e.id, role: e.role, category: e.category, window_ends_at: e.window_ends_at,
        active: new Date(e.window_ends_at) > new Date(), saved: round2(e.saved), needs_category: !e.category,
      }));

      const invitedBy = (await pool.query(
        `SELECT c.name FROM referrals r JOIN customers c ON c.id = r.referrer_id WHERE r.referred_id=$1`, [me]
      )).rows[0];

      const taken = new Set(mine.filter((e) => e.category && e.active).map((e) => e.category));
      const cats = (await pool.query('SELECT name FROM categories ORDER BY sort_order, id')).rows.map((c) => c.name);
      const st = await getSettings();

      res.json({
        code,
        link_path: '/customer/?ref=' + code,
        stats: { link_opens: opens, registered: friends.length, rewarded: friends.filter((f) => f.status === 'rewarded').length },
        total_saved: round2(mine.reduce((a, e) => a + e.saved, 0)),
        invited_by: invitedBy ? String(invitedBy.name || '').split(' ')[0] : null,
        friends,
        entitlements: mine,
        choosable_categories: cats.filter((c) => !taken.has(c)),
        sacrifice_pct: st.sacrifice_pct,
        progressive_steps: st.progressive_steps,
      });
    } catch (e) {
      console.error('referral/me failed', e.message);
      res.status(500).json({ error: 'failed' });
    }
  });

  // ----- customer: pick the category for one of my entitlements (once; no repeats across entitlements) -----
  router.post('/referral/entitlements/:id/category', requireAuth('customer'), async (req, res) => {
    try {
      const category = String(req.body.category || '').trim();
      const ent = (await pool.query(
        `SELECT e.*, r.window_ends_at FROM referral_entitlements e JOIN referrals r ON r.id = e.referral_id
          WHERE e.id=$1 AND e.customer_id=$2`, [req.params.id, req.user.id]
      )).rows[0];
      if (!ent) return res.status(404).json({ error: 'not_found' });
      if (ent.category) return res.status(409).json({ error: 'already_set', message: 'الفئة اتحددت قبل كده.' });
      if (new Date(ent.window_ends_at) <= new Date()) return res.status(410).json({ error: 'expired', message: 'المدة انتهت.' });
      const exists = await pool.query('SELECT 1 FROM categories WHERE name=$1', [category]);
      if (!exists.rows.length) return res.status(400).json({ error: 'bad_category', message: 'الفئة غير موجودة.' });
      const dup = await pool.query(
        `SELECT 1 FROM referral_entitlements e JOIN referrals r ON r.id = e.referral_id
          WHERE e.customer_id=$1 AND e.category=$2 AND r.window_ends_at > now()`, [req.user.id, category]
      );
      if (dup.rows.length) return res.status(409).json({ error: 'category_taken', message: 'الفئة دي مستخدمة في إحالة تانية، اختار فئة مختلفة.' });
      const r = await pool.query('UPDATE referral_entitlements SET category=$1 WHERE id=$2 AND category IS NULL RETURNING id, category', [category, ent.id]);
      if (!r.rows.length) return res.status(409).json({ error: 'already_set' });
      res.json(r.rows[0]);
    } catch (e) {
      console.error('set category failed', e.message);
      res.status(500).json({ error: 'failed' });
    }
  });

  // ----- admin: settings, flags -----
  // sacrifice_pct here is a direct % off price (the admin's own call on whether that beats their margin).
  router.get('/referral/settings', requireAuth('admin'), async (req, res) => {
    res.json({ settings: await getSettings() });
  });

  router.put('/referral/settings', requireAuth('admin'), async (req, res) => {
    const b = req.body || {};
    const cur = await getSettings();
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
    let steps = cur.progressive_steps;
    if (Array.isArray(b.progressive_steps) && b.progressive_steps.length >= 1 && b.progressive_steps.length <= 12 &&
        b.progressive_steps.every((x) => Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) <= 1)) {
      steps = b.progressive_steps.map(Number);
    }
    await pool.query(
      `UPDATE referral_settings SET sacrifice_pct=$1, window_days=$2, person_address_cap=$3, address_cap=$4,
              enforce_address_caps=$5, otp_enforced=$6, progressive_steps=$7 WHERE id=1`,
      [num(b.sacrifice_pct, 0, 100, cur.sacrifice_pct), Math.round(num(b.window_days, 1, 365, cur.window_days)),
       Math.round(num(b.person_address_cap, 1, 1000, cur.person_address_cap)), Math.round(num(b.address_cap, 1, 10000, cur.address_cap)),
       typeof b.enforce_address_caps === 'boolean' ? b.enforce_address_caps : cur.enforce_address_caps,
       typeof b.otp_enforced === 'boolean' ? b.otp_enforced : cur.otp_enforced,
       JSON.stringify(steps)]
    );
    res.json({ settings: await getSettings() });
  });

  router.get('/referral/flags', requireAuth('admin'), async (req, res) => {
    const r = await pool.query(
      `SELECT f.*, a.name AS referrer_name, b.name AS referred_name
         FROM referral_flags f LEFT JOIN customers a ON a.id = f.referrer_id LEFT JOIN customers b ON b.id = f.referred_id
        ORDER BY f.created_at DESC LIMIT 200`
    );
    res.json(r.rows);
  });

  return { router, getSettings, ensureCode, isPhoneVerified, createReferral, computeDiscount, recordDiscount, clearOrderRewards, onDelivered };
}

module.exports = { init, _test: { normPhone, normAddress, stepMultiplier, round2, isEgMobile } };
