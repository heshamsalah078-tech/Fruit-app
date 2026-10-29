// Courier earnings. The courier's pay for an order = the delivery fee of the zone, frozen on the order when it was placed
// (orders.delivery_fee). It is credited exactly once, by the server:
//   * when the order is delivered, to whoever actually delivered it (orders.delivery_staff_id — after a breakdown rescue that
//     is the rescue courier, because rescue-picked rewrites it);
//   * when the customer cancels after the courier left: the full fee, since it is not the courier's fault (cancelPolicy).
// Finance/admin sees what each courier is owed and records a payout, which marks all his unpaid earnings as paid.

function init({ pool, requireAuth, express }) {
  const router = express.Router();
  const money = (v) => Math.round(Number(v || 0) * 100) / 100;

  // Cash the courier is holding for the company: delivered orders not yet settled (same rule as cashCustody.courierOwed).
  async function cashHeld(db, courierId) {
    const r = await db.query(`SELECT COALESCE(SUM(total),0) AS c FROM orders WHERE delivery_staff_id = $1 AND status = 'delivered' AND cash_settled = false`, [courierId]);
    return money(r.rows[0].c);
  }

  // Idempotent: UNIQUE(order_id) + ON CONFLICT DO NOTHING means a retry or double-press can never pay twice.
  async function credit(db, orderId, reason) {
    const o = await db.query(
      `SELECT o.id, o.trip_id, COALESCE(o.zone_fee, o.delivery_fee) AS delivery_fee, o.zone_name, o.delivery_staff_id, t.courier_id AS trip_courier
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
                COALESCE(SUM(amount) FILTER (WHERE earned_at >= date_trunc('day', now())),0) AS today,
                COALESCE(SUM(amount) FILTER (WHERE paid_at IS NULL AND reason = 'cancelled_after_departure'),0) AS cancel_owed,
                COUNT(*) FILTER (WHERE paid_at IS NULL AND reason = 'cancelled_after_departure')::int AS cancel_count
           FROM courier_earnings WHERE courier_id = $1`, [req.user.id]);
      const rows = await pool.query(
        `SELECT order_id, zone_name, amount, reason, earned_at, paid_at FROM courier_earnings
          WHERE courier_id = $1 ORDER BY earned_at DESC LIMIT 40`, [req.user.id]);
      const s = sum.rows[0];
      const held = await cashHeld(pool, req.user.id);
      res.json({ owed: money(s.owed), paid: money(s.paid), owed_count: s.owed_count, today: money(s.today), cancel_owed: money(s.cancel_owed), cancel_count: s.cancel_count, cash_held: held, net: money(held - Number(s.owed)), rows: rows.rows.map((r) => ({ ...r, amount: money(r.amount) })) });
    } catch (e) { console.error('courier/earnings', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });

  // Finance / admin / ops: who is owed what.
  router.get('/earnings/summary', requireAuth('admin', 'finance', 'ops'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT s.id, s.name, s.phone,
                COALESCE(SUM(e.amount) FILTER (WHERE e.paid_at IS NULL),0) AS owed,
                COUNT(e.id) FILTER (WHERE e.paid_at IS NULL)::int AS owed_count,
                COALESCE(SUM(e.amount) FILTER (WHERE e.paid_at IS NOT NULL),0) AS paid,
                COALESCE(SUM(e.amount) FILTER (WHERE e.paid_at IS NULL AND e.reason = 'cancelled_after_departure'),0) AS cancel_owed,
                COUNT(e.id) FILTER (WHERE e.paid_at IS NULL AND e.reason = 'cancelled_after_departure')::int AS cancel_count,
                COALESCE((SELECT SUM(o.total) FROM orders o WHERE o.delivery_staff_id = s.id AND o.status = 'delivered' AND o.cash_settled = false),0) AS cash_held
           FROM staff s JOIN courier_earnings e ON e.courier_id = s.id
          GROUP BY s.id, s.name, s.phone ORDER BY owed DESC, s.name`);
      const pays = await pool.query(
        `SELECT p.id, p.courier_id, c.name AS courier_name, p.amount, p.orders_count, p.paid_at, p.method, p.cash_handed, b.name AS paid_by_name
           FROM courier_payouts p JOIN staff c ON c.id = p.courier_id LEFT JOIN staff b ON b.id = p.paid_by
          ORDER BY p.paid_at DESC LIMIT 30`);
      res.json({
        couriers: r.rows.map((x) => ({ ...x, owed: money(x.owed), paid: money(x.paid), cancel_owed: money(x.cancel_owed), cash_held: money(x.cash_held), net: money(Number(x.cash_held) - Number(x.owed)) })),
        payouts: pays.rows.map((x) => ({ ...x, amount: money(x.amount) })),
        total_owed: money(r.rows.reduce((a, x) => a + Number(x.owed), 0))
      });
    } catch (e) { console.error('earnings/summary', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });

  // Pay a courier what the company owes him. Takes ONLY the courier id: the amount is computed here, under a lock, so it can
  // never be tampered with or paid twice (two simultaneous presses: the second finds nothing unpaid).
  //   default            : the company pays him the whole unpaid amount (method 'cash').
  //   deduct_from_cash   : FINANCE ONLY. The courier is holding the company's cash (delivered orders not yet settled). What the
  //                        company owes him is deducted from it: he hands over (cash - deducted), his unpaid earnings are marked
  //                        paid (only whole orders, oldest first, up to the cash he holds) and his orders are marked settled.
  router.post('/earnings/pay', requireAuth('admin', 'finance'), async (req, res) => {
    const courierId = Number(req.body && req.body.courier_id);
    const net = !!(req.body && req.body.deduct_from_cash);
    if (!courierId) return res.status(400).json({ error: 'invalid', message: 'اختر المندوب.' });
    if (net && req.user.role !== 'finance') return res.status(403).json({ error: 'finance_only', message: 'الخصم من العهدة للمدير المالي فقط.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const un = await client.query(`SELECT id, amount FROM courier_earnings WHERE courier_id = $1 AND paid_at IS NULL ORDER BY earned_at, id FOR UPDATE`, [courierId]);
      if (!un.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'nothing', message: 'مفيش مستحقات على المندوب ده.' }); }
      const note = req.body.note ? String(req.body.note).slice(0, 200) : null;
      let chosen = un.rows, total = money(un.rows.reduce((a, x) => a + Number(x.amount), 0)), handed = null;
      if (net) {
        const held = await client.query(`SELECT id, total FROM orders WHERE delivery_staff_id = $1 AND status = 'delivered' AND cash_settled = false FOR UPDATE`, [courierId]);
        const cash = money(held.rows.reduce((a, x) => a + Number(x.total), 0));
        chosen = []; let sum = 0;
        for (const r of un.rows) { if (money(sum + Number(r.amount)) > cash) break; sum = money(sum + Number(r.amount)); chosen.push(r); }
        if (!chosen.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'cash_too_low', message: 'العهدة اللي مع المندوب أقل من مستحقاته. سجّل الدفع كاش بدل الخصم.' }); }
        total = sum; handed = money(cash - sum);
        const ids = held.rows.map((x) => x.id);
        if (ids.length) {
          // the courier had already reported a handover for these orders: replace it with this one
          await client.query(`DELETE FROM cash_custody_events WHERE kind = 'courier_settlement' AND from_staff_id = $1 AND status = 'pending'`, [courierId]);
          if (handed > 0) {
            await client.query(`INSERT INTO cash_custody_events (kind, from_staff_id, to_staff_id, amount, order_ids, status, confirmed_by, confirmed_at)
                                VALUES ('courier_settlement', $1, $2, $3, $4, 'confirmed', $2, now())`, [courierId, req.user.id, handed, ids]);
          }
          await client.query(`UPDATE orders SET cash_settled = true WHERE id = ANY($1::int[])`, [ids]);
        }
      }
      const p = await client.query(`INSERT INTO courier_payouts (courier_id, amount, orders_count, paid_by, note, method, cash_handed) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [courierId, total, chosen.length, req.user.id, note, net ? 'netted' : 'cash', handed]);
      await client.query(`UPDATE courier_earnings SET paid_at = now(), paid_by = $2, payout_id = $3 WHERE id = ANY($1)`, [chosen.map((x) => x.id), req.user.id, p.rows[0].id]);
      await client.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('courier_payout', $1, $2)`, [req.user.id, JSON.stringify({ courier_id: courierId, amount: total, orders: chosen.length, method: net ? 'netted' : 'cash', cash_handed: handed })]);
      await client.query('COMMIT');
      res.json({ ok: true, amount: total, orders: chosen.length, method: net ? 'netted' : 'cash', cash_handed: handed });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('earnings/pay', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تسجيل الدفع.' });
    } finally { client.release(); }
  });

  return { router, credit };
}

module.exports = { init };
