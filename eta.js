// eta.js: the delivery-time RANGE the customer sees on his order (like the big delivery apps: a range, never one exact minute).
//
//   estimate = remaining prep time + travel time (+ a safety margin while no courier has taken the order yet)
//   travel   = the real average of recently delivered orders IN THE SAME ZONE (falls back to all zones, then to sla_delivery_min)
//
// The range is recomputed on every refresh of the customer's order, so it tightens as the order moves:
//   preparing        -> wide  (prep + travel + assignment margin)
//   waiting_courier  -> travel + assignment margin ("we are looking for a courier")
//   courier_assigned -> travel + small margin (courier is coming to pick it up)
//   on_the_way       -> travel minus the time already spent on the road, small margin
// It never promises less than the truth: the low end is rounded DOWN and the high end UP to 5 minutes.

function init({ pool }) {
  const MIN_SAMPLES = 3;
  const ceil5 = (m) => Math.ceil(m / 5) * 5;
  const floor5 = (m) => Math.max(5, Math.floor(m / 5) * 5);

  async function setting(key, def) {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    const v = r.rows[0] ? parseInt(r.rows[0].value, 10) : NaN;
    return Number.isInteger(v) && v > 0 ? v : def;
  }

  // average real travel minutes (delivery_started_at -> delivered_at) for a zone; null when there is not enough history
  async function avgTravel(zoneId) {
    const q = zoneId
      ? `SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - delivery_started_at)) / 60) AS m, COUNT(*)::int AS n FROM (
           SELECT delivered_at, delivery_started_at FROM orders WHERE status = 'delivered' AND zone_id = $1
              AND delivered_at IS NOT NULL AND delivery_started_at IS NOT NULL
              AND delivered_at - delivery_started_at BETWEEN interval '1 minute' AND interval '4 hours'
            ORDER BY delivered_at DESC LIMIT 30) x`
      : `SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - delivery_started_at)) / 60) AS m, COUNT(*)::int AS n FROM (
           SELECT delivered_at, delivery_started_at FROM orders WHERE status = 'delivered'
              AND delivered_at IS NOT NULL AND delivery_started_at IS NOT NULL
              AND delivered_at - delivery_started_at BETWEEN interval '1 minute' AND interval '4 hours'
            ORDER BY delivered_at DESC LIMIT 50) x`;
    const r = await pool.query(q, zoneId ? [zoneId] : []);
    return r.rows[0].n >= MIN_SAMPLES ? Number(r.rows[0].m) : null;
  }

  // adds `eta` to every open order in the list (delivered / cancelled orders are left alone)
  async function attach(orders) {
    const open = orders.filter((o) => o.status && !['delivered', 'cancelled'].includes(o.status));
    if (!open.length) return orders;
    const ids = open.map((o) => o.id);
    const tr = await pool.query(`SELECT o.id, t.status AS trip_status FROM orders o LEFT JOIN trips t ON t.id = o.trip_id WHERE o.id = ANY($1::int[])`, [ids]);
    const tripStatus = Object.fromEntries(tr.rows.map((x) => [x.id, x.trip_status]));
    const defTravel = await setting('sla_delivery_min', 25);
    const defPrep = await setting('sla_prep_min', 15);
    const buffer = await setting('eta_assign_buffer_min', 10);
    const cache = {};
    const now = Date.now();
    for (const o of open) {
      const key = o.zone_id || 0;
      if (!(key in cache)) cache[key] = (await avgTravel(o.zone_id)) ?? (o.zone_id ? await avgTravel(null) : null) ?? defTravel;
      const travel = Math.max(5, cache[key]);
      const mins = (t) => (t ? (new Date(t).getTime() - now) / 60000 : null);
      let phase, low, high;
      if (o.status === 'on_the_way') {
        phase = 'on_the_way';
        const spent = o.delivery_started_at ? (now - new Date(o.delivery_started_at).getTime()) / 60000 : 0;
        const left = travel - spent;
        if (left <= 3) { low = 2; high = 8; }               // should be arriving: do not keep promising a stale time
        else { low = Math.max(2, Math.floor(left)); high = low + Math.max(5, Math.round(travel * 0.3)); }
      } else {
        const prepLeft = o.status === 'awaiting_delivery' ? 0
          : o.prep_due_at ? Math.max(0, mins(o.prep_due_at)) : defPrep;
        const ts = tripStatus[o.id];
        const assigned = ts === 'assigned';
        phase = o.status === 'awaiting_delivery' ? (assigned ? 'courier_assigned' : 'waiting_courier') : 'preparing';
        const margin = assigned ? Math.round(buffer / 2) : buffer;
        low = floor5(prepLeft + travel);
        high = ceil5(prepLeft + travel + margin);
        if (phase === 'preparing' && !assigned) high = ceil5(high + 5);
      }
      if (high - low < 5) high = low + 5;
      o.eta = {
        phase, low, high,
        from_at: new Date(now + low * 60000).toISOString(),
        to_at: new Date(now + high * 60000).toISOString(),
      };
    }
    return orders;
  }

  return { attach };
}

module.exports = { init };
