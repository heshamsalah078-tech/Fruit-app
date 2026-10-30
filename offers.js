// Offers (admin only). Conditions: date range, minimum amount (counted on the products the offer covers), scope
// (all products / categories / specific products). Result: percent, fixed amount, or free delivery.
// Combining: offers are evaluated by priority (lower number first). An offer marked "stackable = false" never combines:
// it is skipped if something already applied, and it stops the offers after it. Referral discount: a global switch says
// whether it stacks with offers, or whether the customer just gets the larger of the two.
// Free delivery: the customer pays 0, the courier is still paid the ZONE price (orders.zone_fee) and the company absorbs it.
// Prices are always read from the products table (never from the app).

function init({ pool, requireAuth, express }) {
  const router = express.Router();
    const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

  async function activeOffers(db) {
    return (await db.query(
      `SELECT * FROM offers WHERE active = true AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        ORDER BY priority ASC, id ASC`)).rows;
  }

  // items: [{product_id, quantity}]  ->  { applied:[{offer_id,name,amount,free_delivery,free_cost,gift}], discount, free_delivery, gifts }
  // opts.lock: at order time, lock the gift products' stock rows so the availability check and the reservation agree.
  async function evaluate(db, items, opts) {
    const lock = !!(opts && opts.lock);
    const ids = (items || []).map((i) => Number(i.product_id));
    if (!ids.length) return { applied: [], discount: 0, free_delivery: false, gifts: [], skipped: [] };
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
    const offers = await activeOffers(db);
    const giftIds = [...new Set(offers.map((o) => o.gift_product_id).filter(Boolean))];
    const gInfo = {};
    if (giftIds.length) {
      (await db.query(`SELECT id, name, emoji, unit, price, stock_qty, reserved_qty FROM products WHERE id = ANY($1) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [giftIds]))
        .rows.forEach((g) => { gInfo[g.id] = g; });
    }
    const allocated = {};
    const applied = [];
    const skipped = [];
    let free = false;
    for (const o of offers) {
      if (applied.length && !o.stackable) continue;          // does not combine with what already applied
      const cats = o.scope_categories || [], prods = o.scope_products || [];
      const all = !cats.length && !prods.length;
      const elig = lines.filter((l) => all || cats.includes(l.cat) || prods.includes(l.pid));
      const orig = r2(elig.reduce((a, l) => a + l.orig, 0));
      const rem = r2(elig.reduce((a, l) => a + l.remaining, 0));
      if (orig <= 0 || orig < Number(o.min_amount || 0)) continue;

      // gift: if it is out of stock the WHOLE offer is skipped, so the customer is never promised something we cannot give
      let gift = null;
      if (o.gift_product_id) {
        const g = gInfo[o.gift_product_id];
        if (!g) { skipped.push({ offer_id: o.id, name: o.name, reason: 'gift_missing', gift_product_id: o.gift_product_id, gift_name: null, needed: Number(o.gift_qty || 1), available: 0 }); continue; }
        const qty = Number(o.gift_qty || 1);
        const inCart = items.filter((i) => Number(i.product_id) === g.id).reduce((a, i) => a + Number(i.quantity), 0);
        const avail = Number(g.stock_qty) - Number(g.reserved_qty) - inCart - (allocated[g.id] || 0);
        if (avail < qty) { skipped.push({ offer_id: o.id, name: o.name, reason: 'gift_out_of_stock', gift_product_id: g.id, gift_name: g.name, needed: qty, available: Math.max(avail, 0) }); continue; }
        gift = { product_id: g.id, name: g.name, emoji: g.emoji || '', unit: g.unit || '', qty, value: r2(qty * Number(g.price)) };
      }
      let amt = 0;
      if (o.discount_type === 'percent') amt = r2(rem * Number(o.discount_value) / 100);
      else if (o.discount_type === 'amount') amt = Math.min(r2(o.discount_value), rem);
      const newFree = !!o.free_delivery && !free;
      if (amt <= 0 && !newFree && !gift) continue;            // nothing new to give
      if (amt > 0) {
        // spend it from the covered lines (proportionally) so combined discounts can never exceed a line's value
        let left = amt;
        elig.forEach((l, i) => {
          const share = i === elig.length - 1 ? left : r2(amt * l.remaining / (rem || 1));
          const take = Math.min(share, l.remaining, left);
          l.remaining = r2(l.remaining - take); left = r2(left - take);
        });
        amt = r2(amt - left);
      }
      if (newFree) free = true;
      if (gift) allocated[gift.product_id] = (allocated[gift.product_id] || 0) + gift.qty;
      applied.push({ offer_id: o.id, name: o.name, amount: amt, free_delivery: !!o.free_delivery, free_cost: newFree, gift });
      if (!o.stackable) break;
    }
    return { applied, discount: r2(applied.reduce((a, x) => a + x.amount, 0)), free_delivery: free, gifts: applied.filter((a) => a.gift).map((a) => a.gift), skipped };
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
    return { ...ev, applied, discount: r2(applied.reduce((a, x) => a + x.amount, 0)) };
  }
  // Referral wins over the offers' discount: keep only the non-discount benefits (free delivery, gifts).
  function dropDiscounts(ev) {
    const applied = ev.applied.map((a) => ({ ...a, amount: 0 })).filter((a) => a.free_delivery || a.gift);
    return { applied, discount: 0, free_delivery: ev.free_delivery, gifts: applied.filter((a) => a.gift).map((a) => a.gift), skipped: ev.skipped || [] };
  }
  async function stackWithReferral(db) {
    const r = await db.query(`SELECT value FROM app_settings WHERE key = 'offers_stack_with_referral'`);
    return !r.rows.length || r.rows[0].value !== '0';
  }
  async function recordApplied(db, orderId, ev, zoneFee) {
    for (const a of ev.applied) {
      const kind = [a.amount > 0 ? 'discount' : null, a.free_delivery ? 'free_delivery' : null, a.gift ? 'gift' : null].filter(Boolean).join('+') || 'offer';
      await db.query(
        `INSERT INTO order_offers (order_id, offer_id, offer_name, kind, amount, free_delivery_cost, gift_product_id, gift_qty, gift_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orderId, a.offer_id, a.name, kind, a.amount, a.free_cost ? r2(zoneFee) : 0, a.gift ? a.gift.product_id : null, a.gift ? a.gift.qty : null, a.gift ? a.gift.value : 0]);
    }
  }

  // An order was confirmed WITHOUT an offer it would have qualified for, because the gift was not available.
  // Every case is logged; it returns the ones the admin should be notified about (at most once per offer every 6 hours).
  async function logSkips(db, customerId, skipped) {
    const notify = [];
    for (const k of skipped || []) {
      const recent = await db.query(`SELECT 1 FROM offer_skips WHERE offer_id = $1 AND notified AND created_at > now() - interval '6 hours' LIMIT 1`, [k.offer_id]);
      const doNotify = !recent.rows.length;
      await db.query(
        `INSERT INTO offer_skips (offer_id, offer_name, reason, gift_product_id, gift_name, needed_qty, available_qty, customer_id, notified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [k.offer_id, k.name, k.reason, k.gift_product_id, k.gift_name, k.needed, k.available, customerId, doNotify]);
      if (doNotify) notify.push(k);
    }
    return notify;
  }
  router.get('/offers/skips', requireAuth('admin'), async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const r = await pool.query(
        `SELECT offer_id, MAX(offer_name) AS name, MAX(gift_name) AS gift_name, COUNT(*)::int AS times,
                to_char(MAX(created_at) AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS last_at,
                (array_agg(needed_qty ORDER BY created_at DESC))[1] AS needed, (array_agg(available_qty ORDER BY created_at DESC))[1] AS available
           FROM offer_skips WHERE created_at >= now() - ($1 || ' days')::interval GROUP BY offer_id ORDER BY MAX(created_at) DESC`, [String(days)]);
      res.json({ days, skips: r.rows.map((x) => ({ ...x, needed: Number(x.needed), available: Number(x.available) })) });
    } catch (e) { console.error('offers skips', e.message); res.status(500).json({ error: 'failed' }); }
  });

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
        `SELECT id, name, active, min_amount, scope_categories, scope_products, discount_type, discount_value, free_delivery, gift_product_id, gift_qty, stackable, priority,
                ${ts('starts_at')} AS starts_at, ${ts('ends_at')} AS ends_at,
                CASE WHEN NOT active THEN 'off' WHEN starts_at > now() THEN 'scheduled' WHEN ends_at <= now() THEN 'ended' ELSE 'live' END AS status
           FROM offers ORDER BY active DESC, priority, id`);
      res.json({ offers: r.rows.map((o) => ({ ...o, min_amount: Number(o.min_amount), discount_value: Number(o.discount_value), gift_qty: Number(o.gift_qty) })), stack_with_referral: await stackWithReferral(pool) });
    } catch (e) { console.error('offers list', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });
  router.get('/offers/catalog', requireAuth('admin'), async (req, res) => {
    try {
      const r = await pool.query('SELECT id, name, category, emoji FROM products ORDER BY category, name');
      const c = await pool.query('SELECT name, emoji FROM categories ORDER BY sort_order, id');
      const names = c.rows.map((x) => x.name);
      r.rows.forEach((p) => { if (!names.includes(p.category)) names.push(p.category); });
      const emoji = {}; c.rows.forEach((x) => { emoji[x.name] = x.emoji; });
      res.json({ products: r.rows, categories: names.map((n) => ({ name: n, emoji: emoji[n] || '' })) });
    } catch (e) { res.status(500).json({ error: 'failed' }); }
  });
  router.get('/offers/report', requireAuth('admin'), async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const r = await pool.query(
        `SELECT oo.offer_id, COUNT(DISTINCT oo.order_id)::int AS orders, COALESCE(SUM(oo.amount),0) AS discount, COALESCE(SUM(oo.free_delivery_cost),0) AS delivery_cost, COALESCE(SUM(oo.gift_value),0) AS gift_cost
           FROM order_offers oo JOIN orders o ON o.id = oo.order_id
          WHERE o.status <> 'cancelled' AND o.created_at >= now() - ($1 || ' days')::interval GROUP BY oo.offer_id`, [String(days)]);
      const out = {};
      r.rows.forEach((x) => { out[x.offer_id] = { orders: x.orders, cost: r2(Number(x.discount) + Number(x.delivery_cost) + Number(x.gift_cost)) }; });
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
    const dtype = ['none', 'percent', 'amount'].includes(b.discount_type) ? b.discount_type : 'none';
    let value = Number(b.discount_value || 0);
    if (dtype === 'percent' && !(value > 0 && value <= 100)) return { error: 'النسبة لازم تكون بين 1 و 100.' };
    if (dtype === 'amount' && !(value > 0)) return { error: 'اكتب مبلغ الخصم.' };
    if (dtype === 'none') value = 0;
    const free = !!b.free_delivery;
    const giftId = b.gift_product_id ? Number(b.gift_product_id) : null;
    const giftQty = Number(b.gift_qty || 1);
    if (giftId && (!Number.isInteger(giftId) || !(giftQty > 0 && giftQty <= 1000))) return { error: 'كمية الهدية غير صحيحة.' };
    if (dtype === 'none' && !free && !giftId) return { error: 'اختار للعرض نتيجة واحدة على الأقل: خصم أو توصيل مجاني أو هدية.' };
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
    return { v: { name, dtype, value, free, giftId, giftQty, result_type: dtype !== 'none' ? dtype : (free ? 'free_delivery' : 'gift'), min_amount: min, priority: pri, from, to, cats, prods, stackable: b.stackable !== false, active: b.active !== false } };
  }
  const TZ = (n) => `CASE WHEN $${n}::text IS NULL THEN NULL ELSE ($${n}::text)::timestamp AT TIME ZONE 'Africa/Cairo' END`;

  router.post('/offers', requireAuth('admin'), async (req, res) => {
    const c = clean(req.body || {});
    if (c.error) return res.status(400).json({ error: 'invalid', message: c.error });
    const v = c.v;
    try {
      if (v.giftId && !(await pool.query('SELECT 1 FROM products WHERE id = $1', [v.giftId])).rows.length) return res.status(400).json({ error: 'invalid', message: 'منتج الهدية مش موجود.' });
      const r = await pool.query(
        `INSERT INTO offers (name, active, starts_at, ends_at, min_amount, scope_categories, scope_products, result_type, result_value, discount_type, discount_value, free_delivery, gift_product_id, gift_qty, stackable, priority, created_by)
         VALUES ($1,$2,${TZ(3)},${TZ(4)},$5,$6,$7,$8,$9,$10,$9,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [v.name, v.active, v.from, v.to, v.min_amount, v.cats, v.prods, v.result_type, v.value, v.dtype, v.free, v.giftId, v.giftQty, v.stackable, v.priority, req.user.id]);
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('offer_created', $1, $2)`, [req.user.id, JSON.stringify({ id: r.rows[0].id, name: v.name })]);
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { console.error('offer create', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });
  router.put('/offers/:id', requireAuth('admin'), async (req, res) => {
    const c = clean(req.body || {});
    if (c.error) return res.status(400).json({ error: 'invalid', message: c.error });
    const v = c.v;
    try {
      if (v.giftId && !(await pool.query('SELECT 1 FROM products WHERE id = $1', [v.giftId])).rows.length) return res.status(400).json({ error: 'invalid', message: 'منتج الهدية مش موجود.' });
      const r = await pool.query(
        `UPDATE offers SET name=$1, active=$2, starts_at=${TZ(3)}, ends_at=${TZ(4)}, min_amount=$5, scope_categories=$6, scope_products=$7,
                result_type=$8, result_value=$9, discount_type=$10, discount_value=$9, free_delivery=$11, gift_product_id=$12, gift_qty=$13, stackable=$14, priority=$15 WHERE id=$16 RETURNING id`,
        [v.name, v.active, v.from, v.to, v.min_amount, v.cats, v.prods, v.result_type, v.value, v.dtype, v.free, v.giftId, v.giftQty, v.stackable, v.priority, Number(req.params.id)]);
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

  return { router, evaluate, cap, dropDiscounts, stackWithReferral, recordApplied, logSkips };
}
module.exports = { init };
