
// server.js — Fresh Produce App backend API
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
['manifest.json','staff-manifest.json','sw.js','install-sw.js','icon-192.png','icon-512.png'].forEach(function(f){
  app.get('/'+f, function(req,res){res.sendFile(require('path').join(__dirname,f))});
});
app.get('/', (req, res) => res.sendFile(require('path').join(__dirname, 'index.html')));
// Express treats /x and /x/ as the same route, so check the real URL to avoid a redirect loop
function pageRoute(base, file) {
  return (req, res) => {
    const p = req.originalUrl.split('?')[0];
    if (!p.endsWith('/')) return res.redirect(base + '/' + req.originalUrl.slice(p.length));
    res.sendFile(require('path').join(__dirname, file));
  };
}
app.get('/customer', pageRoute('/customer', 'index.html'));
app.get('/staff', pageRoute('/staff', 'staff.html'));
app.get('/customer/install', (req, res) => res.sendFile(require('path').join(__dirname, 'install-customer.html')));
app.get('/staff/install', (req, res) => res.sendFile(require('path').join(__dirname, 'install-staff.html')));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // your Neon connection string
  ssl: { rejectUnauthorized: false }
});

// Secret used to sign login tokens. Set JWT_SECRET in Railway's Variables for production.
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-railway-variables';

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// Middleware: require a valid logged-in token, optionally restricted to certain roles
function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      req.user = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}

// ---- CATEGORIES ----
app.get('/categories', async (req, res) => {
  const r = await pool.query('SELECT * FROM categories ORDER BY sort_order, id');
  res.json(r.rows);
});

app.post('/categories', requireAuth('admin'), async (req, res) => {
  const { name, emoji, color, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'missing_name', message: 'اسم القسم مطلوب.' });
  try {
    const r = await pool.query(
      'INSERT INTO categories (name, emoji, color, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, emoji || '🛒', color || '#D7F0E3', sort_order || 0]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'duplicate', message: 'يوجد قسم بنفس الاسم بالفعل.' });
    throw e;
  }
});

