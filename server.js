
// server.js — Fresh Produce App backend API
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
['manifest.json','staff-manifest.json','sw.js','install-sw.js','icon-192.png','icon-512.png'].forEach(function(f){
  app.get('/'+f, function(req,res){res.sendFile(require('path').join(__dirname,f))});
});

// ---- PUSH NOTIFICATIONS (web-push) ----
// Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Railway's Variables for production.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BAwDYPNkTZd0eDBBXVYnrmD83iSv3YPxIvz43X4PHfBbitsjIni24aZo8asrKZchcqgippLL-XGOJwHK84NyOZE';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'vkaRyGbO8EoUE_qjAhdFpf69K_BhdWqhNpoH_jy86Og';
webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Send a push notification to every admin device subscribed. Removes subscriptions that are no longer valid.
async function notifyAdmins(payload) {
  const subs = await pool.query(
    `SELECT ps.* FROM push_subscriptions ps JOIN staff s ON s.id = ps.staff_id WHERE s.role = 'admin'`
  );
  const body = JSON.stringify(payload);
  for (const sub of subs.rows) {
    const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(pushSub, body);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
      } else {
        console.error('push failed', e.message);
      }
    }
  }
}

// Voice-note uploads for complaints, stored on local disk under /uploads (served statically below).
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + '.webm')
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});
app.use('/uploads', express.static(UPLOAD_DIR));
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

// ---- PUSH SUBSCRIPTIONS ----
app.get('/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// Admin device registers itself to receive push notifications.
app.post('/push/subscribe', requireAuth('admin'), async (req, res) => {
  const { endpoint, keys } = req.body.subscription || req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  await pool.query(
    `INSERT INTO push_subscriptions (staff_id, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET staff_id=$1, p256dh=$3, auth=$4`,
    [req.user.id, endpoint, keys.p256dh, keys.auth]
  );
  res.json({ ok: true });
});

app.post('/push/unsubscribe', requireAuth('admin'), async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
  res.json({ ok: true });
});

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
  const { name, emoji, image_url, price, unit, category, stock_qty, low_stock_threshold } = req.body;
  const r = await pool.query(
    'INSERT INTO products (name, emoji, image_url, price, unit, category, stock_qty, low_stock_threshold) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [name, emoji, image_url, price, unit, category, stock_qty || 0, low_stock_threshold || 0]
  );
  res.json(r.rows[0]);
});

app.put('/products/:id', requireAuth('admin'), async (req, res) => {
  const { name, price, unit, category, image_url, emoji, low_stock_threshold } = req.body;
  const r = await pool.query(
    'UPDATE products SET name=$1, price=$2, unit=$3, category=$4, image_url=$5, emoji=$6, low_stock_threshold=$7 WHERE id=$8 RETURNING *',
    [name, price, unit, category, image_url, emoji, low_stock_threshold || 0, req.params.id]
  );
  res.json(r.rows[0]);
});

// Admin-only: products at or below their own low_stock_threshold, queried on demand.
app.get('/stock/low', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT id, name, emoji, unit, stock_qty, low_stock_threshold
     FROM products
     WHERE low_stock_threshold > 0 AND stock_qty <= low_stock_threshold
     ORDER BY stock_qty ASC`
  );
  res.json(r.rows);
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
  const upd = await client.query(
    'UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 RETURNING stock_qty, low_stock_threshold, name, emoji, unit',
    [sign * quantity, product_id]
  );
  await client.query(
    `INSERT INTO stock_movements (product_id, type, quantity, note, order_id, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [product_id, type, quantity, note || null, order_id || null, staff_id || null]
  );
  // If this movement just brought the product down to/below its critical threshold, notify admins —
  // but only once per "episode" (we won't notify again until it goes back above threshold and dips again).
  const p = upd.rows[0];
  if (p && p.low_stock_threshold > 0 && Number(p.stock_qty) <= Number(p.low_stock_threshold)) {
    checkLowStockNotify(p, product_id).catch(function (e) { console.error('low stock notify failed', e.message); });
  } else if (p && Number(p.stock_qty) > Number(p.low_stock_threshold)) {
    // Back above threshold — clear the flag so a future dip notifies again.
    await client.query('DELETE FROM notified_low_stock WHERE product_id=$1', [product_id]);
  }
}

