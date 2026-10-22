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


  // ---------- courier management permission: admin always, or a delegate the admin chose ----------
  async function canManageCouriers(user) {
    if (user.role === 'admin') return true;
    const r = await pool.query('SELECT 1 FROM courier_mgmt_delegates WHERE staff_id=$1', [user.id]);
    return r.rows.length > 0;
  }
  function needManage(req, res, next) {
    canManageCouriers(req.user).then((ok) => {
      if (!ok) return res.status(403).json({ error: 'forbidden', message: 'ليس لديك صلاحية إدارة الدليفرية.' });
      next();
    }).catch(() => res.status(500).json({ error: 'failed' }));
  }

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
    if (mode === 'suspended') return { ok: false, reason: 'suspended', amount: 0 };
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


  // ---------- per-order collection (the collector decides: received / not received) ----------

  // Delivered orders for couriers this person collects from (admin sees all). Grouped client-side.
  router.get('/cash/orders', requireAuth('finance', 'admin'), async (req, res) => {
    try {
      const where = req.user.role === 'admin' ? '' : 'AND (s.collector_id = $1 OR s.collector_id IS NULL)';
      const params = req.user.role === 'admin' ? [] : [req.user.id];
      const r = await pool.query(
        `SELECT o.id, o.total, o.cash_status, o.cash_decided_at, o.delivered_at, o.created_at,
                s.id AS courier_id, s.name AS courier_name, s.settlement_mode,
                d.name AS decided_by_name
           FROM orders o JOIN staff s ON s.id = o.delivery_staff_id
           LEFT JOIN staff d ON d.id = o.cash_decided_by
          WHERE o.status='delivered' ${where}
            AND (o.cash_status='pending' OR o.cash_status='not_received' OR o.cash_decided_at > now() - interval '7 days')
          ORDER BY o.id DESC LIMIT 500`, params
      );
      res.json({ orders: r.rows });
    } catch (e) {
      console.error('cash/orders failed', e.message);
      res.status(500).json({ error: 'failed' });
    }
  });

  // The collector marks specific orders received / not received. Identity comes from the session.
  router.patch('/cash/orders/decide', requireAuth('finance', 'admin'), async (req, res) => {
    const ids = Array.isArray(req.body.order_ids) ? req.body.order_ids.map(Number).filter(Number.isInteger) : [];
    const status = req.body.status;
    if (!ids.length || !['received', 'not_received'].includes(status)) {
      return res.status(400).json({ error: 'invalid', message: 'بيانات غير صحيحة.' });
    }
    try {
      const scope = req.user.role === 'admin' ? '' :
        'AND delivery_staff_id IN (SELECT id FROM staff WHERE collector_id = $4 OR collector_id IS NULL)';
      const params = [ids, status, req.user.id].concat(req.user.role === 'admin' ? [] : [req.user.id]);
      const r = await pool.query(
        `UPDATE orders SET cash_status=$2, cash_decided_by=$3, cash_decided_at=now(),
                cash_settled = ($2 = 'received')
          WHERE id = ANY($1::int[]) AND status='delivered' ${scope} RETURNING id, total`, params
      );
      if (status === 'received' && r.rows.length) {
        // record the money as now in this person's custody (one ledger row per courier)
        const byC = await pool.query(
          `SELECT delivery_staff_id AS cid, SUM(total)::numeric AS amt, array_agg(id) AS oids
             FROM orders WHERE id = ANY($1::int[]) GROUP BY delivery_staff_id`, [r.rows.map((x) => x.id)]
        );
        for (const g of byC.rows) {
          await pool.query(
            `INSERT INTO cash_custody_events (kind, from_staff_id, to_staff_id, amount, order_ids, status, confirmed_by, confirmed_at)
             VALUES ('courier_settlement',$1,$2,$3,$4,'confirmed',$2,now())`,
            [g.cid, req.user.id, g.amt, g.oids]
          );
        }
      }
      res.json({ ok: true, updated: r.rows.length });
    } catch (e) {
      console.error('cash/decide failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' });
    }
  });

  // ---------- courier management page (admin or delegate) ----------

  router.get('/couriers', requireAuth('admin', 'finance', 'prep', 'delivery'), needManage, async (req, res) => {
    const couriers = await pool.query(
      `SELECT s.id, s.name, s.phone, s.active, s.settlement_mode, s.collector_id, c.name AS collector_name,
              COALESCE((SELECT SUM(total) FROM orders o WHERE o.delivery_staff_id=s.id AND o.status='delivered' AND o.cash_settled=false),0)::numeric AS owed
         FROM staff s LEFT JOIN staff c ON c.id = s.collector_id
        WHERE s.role='delivery' ORDER BY s.id`
    );
    const collectors = await pool.query(`SELECT id, name, role FROM staff WHERE role IN ('finance','admin') AND active=true ORDER BY role DESC, name`);
    const out = { couriers: couriers.rows.map((c) => ({ ...c, owed: round2(c.owed) })), collectors: collectors.rows };
    if (req.user.role === 'admin') {
      const d = await pool.query(
        `SELECT s.id, s.name, s.role FROM courier_mgmt_delegates g JOIN staff s ON s.id = g.staff_id ORDER BY s.name`
      );
      const cand = await pool.query(`SELECT id, name, role FROM staff WHERE role <> 'admin' AND role <> 'delivery' AND active=true ORDER BY role DESC, name`);
      out.delegates = d.rows; out.delegate_candidates = cand.rows;
    }
    res.json(out);
  });

  router.post('/couriers', requireAuth('admin', 'finance', 'prep', 'delivery'), needManage, async (req, res) => {
    const bcrypt = require('bcryptjs');
    const { name, phone, password, settlement_mode, collector_id } = req.body;
    if (!name || !phone || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'invalid', message: 'البيانات غير مكتملة.' });
    }
    const mode = ['per_order', 'daily', 'weekly', 'suspended'].includes(settlement_mode) ? settlement_mode : 'per_order';
    try {
      const dup = await pool.query('SELECT id FROM staff WHERE phone=$1', [phone]);
      if (dup.rows.length) return res.status(409).json({ error: 'phone_taken', message: 'رقم الموبايل مستخدم بالفعل.' });
      let col = collector_id ? Number(collector_id) : null;
      if (!col) { // default collector: a finance staff member
        const f = await pool.query(`SELECT id FROM staff WHERE role='finance' AND active=true ORDER BY id LIMIT 1`);
        col = f.rows[0] ? f.rows[0].id : null;
      }
      const hash = await bcrypt.hash(password, 10);
      const r = await pool.query(
        `INSERT INTO staff (name, phone, password_hash, role, settlement_mode, collector_id)
         VALUES ($1,$2,$3,'delivery',$4,$5) RETURNING id, name, phone, settlement_mode, collector_id`,
        [name, phone, hash, mode, col]
      );
      res.json({ ok: true, courier: r.rows[0] });
    } catch (e) {
      console.error('add courier failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّرت الإضافة.' });
    }
  });

  router.patch('/couriers/:id', requireAuth('admin', 'finance', 'prep', 'delivery'), needManage, async (req, res) => {
    const { settlement_mode, collector_id, active } = req.body;
    try {
      const t = await pool.query(`SELECT id FROM staff WHERE id=$1 AND role='delivery'`, [req.params.id]);
      if (!t.rows.length) return res.status(404).json({ error: 'not_found' });
      if (settlement_mode !== undefined) {
        if (!['per_order', 'daily', 'weekly', 'suspended'].includes(settlement_mode)) return res.status(400).json({ error: 'invalid_mode' });
        await pool.query('UPDATE staff SET settlement_mode=$1 WHERE id=$2', [settlement_mode, req.params.id]);
      }
      if (collector_id !== undefined) {
        const c = collector_id ? Number(collector_id) : null;
        if (c) {
          const ok = await pool.query(`SELECT 1 FROM staff WHERE id=$1 AND role IN ('finance','admin') AND active=true`, [c]);
          if (!ok.rows.length) return res.status(400).json({ error: 'invalid_collector' });
        }
        await pool.query('UPDATE staff SET collector_id=$1 WHERE id=$2', [c, req.params.id]);
      }
      if (typeof active === 'boolean') await pool.query('UPDATE staff SET active=$1 WHERE id=$2', [active, req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('patch courier failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' });
    }
  });

  // Delegation is the admin's alone: grant / revoke courier-management to a staff member.
  router.put('/couriers/delegates/:staffId', requireAuth('admin'), async (req, res) => {
    const grant = req.body.grant !== false;
    try {
      if (grant) {
        const ok = await pool.query(`SELECT 1 FROM staff WHERE id=$1 AND role IN ('finance','prep') AND active=true`, [req.params.staffId]);
        if (!ok.rows.length) return res.status(400).json({ error: 'invalid_staff' });
        await pool.query(
          'INSERT INTO courier_mgmt_delegates (staff_id, granted_by) VALUES ($1,$2) ON CONFLICT (staff_id) DO NOTHING',
          [req.params.staffId, req.user.id]
        );
      } else {
        await pool.query('DELETE FROM courier_mgmt_delegates WHERE staff_id=$1', [req.params.staffId]);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('delegate failed', e.message);
      res.status(500).json({ error: 'failed' });
    }
  });

  // Lets the UI know whether to show the "الدليفرية" tab to this user.
  router.get('/couriers/can-manage', requireAuth('admin', 'finance', 'prep', 'delivery'), async (req, res) => {
    res.json({ can: await canManageCouriers(req.user) });
  });

  return { router, canTakeDelivery, courierOwed, custodyBalance };
}

module.exports = { init };
