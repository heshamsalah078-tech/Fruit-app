// SLA settings + delay report with attribution (requirements doc sections 6, 7, 12, 22).
//
// Stages and who is responsible when one runs over its deadline:
//   prep      (prep_assigned_at -> prepared_at)       -> the prep worker holding the order
//   pickup    (prepared_at -> courier starts)         -> the assigned courier; if nobody was assigned, the ops manager
//   delivery  (delivery_started_at -> delivered_at)   -> the courier delivering it
//   queue     (created_at -> prep assigned)           -> nobody (all prep staff busy), unless there is NO active prep worker -> ops manager
// Cancelled orders are never counted against anyone.

function init({ pool, requireAuth, express }) {
  const router = express.Router();
  const KEYS = { total: 'sla_total_max_min', prep: 'sla_prep_min', delivery: 'sla_delivery_min', pickup: 'sla_pickup_min' };
  const DEFAULTS = { total: 45, prep: 15, delivery: 25, pickup: 5 };

  async function readSettings(db = pool) {
    const r = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.values(KEYS)]);
    const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    const out = {};
    for (const [name, key] of Object.entries(KEYS)) {
      const n = parseInt(m[key], 10);
      out[name] = Number.isInteger(n) && n > 0 ? n : DEFAULTS[name];
    }
    return out;
  }
  const isMin = v => Number.isInteger(v) && v >= 1 && v <= 600;
  async function save(pairs) {
    for (const [key, v] of pairs) {
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(v)]);
    }
  }

  router.get('/sla/settings', requireAuth('admin', 'ops'), async (req, res) => {
    try { res.json(await readSettings()); }
    catch (e) { console.error('sla settings', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تحميل الإعدادات.' }); }
  });

  // Admin: the overall ceiling for one order (prep + delivery must fit inside it).
  router.put('/sla/total', requireAuth('admin'), async (req, res) => {
    try {
      const total = Number(req.body.total_max_min);
      if (!isMin(total)) return res.status(400).json({ error: 'invalid', message: 'قيمة غير صحيحة.' });
      const cur = await readSettings();
      if (cur.prep + cur.delivery > total) {
        return res.status(400).json({ error: 'below_split',
          message: `السقف أقل من مجموع التجهيز والتوصيل الحاليين (${cur.prep + cur.delivery} دقيقة). اطلب من مدير التشغيل تقليلهم أولًا.` });
      }
      await save([[KEYS.total, total]]);
      res.json({ ok: true, settings: await readSettings() });
    } catch (e) { console.error('sla total', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });

  // Ops manager (or admin): split the ceiling into prep + delivery, and the courier pickup wait.
  router.put('/sla/split', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const cur = await readSettings();
      const prep = req.body.prep_min === undefined ? cur.prep : Number(req.body.prep_min);
      const delivery = req.body.delivery_min === undefined ? cur.delivery : Number(req.body.delivery_min);
      const pickup = req.body.pickup_min === undefined ? cur.pickup : Number(req.body.pickup_min);
      if (!isMin(prep) || !isMin(delivery) || !isMin(pickup)) return res.status(400).json({ error: 'invalid', message: 'قيمة غير صحيحة.' });
      if (prep + delivery > cur.total) {
        return res.status(400).json({ error: 'over_total',
          message: `مجموع التجهيز والتوصيل (${prep + delivery}) أكبر من السقف الكلي (${cur.total} دقيقة) الذي حدّده المدير.` });
      }
      await save([[KEYS.prep, prep], [KEYS.delivery, delivery], [KEYS.pickup, pickup]]);
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('sla_split_changed', $1, $2)`,
        [req.user.id, JSON.stringify({ prep, delivery, pickup })]);
      res.json({ ok: true, settings: await readSettings() });
    } catch (e) { console.error('sla split', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });

  const mins = s => (s === null || s === undefined) ? null : Math.round(Number(s) / 60);

  // Report: per order, expected vs actual per stage + who is responsible for each overrun.
  // ?scope=open (default) | done   ?days=7 (done only)   ?late=1 -> only orders with some delay
  router.get('/orders/sla', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const done = req.query.scope === 'done';
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
      const r = await pool.query(
        `SELECT o.id, o.status, o.created_at, o.prep_assignment_mode,
                o.assigned_delivery_id, o.assigned_prep_id,
                c.name AS customer_name,
                ps.name AS prep_name, ad.name AS assigned_courier_name, dd.name AS delivery_name,
                EXTRACT(EPOCH FROM (o.prep_due_at - o.prep_assigned_at)) AS prep_expected_s,
                EXTRACT(EPOCH FROM (COALESCE(o.prepared_at, now()) - o.prep_assigned_at)) AS prep_actual_s,
                EXTRACT(EPOCH FROM (COALESCE(o.prepared_at, now()) - o.prep_due_at)) AS prep_over_s,
                EXTRACT(EPOCH FROM (COALESCE(o.delivery_started_at, now()) - o.pickup_due_at)) AS pickup_over_s,
                EXTRACT(EPOCH FROM (o.delivery_due_at - o.delivery_started_at)) AS delivery_expected_s,
                EXTRACT(EPOCH FROM (COALESCE(o.delivered_at, now()) - o.delivery_started_at)) AS delivery_actual_s,
                EXTRACT(EPOCH FROM (COALESCE(o.delivered_at, now()) - o.delivery_due_at)) AS delivery_over_s,
                EXTRACT(EPOCH FROM (COALESCE(o.prep_assigned_at, now()) - o.created_at)) AS queue_wait_s,
                EXTRACT(EPOCH FROM (COALESCE(o.delivered_at, now()) - o.created_at)) AS total_actual_s,
                tr.courier_arrived_at, tr.assignment_mode AS delivery_assignment_mode,
                EXISTS (SELECT 1 FROM trip_assign_log l WHERE l.trip_id = o.trip_id AND l.mode = 'manual' AND l.action IN ('assigned','merged','split')) AS trip_manual_touch,
                (o.prep_assigned_at IS NULL) AS in_queue, o.prep_due_at, o.pickup_due_at, o.delivery_due_at,
                (SELECT COUNT(*) FROM staff WHERE role='prep' AND active AND password_hash IS NOT NULL) AS active_prep
           FROM orders o
           JOIN customers c ON c.id = o.customer_id
           LEFT JOIN staff ps ON ps.id = o.prep_staff_id
           LEFT JOIN staff ad ON ad.id = o.assigned_delivery_id
           LEFT JOIN staff dd ON dd.id = o.delivery_staff_id
           LEFT JOIN trips tr ON tr.id = o.trip_id
          WHERE o.status <> 'cancelled'
            AND (${done ? `o.status = 'delivered' AND o.delivered_at > now() - make_interval(days => $1)`
                        : `o.status NOT IN ('delivered')`})
          ORDER BY o.created_at DESC
          LIMIT 300`, done ? [days] : []);
      const rows = r.rows.map(o => {
        const delays = [];
        const prepOver = mins(o.prep_over_s);
        if (o.prep_due_at && prepOver > 0)
          delays.push({ stage: 'prep', minutes: prepOver, party_role: 'prep', party_name: o.prep_name || 'موظف التجهيز' });
        const pickOver = mins(o.pickup_over_s);
        if (o.pickup_due_at && pickOver > 0) {
          // no courier assigned, or the courier was already standing at the store in time and the trip just wasn't started -> ops manager
          const byOps = !o.assigned_delivery_id || (o.courier_arrived_at && o.pickup_due_at && new Date(o.courier_arrived_at) <= new Date(o.pickup_due_at));
          delays.push({ stage: 'pickup', minutes: pickOver, party_role: byOps ? 'ops' : 'delivery',
                        party_name: byOps ? 'مدير التشغيل' : (o.assigned_courier_name || 'المندوب') });
        }
        const delOver = mins(o.delivery_over_s);
        if (o.delivery_due_at && delOver > 0)
          delays.push({ stage: 'delivery', minutes: delOver, party_role: 'delivery', party_name: o.delivery_name || 'المندوب' });
        if (o.in_queue && Number(o.active_prep) === 0)
          delays.push({ stage: 'queue', minutes: mins(o.queue_wait_s), party_role: 'ops', party_name: 'مدير التشغيل (لا يوجد موظف تجهيز فعّال)' });
        return {
          id: o.id, status: o.status, customer_name: o.customer_name, created_at: o.created_at,
          assignment_mode: o.prep_assignment_mode,
          delivery_assignment_mode: o.delivery_assignment_mode || null,
          // section 18: the ops manager is accountable for ANY delay (he can always override); this flags whether he actually intervened
          ops_intervened: o.prep_assignment_mode === 'manual' || o.delivery_assignment_mode === 'manual' || o.trip_manual_touch === true,
          queue_wait_min: mins(o.queue_wait_s),
          prep: { expected_min: mins(o.prep_expected_s), actual_min: mins(o.prep_actual_s) },
          delivery: { expected_min: mins(o.delivery_expected_s), actual_min: mins(o.delivery_actual_s) },
          total_actual_min: mins(o.total_actual_s),
          delays: delays.map(d => ({ ...d, ops_accountable: true }))
        };
      });
      res.json(req.query.late === '1' ? rows.filter(x => x.delays.length) : rows);
    } catch (e) {
      console.error('orders/sla failed', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر تحميل التقرير.' });
    }
  });

  return { router, readSettings };
}

module.exports = { init };