async function checkLowStockNotify(p, product_id) {
  const already = await pool.query('SELECT 1 FROM notified_low_stock WHERE product_id=$1', [product_id]);
  if (already.rows.length) return;
  await pool.query(
    'INSERT INTO notified_low_stock (product_id, notified_at) VALUES ($1, now()) ON CONFLICT (product_id) DO UPDATE SET notified_at=now()',
    [product_id]
  );
  await notifyAdmins({
    title: '📉 مخزون منخفض',
    body: (p.emoji || '') + ' ' + p.name + ': تبقّى ' + p.stock_qty + ' ' + p.unit + ' فقط (الحد الحرج ' + p.low_stock_threshold + ').',
    tag: 'lowstock',
    url: '/staff/#lowstock'
  });
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
        const availableQty = cur.rows[0] ? cur.rows[0].stock_qty : 0;
        const productName = cur.rows[0] ? cur.rows[0].name : 'المنتج';
        // Log the failed attempt, but only once per customer+product within a short window —
        // if they keep tapping "add" without noticing the error, we don't want dozens of
        // near-identical log rows for what is really a single attempt.
        const recent = await client.query(
          `SELECT id FROM stock_shortage_log
           WHERE customer_id=$1 AND product_id=$2 AND created_at > now() - interval '2 minutes'`,
          [customer_id, it.product_id]
        );
        let justLogged = false;
        if (!recent.rows.length) {
          await client.query(
            `INSERT INTO stock_shortage_log (customer_id, product_id, requested_qty, available_qty)
             VALUES ($1,$2,$3,$4)`,
            [customer_id, it.product_id, it.quantity, availableQty]
          );
          justLogged = true;
        }
        await client.query('COMMIT');
        if (justLogged) {
          // Fire-and-forget: tell the admin a customer just hit a stock wall, with full detail.
          pool.query('SELECT name, phone FROM customers WHERE id=$1', [customer_id]).then(function (cr) {
            const custName = cr.rows[0] ? cr.rows[0].name : 'عميل';
            notifyAdmins({
              title: '⚠️ محاولة شراء فاشلة',
              body: custName + ' حاول يطلب ' + it.quantity + ' من "' + productName + '" والمتاح ' + availableQty + ' فقط.',
              tag: 'shortage',
              url: '/staff/#shortages'
            }).catch(function (e) { console.error('notify shortage failed', e.message); });
          }).catch(function (e) { console.error('notify shortage lookup failed', e.message); });
        }
        return res.status(409).json({
          error: 'insufficient_stock',
          message: 'عذرًا، الكمية المتاحة من "' + productName + '" لا تكفي.'
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

// Admin-only: log of failed order attempts caused by insufficient stock —
// which customer, which product, requested vs available quantity, and when.
app.get('/stock/shortages', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT sl.*, c.name AS customer_name, c.phone AS customer_phone,
            p.name AS product_name, p.emoji, p.unit
     FROM stock_shortage_log sl
     JOIN customers c ON c.id = sl.customer_id
     JOIN products p ON p.id = sl.product_id
     ORDER BY sl.created_at DESC LIMIT 200`
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

// Delivery staff (and admin, view-only): awaiting_delivery + on_the_way orders,
// plus the delivery person's own recently delivered & paid orders (last 7 days).
app.get('/orders/staff/delivery', requireAuth('delivery', 'admin'), async (req, res) => {
  const me = req.user.role === 'admin' ? null : req.user.id;
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'awaiting_delivery'
        OR (o.status = 'on_the_way' AND ($1::int IS NULL OR o.delivery_staff_id = $1::int))
        OR (o.status = 'delivered' AND o.payment_status = 'paid'
            AND ($1::int IS NULL OR o.delivery_staff_id = $1::int)
            AND o.delivered_at > now() - interval '7 days')
     ORDER BY o.created_at`, [me]
  );
  res.json(await withItems(r.rows));
});

// Admin-only: orders delayed more than 30 minutes, queried on demand.
// ?delivered=1 -> delayed orders that WERE eventually delivered (delivered_at - created_at > 30 min)
// ?delivered=0 (default) -> still-open orders delayed more than 30 min since creation
app.get('/orders/delayed', requireAuth('admin'), async (req, res) => {
  const wantDelivered = req.query.delivered === '1' || req.query.delivered === 'true';
  let r;
  if (wantDelivered) {
    r = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status = 'delivered'
         AND o.delivered_at IS NOT NULL
         AND o.delivered_at - o.created_at > interval '30 minutes'
       ORDER BY o.created_at DESC`
    );
  } else {
    r = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status NOT IN ('delivered','cancelled')
         AND o.created_at < now() - interval '30 minutes'
       ORDER BY o.created_at`
    );
  }
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

// ---- CART TRACKING (abandoned cart detection) ----
// Customer app pings this (debounced) whenever the cart changes. We just remember the
// latest snapshot and when it last changed; a background job looks for stale non-empty carts.
app.post('/cart/sync', requireAuth('customer'), async (req, res) => {
  const { items } = req.body; // { productId: qty, ... }
  const hasItems = items && Object.keys(items).length > 0;
  if (!hasItems) {
    // Cart emptied or order placed — clear any pending snapshot so we don't notify about it later.
    await pool.query('DELETE FROM cart_snapshots WHERE customer_id=$1', [req.user.id]);
    return res.json({ ok: true });
  }
  await pool.query(
    `INSERT INTO cart_snapshots (customer_id, items, updated_at, notified_at)
     VALUES ($1,$2, now(), NULL)
     ON CONFLICT (customer_id) DO UPDATE SET items=$2, updated_at=now(), notified_at=NULL`,
    [req.user.id, JSON.stringify(items)]
  );
  res.json({ ok: true });
});

// ---- COMPLAINTS ----
// Customer submits a written and/or voice complaint; admin is notified immediately.
app.post('/complaints', requireAuth('customer'), upload.single('voice'), async (req, res) => {
  const { message } = req.body;
  const voiceUrl = req.file ? '/uploads/' + req.file.filename : null;
  if (!message && !voiceUrl) {
    return res.status(400).json({ error: 'empty', message: 'اكتب شكواك أو سجّلها صوتيًا.' });
  }
  const r = await pool.query(
    `INSERT INTO complaints (customer_id, message, voice_url) VALUES ($1,$2,$3) RETURNING *`,
    [req.user.id, message || null, voiceUrl]
  );
  const cust = await pool.query('SELECT name FROM customers WHERE id=$1', [req.user.id]);
  const custName = cust.rows[0] ? cust.rows[0].name : 'عميل';
  notifyAdmins({
    title: '📝 شكوى جديدة من ' + custName,
    body: message ? message.slice(0, 120) : 'تم إرسال ملاحظة صوتية.',
    tag: 'complaint',
    url: '/staff/#complaints'
  }).catch(function (e) { console.error('notify complaint failed', e.message); });
  res.json(r.rows[0]);
});

// Admin-only: browse complaints, newest first.
app.get('/complaints', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT cm.*, c.name AS customer_name, c.phone AS customer_phone
     FROM complaints cm JOIN customers c ON c.id = cm.customer_id
     ORDER BY cm.created_at DESC LIMIT 200`
  );
  res.json(r.rows);
});

// ---- BACKGROUND: delayed-order watcher ----
// Every 3 minutes, check for orders delayed more than 30 minutes that we haven't already
// notified about, and push one notification per newly-delayed order found.
async function checkDelayedOrders() {
  try {
    const r = await pool.query(
      `SELECT o.id, c.name AS customer_name
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN notified_delayed_orders n ON n.order_id = o.id
       WHERE o.status NOT IN ('delivered','cancelled')
         AND o.created_at < now() - interval '30 minutes'
         AND n.order_id IS NULL`
    );
    for (const row of r.rows) {
      await pool.query('INSERT INTO notified_delayed_orders (order_id) VALUES ($1) ON CONFLICT DO NOTHING', [row.id]);
      await notifyAdmins({
        title: '⏰ طلب متأخر',
        body: 'طلب ' + row.customer_name + ' اتأخر أكتر من 30 دقيقة ولسه ما اتسلّمش.',
        tag: 'delayed-' + row.id,
        url: '/staff/#delayed'
      });
    }
  } catch (e) {
    console.error('checkDelayedOrders failed', e.message);
  }
}
setInterval(checkDelayedOrders, 3 * 60 * 1000);
checkDelayedOrders();

// ---- BACKGROUND: abandoned-cart watcher ----
// Every 5 minutes, find carts that haven't changed in 20+ minutes and haven't been
// cleared (meaning no order followed), and notify once per abandonment.
async function checkAbandonedCarts() {
  try {
    const r = await pool.query(
      `SELECT cs.customer_id, cs.items, c.name, c.phone
       FROM cart_snapshots cs
       JOIN customers c ON c.id = cs.customer_id
       WHERE cs.updated_at < now() - interval '20 minutes'
         AND cs.notified_at IS NULL`
    );
    for (const row of r.rows) {
      const items = row.items || {};
      const ids = Object.keys(items);
      let itemsDesc = '';
      if (ids.length) {
        const prods = await pool.query('SELECT id, name, emoji FROM products WHERE id = ANY($1::int[])', [ids.map(Number)]);
        itemsDesc = prods.rows.map(p => (p.emoji || '') + ' ' + p.name + ' ×' + items[p.id]).join('، ');
      }
      await pool.query('UPDATE cart_snapshots SET notified_at = now() WHERE customer_id=$1', [row.customer_id]);
      await notifyAdmins({
        title: '🛒 سلة متروكة',
        body: row.name + ' أضاف منتجات ولم يكمل الطلب: ' + (itemsDesc || 'منتجات في السلة') + '.',
        tag: 'abandoned-cart-' + row.customer_id,
        url: '/staff'
      });
    }
  } catch (e) {
    console.error('checkAbandonedCarts failed', e.message);
  }
}
setInterval(checkAbandonedCarts, 5 * 60 * 1000);
checkAbandonedCarts();

// ---- BACKGROUND: inactive-customer watcher ----
// Every 6 hours, look at customers with at least 3 past orders, compute the average gap
// between their orders, and flag anyone silent for more than 2x their own average gap
// since their last order (never notified twice for the same silence).
async function checkInactiveCustomers() {
  try {
    const r = await pool.query(`
      WITH gaps AS (
        SELECT customer_id,
               created_at,
               created_at - LAG(created_at) OVER (PARTITION BY customer_id ORDER BY created_at) AS gap
        FROM orders
        WHERE status <> 'cancelled'
      ),
      stats AS (
        SELECT customer_id, AVG(gap) AS avg_gap, MAX(created_at) AS last_order, COUNT(*) AS n
        FROM gaps
        GROUP BY customer_id
        HAVING COUNT(*) >= 2
      )
      SELECT s.customer_id, c.name, c.phone, s.avg_gap, s.last_order
      FROM stats s
      JOIN customers c ON c.id = s.customer_id
      LEFT JOIN notified_inactive_customers n ON n.customer_id = s.customer_id
      WHERE now() - s.last_order > s.avg_gap * 2
        AND (n.notified_at IS NULL OR n.notified_at < s.last_order)
    `);
    for (const row of r.rows) {
      await pool.query(
        `INSERT INTO notified_inactive_customers (customer_id, notified_at) VALUES ($1, now())
         ON CONFLICT (customer_id) DO UPDATE SET notified_at = now()`,
        [row.customer_id]
      );
      const days = Math.round((Date.now() - new Date(row.last_order).getTime()) / 86400000);
      await notifyAdmins({
        title: '👋 عميل غاب عن عادته',
        body: row.name + ' لم يطلب منذ ' + days + ' يومًا، وده أكتر من ضعف معدله المعتاد.',
        tag: 'inactive-' + row.customer_id,
        url: '/staff'
      });
    }
  } catch (e) {
    console.error('checkInactiveCustomers failed', e.message);
  }
}
setInterval(checkInactiveCustomers, 6 * 60 * 60 * 1000);
checkInactiveCustomers();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API running on port ' + PORT));
