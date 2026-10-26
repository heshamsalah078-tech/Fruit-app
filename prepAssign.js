// Automatic prep assignment (requirements doc sections 1 and 22).
//
// Rules:
//  - A prep worker is BUSY while he holds exactly 1 open order (awaiting_prep / preparing). Hard constant.
//  - A new order goes to the first free prep worker (the one idle the longest).
//  - If everyone is busy the order waits in the queue (awaiting_prep with no assigned_prep_id).
//  - When a worker frees up (hands off to delivery, or his order is cancelled) he automatically
//    takes the OLDEST queued order.
//  - The prep timer starts at assignment (prep_assigned_at), not at order creation.
//
// run() is idempotent and safe to call from anywhere, as often as you like.

const LOCK_KEY = 17001; // pg advisory lock so two runs never assign at the same time

function init({ pool }) {
  async function run() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);

      // Safety net: an order that was auto-assigned but NOT started yet, whose worker has since been
      // deactivated, goes back to the queue. (Manual assignments are the ops manager's call, so untouched.)
      await client.query(
        `UPDATE orders o SET assigned_prep_id = NULL, prep_assigned_at = NULL, prep_assignment_mode = NULL
           FROM staff s
          WHERE s.id = o.assigned_prep_id
            AND o.status = 'awaiting_prep'
            AND o.prep_assignment_mode = 'auto'
            AND (s.active = false OR s.role <> 'prep')`);

      // Pair free workers (longest idle first) with queued orders (oldest first).
      const r = await client.query(
        `WITH free AS (
           SELECT s.id,
                  ROW_NUMBER() OVER (ORDER BY COALESCE(l.last_free, s.created_at), s.id) AS rn
             FROM staff s
             LEFT JOIN LATERAL (
                  SELECT MAX(prepared_at) AS last_free FROM orders WHERE prep_staff_id = s.id
             ) l ON true
            WHERE s.role = 'prep' AND s.active = true AND s.password_hash IS NOT NULL
              AND NOT EXISTS (
                    SELECT 1 FROM orders o
                     WHERE o.assigned_prep_id = s.id AND o.status IN ('awaiting_prep','preparing'))
         ),
         q AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
             FROM orders
            WHERE status = 'awaiting_prep' AND assigned_prep_id IS NULL
         )
         UPDATE orders o
            SET assigned_prep_id = f.id, prep_assigned_at = now(), prep_assignment_mode = 'auto'
           FROM q JOIN free f ON f.rn = q.rn
          WHERE o.id = q.id AND o.status = 'awaiting_prep' AND o.assigned_prep_id IS NULL
        RETURNING o.id AS order_id, f.id AS staff_id`);

      await client.query('COMMIT');
      return r.rows; // [{order_id, staff_id}, ...] — what was just assigned
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('prepAssign.run failed:', e.message);
      return [];
    } finally {
      client.release();
    }
  }

  // Fire-and-forget helper for request handlers (never throws, never blocks the response).
  function kick() { run().catch(() => {}); }

  return { run, kick };
}

module.exports = { init };
