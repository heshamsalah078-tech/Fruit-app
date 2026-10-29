// Automatic courier dispatch with trips (requirements doc sections 2,3,4,5,13,14,15,16,21).
//
//  * Every order lives in a trip (default: one order per trip). The ops manager may merge orders into one trip.
//  * The system assigns each trip to a courier BEFORE prep finishes (pre-emptive, courier_lead_min). There is NO choice for the
//    courier: he only acknowledges ("تمام") within courier_offer_min; if he doesn't, it moves to the next courier; nobody left ->
//    escalated to ops (red alert).
//  * Ranking: couriers already free at the store (idle longest first) -> couriers who finished and are heading back
//    (finished earliest; they do NOT wait for "وصلت"). A courier still carrying orders is never given a new one.
//  * A courier becomes free ONLY by pressing "وصلت" at the store after finishing his trip. The moment any courier presses it
//    he takes the oldest ready trip, overriding a reservation held by a courier who isn't physically there yet; the displaced
//    courier is auto-given the next trip in line.
//  * A courier who said "تمام" but isn't at the store courier_max_delay_min after the order is ready: depending on the setting
//    courier_late_action the trip moves to another courier ('auto') or the ops manager is notified and decides ('manual').
//  * The ops manager starts a trip with one button ("بدأت"); that is when the delivery timer begins.

const LOCK_KEY = 19001;
const DEFAULTS = { courier_max_orders: 3, courier_offer_min: 2, courier_lead_min: 3, courier_max_delay_min: 30, courier_late_grace_min: 5 };
const RANGES = { courier_max_orders: [1, 10], courier_offer_min: [1, 30], courier_lead_min: [0, 30], courier_max_delay_min: [5, 240], courier_late_grace_min: [1, 120] };
// What happens when a courier said "تمام" but didn't reach the store in time: 'auto' = the system moves the trip to the next courier,
// 'manual' = only the ops manager is notified and he decides. Either way the ops manager can reassign at any time.
const LATE_ACTIONS = ['auto', 'manual'];
const OPEN_TRIP = ['unassigned', 'offering', 'assigned', 'on_the_way'];