app.put('/categories/:id', requireAuth('admin'), async (req, res) => {
  const { name, emoji, color, sort_order } = req.body;
  const r = await pool.query(
    'UPDATE categories SET name=$1, emoji=$2, color=$3, sort_order=$4 WHERE id=$5 RETURNING *',
    [name, emoji, color, sort_order, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found', message: 'القسم غير موجود.' });
  res.json(r.rows[0]);
});

app.delete('/categories/:id', requireAuth('admin'), async (req, res) => {
  const cat = await pool.query('SELECT name FROM categories WHERE id=$1', [req.params.id]);
  if (!cat.rows.length) return res.status(404).json({ error: 'not_found', message: 'القسم غير موجود.' });
  const inUse = await pool.query('SELECT COUNT(*) FROM products WHERE category=$1', [cat.rows[0].name]);
  if (Number(inUse.rows[0].count) > 0) {
    return res.status(409).json({ error: 'category_in_use', message: 'لا يمكن حذف قسم يحتوي على منتجات، احذف أو انقل المنتجات أولًا.' });
  }
  await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- PRODUCTS ----
app.get('/products', async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE in_stock = true ORDER BY id');
  res.json(r.rows);
});

app.post('/products', requireAuth('admin'), async (req, res) => {
  const { name, emoji, image_url, price, unit, category, stock_qty } = req.body;
  const r = await pool.query(
    'INSERT INTO products (name, emoji, image_url, price, unit, category, stock_qty) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [name, emoji, image_url, price, unit, category, stock_qty || 0]
  );
  res.json(r.rows[0]);
});

app.put('/products/:id', requireAuth('admin'), async (req, res) => {
  const { name, price, unit, category, image_url, emoji } = req.body;
  const r = await pool.query(
    'UPDATE products SET name=$1, price=$2, unit=$3, category=$4, image_url=$5, emoji=$6 WHERE id=$7 RETURNING *',
    [name, price, unit, category, image_url, emoji, req.params.id]
  );
  res.json(r.rows[0]);
});

app.delete('/products/:id', requireAuth('admin'), async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- CUSTOMER ACCOUNTS (signup / login) ----

app.post('/auth/signup', async (req, res) => {
  const { name, phone, address, password } = req.body;
  if (!name || !phone || !address || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'من فضلك أكمل كل البيانات.' });
  }
  const existing = await pool.query('SELECT id FROM customers WHERE phone=$1', [phone]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'phone_taken', message: 'رقم الهاتف مسجل بالفعل، جرّب تسجيل الدخول.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO customers (name, phone, address, password_hash, role)
     VALUES ($1,$2,$3,$4,'customer') RETURNING id, name, phone, address`,
    [name, phone, address, hash]
  );
  const customer = r.rows[0];
  const token = makeToken({ id: customer.id, role: 'customer', name: customer.name });
  res.json({ token, customer });
});

app.post('/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  const r = await pool.query('SELECT * FROM customers WHERE phone=$1', [phone]);
  if (!r.rows.length || !r.rows[0].password_hash) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'رقم الهاتف أو كلمة السر غير صحيحة.' });
  }
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'رقم الهاتف أو كلمة السر غير صحيحة.' });
  }
  const customer = r.rows[0];
  const token = makeToken({ id: customer.id, role: 'customer', name: customer.name });
  res.json({
    token,
    customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address }
  });
});

app.post('/auth/staff-login', async (req, res) => {
  const { phone, password } = req.body;
  const r = await pool.query('SELECT * FROM staff WHERE phone=$1 AND active=true', [phone]);
  if (!r.rows.length) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'بيانات الدخول غير صحيحة.' });
  }
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'بيانات الدخول غير صحيحة.' });
  }
  const staffMember = r.rows[0];
  const token = makeToken({ id: staffMember.id, role: staffMember.role, name: staffMember.name });
  res.json({ token, staff: { id: staffMember.id, name: staffMember.name, role: staffMember.role } });
});

app.post('/auth/staff-create', requireAuth('admin'), async (req, res) => {
  const { name, phone, password, role, job_title } = req.body;
  if (!['prep', 'delivery', 'admin'].includes(role) || !name || !phone || !password || password.length < 6) {
    return res.status(400).json({ error: 'invalid', message: 'البيانات غير مكتملة.' });
  }
  const dup = await pool.query('SELECT id FROM staff WHERE phone=$1', [phone]);
  if (dup.rows.length) return res.status(409).json({ error: 'phone_taken', message: 'رقم الموبايل مستخدم بالفعل.' });
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    'INSERT INTO staff (name, phone, password_hash, role, job_title) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone, role, job_title',
    [name, phone, hash, role, job_title || null]
  );
  res.json(r.rows[0]);
});

app.patch('/staff/:id', requireAuth('admin'), async (req, res) => {
  const { name, job_title, role, password } = req.body;
  if (!['prep', 'delivery', 'admin'].includes(role) || !name) return res.status(400).json({ error: 'invalid' });
  if (Number(req.params.id) === req.user.id && role !== 'admin') return res.status(400).json({ error: 'self' });
  await pool.query('UPDATE staff SET name=$1, job_title=$2, role=$3 WHERE id=$4', [name, job_title || null, role, req.params.id]);
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'short_password' });
    await pool.query('UPDATE staff SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 10), req.params.id]);
  }
  res.json({ ok: true });
});

app.get('/customers/:phone', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, phone, address, reward_balance, referred_friends, created_at FROM customers WHERE phone=$1',
    [req.params.phone]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

app.get('/staff-list', requireAuth('admin'), async (req, res) => {
  const r = await pool.query('SELECT id, name, phone, role, job_title, active FROM staff ORDER BY id');
  res.json(r.rows);
});
app.patch('/staff/:id/active', requireAuth('admin'), async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'self' });
  const r = await pool.query('UPDATE staff SET active = NOT active WHERE id=$1 RETURNING id, active', [req.params.id]);
  res.json(r.rows[0] || {});
});

app.get('/customers', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, phone, address, reward_balance, referred_friends, created_at FROM customers ORDER BY created_at DESC'
  );
  res.json(r.rows);
});

// ---- STOCK (inventory) ----
// Internal helper: record a stock movement and update the product's stock_qty in one transaction.
// type: 'purchase' | 'sale' | 'return' | 'waste' | 'cancel_restock'. quantity is always positive.
async function moveStock(client, { product_id, type, quantity, note, order_id, staff_id }) {
  const sign = (type === 'purchase' || type === 'return' || type === 'cancel_restock') ? 1 : -1;
  await client.query(
    'UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2',
    [sign * quantity, product_id]
  );
  await client.query(
    `INSERT INTO stock_movements (product_id, type, quantity, note, order_id, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [product_id, type, quantity, note || null, order_id || null, staff_id || null]
  );
}

// Admin: full stock dashboard — current quantities + movement history
app.get('/stock', requireAuth('admin'), async (req, res) => {
  const products = await pool.query('SELECT id, name, emoji, unit, stock_qty FROM products ORDER BY id');
  const moves = await pool.query(
    `SELECT m.*, p.name AS product_name, p.emoji, p.unit, s.name AS staff_name
     FROM stock_movements m
     JOIN products p ON p.id = m.product_id
     LEFT JOIN staff s ON s.id = m.staff_id
     ORDER BY m.created_at DESC LIMIT 200`
  );
  res.json({ products: products.rows, movements: moves.rows });
});

// Admin: record a purchase (restock) or waste entry
app.post('/stock/movement', requireAuth('admin'), async (req, res) => {
  const { product_id, type, quantity, note } = req.body;
  if (!['purchase', 'waste'].includes(type) || !product_id || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'invalid', message: 'بيانات غير صحيحة.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (type === 'waste') {
      const cur = await client.query('SELECT stock_qty FROM products WHERE id=$1 FOR UPDATE', [product_id]);
      if (!cur.rows.length || Number(cur.rows[0].stock_qty) < Number(quantity)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'insufficient_stock', message: 'الكمية المسجلة كتالفة أكبر من المخزون المتاح.' });
      }
    }
    await moveStock(client, { product_id, type, quantity, note, staff_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---- ORDERS ----
// Customer places an order: checks stock, creates order, decrements stock ('sale'), all atomically.
app.post('/orders', requireAuth('customer'), async (req, res) => {
  const { customer_id, items, delivery_fee, reward_discount, total } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock and check stock for every item first
    for (const it of items) {
      const cur = await client.query('SELECT stock_qty, name FROM products WHERE id=$1 FOR UPDATE', [it.product_id]);
      if (!cur.rows.length || Number(cur.rows[0].stock_qty) < Number(it.quantity)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'insufficient_stock',
          message: 'عذرًا، الكمية المتاحة من "' + (cur.rows[0] ? cur.rows[0].name : 'المنتج') + '" لا تكفي.'
        });
      }
    }

    const orderR = await client.query(
      `INSERT INTO orders (customer_id, status, delivery_fee, reward_discount, total, payment_status)
       VALUES ($1,'awaiting_prep',$2,$3,$4,'due') RETURNING *`,
      [customer_id, delivery_fee, reward_discount, total]
    );
    const order = orderR.rows[0];
    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, it.product_id, it.quantity, it.unit_price, it.quantity * it.unit_price]
      );
      await moveStock(client, { product_id: it.product_id, type: 'sale', quantity: it.quantity, order_id: order.id });
    }
    await client.query('COMMIT');
    res.json(order);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/orders/customer/:id', requireAuth('customer', 'admin'), async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.json(r.rows);
});

async function withItems(orders) {
  if (!orders.length) return orders;
  const ids = orders.map(o => o.id);
  const items = await pool.query(
    `SELECT oi.*, p.name, p.emoji, p.unit FROM order_items oi
     JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ANY($1)`,
    [ids]
  );
  const byOrder = {};
  for (const it of items.rows) { (byOrder[it.order_id] = byOrder[it.order_id] || []).push(it); }
  return orders.map(o => ({ ...o, items: byOrder[o.id] || [] }));
}

// Prep staff (and admin, view-only): awaiting_prep + preparing orders
app.get('/orders/staff/prep', requireAuth('prep', 'admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('awaiting_prep','preparing') ORDER BY o.created_at`
  );
  res.json(await withItems(r.rows));
});

