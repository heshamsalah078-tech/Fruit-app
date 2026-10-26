// Courier earnings. The courier's pay for an order = the delivery fee of the zone, frozen on the order when it was placed
// (orders.delivery_fee). It is credited exactly once, by the server:
//   * when the order is delivered, to whoever actually delivered it (orders.delivery_staff_id — after a breakdown rescue that
//     is the rescue courier, because rescue-picked rewrites it);
//   * when the customer cancels after the courier left: the full fee, since it is not the courier's fault (cancelPolicy).
// Finance/admin sees what each courier is owed and records a payout, which marks all his unpaid earnings as paid.

function init({ pool, requireAuth, express }) {
  const router = express.Router();
  const money = (v) => Math.round(Number(v || 0) * 100) / 100;

  // Idempotent: UNIQUE(order_id) + ON CONFLICT DO NOTHING means a retry or double-press can never pay twice.
  async function credit(db, orderId, reason) {
    const o = await db.query(
      `SELECT o.id, o.trip_id, o.delivery_fee, o.zone_name, o.delivery_staff_id, t.courier_id AS trip_courier
         FROM orders o LEFT JOIN trips t ON t.id = o.trip_id WHERE o.id = $1`, [orderId]);
    if (!o.rows.length) return null;
    const x = o.rows[0];
    const courierId = x.delivery_staff_id || x.trip_courier;
    if (!courierId) return null;                          // never left with anyone: nobody earned anything
    const r = await db.query(
      `INSERT INTO courier_earnings (order_id, courier_id, trip_id, zone_name, amount, reason)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_id) DO NOTHING RETURNING id, amount`,
      [x.id, courierId, x.trip_id || null, x.zone_name || null, money(x.delivery_fee), reason]);
    return r.rows[0] || null;
  }

  // Courier: my own earnings.
  router.get('/courier/earnings', requireAuth('delivery'), async (req, res) => {
    try {
      const sum = await pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE paid_at IS NULL),0) AS owed,
                COALESCE(SUM(amount) FILTER (WHERE paid_at IS NOT NULL),0) AS paid,
                COUNT(*) FILTER (WHERE paid_at IS NULL)::int AS owed_count,
                COALESCE(SUM(amount) FILTER (WHERE earned_at >= date_trunc('day', now())),0) AS today
           FROM courier_earnings WHERE courier_id = $1`, [req.user.id]);
      const rows = await pool.query(
        `SELECT order_id, zone_name, amount, reason, earned_at, paid_at FROM courier_earnings
          WHERE courier_id = $1 ORDER BY earned_at DESC LIMIT 40`, [req.user.id]);
      const s = sum.rows[0];
      res.json({ owed: money(s.owed), paid: money(s.paid), owed_count: s.owed_count, today: money(s.today), rows: rows.rows.map((r) => ({ ...r, amount: money(r.amount) })) });
    } catch (e) { console.error('courier/earnings', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });

  // Finance / admin / ops: who is owed what.
  router.get('/earnings/summary', requireAuth('admin', 'finance', 'ops'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT s.id, s.name, s.phone,
                COALESCE(SUM(e.amount) FILTER (WHERE e.paid_at IS NULL),0) AS owed,
                COUNT(e.id) FILTER (WHERE e.paid_at IS NULL)::int AS owed_count,
                COALESCE(SUM(e.amount) FILTER (WHERE e.paid_at IS NOT NULL),0) AS paid
           FROM staff s JOIN courier_earnings e ON e.courier_id = s.id
          GROUP BY s.id, s.name, s.phone ORDER BY owed DESC, s.name`);
      const pays = await pool.query(
        `SELECT p.id, p.courier_id, c.name AS courier_name, p.amount, p.orders_count, p.paid_at, b.name AS paid_by_name
           FROM courier_payouts p JOIN staff c ON c.id = p.courier_id LEFT JOIN staff b ON b.id = p.paid_by
          ORDER BY p.paid_at DESC LIMIT 30`);
      res.json({
        couriers: r.rows.map((x) => ({ ...x, owed: money(x.owed), paid: money(x.paid) })),
        payouts: pays.rows.map((x) => ({ ...x, amount: money(x.amount) })),
        total_owed: money(r.rows.reduce((a, x) => a + Number(x.owed), 0))
      });
    } catch (e) { console.error('earnings/summary', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });

  // Pay everything a courier is owed. Takes ONLY the courier id: the amount is computed here, under a lock, so it can never
  // be tampered with or paid twice (two simultaneous presses: the second finds nothing unpaid).
  router.post('/earnings/pay', requireAuth('admin', 'finance'), async (req, res) => {
    const courierId = Number(req.body && req.body.courier_id);
    if (!courierId) return res.status(400).json({ error: 'invalid', message: 'اختر المندوب.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const un = await client.query(`SELECT id, amount FROM courier_earnings WHERE courier_id = $1 AND paid_at IS NULL FOR UPDATE`, [courierId]);
      if (!un.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'nothing', message: 'مفيش مستحقات على المندوب ده.' }); }
      const total = money(un.rows.reduce((a, x) => a + Number(x.amount), 0));
      const note = req.body.note ? String(req.body.note).slice(0, 200) : null;
      const p = await client.query(`INSERT INTO courier_payouts (courier_id, amount, orders_count, paid_by, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [courierId, total, un.rows.length, req.user.id, note]);
      await client.query(`UPDATE courier_earnings SET paid_at = now(), paid_by = $2, payout_id = $3 WHERE id = ANY($1)`, [un.rows.map((x) => x.id), req.user.id, p.rows[0].id]);
      await client.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('courier_payout', $1, $2)`, [req.user.id, JSON.stringify({ courier_id: courierId, amount: total, orders: un.rows.length })]);
      await client.query('COMMIT');
      res.json({ ok: true, amount: total, orders: un.rows.length });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('earnings/pay', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تسجيل الدفع.' });
    } finally { client.release(); }
  });

  return { router, credit };
}

module.exports = { init };
