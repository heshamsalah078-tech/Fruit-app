// Offers (admin only). Conditions: date range, minimum amount (counted on the products the offer covers), scope
// (all products / categories / specific products). Result: percent, fixed amount, or free delivery.
// Combining: offers are evaluated by priority (lower number first). An offer marked "stackable = false" never combines:
// it is skipped if something already applied, and it stops the offers after it. Referral discount: a global switch says
// whether it stacks with offers, or whether the customer just gets the larger of the two.
// Free delivery: the customer pays 0, the courier is still paid the ZONE price (orders.zone_fee) and the company absorbs it.
// Prices are always read from the products table (never from the app).

function init({ pool, requireAuth, express }) {
  const router = express.Router();
  const TYPES = ['percent', 'amount', 'free_delivery'];
  const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

  async function activeOffers(db) {
    return (await db.query(
      `SELECT * FROM offers WHERE active = true AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        ORDER BY priority ASC, id ASC`)).rows;
  }

  // items: [{product_id, quantity}]  ->  { applied:[{offer_id,name,type,amount,free_delivery}], discount, free_delivery }
  async function evaluate(db, items) {
    const ids = (items || []).map((i) => Number(i.product_id));
    if (!ids.length) return { applied: [], discount: 0, free_delivery: false };
    const pr = await db.query('SELECT id, category, price FROM products WHERE id = ANY($1)', [ids]);
    const info = {};
    pr.rows.forEach((p) => { info[p.id] = p; });
    const lines = [];
    for (const it of items) {
      const p = info[Number(it.product_id)];
      if (!p) continue;
      const v = r2(Number(it.quantity) * Number(p.price));
      lines.push({ pid: p.id, cat: p.category, orig: v, remaining: v });
    }
    const applied = [];
    let free = false;
    for (const o of await activeOffers(db)) {
      if (applied.length && !o.stackable) continue;          // does not combine with what already applied
      const cats = o.scope_categories || [], prods = o.scope_products || [];
      const all = !cats.length && !prods.length;
      const elig = lines.filter((l) => all || cats.includes(l.cat) || prods.includes(l.pid));
      const orig = r2(elig.reduce((a, l) => a + l.orig, 0));
      const rem = r2(elig.reduce((a, l) => a + l.remaining, 0));
      if (orig <= 0 || orig < Number(o.min_amount || 0)) continue;
      let amt = 0;
      if (o.result_type === 'percent') amt = r2(rem * Number(o.result_value) / 100);
      else if (o.result_type === 'amount') amt = Math.min(r2(o.result_value), rem);
      else { if (free) continue; free = true; }
      if (o.result_type !== 'free_delivery') {
        if (amt <= 0) continue;
        // spend it from the covered lines (proportionally) so combined discounts can never exceed a line's value
        let left = amt;
        elig.forEach((l, i) => {
          const share = i === elig.length - 1 ? left : r2(amt * l.remaining / (rem || 1));
          const take = Math.min(share, l.remaining, left);
          l.remaining = r2(l.remaining - take); left = r2(left - take);
        });
        amt = r2(amt - left);
      }
      applied.push({ offer_id: o.id, name: o.name, type: o.result_type, amount: amt, free_delivery: o.result_type === 'free_delivery' });
      if (!o.stackable) break;
    }
    return { applied, discount: r2(applied.reduce((a, x) => a + x.amount, 0)), free_delivery: free };
  }

  // Never let (offers + referral) exceed the items total: trim from the last applied offer backwards.
  function cap(ev, max) {
    let over = r2(ev.discount - Math.max(max, 0));
    if (over <= 0) return ev;
    const applied = ev.applied.map((a) => ({ ...a }));
    for (let i = applied.length - 1; i >= 0 && over > 0; i--) {
      const cut = Math.min(applied[i].amount, over);
      applied[i].amount = r2(applied[i].amount - cut); over = r2(over - cut);
    }
    return { applied, discount: r2(applied.reduce((a, x) => a + x.amount, 0)), free_delivery: ev.free_delivery };
  }
  function dropDiscounts(ev) {
    const applied = ev.applied.filter((a) => a.free_delivery);
    return { applied, discount: 0, free_delivery: ev.free_delivery };
  }
  async function stackWithReferral(db) {
    const r = await db.query(`SELECT value FROM app_settings WHERE key = 'offers_stack_with_referral'`);
    return !r.rows.length || r.rows[0].value !== '0';
  }
  async function recordApplied(db, orderId, ev, zoneFee) {
    for (const a of ev.applied) {
      await db.query(
        `INSERT INTO order_offers (order_id, offer_id, offer_name, kind, amount, free_delivery_cost) VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, a.offer_id, a.name, a.type, a.amount, a.free_delivery ? r2(zoneFee) : 0]);
    }
  }

  // ---- customer: what applies to my cart right now (display only; the order recomputes everything) ----
  router.post('/offers/preview', requireAuth('customer'), async (req, res) => {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
      const ev = await evaluate(pool, items);
      res.json({ ...ev, stack_with_referral: await stackWithReferral(pool) });
    } catch (e) { console.error('offers preview', e.message); res.status(500).json({ error: 'failed' }); }
  });

  // ---- admin ----
  const ts = (c) => `to_char(${c} AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD"T"HH24:MI')`;
  router.get('/offers', requireAuth('admin'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, active, min_amount, scope_categories, scope_products, result_type, result_value, stackable, priority,
                ${ts('starts_at')} AS starts_at, ${ts('ends_at')} AS ends_at,
                CASE WHEN NOT active THEN 'off' WHEN starts_at > now() THEN 'scheduled' WHEN ends_at <= now() THEN 'ended' ELSE 'live' END AS status
           FROM offers ORDER BY active DESC, priority, id`);
      res.json({ offers: r.rows.map((o) => ({ ...o, min_amount: Number(o.min_amount), result_value: Number(o.result_value) })), stack_with_referral: await stackWithReferral(pool) });
    } catch (e) { console.error('offers list', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });
  router.get('/offers/catalog', requireAuth('admin'), async (req, res) => {
    try {
      const r = await pool.query('SELECT id, name, category, emoji FROM products ORDER BY category, name');
      res.json({ products: r.rows, categories: [...new Set(r.rows.map((p) => p.category))] });
    } catch (e) { res.status(500).json({ error: 'failed' }); }
  });
  router.get('/offers/report', requireAuth('admin'), async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const r = await pool.query(
        `SELECT oo.offer_id, COUNT(DISTINCT oo.order_id)::int AS orders, COALESCE(SUM(oo.amount),0) AS discount, COALESCE(SUM(oo.free_delivery_cost),0) AS delivery_cost
           FROM order_offers oo JOIN orders o ON o.id = oo.order_id
          WHERE o.status <> 'cancelled' AND o.created_at >= now() - ($1 || ' days')::interval GROUP BY oo.offer_id`, [String(days)]);
      const out = {};
      r.rows.forEach((x) => { out[x.offer_id] = { orders: x.orders, cost: r2(Number(x.discount) + Number(x.delivery_cost)) }; });
      res.json({ days, by_offer: out });
    } catch (e) { console.error('offers report', e.message); res.status(500).json({ error: 'failed' }); }
  });
  router.put('/offers/settings', requireAuth('admin'), async (req, res) => {
    try {
      const v = req.body.stack_with_referral === false ? '0' : '1';
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('offers_stack_with_referral',$1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('offers_settings_changed', $1, $2)`, [req.user.id, JSON.stringify({ stack_with_referral: v === '1' })]);
      res.json({ ok: true, stack_with_referral: v === '1' });
    } catch (e) { res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });

  function clean(b) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return { error: 'اكتب اسم العرض.' };
    if (!TYPES.includes(b.result_type)) return { error: 'نوع العرض غير صحيح.' };
    let value = Number(b.result_value || 0);
    if (b.result_type === 'percent' && !(value > 0 && value <= 100)) return { error: 'النسبة لازم تكون بين 1 و 100.' };
    if (b.result_type === 'amount' && !(value > 0)) return { error: 'اكتب مبلغ الخصم.' };
    if (b.result_type === 'free_delivery') value = 0;
    const min = Number(b.min_amount || 0);
    if (!Number.isFinite(min) || min < 0 || min > 1000000) return { error: 'الحد الأدنى غير صحيح.' };
    const pri = Math.round(Number(b.priority || 100));
    if (!Number.isFinite(pri) || pri < 1 || pri > 999) return { error: 'الأولوية من 1 لـ 999.' };
    const dre = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    const from = b.starts_at ? String(b.starts_at) : null, to = b.ends_at ? String(b.ends_at) : null;
    if ((from && !dre.test(from)) || (to && !dre.test(to))) return { error: 'التاريخ غير صحيح.' };
    if (from && to && to <= from) return { error: 'تاريخ النهاية لازم يكون بعد البداية.' };
    const cats = Array.isArray(b.scope_categories) ? [...new Set(b.scope_categories.map((c) => String(c).slice(0, 80)))] : [];
    const prods = Array.isArray(b.scope_products) ? [...new Set(b.scope_products.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
    return { v: { name, result_type: b.result_type, result_value: value, min_amount: min, priority: pri, from, to, cats, prods, stackable: b.stackable !== false, active: b.active !== false } };
  }
  const TZ = (n) => `CASE WHEN $${n}::text IS NULL THEN NULL ELSE ($${n}::text)::timestamp AT TIME ZONE 'Africa/Cairo' END`;

  router.post('/offers', requireAuth('admin'), async (req, res) => {
    const c = clean(req.body || {});
    if (c.error) return res.status(400).json({ error: 'invalid', message: c.error });
    const v = c.v;
    try {
      const r = await pool.query(
        `INSERT INTO offers (name, active, starts_at, ends_at, min_amount, scope_categories, scope_products, result_type, result_value, stackable, priority, created_by)
         VALUES ($1,$2,${TZ(3)},${TZ(4)},$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [v.name, v.active, v.from, v.to, v.min_amount, v.cats, v.prods, v.result_type, v.result_value, v.stackable, v.priority, req.user.id]);
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('offer_created', $1, $2)`, [req.user.id, JSON.stringify({ id: r.rows[0].id, name: v.name })]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { console.error('offer create', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });
  router.put('/offers/:id', requireAuth('admin'), async (req, res) => {
    const c = clean(req.body || {});
    if (c.error) return res.status(400).json({ error: 'invalid', message: c.error });
    const v = c.v;
    try {
      const r = await pool.query(
        `UPDATE offers SET name=$1, active=$2, starts_at=${TZ(3)}, ends_at=${TZ(4)}, min_amount=$5, scope_categories=$6, scope_products=$7,
                result_type=$8, result_value=$9, stackable=$10, priority=$11 WHERE id=$12 RETURNING id`,
        [v.name, v.active, v.from, v.to, v.min_amount, v.cats, v.prods, v.result_type, v.result_value, v.stackable, v.priority, Number(req.params.id)]);
      if (!r.rows.length) return res.status(404).json({ error: 'not_found', message: 'العرض مش موجود.' });
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('offer_updated', $1, $2)`, [req.user.id, JSON.stringify({ id: r.rows[0].id, name: v.name, active: v.active })]);
      res.json({ ok: true });
    } catch (e) { console.error('offer update', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });
  router.delete('/offers/:id', requireAuth('admin'), async (req, res) => {
    try {
      await pool.query('DELETE FROM offers WHERE id = $1', [Number(req.params.id)]);   // old orders keep their frozen copy in order_offers
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('offer_deleted', $1, $2)`, [req.user.id, JSON.stringify({ id: Number(req.params.id) })]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'failed', message: 'تعذّر الحذف.' }); }
  });

  return { router, evaluate, cap, dropDiscounts, stackWithReferral, recordApplied };
}
module.exports = { init };
