// cashCustody.js — courier -> finance -> admin cash settlement chain for سوق الطازج
// Mounted from server.js:  const cash = require('./cashCustody').init({ pool, requireAuth, express });
//
// Model:
//  - Every delivered order's cash is "owed" by the delivery staff who delivered it, until it's
//    folded into a CONFIRMED courier_settlement event (cash_custody_events, kind='courier_settlement').
//  - A courier whose settlement_mode is 'per_order' cannot be assigned/claim a new delivery while they
//    have ANY unsettled delivered order. 'daily'/'weekly' couriers are never blocked by this module;
//    the admin is simply expected to chase them on that cadence.
//  - Once a finance/admin user CONFIRMS a courier_settlement, those orders are marked cash_settled=true
//    and the amount becomes a debt owed by that finance/admin staff member (it is now in their custody).
//  - A finance user can report a finance_handover (forwarding their accumulated custody to the admin);
//    once an admin confirms it, that amount is cleared from the finance user's custody balance.
//  - Everything is manual confirmation (no real payment gateway) — this file only tracks who currently
//    holds responsibility for which cash, and blocks new delivery claims until the chain is honoured.

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function init({ pool, requireAuth, express }) {
  const router = express.Router();

  // ---------- core balance queries ----------

  // Sum of delivered-but-not-yet-settled orders for one courier.
  async function courierOwed(db, staffId) {
    const r = await db.query(
      `SELECT COALESCE(SUM(total),0)::numeric AS amount, COALESCE(array_agg(id),'{}')::int[] AS order_ids
         FROM orders WHERE delivery_staff_id=$1 AND status='delivered' AND cash_settled=false`,
      [staffId]
    );
    return { amount: round2(r.rows[0].amount), order_ids: r.rows[0].order_ids };
  }

  // Current custody balance held by a finance/admin staff member:
  // sum of confirmed courier_settlements received, minus sum of confirmed finance_handovers sent onward.
  async function custodyBalance(db, staffId) {
    const r = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE kind='courier_settlement' AND to_staff_id=$1 AND status='confirmed'),0)
         - COALESCE(SUM(amount) FILTER (WHERE kind='finance_handover' AND from_staff_id=$1 AND status='confirmed'),0)
         AS balance
       FROM cash_custody_events`,
      [staffId]
    );
    return round2(r.rows[0].balance);
  }

  // Can this delivery staff member take on a new delivery right now?
  async function canTakeDelivery(db, staffId) {
    const s = await db.query('SELECT settlement_mode FROM staff WHERE id=$1', [staffId]);
    const mode = s.rows[0] && s.rows[0].settlement_mode;
    if (mode !== 'per_order') return { ok: true };
    const owed = await courierOwed(db, staffId);
    if (owed.amount > 0) {
      return { ok: false, reason: 'unsettled_cash', amount: owed.amount };
    }
    return { ok: true };
  }

  // ---------- courier side ----------

  // Courier reports they have paid their outstanding cash to a finance/admin person.
  // Nothing is confirmed yet — this just opens a pending event that staff must confirm.
  router.post('/cash/courier-settle', requireAuth('delivery'), async (req, res) => {
    try {
      const owed = await courierOwed(pool, req.user.id);
      if (!owed.order_ids.length) {
        return res.status(400).json({ error: 'nothing_owed', message: 'لا يوجد مبلغ مستحق عليك حالياً.' });
      }
      const to_staff_id = req.body.to_staff_id || null; // optional: which finance/admin person they paid
      const r = await pool.query(
        `INSERT INTO cash_custody_events (kind, from_staff_id, to_staff_id, amount, order_ids, status)
         VALUES ('courier_settlement',$1,$2,$3,$4,'pending') RETURNING *`,
        [req.user.id, to_staff_id, owed.amount, owed.order_ids]
      );
      res.json({ ok: true, event: r.rows[0] });
    } catch (e) {
      console.error('courier-settle failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر تسجيل التسديد.' });
    }
  });

  // Courier's own current standing: how much they owe (if anything) + whether they're blocked.
  router.get('/cash/my-status', requireAuth('delivery'), async (req, res) => {
    const owed = await courierOwed(pool, req.user.id);
    const gate = await canTakeDelivery(pool, req.user.id);
    const pending = await pool.query(
      `SELECT * FROM cash_custody_events WHERE kind='courier_settlement' AND from_staff_id=$1 AND status='pending' ORDER BY reported_at DESC`,
      [req.user.id]
    );
    res.json({ owed: owed.amount, order_count: owed.order_ids.length, blocked: !gate.ok, pending: pending.rows });
  });

  // ---------- finance / admin side ----------

  // List pending events this staff member can act on:
  //  - finance sees pending courier_settlements (any courier -> finance/admin generally, shown to all finance+admin)
  //  - admin additionally sees pending finance_handovers
  router.get('/cash/pending', requireAuth('finance', 'admin'), async (req, res) => {
    const courierEvents = await pool.query(
      `SELECT e.*, s.name AS from_name FROM cash_custody_events e JOIN staff s ON s.id = e.from_staff_id
        WHERE e.kind='courier_settlement' AND e.status='pending' ORDER BY e.reported_at`
    );
    let handovers = { rows: [] };
    if (req.user.role === 'admin') {
      handovers = await pool.query(
        `SELECT e.*, s.name AS from_name FROM cash_custody_events e JOIN staff s ON s.id = e.from_staff_id
          WHERE e.kind='finance_handover' AND e.status='pending' ORDER BY e.reported_at`
      );
    }
    res.json({ courier_settlements: courierEvents.rows, finance_handovers: handovers.rows });
  });

  // Finance or admin confirms they actually received a courier's cash.
  // The money becomes their own custody; those orders are marked settled.
  router.patch('/cash/custody/:id/confirm', requireAuth('finance', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT * FROM cash_custody_events WHERE id=$1 AND status='pending' FOR UPDATE`, [req.params.id]
      );
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
      const ev = r.rows[0];
      if (ev.kind === 'finance_handover' && req.user.role !== 'admin') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'admin_only', message: 'تسليم المدير المالي للإدارة يؤكده الأدمن فقط.' });
      }
      await client.query(
        `UPDATE cash_custody_events SET status='confirmed', confirmed_by=$1, confirmed_at=now(), to_staff_id=$1 WHERE id=$2`,
        [req.user.id, ev.id]
      );
      if (ev.kind === 'courier_settlement' && ev.order_ids && ev.order_ids.length) {
        await client.query(`UPDATE orders SET cash_settled=true WHERE id = ANY($1::int[])`, [ev.order_ids]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('confirm custody failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر تأكيد الاستلام.' });
    } finally { client.release(); }
  });

  // Finance reports forwarding their accumulated custody balance onward to the admin.
  router.post('/cash/finance-handover', requireAuth('finance'), async (req, res) => {
    try {
      const balance = await custodyBalance(pool, req.user.id);
      if (balance <= 0) {
        return res.status(400).json({ error: 'nothing_owed', message: 'لا يوجد رصيد في عهدتك حالياً.' });
      }
      const r = await pool.query(
        `INSERT INTO cash_custody_events (kind, from_staff_id, to_staff_id, amount, status)
         VALUES ('finance_handover',$1,NULL,$2,'pending') RETURNING *`,
        [req.user.id, balance]
      );
      res.json({ ok: true, event: r.rows[0] });
    } catch (e) {
      console.error('finance-handover failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر تسجيل التوريد.' });
    }
  });

  // Any finance/admin user's current custody balance + courier owed amounts (for dashboards).
  router.get('/cash/overview', requireAuth('finance', 'admin'), async (req, res) => {
    const myCustody = await custodyBalance(pool, req.user.id);
    const couriers = await pool.query(
      `SELECT s.id, s.name, s.settlement_mode,
              COALESCE((SELECT SUM(total) FROM orders o WHERE o.delivery_staff_id=s.id AND o.status='delivered' AND o.cash_settled=false),0)::numeric AS owed
         FROM staff s WHERE s.role='delivery' AND s.active=true ORDER BY s.name`
    );
    res.json({
      my_custody: myCustody,
      couriers: couriers.rows.map(c => ({ id: c.id, name: c.name, settlement_mode: c.settlement_mode, owed: round2(c.owed) }))
    });
  });

  return { router, canTakeDelivery, courierOwed, custodyBalance };
}

module.exports = { init };
