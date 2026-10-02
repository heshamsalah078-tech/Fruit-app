
// server.js — Fresh Produce App backend API
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.sendFile(require('path').join(__dirname, 'index.html')));

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

// ---- PRODUCTS ----
app.get('/products', async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE in_stock = true ORDER BY id');
  res.json(r.rows);
});

app.post('/products', requireAuth('admin'), async (req, res) => {
  const { name, emoji, image_url, price, unit, category } = req.body;
  const r = await pool.query(
    'INSERT INTO products (name, emoji, image_url, price, unit, category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [name, emoji, image_url, price, unit, category]
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

// Sign up: create a brand-new customer account with a password
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

// Login: existing customer with phone + password
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

// Staff login (prep / delivery / admin) — accounts are created by the admin, not self-signup
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

// Admin creates a staff account (prep, delivery, or another admin)
app.post('/auth/staff-create', requireAuth('admin'), async (req, res) => {
  const { name, phone, password, role } = req.body;
  if (!['prep', 'delivery', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    'INSERT INTO staff (name, phone, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, role',
    [name, phone, hash, role]
  );
  res.json(r.rows[0]);
});

app.get('/customers/:phone', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, phone, address, reward_balance, referred_friends, created_at FROM customers WHERE phone=$1',
    [req.params.phone]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// Admin: list every customer (for the admin dashboard)
app.get('/customers', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, phone, address, reward_balance, referred_friends, created_at FROM customers ORDER BY created_at DESC'
  );
  res.json(r.rows);
});

// ---- ORDERS ----
app.post('/orders', requireAuth('customer'), async (req, res) => {
  const { customer_id, items, delivery_fee, reward_discount, total } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderR = await client.query(
      `INSERT INTO orders (customer_id, status, delivery_fee, reward_discount, total, payment_status)
       VALUES ($1,'registered',$2,$3,$4,'due') RETURNING *`,
      [customer_id, delivery_fee, reward_discount, total]
    );
    const order = orderR.rows[0];
    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, it.product_id, it.quantity, it.unit_price, it.quantity * it.unit_price]
      );
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

app.get('/orders/staff/prep', requireAuth('prep', 'admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('registered','preparing') ORDER BY o.created_at`
  );
  res.json(r.rows);
});

app.get('/orders/staff/delivery', requireAuth('delivery', 'admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('ready','on_the_way') ORDER BY o.created_at`
  );
  res.json(r.rows);
});


// Admin: every order (open + finished), with customer info — basis for reports
app.get('/orders', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     ORDER BY o.created_at DESC`
  );
  res.json(r.rows);
});

app.patch('/orders/:id/status', requireAuth('prep', 'delivery', 'admin'), async (req, res) => {
  const { status } = req.body;
  const r = await pool.query(
    'UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',
    [status, req.params.id]
  );
  res.json(r.rows[0]);
});

app.patch('/orders/:id/cancel', requireAuth('customer', 'admin'), async (req, res) => {
  const r = await pool.query(
    "UPDATE orders SET status='cancelled' WHERE id=$1 RETURNING *",
    [req.params.id]
  );
  res.json(r.rows[0]);
});

// ---- PAYMENTS ----
app.post('/payments/confirm', async (req, res) => {
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

app.patch('/payments/:orderId/verify', async (req, res) => {
  const r = await pool.query(
    "UPDATE orders SET payment_status='confirmed' WHERE id=$1 RETURNING *",
    [req.params.orderId]
  );
  res.json(r.rows[0]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API running on port ' + PORT));
