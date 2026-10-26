// Delivery zones + fee (customer side + ops management).
//
//  * The ops manager (or admin) maintains a table of zones: name + delivery fee + active/inactive.
//  * The customer PICKS a zone from that list. The server looks the fee up at the moment the order is confirmed and freezes
//    it on the order (orders.delivery_fee, zone_id, zone_name). The fee sent by the app is never trusted.
//  * A customer whose area is not in an active zone gets a polite "outside our coverage area" message and cannot order.

function init({ pool, requireAuth, express }) {
  const router = express.Router();
  const OUT_OF_AREA = 'آسفين، منطقتك خارج نطاق التوصيل حالياً.';

  // Public: the list the customer chooses from (active zones only).
  router.get('/zones', async (req, res) => {
    try {
      const r = await pool.query('SELECT id, name, fee FROM delivery_zones WHERE active = true ORDER BY sort_order, name');
      res.json({ zones: r.rows.map((z) => ({ id: z.id, name: z.name, fee: Number(z.fee) })) });
    } catch (e) { console.error('zones', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر تحميل المناطق.' }); }
  });

  // Ops / admin: the full table, including inactive zones.
  router.get('/zones/all', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const r = await pool.query('SELECT id, name, fee, active, sort_order FROM delivery_zones ORDER BY sort_order, name');
      res.json({ zones: r.rows.map((z) => ({ ...z, fee: Number(z.fee) })) });
    } catch (e) { res.status(500).json({ error: 'failed', message: 'تعذّر التحميل.' }); }
  });

  function clean(b) {
    const name = String(b.name || '').trim().slice(0, 80);
    const fee = Number(b.fee);
    if (!name) return { error: 'اكتب اسم المنطقة.' };
    if (!Number.isFinite(fee) || fee < 0 || fee > 10000) return { error: 'سعر التوصيل غير صحيح.' };
    return { name, fee: Math.round(fee * 100) / 100, active: b.active === undefined ? true : !!b.active, sort_order: Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 0 };
  }
  async function audit(action, actor, details) {
    await pool.query(`INSERT INTO staff_audit (action, actor_id, details) VALUES ($1,$2,$3)`, [action, actor, JSON.stringify(details)]).catch(() => {});
  }

  router.post('/zones', requireAuth('admin', 'ops'), async (req, res) => {
    const z = clean(req.body || {});
    if (z.error) return res.status(400).json({ error: 'invalid', message: z.error });
    try {
      const r = await pool.query('INSERT INTO delivery_zones (name, fee, active, sort_order) VALUES ($1,$2,$3,$4) RETURNING *', [z.name, z.fee, z.active, z.sort_order]);
      await audit('zone_created', req.user.id, { id: r.rows[0].id, name: z.name, fee: z.fee });
      res.json({ ok: true, zone: { ...r.rows[0], fee: Number(r.rows[0].fee) } });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'duplicate', message: 'المنطقة دي موجودة بالفعل.' });
      console.error('zones post', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' });
    }
  });

  router.put('/zones/:id', requireAuth('admin', 'ops'), async (req, res) => {
    const z = clean(req.body || {});
    if (z.error) return res.status(400).json({ error: 'invalid', message: z.error });
    try {
      const old = await pool.query('SELECT name, fee, active FROM delivery_zones WHERE id = $1', [Number(req.params.id)]);
      if (!old.rows.length) return res.status(404).json({ error: 'not_found', message: 'المنطقة غير موجودة.' });
      const r = await pool.query('UPDATE delivery_zones SET name=$2, fee=$3, active=$4, sort_order=$5 WHERE id=$1 RETURNING *', [Number(req.params.id), z.name, z.fee, z.active, z.sort_order]);
      await audit('zone_updated', req.user.id, { id: r.rows[0].id, before: old.rows[0], after: { name: z.name, fee: z.fee, active: z.active } });
      res.json({ ok: true, zone: { ...r.rows[0], fee: Number(r.rows[0].fee) } });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'duplicate', message: 'المنطقة دي موجودة بالفعل.' });
      console.error('zones put', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحفظ.' });
    }
  });

  // Zones are switched off, not deleted, so old orders and customers keep their history. Used zones can't be removed.
  router.delete('/zones/:id', requireAuth('admin', 'ops'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const used = await pool.query('SELECT (SELECT COUNT(*) FROM orders WHERE zone_id = $1)::int AS o, (SELECT COUNT(*) FROM customers WHERE zone_id = $1)::int AS c', [id]);
      if (used.rows[0].o || used.rows[0].c) {
        await pool.query('UPDATE delivery_zones SET active = false WHERE id = $1', [id]);
        await audit('zone_deactivated', req.user.id, { id });
        return res.json({ ok: true, deactivated: true, message: 'المنطقة عليها طلبات أو عملاء، فاتقفلت بدل ما تتمسح.' });
      }
      await pool.query('DELETE FROM delivery_zones WHERE id = $1', [id]);
      await audit('zone_deleted', req.user.id, { id });
      res.json({ ok: true });
    } catch (e) { console.error('zones delete', e.message); res.status(500).json({ error: 'failed', message: 'تعذّر الحذف.' }); }
  });

  // Customer: remember my zone (no fee is taken from the client).
  async function setCustomerZone(db, customerId, zoneId) {
    const z = await db.query('SELECT id FROM delivery_zones WHERE id = $1 AND active = true', [Number(zoneId)]);
    if (!z.rows.length) return false;
    await db.query('UPDATE customers SET zone_id = $2 WHERE id = $1', [customerId, z.rows[0].id]);
    return true;
  }

  // Used by POST /orders: resolve the customer's zone and fee on the server. Returns {ok, zone} or {ok:false, message}.
  async function resolveForOrder(db, customerId, zoneIdFromClient) {
    let zid = zoneIdFromClient ? Number(zoneIdFromClient) : null;
    if (!zid) {
      const c = await db.query('SELECT zone_id FROM customers WHERE id = $1', [customerId]);
      zid = c.rows[0] && c.rows[0].zone_id;
    }
    if (!zid) return { ok: false, code: 'zone_required', message: 'اختر منطقتك الأول عشان نحسب التوصيل.' };
    const z = await db.query('SELECT id, name, fee, active FROM delivery_zones WHERE id = $1', [zid]);
    if (!z.rows.length || !z.rows[0].active) return { ok: false, code: 'out_of_area', message: OUT_OF_AREA };
    return { ok: true, zone: { id: z.rows[0].id, name: z.rows[0].name, fee: Number(z.rows[0].fee) } };
  }

  return { router, resolveForOrder, setCustomerZone, OUT_OF_AREA };
}

module.exports = { init };
