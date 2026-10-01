
// server.js — Fresh Produce App backend API
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // your Neon connection string
  ssl: { rejectUnauthorized: false }
});

// ---- PRODUCTS ----
app.get('/products', async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE in_stock = true ORDER BY id');
  res.json(r.rows);
});

app.post('/products', async (req, res) => {
  const { name, emoji, image_url, price, unit, category } = req.body;
  const r = await pool.query(
    'INSERT INTO products (name, emoji, image_url, price, unit, category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [name, emoji, image_url, price, unit, category]
  );
  res.json(r.rows[0]);
});

app.put('/products/:id', async (req, res) => {
  const { name, price, unit, category, image_url, emoji } = req.body;
  const r = await pool.query(
    'UPDATE products SET name=$1, price=$2, unit=$3, category=$4, image_url=$5, emoji=$6 WHERE id=$7 RETURNING *',
    [name, price, unit, category, image_url, emoji, req.params.id]
  );
  res.json(r.rows[0]);
});

app.delete('/products/:id', async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---- CUSTOMERS ----
app.post('/customers/register', async (req, res) => {
  const { name, phone, address } = req.body;
  const existing = await pool.query('SELECT * FROM customers WHERE phone=$1', [phone]);
  if (existing.rows.length) {
    const r = await pool.query(
      'UPDATE customers SET name=$1, address=$2 WHERE phone=$3 RETURNING *',
      [name, address, phone]
    );
    return res.json(r.rows[0]);
  }
  const r = await pool.query(
    'INSERT INTO customers (name, phone, address) VALUES ($1,$2,$3) RETURNING *',
    [name, phone, address]
  );
  res.json(r.rows[0]);
});

app.get('/customers/:phone', async (req, res) => {
  const r = await pool.query('SELECT * FROM customers WHERE phone=$1', [req.params.phone]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// ---- ORDERS ----
app.post('/orders', async (req, res) => {
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

app.get('/orders/customer/:id', async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.json(r.rows);
});

app.get('/orders/staff/prep', async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('registered','preparing') ORDER BY o.created_at`
  );
  res.json(r.rows);
});

app.get('/orders/staff/delivery', async (req, res) => {
  const r = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('ready','on_the_way') ORDER BY o.created_at`
  );
  res.json(r.rows);
});

app.patch('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const r = await pool.query(
    'UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',
    [status, req.params.id]
  );
  res.json(r.rows[0]);
});

app.patch('/orders/:id/cancel', async (req, res) => {
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