// Delivery staff (and admin, view-only): awaiting_delivery + on_the_way orders
app.get('/orders/staff/delivery', requireAuth('delivery', 'admin'), async (req, res) => {
  const me = req.user.role === 'admin' ? null : req.user.id;
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'awaiting_delivery' OR (o.status = 'on_the_way' AND ($1::int IS NULL OR o.delivery_staff_id = $1::int))
     ORDER BY o.created_at`, [me]
  );
  res.json(await withItems(r.rows));
});

// Admin-only: orders confirmed more than 30 minutes ago that are still not delivered.
app.get('/orders/delayed', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status NOT IN ('delivered','cancelled')
       AND o.created_at < now() - interval '30 minutes'
     ORDER BY o.created_at`
  );
  res.json(await withItems(r.rows));
});

app.get('/orders', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
            ps.name AS prep_staff_name, ds.name AS delivery_staff_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN staff ps ON ps.id = o.prep_staff_id
     LEFT JOIN staff ds ON ds.id = o.delivery_staff_id
     ORDER BY o.created_at DESC`
  );
  res.json(await withItems(r.rows));
});

// Six-stage order flow, each move stamped with its own timestamp:
// awaiting_prep -> preparing -> awaiting_delivery -> on_the_way -> delivered
const STATUS_MOVES = {
  prep: { awaiting_prep: 'preparing', preparing: 'awaiting_delivery' },
  delivery: { awaiting_delivery: 'on_the_way', on_the_way: 'delivered' }
};

app.patch('/orders/:id/status', requireAuth('prep', 'delivery'), async (req, res) => {
  const { status } = req.body;
  const moves = STATUS_MOVES[req.user.role] || {};
  const cur = await pool.query('SELECT status, delivery_staff_id FROM orders WHERE id=$1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'not_found' });
  const row = cur.rows[0];
  if (moves[row.status] !== status || (status === 'delivered' && row.delivery_staff_id !== req.user.id)) {
    return res.status(403).json({ error: 'not_allowed', message: 'لا يمكنك تنفيذ هذا التغيير على هذا الطلب.' });
  }
  const params = [status, req.params.id, row.status];
  let extra = '';
  if (status === 'preparing') { extra = ', prep_started_at=now(), prep_staff_id=$4'; params.push(req.user.id); }
  if (status === 'awaiting_delivery') extra = ', prepared_at=now()';
  if (status === 'on_the_way') { extra = ', delivery_started_at=now(), delivery_staff_id=$4'; params.push(req.user.id); }
  if (status === 'delivered') extra = ", delivered_at=now(), payment_status='paid'";
  const r = await pool.query(`UPDATE orders SET status=$1${extra} WHERE id=$2 AND status=$3 RETURNING *`, params);
  if (!r.rows.length) return res.status(409).json({ error: 'taken', message: 'الطلب اتغيّرت حالته، حدّث الشاشة.' });
  res.json(r.rows[0]);
});

// Cancel an order: only the owning customer or an admin, and stock is returned ('return')
app.patch('/orders/:id/cancel', requireAuth('customer', 'admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!ord.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const order = ord.rows[0];
    if (req.user.role === 'customer' && order.customer_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden', message: 'لا يمكنك إلغاء طلب لا يخصك.' });
    }
    if (order.status === 'delivered' || order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'not_allowed', message: 'لا يمكن إلغاء هذا الطلب.' });
    }
    const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id=$1', [order.id]);
    for (const it of items.rows) {
      await moveStock(client, { product_id: it.product_id, type: 'cancel_restock', quantity: it.quantity, order_id: order.id, note: 'إلغاء طلب قبل التسليم' });
    }
    const r = await client.query("UPDATE orders SET status='cancelled' WHERE id=$1 RETURNING *", [order.id]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---- PAYMENTS ----
app.post('/payments/confirm', requireAuth('customer'), async (req, res) => {
  const { order_id, reference, amount } = req.body;
  const dup = await pool.query('SELECT * FROM transactions WHERE reference=$1', [reference]);
  if (dup.rows.length) {
    return res.status(409).json({ error: 'duplicate_reference', message: 'عذرًا، هذه العملية تمت بالفعل من قبل.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO transactions (order_id, reference, amount) VALUES ($1,$2,$3)',
      [order_id, reference, amount]
    );
    await client.query(
      "UPDATE orders SET payment_status='pending', payment_ref=$1 WHERE id=$2",
      [reference, order_id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.patch('/payments/:orderId/verify', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    "UPDATE orders SET payment_status='confirmed' WHERE id=$1 RETURNING *",
    [req.params.orderId]
  );
  res.json(r.rows[0]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API running on port ' + PORT));
