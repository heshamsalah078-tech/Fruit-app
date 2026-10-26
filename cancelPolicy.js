// Cancellation policy + audit reports (requirements doc sections 17, 18, 19, 20).
//
//  Stage when the customer (or an admin / ops manager) cancels:
//    queued        waiting in the prep queue            -> just removed
//    prep_assigned assigned to a prep worker, not begun -> worker freed, takes the next queued order
//    preparing     prep already started                 -> prep stops, worker freed
//    ready         prepared, maybe a courier reserved   -> removed from the trip, courier freed
//    departed      already left with the courier        -> the COMPANY bears the delivery cost, in tiers:
//                    within cancel_grace_min of the trip starting  -> cancel_early_share_pct of the delivery value
//                    after                                          -> cancel_late_share_pct
//  The customer never pays for a cancelled order. Cancelled orders never count as a delay against anybody.

const DEFAULTS = { cancel_grace_min: 2, cancel_early_share_pct: 33.33, cancel_late_share_pct: 100, standard_delivery_fee: 0 };
const RANGES = { cancel_grace_min: [0, 60], cancel_early_share_pct: [0, 100], cancel_late_share_pct: [0, 100], standard_delivery_fee: [0, 10000] };

function init({ pool, requireAuth, express }) {
  const router = express.Router();

  async function getSettings(db = pool) {
    const r = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.keys(DEFAULTS)]);
    const m = Object.fromEntries(r.rows.map((x) => [x.key, parseFloat(x.value)]));
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = Number.isFinite(m[k]) ? m[k] : DEFAULTS[k];
    return out;
  }

  function stageOf(o) {
    if (o.status === 'awaiting_prep') return o.assigned_prep_id ? 'prep_assigned' : 'queued';
    if (o.status === 'preparing') return 'preparing';
    if (o.status === 'awaiting_delivery') return 'ready';
    if (o.status === 'on_the_way') return 'departed';
    return null;
  }

  // Called inside the cancel transaction, BEFORE the order's status is changed.
  async function record(db, order, actor) {
    const stage = stageOf(order);
    if (!stage) return null;
    const S = await getSettings(db);
    let minutes = null, share = 0, cost = 0, basis = 0;
    const fee = Number(order.delivery_fee || 0);
    if (stage === 'departed') {
      const m = await db.query('SELECT EXTRACT(EPOCH FROM (now() - delivery_started_at)) / 60 AS m FROM orders WHERE id = $1', [order.id]);
      minutes = m.rows[0].m === null ? null : Math.round(Number(m.rows[0].m) * 10) / 10;
      basis = fee > 0 ? fee : S.standard_delivery_fee;
      share = (minutes !== null && minutes <= S.cancel_grace_min) ? S.cancel_early_share_pct : S.cancel_late_share_pct;
      cost = Math.round(basis * share) / 100;
    }
    const trip = order.trip_id ? (await db.query('SELECT courier_id FROM trips WHERE id = $1', [order.trip_id])).rows[0] : null;
    const courierId = (trip && trip.courier_id) || order.delivery_staff_id || null;
    const prepId = order.prep_staff_id || order.assigned_prep_id || null;
    await db.query(
      `INSERT INTO order_cancellations (order_id, cancelled_by_role, cancelled_by_id, stage, reason, trip_id, courier_id, prep_staff_id,
                                        delivery_fee, cost_basis, minutes_since_departure, company_share_pct, company_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (order_id) DO NOTHING`,
      [order.id, actor.role, actor.id, stage, actor.reason ? String(actor.reason).slice(0, 300) : null, order.trip_id || null,
       courierId, prepId, fee, basis, minutes, share, cost]);
    return { stage, company_cost: cost, share_pct: share, minutes, courier_id: courierId, prep_staff_id: prepId };
  }

  router.get('/cancel/settings', requireAuth('admin', 'ops'), async (req, res) => {
    try { res.json(await getSettings()); } catch (e) { res.status(500).json({ error: 'failed' }); }
  });
  router.put('/cancel/settings', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const pairs = [];
      for (const k of Object.keys(DEFAULTS)) {
        if (req.body[k] === undefined) continue;
        const v = Number(req.body[k]);
        if (!Number.isFinite(v) || v < RANGES[k][0] || v > RANGES[k][1]) return res.status(400).json({ error: 'invalid', message: 'قيمة غير صحيحة.' });
        pairs.push([k, v]);
      }
      for (const [k, v] of pairs) await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('cancel_settings_changed', $1, $2)`, [req.user.id, JSON.stringify(Object.fromEntries(pairs))]);
      res.json({ ok: true, settings: await getSettings() });
    } catch (e) { console.error('cancel/settings', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });

  // Cancellation log: who, when, which stage, what the company absorbed.
  router.get('/orders/cancellations', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
      const r = await pool.query(
        `SELECT x.order_id, x.stage, x.reason, x.cancelled_at, x.cancelled_by_role, x.delivery_fee, x.minutes_since_departure,
                x.company_share_pct, x.company_cost,
                c.name AS customer_name,
                CASE WHEN x.cancelled_by_role = 'customer' THEN c.name ELSE sb.name END AS cancelled_by_name,
                cr.name AS courier_name, pr.name AS prep_name
           FROM order_cancellations x
           JOIN orders o ON o.id = x.order_id
           JOIN customers c ON c.id = o.customer_id
           LEFT JOIN staff sb ON sb.id = x.cancelled_by_id AND x.cancelled_by_role <> 'customer'
           LEFT JOIN staff cr ON cr.id = x.courier_id
           LEFT JOIN staff pr ON pr.id = x.prep_staff_id
          WHERE x.cancelled_at > now() - make_interval(days => $1)
          ORDER BY x.cancelled_at DESC LIMIT 300`, [days]);
      const total = r.rows.reduce((a, x) => a + Number(x.company_cost || 0), 0);
      res.json({ rows: r.rows, total_company_cost: Math.round(total * 100) / 100 });
    } catch (e) { console.error('orders/cancellations', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تحميل التقرير.' }); }
  });

  // Manual assignment audit: who assigned which order(s) to whom, and who had them before.
  router.get('/assignments/manual', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
      const prep = await pool.query(
        `SELECT created_at AS at, actor_id, details FROM staff_audit
          WHERE action = 'orders_assigned' AND details ? 'prep' AND created_at > now() - make_interval(days => $1)`, [days]);
      const trip = await pool.query(
        `SELECT created_at AS at, actor_id, action, order_ids, courier_id, prev_courier_id, note, trip_id FROM trip_assign_log
          WHERE actor_id IS NOT NULL AND action IN ('assigned','merged','split') AND mode = 'manual'
            AND created_at > now() - make_interval(days => $1)`, [days]);
      const ids = new Set();
      for (const p of prep.rows) {
        ids.add(p.actor_id); if (p.details.prep) ids.add(Number(p.details.prep));
        for (const v of Object.values(p.details.previous_prep || {})) if (v) ids.add(Number(v));
      }
      for (const t of trip.rows) { ids.add(t.actor_id); if (t.courier_id) ids.add(t.courier_id); if (t.prev_courier_id) ids.add(t.prev_courier_id); }
      const names = {};
      if (ids.size) (await pool.query('SELECT id, name FROM staff WHERE id = ANY($1::int[])', [[...ids].filter(Number.isInteger)])).rows.forEach((s) => { names[s.id] = s.name; });
      const nm = (id) => (id ? (names[id] || '#' + id) : 'بدون');
      const rows = [];
      for (const p of prep.rows) {
        const prev = [...new Set(Object.values(p.details.previous_prep || {}).map((v) => nm(v)))];
        rows.push({ at: p.at, kind: 'prep', actor_name: nm(p.actor_id), order_ids: p.details.order_ids || [], to_name: nm(p.details.prep ? Number(p.details.prep) : null), from_name: prev.join('، ') || 'بدون' });
      }
      for (const t of trip.rows) {
        rows.push({ at: t.at, kind: t.action === 'assigned' ? 'delivery' : t.action, actor_name: nm(t.actor_id), order_ids: t.order_ids || [],
          to_name: t.action === 'assigned' ? nm(t.courier_id) : (t.note || ''), from_name: t.action === 'assigned' ? nm(t.prev_courier_id) : '' });
      }
      rows.sort((a, b) => new Date(b.at) - new Date(a.at));
      res.json({ rows: rows.slice(0, 300) });
    } catch (e) { console.error('assignments/manual', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تحميل التقرير.' }); }
  });

  return { router, record, getSettings };
}

module.exports = { init };