function init({ pool, requireAuth, express, canTakeDelivery, moveStock, notifyStaff, notifyAdmins }) {
  const router = express.Router();
  const safe = (p) => Promise.resolve(p).catch((e) => console.error('trips notify failed:', e.message));

  // ---------- settings ----------
  async function getSettings(db = pool) {
    const r = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.keys(DEFAULTS)]);
    const m = Object.fromEntries(r.rows.map((x) => [x.key, parseInt(x.value, 10)]));
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = Number.isInteger(m[k]) ? m[k] : DEFAULTS[k];
    const la = await db.query(`SELECT value FROM app_settings WHERE key = 'courier_late_action'`);
    out.courier_late_action = la.rows[0] && LATE_ACTIONS.includes(la.rows[0].value) ? la.rows[0].value : 'auto';
    const bw = await db.query(`SELECT value FROM app_settings WHERE key = 'trip_bundle_window_min'`);
    const bwv = bw.rows[0] ? parseInt(bw.rows[0].value, 10) : NaN;
    out.trip_bundle_window_min = Number.isInteger(bwv) && bwv >= 0 && bwv <= 60 ? bwv : 5;
    return out;
  }

  async function log(db, tripId, action, o = {}) {
    await db.query(
      `INSERT INTO trip_assign_log (trip_id, order_ids, action, mode, courier_id, prev_courier_id, actor_id, note)
       VALUES ($1, (SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM orders WHERE trip_id = $1), $2, $3, $4, $5, $6, $7)`,
      [tripId, action, o.mode || null, o.courier_id || null, o.prev || null, o.actor || null, o.note || null]);
  }

  // ---------- low-level transitions (always called inside a transaction) ----------
  async function lockTrip(db, id) {
    const r = await db.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id]);
    return r.rows[0] || null;
  }

  async function supersedePending(db, tripId, exceptOfferId = null) {
    await db.query(
      `UPDATE trip_offers SET response = 'superseded', responded_at = now()
        WHERE trip_id = $1 AND response = 'pending' AND ($2::int IS NULL OR id <> $2)`, [tripId, exceptOfferId]);
  }

  async function assignTrip(db, tripId, courierId, mode, actorId, note) {
    const t = await lockTrip(db, tripId);
    const atStore = await db.query('SELECT at_store_since FROM staff WHERE id = $1', [courierId]);
    const there = !!(atStore.rows[0] && atStore.rows[0].at_store_since);
    await db.query(
      `UPDATE trips SET status = 'assigned', courier_id = $2, assignment_mode = $3, assigned_by = $4, assigned_at = now(),
              escalated_at = NULL, late_notified_at = NULL, courier_arrived_at = CASE WHEN $5 THEN now() ELSE NULL END
        WHERE id = $1`, [tripId, courierId, mode, actorId || null, there]);
    await db.query(
      `UPDATE orders SET assigned_delivery_id = $2 WHERE trip_id = $1 AND status NOT IN ('delivered','cancelled')`,
      [tripId, courierId]);
    await supersedePending(db, tripId);
    await log(db, tripId, 'assigned', { mode, courier_id: courierId, prev: t && t.courier_id, actor: actorId, note });
  }

  async function releaseTrip(db, tripId, note, actorId) {
    const t = await lockTrip(db, tripId);
    if (!t) return;
    await db.query(
      `UPDATE trips SET status = 'unassigned', courier_id = NULL, assignment_mode = NULL, assigned_by = NULL,
              assigned_at = NULL, courier_arrived_at = NULL WHERE id = $1`, [tripId]);
    await db.query(
      `UPDATE orders SET assigned_delivery_id = NULL WHERE trip_id = $1 AND status NOT IN ('delivered','cancelled','on_the_way')`, [tripId]);
    await supersedePending(db, tripId);
    await log(db, tripId, 'released', { prev: t.courier_id, actor: actorId, note });
  }

  // Recompute a trip's state after one of its orders was delivered or cancelled. Used by server.js hooks.
  async function refreshTrip(db, tripId) {
    if (!tripId) return;
    const t = await lockTrip(db, tripId);
    if (!t || t.status === 'done' || t.status === 'cancelled') return;
    const c = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('delivered','cancelled'))::int AS open,
              COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered FROM orders WHERE trip_id = $1`, [tripId]);
    const { open, delivered } = c.rows[0];
    if (open > 0) return;
    await supersedePending(db, tripId);
    if (t.status === 'on_the_way' || delivered > 0) {
      await db.query(`UPDATE trips SET status = 'done', ended_at = now() WHERE id = $1`, [tripId]);
      // Finished his trip: NOT free until he presses "وصلت" at the store again.
      if (t.courier_id) await db.query('UPDATE staff SET at_store_since = NULL WHERE id = $1', [t.courier_id]);
      await log(db, tripId, 'done', { mode: 'system', courier_id: t.courier_id });
    } else {
      await db.query(`UPDATE trips SET status = 'cancelled', ended_at = now() WHERE id = $1`, [tripId]);
      await log(db, tripId, 'cancelled', { mode: 'system', courier_id: t.courier_id, note: 'all orders cancelled' });
    }
  }

  // ---------- candidate selection ----------
  // A courier does NOT have to wait at the store: he only goes there once a trip is assigned to him.
  //   FREE  = on duty, no trip, nothing to return.  BUSY = still on a trip.
  //   1) the trip is shown to EVERY free courier at once; the first one to press "تمام" gets it and it disappears from the rest;
  //   2) only if nobody is free, or nobody confirmed within courier_offer_min, it goes to BUSY couriers ONE AT A TIME, the one who
  //      will finish first first (fewest orders left, then the one who left earliest); each has courier_offer_min to confirm.
  // Never offered: a courier who already holds a waiting trip, whose bike broke down, who carries an order to return, or who
  // already ignored / was late on THIS trip.
  async function candidatesFor(db, tripId) {
    const r = await db.query(
      `SELECT s.id, s.name, bt.id AS busy_trip, bt.started_at AS busy_started,
              COALESCE((SELECT COUNT(*) FROM orders ob WHERE ob.trip_id = bt.id AND ob.status NOT IN ('delivered','cancelled')), 0)::int AS open_left,
              EXISTS (SELECT 1 FROM trip_offers f WHERE f.courier_id = s.id AND f.response = 'pending' AND f.deadline_at > now()) AS has_pending
         FROM staff s
         LEFT JOIN LATERAL (SELECT id, started_at FROM trips WHERE courier_id = s.id AND status = 'on_the_way' ORDER BY id LIMIT 1) bt ON true
        WHERE s.role = 'delivery' AND s.active = true AND s.password_hash IS NOT NULL AND s.on_duty = true
          AND s.settlement_mode IS DISTINCT FROM 'suspended'
          AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.courier_id = s.id AND x.status = 'assigned')
          AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.courier_id = s.id AND x.status = 'on_the_way' AND x.breakdown_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM orders r WHERE r.delivery_staff_id = s.id AND r.return_pending)
          AND NOT EXISTS (SELECT 1 FROM trip_offers f WHERE f.trip_id = $1 AND f.courier_id = s.id AND f.response IN ('declined','timeout'))`,
      [tripId]);
    const t = (v) => (v ? new Date(v).getTime() : 0);
    const free = r.rows.filter((c) => !c.busy_trip && !c.has_pending);
    const freeBusyElsewhere = r.rows.filter((c) => !c.busy_trip && c.has_pending).length;
    const busy = r.rows.filter((c) => c.busy_trip && !c.has_pending)
      .sort((a, b) => a.open_left - b.open_left || t(a.busy_started) - t(b.busy_started) || a.id - b.id);
    return { free, freeBusyElsewhere, busy };
  }

  async function offerTrip(db, tripId, settings) {
    const cands = await candidatesFor(db, tripId);
    let targets = [], tier = 'free';
    for (const c of cands.free) { if ((await canTakeDelivery(db, c.id)).ok) targets.push(c); }
    if (!targets.length && cands.freeBusyElsewhere > 0) return false; // free couriers exist but are deciding on another trip: wait, do not jump to busy ones
    if (!targets.length) {
      tier = 'busy';
      for (const c of cands.busy) { if ((await canTakeDelivery(db, c.id)).ok) { targets = [c]; break; } }
    }
    if (!targets.length) {
      const was = await db.query('SELECT escalated_at FROM trips WHERE id = $1', [tripId]);
      if (!was.rows[0].escalated_at) {
        await db.query('UPDATE trips SET escalated_at = now() WHERE id = $1', [tripId]);
        await log(db, tripId, 'escalated', { mode: 'system', note: 'no courier accepted / available' });
        safe(notifyAdmins({ title: '🚨 رحلة بدون مندوب', body: `الرحلة #${tripId} ما لقتش مندوب. محتاجة تدخّلك الآن.`, tag: 'trip-esc-' + tripId, url: '/staff/#ops' }));
      }
      return false;
    }
    // Nobody gets a choice to decline: they only acknowledge ("تمام") within courier_offer_min. All offers of one broadcast share a deadline.
    for (const c of targets) {
      await db.query(`INSERT INTO trip_offers (trip_id, courier_id, deadline_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [tripId, c.id, settings.courier_offer_min]);
    }
    await db.query(`UPDATE trips SET status = 'offering' WHERE id = $1`, [tripId]);
    await log(db, tripId, 'offered', { mode: 'system', note: tier === 'free' ? `shown to ${targets.length} free courier(s)` : `offered to busy courier #${targets[0].id}` });
    safe(notifyStaff(targets.map((c) => c.id), tier === 'free'
      ? { title: '🛵 أوردر متاح', body: `رحلة #${tripId} متاحة. أول واحد يضغط "تمام" خلال ${settings.courier_offer_min} دقيقة ياخدها.`, tag: 'offer-' + tripId, url: '/staff/#driver' }
      : { title: '🛵 اتعيّن لك أوردر', body: `رحلة #${tripId} اتعيّنت لك لما تخلّص رحلتك. اضغط "تمام" خلال ${settings.courier_offer_min} دقيقة.`, tag: 'offer-' + tripId, url: '/staff/#driver' }));
    return true;
  }

  // ---------- the dispatcher tick ----------
  async function run() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const S = await getSettings(client);

      // 1) offers whose deadline passed -> timeout, trip goes back to the rotation
      const notes = [];  // push notifications, sent only after the transaction commits
      const to = await client.query(
        `UPDATE trip_offers SET response = 'timeout', responded_at = now()
          WHERE response = 'pending' AND deadline_at < now() RETURNING trip_id, courier_id`);
      for (const x of to.rows) {
        await client.query(`UPDATE trips SET status = 'unassigned' WHERE id = $1 AND status = 'offering'
                               AND NOT EXISTS (SELECT 1 FROM trip_offers p WHERE p.trip_id = $1 AND p.response = 'pending')`, [x.trip_id]);
        await log(client, x.trip_id, 'offer_timeout', { mode: 'system', courier_id: x.courier_id, note: 'courier did not press "تمام" in time' });
        const nm = (await client.query('SELECT name FROM staff WHERE id = $1', [x.courier_id])).rows[0];
        notes.push({ title: '⚠️ مندوب ما أكّدش', body: `${nm ? nm.name : 'مندوب'} ما ضغطش "تمام" على رحلة #${x.trip_id} والرحلة اتحوّلت لمندوب تاني. كلّمه واعرف السبب.`, tag: 'noack-' + x.trip_id, url: '/staff/#ops' });
      }

      // 2) every open order must live in a trip (legacy / brand-new orders get a one-order trip)
      const lone = await client.query(
        `SELECT id, status, assigned_delivery_id, delivery_staff_id, delivery_started_at FROM orders
          WHERE trip_id IS NULL AND status IN ('awaiting_prep','preparing','awaiting_delivery','on_the_way') ORDER BY created_at, id`);
      for (const o of lone.rows) {
        let t;
        if (o.status === 'on_the_way') {
          t = await client.query(
            `INSERT INTO trips (status, courier_id, assignment_mode, started_at) VALUES ('on_the_way', $1, 'manual', $2) RETURNING id`,
            [o.delivery_staff_id, o.delivery_started_at]);
        } else if (o.assigned_delivery_id) {
          t = await client.query(
            `INSERT INTO trips (status, courier_id, assignment_mode, assigned_at) VALUES ('assigned', $1, 'manual', now()) RETURNING id`,
            [o.assigned_delivery_id]);
        } else {
          t = await client.query(`INSERT INTO trips DEFAULT VALUES RETURNING id`);
        }
        await client.query('UPDATE orders SET trip_id = $2 WHERE id = $1', [o.id, t.rows[0].id]);
      }

      // 3) courier said "تمام" but did not reach the store in time. The wait is counted from the later of
      //    (his acknowledgement, the order being ready) so nobody is penalised before the order exists.
      //    courier_late_action = 'auto'   -> the trip moves to the next courier by itself
      //    courier_late_action = 'manual' -> only the ops manager is told (once) and he decides
      const late = await client.query(
        `SELECT t.id, t.courier_id, t.late_notified_at, c.name AS courier_name,
                (t.late_notified_at IS NOT NULL AND t.late_notified_at + make_interval(mins => $2) < now()) AS grace_over FROM trips t
           JOIN staff c ON c.id = t.courier_id
           JOIN orders o ON o.trip_id = t.id AND o.status NOT IN ('delivered','cancelled')
          WHERE t.status = 'assigned' AND c.at_store_since IS NULL
            AND NOT EXISTS (SELECT 1 FROM trips a WHERE a.courier_id = t.courier_id AND a.status = 'on_the_way')
          GROUP BY t.id, t.courier_id, t.late_notified_at, c.name, t.assigned_at
         HAVING BOOL_AND(o.prepared_at IS NOT NULL)
            AND GREATEST(COALESCE(t.assigned_at, MAX(o.prepared_at)), MAX(o.prepared_at),
                         (SELECT MAX(a.ended_at) FROM trips a WHERE a.courier_id = t.courier_id AND a.status = 'done' AND a.ended_at >= t.assigned_at))
                + make_interval(mins => $1) < now()`,
        [S.courier_max_delay_min, S.courier_late_grace_min]);
      for (const x of late.rows) {
        if (!x.late_notified_at) {
          // first time late: tell the courier (and the ops manager) that an order is waiting for him
          await client.query('UPDATE trips SET late_notified_at = now() WHERE id = $1', [x.id]);
          await log(client, x.id, 'late_notice', { mode: 'system', courier_id: x.courier_id, note: S.courier_late_action === 'auto' ? `courier late; ${S.courier_late_grace_min} min grace before reassigning` : 'courier late; waiting for the ops manager to decide' });
          safe(notifyStaff([x.courier_id], { title: '⏰ إنت اتأخرت', body: `في أوردر جاهز مستنيك في المحل (رحلة #${x.id}). تعالى بسرعة${S.courier_late_action === 'auto' ? `، ولو ما وصلتش خلال ${S.courier_late_grace_min} دقيقة هيتحوّل لمندوب تاني` : ''}.`, tag: 'late-c-' + x.id, url: '/staff/#driver' }));
          notes.push({ title: '⚠️ مندوب اتأخر', body: S.courier_late_action === 'auto'
            ? `${x.courier_name} قال "تمام" وما وصلش المحل خلال ${S.courier_max_delay_min} دقيقة (رحلة #${x.id}). نبّهناه، ولو ما وصلش خلال ${S.courier_late_grace_min} دقيقة هتتحوّل أوتوماتيك لمندوب تاني.`
            : `${x.courier_name} قال "تمام" وما وصلش المحل خلال ${S.courier_max_delay_min} دقيقة (رحلة #${x.id}). نبّهناه. قرّر: انقله لمندوب تاني أو استنى.`, tag: 'late-' + x.id, url: '/staff/#ops' });
        } else if (S.courier_late_action === 'auto' && x.grace_over) {
          // still not here after the warning: the trip goes to the next courier in line
          await client.query(
            `INSERT INTO trip_offers (trip_id, courier_id, deadline_at, response, responded_at) VALUES ($1, $2, now(), 'timeout', now())`,
            [x.id, x.courier_id]);
          await releaseTrip(client, x.id, `courier still not at the store ${S.courier_late_grace_min} min after the late warning`);
          notes.push({ title: '⚠️ الرحلة اتحوّلت', body: `${x.courier_name} ما وصلش المحل حتى بعد التنبيه. رحلة #${x.id} اتحوّلت أوتوماتيك لمندوب تاني.`, tag: 'late2-' + x.id, url: '/staff/#ops' });
        }
      }

      // 3b) bundling window (section 16). Default = one order per trip. When a single-order trip is ready and still waiting for
      //     a courier, the ops manager is told once ("add other orders to this trip?") and has trip_bundle_window_min minutes.
      //     Nobody added anything in time -> nothing happens, the trip simply goes out with its one order. If it is delayed
      //     meanwhile, that wait is the ops manager's, which the SLA report already attributes to him.
      if (S.trip_bundle_window_min > 0) {
        const cand = await client.query(
          `SELECT t.id,
                  (SELECT string_agg('#' || o.id || ' — ' || c.name || ' (' || COALESCE(c.address, '') || ')', '، ')
                     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.trip_id = t.id AND o.status NOT IN ('delivered','cancelled')) AS detail,
                  (SELECT COUNT(*)::int FROM orders o WHERE o.trip_id = t.id AND o.status NOT IN ('delivered','cancelled')) AS n
             FROM trips t
            WHERE t.status IN ('unassigned','offering','assigned') AND t.bundle_notified_at IS NULL`);
        for (const x of cand.rows) {
          if (x.n !== 1) continue;
          const ready = await client.query(
            `SELECT 1 FROM orders o WHERE o.trip_id = $1 AND o.status = 'awaiting_delivery' AND o.prepared_at IS NOT NULL`, [x.id]);
          if (!ready.rows.length) continue;
          await client.query(`UPDATE trips SET bundle_notified_at = now(), bundle_deadline_at = now() + make_interval(mins => $2) WHERE id = $1`, [x.id, S.trip_bundle_window_min]);
          await log(client, x.id, 'bundle_window', { mode: 'system', note: `window ${S.trip_bundle_window_min} min` });
          notes.push({ title: '🔗 تضيف أوردرات على الرحلة؟', body: `رحلة #${x.id} جاهزة بأوردر واحد: ${x.detail}. عندك ${S.trip_bundle_window_min} دقايق تضيف عليها أوردرات تانية، وبعدها هتمشي زي ما هي.`, tag: 'bundle-' + x.id, url: '/staff/#ops' });
        }
      }

      // 4) pre-emptive dispatch: trips whose prep finishes within the lead window (or is already done) and have no courier
      const due = await client.query(
        `SELECT t.id FROM trips t
           JOIN orders o ON o.trip_id = t.id AND o.status NOT IN ('delivered','cancelled')
          WHERE t.status = 'unassigned'
          GROUP BY t.id
         HAVING BOOL_AND(COALESCE(o.prepared_at, o.prep_due_at) IS NOT NULL)
            AND MAX(COALESCE(o.prepared_at, o.prep_due_at)) <= now() + make_interval(mins => $1)
          ORDER BY MIN(COALESCE(o.prepared_at, o.prep_due_at)), t.id`, [S.courier_lead_min]);
      for (const t of due.rows) await offerTrip(client, t.id, S);

      await client.query('COMMIT');
      for (const n of notes) safe(notifyAdmins(n));
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('trips.run failed:', e.message);
    } finally {
      client.release();
    }
  }
  function kick() { run().catch(() => {}); }

  // ---------- courier endpoints ----------
  router.get('/courier/me', requireAuth('delivery'), async (req, res) => {
    try {
      const me = await pool.query('SELECT on_duty, at_store_since FROM staff WHERE id = $1', [req.user.id]);
      const onTrip = await pool.query(`SELECT id FROM trips WHERE courier_id = $1 AND status = 'on_the_way' LIMIT 1`, [req.user.id]);
      const s = me.rows[0] || {};
      const state = !s.on_duty ? 'off' : onTrip.rows.length ? 'on_trip' : 'free';
      const offer = await pool.query(
        `SELECT f.id, f.trip_id, EXTRACT(EPOCH FROM (f.deadline_at - now()))::int AS remaining_s
           FROM trip_offers f WHERE f.courier_id = $1 AND f.response = 'pending' AND f.deadline_at > now() LIMIT 1`, [req.user.id]);
      const brief = async (tripId) => (await pool.query(
        `SELECT o.id, o.total, c.address, (SELECT COUNT(*)::int FROM order_items i WHERE i.order_id = o.id) AS items
           FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE o.trip_id = $1 AND o.status NOT IN ('delivered','cancelled') ORDER BY o.id`, [tripId])).rows;
      const mine = await pool.query(
        `SELECT id, status FROM trips WHERE courier_id = $1 AND status IN ('assigned','on_the_way') ORDER BY (status = 'on_the_way') DESC, id LIMIT 1`, [req.user.id]);
      const back = await pool.query(`SELECT o.id, o.total, COALESCE(e.amount, 0) AS fee FROM orders o LEFT JOIN courier_earnings e ON e.order_id = o.id WHERE o.delivery_staff_id = $1 AND o.return_pending ORDER BY o.id`, [req.user.id]);
      const resc = await pool.query(`SELECT o.id, o.total, c.address, t.breakdown_lat, t.breakdown_lng FROM orders o JOIN trips t ON t.id = o.trip_id JOIN customers c ON c.id = o.customer_id WHERE o.rescue_courier_id = $1 AND t.rescue_picked_at IS NULL AND o.status = 'on_the_way' ORDER BY o.id`, [req.user.id]);
      res.json({
        to_return: back.rows, rescue: resc.rows,
        state, at_store_since: s.at_store_since || null,
        offer: offer.rows[0] ? { ...offer.rows[0], orders: await brief(offer.rows[0].trip_id) } : null,
        trip: mine.rows[0] ? { ...mine.rows[0], orders: await brief(mine.rows[0].id) } : null
      });
    } catch (e) { console.error('courier/me', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });

  // "وصلت": the courier is physically at the store and free.
  router.post('/courier/arrive', requireAuth('delivery'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const on = await client.query(`SELECT 1 FROM trips WHERE courier_id = $1 AND status = 'on_the_way'`, [req.user.id]);
      if (on.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'still_on_trip', message: 'لسه معاك أوردرات في الطريق. اقفلها الأول.' });
      }
      const bag = await client.query('SELECT id FROM orders WHERE delivery_staff_id = $1 AND return_pending', [req.user.id]);
      if (bag.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'return_first', message: 'معاك أوردر ملغي لسه ما رجّعتوش. اضغط "رجّعت الأوردر" الأول.' });
      }
      // He only goes to the store once a trip is assigned to him. Arriving with nothing assigned does nothing.
      const mine = await client.query(`SELECT id FROM trips WHERE courier_id = $1 AND status = 'assigned' ORDER BY id LIMIT 1`, [req.user.id]);
      if (!mine.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'no_trip', message: 'مفيش أوردر متعيّن لك دلوقتي. هتتبلّغ أول ما يتعيّن لك.' }); }
      const tripId = mine.rows[0].id;
      await client.query(`UPDATE staff SET on_duty = true, at_store_since = COALESCE(at_store_since, now()) WHERE id = $1`, [req.user.id]);
      await client.query(`UPDATE trips SET courier_arrived_at = COALESCE(courier_arrived_at, now()) WHERE id = $1`, [tripId]);
      await client.query('COMMIT');
      kick();
      res.json({ ok: true, trip_id: tripId });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('courier/arrive', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التسجيل.' });
    } finally { client.release(); }
  });

  // "بدء الدوام": the courier goes on duty from wherever he is. He does NOT have to come to the store.
  router.post('/courier/on', requireAuth('delivery'), async (req, res) => {
    try {
      await pool.query(`UPDATE staff SET on_duty = true WHERE id = $1`, [req.user.id]);
      kick();
      res.json({ ok: true });
    } catch (e) { console.error('courier/on', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التسجيل.' }); }
  });

  // "انصراف": end of shift, stop receiving offers.
  // Returned goods (an order cancelled after it left): TWO-SIDED.
  //   1) the courier presses "رجّعت الأوردر"            -> return_courier_at
  //   2) the ops manager / admin confirms they received -> the stock goes back, courier is released
  // Stock never returns on the courier's word alone.
  router.post('/courier/returned', requireAuth('delivery'), async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE orders SET return_courier_at = COALESCE(return_courier_at, now())
          WHERE delivery_staff_id = $1 AND return_pending AND ($2::int IS NULL OR id = $2::int) RETURNING id`,
        [req.user.id, req.body && req.body.order_id ? Number(req.body.order_id) : null]);
      if (!r.rows.length) return res.status(404).json({ error: 'nothing', message: 'مفيش أوردر ملغي معاك.' });
      safe(notifyAdmins({ title: '📦 مرتجع محتاج تأكيد استلام', body: `المندوب بيقول إنه رجّع الأوردر ${r.rows.map((x) => '#' + x.id).join('، ')}. أكّد الاستلام بعد ما تتأكد.`, tag: 'ret-' + r.rows[0].id, url: '/staff/#ops' }));
      res.json({ ok: true, count: r.rows.length, message: 'اتبلّغ مدير التشغيل. استنى تأكيد الاستلام.' });
    } catch (e) { console.error('courier/returned', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التسجيل.' }); }
  });

  router.get('/returns/pending', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT o.id, o.total, o.return_courier_at, s.name AS courier_name FROM orders o LEFT JOIN staff s ON s.id = o.delivery_staff_id
          WHERE o.return_pending ORDER BY (o.return_courier_at IS NULL), o.return_courier_at, o.id`);
      res.json({ rows: r.rows });
    } catch (e) { res.status(500).json({ error: 'failed' }); }
  });

  router.post('/returns/:orderId/confirm', requireAuth('admin', 'ops'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const o = await client.query('SELECT id, delivery_staff_id FROM orders WHERE id = $1 AND return_pending FOR UPDATE', [Number(req.params.orderId)]);
      if (!o.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'nothing', message: 'الأوردر ده مش مرتجع مستني تأكيد.' }); }
      const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [o.rows[0].id]);
      for (const it of items.rows) {
        await moveStock(client, { product_id: it.product_id, type: 'cancel_restock', quantity: it.quantity, order_id: o.rows[0].id, staff_id: req.user.id, note: 'مرتجع اتأكد استلامه في المحل' });
      }
      await client.query('UPDATE orders SET return_pending = false, returned_at = now(), returned_by = $2 WHERE id = $1', [o.rows[0].id, req.user.id]);
      await client.query('UPDATE order_cancellations SET returned_at = now() WHERE order_id = $1', [o.rows[0].id]);
      await client.query('COMMIT');
      kick();
      if (o.rows[0].delivery_staff_id) safe(notifyStaff([o.rows[0].delivery_staff_id], { title: '✅ اتأكد استلام المرتجع', body: `أوردر #${o.rows[0].id} اتسجّل ورجع المخزن. لو فيه أوردر جاهز هيتبعتلك، ولو مفيش استنى لحد ما يتبعتلك.`, tag: 'retok-' + o.rows[0].id, url: '/staff/#driver' }));
      res.json({ ok: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('returns/confirm', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التأكيد.' });
    } finally { client.release(); }
  });

  // ---------- courier breakdown mid-trip (requirements doc section 23) ----------
  // The broken-down courier is NOT blamed for any delay. The first free (or soonest-to-be-free) courier is sent the
  // location and collects the orders directly: they do NOT go back to the store. The rescue courier is held to the FULL
  // order duration, counted from the moment he is dispatched (including his travel to the breakdown location).
  router.post('/courier/breakdown', requireAuth('delivery'), async (req, res) => {
    const client = await pool.connect();
    let note = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const tr = await client.query(`SELECT * FROM trips WHERE courier_id = $1 AND status = 'on_the_way' ORDER BY id LIMIT 1 FOR UPDATE`, [req.user.id]);
      const trip = tr.rows[0];
      if (!trip) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'no_trip', message: 'مفيش رحلة شغّالة معاك.' }); }
      if (trip.rescue_courier_id && !trip.rescue_picked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already', message: 'اتبعت مندوب بديل بالفعل.' }); }
      const lat = req.body && Number.isFinite(Number(req.body.lat)) ? Number(req.body.lat) : null;
      const lng = req.body && Number.isFinite(Number(req.body.lng)) ? Number(req.body.lng) : null;
      // first free courier at the store, else one who finished and is heading back; never someone carrying orders
      const cand = await client.query(
        `SELECT s.id, s.name, s.at_store_since,
                (SELECT MAX(ended_at) FROM trips x WHERE x.courier_id = s.id AND x.status = 'done') AS last_ended
           FROM staff s
          WHERE s.role = 'delivery' AND s.active = true AND s.password_hash IS NOT NULL AND s.on_duty = true AND s.id <> $1
            AND s.settlement_mode IS DISTINCT FROM 'suspended'
            AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.courier_id = s.id AND x.status IN ('assigned','on_the_way'))
            AND NOT EXISTS (SELECT 1 FROM orders r WHERE r.delivery_staff_id = s.id AND r.return_pending)
            AND NOT EXISTS (SELECT 1 FROM orders q WHERE q.rescue_courier_id = s.id AND q.status = 'on_the_way')`, [req.user.id]);
      let pick = null;
      const sorted = cand.rows.sort((a, b) => (a.at_store_since ? 0 : 1) - (b.at_store_since ? 0 : 1)
        || new Date(a.at_store_since || a.last_ended || 0) - new Date(b.at_store_since || b.last_ended || 0) || a.id - b.id);
      for (const c of sorted) { const g = await canTakeDelivery(client, c.id); if (g.ok) { pick = c; break; } }
      await client.query(`UPDATE trips SET breakdown_at = now(), breakdown_lat = $2, breakdown_lng = $3, breakdown_from_courier = $4,
                                           rescue_courier_id = $5, rescue_assigned_at = CASE WHEN $5::int IS NULL THEN NULL ELSE now() END WHERE id = $1`,
        [trip.id, lat, lng, req.user.id, pick ? pick.id : null]);
      if (pick) {
        await client.query(`UPDATE orders SET rescue_courier_id = $2, rescue_assigned_at = now() WHERE trip_id = $1 AND status = 'on_the_way'`, [trip.id, pick.id]);
      }
      await log(client, trip.id, 'breakdown', { mode: 'system', courier_id: pick ? pick.id : null, prev: req.user.id, note: pick ? 'rescue courier dispatched' : 'no courier available' });
      note = { trip: trip.id, pick, lat, lng, from: req.user.name };
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('courier/breakdown', e.message);
      client.release();
      return res.status(500).json({ error: 'failed', message: 'تعذّر الإبلاغ.' });
    }
    client.release();
    const where = note.lat !== null && note.lng !== null ? ` الموقع: https://maps.google.com/?q=${note.lat},${note.lng}` : '';
    if (note.pick) {
      safe(notifyStaff([note.pick.id], { title: '🚨 روح استلم أوردرات من مندوب عطلان', body: `رحلة #${note.trip}: روح للموقع واستلم الأوردرات وسلّمها مباشرة.${where}`, tag: 'rescue-' + note.trip, url: '/staff/#driver' }));
      safe(notifyAdmins({ title: '🚨 عطل مندوب', body: `${note.from || 'مندوب'} عطلان في رحلة #${note.trip}. اتبعت ${note.pick.name} يستلم الأوردرات.${where}`, tag: 'bd-' + note.trip, url: '/staff/#ops' }));
      return res.json({ ok: true, rescue: note.pick.name });
    }
    safe(notifyAdmins({ title: '🚨🚨 عطل مندوب وما فيش مندوب فاضي', body: `${note.from || 'مندوب'} عطلان في رحلة #${note.trip} وما لقيناش مندوب بديل. محتاج تدخّل فوري.${where}`, tag: 'bd-' + note.trip, url: '/staff/#ops' }));
    res.json({ ok: true, rescue: null, message: 'بلّغنا الإدارة، هتتصرف حالاً.' });
  });

  // The rescue courier confirms he took the orders from the broken-down courier. Delivery then continues under him.
  router.post('/courier/rescue-picked', requireAuth('delivery'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tr = await client.query(`SELECT * FROM trips WHERE rescue_courier_id = $1 AND status = 'on_the_way' AND rescue_picked_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE`, [req.user.id]);
      const trip = tr.rows[0];
      if (!trip) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'nothing', message: 'مفيش أوردرات مستنياك.' }); }
      await client.query(`UPDATE trips SET rescue_picked_at = now(), courier_id = $2, assignment_mode = 'manual' WHERE id = $1`, [trip.id, req.user.id]);
      await client.query(`UPDATE orders SET delivery_staff_id = $2, assigned_delivery_id = $2 WHERE trip_id = $1 AND status = 'on_the_way'`, [trip.id, req.user.id]);
      await log(client, trip.id, 'rescue_picked', { mode: 'system', courier_id: req.user.id, prev: trip.breakdown_from_courier, note: 'rescue courier took the orders' });
      await client.query('UPDATE staff SET at_store_since = NULL WHERE id = $1', [trip.breakdown_from_courier]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('courier/rescue-picked', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التسجيل.' });
    } finally { client.release(); }
  });

  router.post('/courier/off', requireAuth('delivery'), async (req, res) => {
    try {
      const busy = await pool.query(`SELECT 1 FROM trips WHERE courier_id = $1 AND status IN ('assigned','on_the_way')`, [req.user.id]);
      const bag = await pool.query('SELECT 1 FROM orders WHERE delivery_staff_id = $1 AND return_pending', [req.user.id]);
      if (bag.rows.length) return res.status(409).json({ error: 'return_first', message: 'معاك أوردر ملغي لسه ما رجّعتوش.' });
      if (busy.rows.length) return res.status(409).json({ error: 'has_trip', message: 'عندك رحلة لسه ما خلصتش.' });
      await pool.query(`UPDATE staff SET on_duty = false, at_store_since = NULL WHERE id = $1`, [req.user.id]);
      await pool.query(`UPDATE trip_offers SET response = 'superseded', responded_at = now() WHERE courier_id = $1 AND response = 'pending'`, [req.user.id]);
      // a trip that was only waiting on him goes back to the rotation
      await pool.query(`UPDATE trips SET status = 'unassigned' WHERE status = 'offering' AND NOT EXISTS (SELECT 1 FROM trip_offers p WHERE p.trip_id = trips.id AND p.response = 'pending')`);
      kick();
      res.json({ ok: true });
    } catch (e) { console.error('courier/off', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر التسجيل.' }); }
  });

  // The courier acknowledges the assignment ("تمام"). There is no decline.
  async function acknowledge(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const o = await client.query(`SELECT * FROM trip_offers WHERE id = $1 AND courier_id = $2 FOR UPDATE`, [Number(req.params.id), req.user.id]);
      const off = o.rows[0];
      if (!off) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found', message: 'التعيين غير موجود.' }); }
      if (off.response !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'closed', message: 'عفواً، الأوردر ده اتعيّن لمندوب تاني قبلك.' }); }
      const expired = (await client.query('SELECT now() > deadline_at AS e FROM trip_offers WHERE id = $1', [off.id])).rows[0].e;
      if (expired) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'expired', message: 'انتهت مهلة التأكيد.' }); }
      const gate = await canTakeDelivery(client, req.user.id);
      if (!gate.ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'unsettled_cash', message: gate.reason === 'suspended' ? 'تم إيقاف التعامل معك حالياً. تواصل مع الإدارة.' : `لازم تسدد ${gate.amount} ج.م المستحقة عليك الأول.` });
      }
      const held = await client.query(`SELECT 1 FROM trips WHERE courier_id = $1 AND status = 'assigned'`, [req.user.id]); // a courier still on his current trip MAY acknowledge the next one
      if (held.rows.length) {
        await client.query(`UPDATE trip_offers SET response = 'superseded', responded_at = now() WHERE id = $1`, [off.id]);
        await client.query(`UPDATE trips SET status = 'unassigned' WHERE id = $1 AND status = 'offering'`, [off.trip_id]);
        await client.query('COMMIT'); kick();
        return res.status(409).json({ error: 'already_busy', message: 'عندك رحلة معيّنة لك ومستنياك، التعيين ده اتحوّل لمندوب تاني.' });
      }
      const others = await client.query(`SELECT courier_id FROM trip_offers WHERE trip_id = $1 AND response = 'pending' AND id <> $2`, [off.trip_id, off.id]);
      await client.query(`UPDATE trip_offers SET response = 'accepted', responded_at = now() WHERE id = $1`, [off.id]);
      await assignTrip(client, off.trip_id, req.user.id, 'auto', null, 'courier acknowledged'); // also withdraws the offer from every other courier
      await client.query('COMMIT');
      if (others.rows.length) safe(notifyStaff(others.rows.map((x) => x.courier_id), { title: 'الأوردر اتاخد', body: `رحلة #${off.trip_id} اتعيّنت لمندوب تاني (ضغط "تمام" قبلك).`, tag: 'offer-' + off.trip_id, url: '/staff/#driver' }));
      kick();
      res.json({ ok: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('acknowledge', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التنفيذ.' });
    } finally { client.release(); }
  }
  router.post('/trips/offers/:id/accept', requireAuth('delivery'), acknowledge);
  // No decline: the courier does not get to choose. (Kept as an explicit refusal so an old app version can't bypass it.)
  router.post('/trips/offers/:id/decline', requireAuth('delivery'), (req, res) =>
    res.status(403).json({ error: 'no_decline', message: 'التعيين إجباري. لو عندك ظرف، بلّغ مدير التشغيل.' }));

  // ---------- ops manager endpoints ----------
  router.get('/trips/ops', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const trips = await pool.query(
        `SELECT t.id, t.status, t.courier_id, t.assignment_mode, t.escalated_at, t.late_notified_at, t.assigned_at, t.started_at, t.courier_arrived_at, t.bundle_deadline_at,
                EXTRACT(EPOCH FROM (t.bundle_deadline_at - now()))::int AS bundle_remaining_s, cr.name AS courier_name, cr.at_store_since AS courier_at_store,
                (SELECT f.courier_id FROM trip_offers f WHERE f.trip_id = t.id AND f.response = 'pending' LIMIT 1) AS offer_courier_id,
                (SELECT sf.name FROM trip_offers f JOIN staff sf ON sf.id = f.courier_id WHERE f.trip_id = t.id AND f.response = 'pending' LIMIT 1) AS offer_courier_name,
                (SELECT EXTRACT(EPOCH FROM (f.deadline_at - now()))::int FROM trip_offers f WHERE f.trip_id = t.id AND f.response = 'pending' LIMIT 1) AS offer_remaining_s,
                (SELECT EXTRACT(EPOCH FROM (MAX(COALESCE(o.prepared_at, o.prep_due_at)) - now()))::int FROM orders o WHERE o.trip_id = t.id AND o.status NOT IN ('delivered','cancelled')) AS ready_in_s,
                (SELECT BOOL_AND(o.prepared_at IS NOT NULL) FROM orders o WHERE o.trip_id = t.id AND o.status NOT IN ('delivered','cancelled')) AS all_prepared
           FROM trips t LEFT JOIN staff cr ON cr.id = t.courier_id
          WHERE t.status = ANY($1) ORDER BY (t.escalated_at IS NOT NULL) DESC, t.created_at, t.id`, [OPEN_TRIP]);
      const ids = trips.rows.map((t) => t.id);
      const ords = ids.length ? await pool.query(
        `SELECT o.id, o.trip_id, o.status, o.total, c.name AS customer_name, c.address
           FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE o.trip_id = ANY($1) AND o.status <> 'cancelled' ORDER BY o.id`, [ids]) : { rows: [] };
      const by = {};
      for (const o of ords.rows) (by[o.trip_id] = by[o.trip_id] || []).push(o);
      const couriers = await pool.query(
        `SELECT s.id, s.name, s.on_duty, s.at_store_since,
                EXISTS (SELECT 1 FROM trips x WHERE x.courier_id = s.id AND x.status = 'on_the_way') AS on_trip,
                EXISTS (SELECT 1 FROM trips x WHERE x.courier_id = s.id AND x.status = 'assigned') AS reserved
           FROM staff s WHERE s.role = 'delivery' AND s.active = true AND s.password_hash IS NOT NULL ORDER BY s.name`);
      const view = couriers.rows.map((c) => ({
        id: c.id, name: c.name, reserved: c.reserved,
        state: !c.on_duty ? 'off' : c.on_trip ? 'on_trip' : 'free'
      }));
      res.json({
        trips: trips.rows.map((t) => ({ ...t, orders: (by[t.id] || []).filter((o) => o.status !== 'delivered' || t.status === 'on_the_way') })).filter((t) => t.orders.length),
        couriers: view, settings: await getSettings()
      });
    } catch (e) { console.error('trips/ops', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تحميل الرحلات.' }); }
  });

  // "استلمت الأوردر وبدأت": the trip leaves the store and the delivery clock starts. EITHER the ops manager OR the assigned
  // courier may press it (whoever is quicker); who pressed is recorded. Time from the courier reaching the store until this
  // moment is the store's hand-over wait (reported separately, never counted against the courier).
  async function startTrip(tripId, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const t = await lockTrip(client, tripId);
      const fail = async (code, msg, status = 409) => { await client.query('ROLLBACK'); return { status, body: { error: code, message: msg } }; };
      if (!t) return fail('not_found', 'الرحلة غير موجودة.', 404);
      if (actor.role === 'delivery' && t.courier_id !== actor.id) return fail('not_yours', 'الرحلة دي مش بتاعتك.', 403);
      if (t.status !== 'assigned') return fail('not_assigned', 'الرحلة لسه ما اتعيّنش لها مندوب.');
      const ords = await client.query(`SELECT id, status FROM orders WHERE trip_id = $1 AND status NOT IN ('delivered','cancelled') ORDER BY id FOR UPDATE`, [t.id]);
      if (!ords.rows.length) return fail('empty', 'الرحلة فاضية.');
      if (ords.rows.some((o) => o.status !== 'awaiting_delivery')) return fail('not_ready', 'لسه في أوردرات في الرحلة ما خلصش تجهيزها.');
      const c = await client.query('SELECT at_store_since FROM staff WHERE id = $1', [t.courier_id]);
      if (!c.rows[0] || !c.rows[0].at_store_since) return fail('courier_not_here', 'المندوب لسه ما ضغطش "وصلت المحل".');
      const gate = await canTakeDelivery(client, t.courier_id);
      if (!gate.ok) return fail('unsettled_cash', gate.reason === 'suspended' ? 'المندوب موقوف حالياً.' : `على المندوب ${gate.amount} ج.م لازم يسددها قبل ما ياخد أوردر جديد.`, 403);
      for (const o of ords.rows) {
        await client.query(`UPDATE orders SET status = 'on_the_way', delivery_started_at = now(), delivery_staff_id = $2 WHERE id = $1 AND status = 'awaiting_delivery'`, [o.id, t.courier_id]);
        const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [o.id]);
        for (const it of items.rows) {
          await client.query('UPDATE products SET reserved_qty = GREATEST(reserved_qty - $1, 0) WHERE id = $2', [it.quantity, it.product_id]);
          await moveStock(client, { product_id: it.product_id, type: 'sale', quantity: it.quantity, order_id: o.id });
        }
      }
      await client.query(`UPDATE trips SET status = 'on_the_way', started_at = now(), started_by = $2 WHERE id = $1`, [t.id, actor.id]);
      await client.query('UPDATE staff SET at_store_since = NULL WHERE id = $1', [t.courier_id]);
      await log(client, t.id, 'started', { mode: actor.role === 'delivery' ? 'courier' : 'manual', courier_id: t.courier_id, actor: actor.id,
        note: actor.role === 'delivery' ? 'courier pressed: received the order' : 'ops pressed: courier received the order' });
      await client.query('COMMIT');
      kick();
      return { status: 200, body: { ok: true } };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('trips/start', e.message);
      return { status: 500, body: { error: 'failed', message: 'تعذّر بدء الرحلة.' } };
    } finally { client.release(); }
  }
  router.post('/trips/:id/start', requireAuth('admin', 'ops'), async (req, res) => {
    const r = await startTrip(Number(req.params.id), { role: req.user.role, id: req.user.id });
    res.status(r.status).json(r.body);
  });
  router.post('/courier/received', requireAuth('delivery'), async (req, res) => {
    const mine = await pool.query(`SELECT id FROM trips WHERE courier_id = $1 AND status = 'assigned' ORDER BY id LIMIT 1`, [req.user.id]);
    if (!mine.rows.length) return res.status(404).json({ error: 'nothing', message: 'مفيش رحلة معيّنة لك.' });
    const r = await startTrip(mine.rows[0].id, { role: 'delivery', id: req.user.id });
    res.status(r.status).json(r.body);
  });

  // Manual override (trial phase). Fully audited: who, which orders, to whom, previous courier.
  router.post('/trips/:id/assign', requireAuth('admin', 'ops'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const t = await lockTrip(client, Number(req.params.id));
      if (!t || !['unassigned', 'offering', 'assigned'].includes(t.status)) {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'not_allowed', message: 'لا يمكن تغيير مندوب هذه الرحلة الآن.' });
      }
      const cid = Number(req.body.courier_id);
      const ok = await client.query(
        `SELECT id FROM staff WHERE id = $1 AND role = 'delivery' AND active = true AND password_hash IS NOT NULL
            AND settlement_mode IS DISTINCT FROM 'suspended'`, [cid]);
      if (!ok.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'bad_target', message: 'المندوب المختار غير مؤهل.' }); }
      const gate = await canTakeDelivery(client, cid);
      if (!gate.ok) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'unsettled_cash', message: `على المندوب ${gate.amount} ج.م لازم يسددها الأول.` }); }
      const has = await client.query(`SELECT 1 FROM trips WHERE courier_id = $1 AND status = 'assigned' AND id <> $2`, [cid, t.id]);
      if (has.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'courier_reserved', message: 'المندوب ده محجوز لرحلة تانية بالفعل.' }); }
      await assignTrip(client, t.id, cid, 'manual', req.user.id, 'ops manager override');
      await client.query('COMMIT');
      safe(notifyStaff([cid], { title: '🛵 اتعيّنت لرحلة', body: `مدير التشغيل عيّنك على رحلة #${t.id}.`, tag: 'manual-' + t.id, url: '/staff/#driver' }));
      if (t.courier_id && t.courier_id !== cid) safe(notifyStaff([t.courier_id], { title: 'تغيير في الرحلة', body: `رحلة #${t.id} اتحوّلت لمندوب تاني.`, tag: 'manual-prev-' + t.id, url: '/staff/#driver' }));
      res.json({ ok: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('trips/assign', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر التعيين.' });
    } finally { client.release(); }
  });

  // Bundle several not-yet-started trips into one (the one human-judgement step: order size + distance).
  router.post('/trips/merge', requireAuth('admin', 'ops'), async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.trip_ids) ? req.body.trip_ids : []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    if (ids.length < 2) return res.status(400).json({ error: 'invalid', message: 'اختر رحلتين على الأقل.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const S = await getSettings(client);
      const ts = await client.query(`SELECT * FROM trips WHERE id = ANY($1) FOR UPDATE`, [ids]);
      if (ts.rows.length !== ids.length || ts.rows.some((t) => !['unassigned', 'offering', 'assigned'].includes(t.status))) {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'not_allowed', message: 'لا يمكن دمج رحلات بدأت أو انتهت.' });
      }
      const n = await client.query(`SELECT COUNT(*)::int AS n FROM orders WHERE trip_id = ANY($1) AND status NOT IN ('delivered','cancelled')`, [ids]);
      if (n.rows[0].n > S.courier_max_orders) {
        await client.query('ROLLBACK'); return res.status(400).json({ error: 'too_many', message: `الحد الأقصى ${S.courier_max_orders} أوردرات في الرحلة الواحدة.` });
      }
      const keep = ids[0];
      await client.query('UPDATE trips SET bundle_notified_at = COALESCE(bundle_notified_at, now()) WHERE id = ANY($1)', [ids]);
      for (const t of ts.rows) {
        if (t.courier_id || t.status === 'offering') await releaseTrip(client, t.id, 'merged — will be re-assigned', req.user.id);
      }
      for (const id of ids.slice(1)) {
        await client.query('UPDATE orders SET trip_id = $2 WHERE trip_id = $1', [id, keep]);
        await supersedePending(client, id);
        await client.query(`UPDATE trips SET status = 'cancelled', ended_at = now() WHERE id = $1`, [id]);
        await log(client, id, 'merged', { mode: 'manual', actor: req.user.id, note: 'merged into trip ' + keep });
      }
      await log(client, keep, 'merged', { mode: 'manual', actor: req.user.id, note: 'merged trips ' + ids.join(',') });
      await client.query('COMMIT');
      kick();
      res.json({ ok: true, trip_id: keep });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('trips/merge', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر الدمج.' });
    } finally { client.release(); }
  });

  // Take one order out of a bundled trip into its own trip.
  router.post('/trips/split', requireAuth('admin', 'ops'), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const o = await client.query(`SELECT id, trip_id, status FROM orders WHERE id = $1 FOR UPDATE`, [Number(req.body.order_id)]);
      const ord = o.rows[0];
      const t = ord && ord.trip_id ? await lockTrip(client, ord.trip_id) : null;
      const cnt = t ? (await client.query(`SELECT COUNT(*)::int AS n FROM orders WHERE trip_id = $1 AND status NOT IN ('delivered','cancelled')`, [t.id])).rows[0].n : 0;
      if (!t || !['unassigned', 'offering', 'assigned'].includes(t.status) || cnt < 2 || ['delivered', 'cancelled', 'on_the_way'].includes(ord.status)) {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'not_allowed', message: 'لا يمكن فصل هذا الأوردر.' });
      }
      const nt = await client.query('INSERT INTO trips DEFAULT VALUES RETURNING id');
      await client.query('UPDATE orders SET trip_id = $2, assigned_delivery_id = NULL WHERE id = $1', [ord.id, nt.rows[0].id]);
      await log(client, t.id, 'split', { mode: 'manual', actor: req.user.id, note: `order ${ord.id} moved to trip ${nt.rows[0].id}` });
      await log(client, nt.rows[0].id, 'split', { mode: 'manual', actor: req.user.id, note: `order ${ord.id} split from trip ${t.id}` });
      await client.query('COMMIT');
      kick();
      res.json({ ok: true, trip_id: nt.rows[0].id });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('trips/split', e.message);
      res.status(500).json({ error: 'failed', message: 'تعذّر الفصل.' });
    } finally { client.release(); }
  });

  router.get('/trips/settings', requireAuth('admin', 'ops'), async (req, res) => {
    try { res.json(await getSettings()); } catch (e) { res.status(500).json({ error: 'failed' }); }
  });
  router.put('/trips/settings', requireAuth('ops'), async (req, res) => {
    try {
      const pairs = [];
      if (req.body.trip_bundle_window_min !== undefined) {
        const w = Number(req.body.trip_bundle_window_min);
        if (!Number.isInteger(w) || w < 0 || w > 60) return res.status(400).json({ error: 'invalid', message: 'مهلة التجميع لازم تكون بين 0 و 60 دقيقة.' });
        pairs.push(['trip_bundle_window_min', w]);
      }
      if (req.body.courier_late_action !== undefined) {
        if (!LATE_ACTIONS.includes(req.body.courier_late_action)) return res.status(400).json({ error: 'invalid', message: 'قيمة غير صحيحة.' });
        pairs.push(['courier_late_action', req.body.courier_late_action]);
      }
      for (const k of Object.keys(DEFAULTS)) {
        if (req.body[k] === undefined) continue;
        const v = Number(req.body[k]);
        if (!Number.isInteger(v) || v < RANGES[k][0] || v > RANGES[k][1]) return res.status(400).json({ error: 'invalid', message: 'قيمة غير صحيحة.' });
        pairs.push([k, v]);
      }
      for (const [k, v] of pairs) await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
      await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ('trip_settings_changed', $1, $2)`, [req.user.id, JSON.stringify(Object.fromEntries(pairs))]);
      res.json({ ok: true, settings: await getSettings() });
    } catch (e) { console.error('trips/settings', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' }); }
  });

  return { router, run, kick, refreshTrip };
}

module.exports = { init };
