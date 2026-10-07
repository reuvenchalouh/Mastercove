const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Checks the admin password (sent by admin.html in the x-admin-password header)
// against the scrambled copy stored in Supabase. The real password is never in the code.
async function isAdmin(event) {
  const h = event.headers || {};
  const pw = h['x-admin-password'] || h['X-Admin-Password'] || '';
  if (!pw || pw.length > 200) return false;
  const { data, error } = await supabase.rpc('verify_admin_password', { pw });
  return !error && data === true;
}

// Server-side order management for admin.html, using the service key so the
// orders table doesn't need to be reachable by the public anon key at all.
// Supports the same operations admin.html previously ran directly against
// Supabase: listing all orders, creating/updating one (upsert), deleting
// one, and generating a random MC-###### order number for manually-added orders.

// When an order is marked Delivered, queue review-request emails (day 3, 7 and 14).
async function queueReviewRequest(order) {
  try {
    if (!order || !order.id) return;
    const { data: row } = await supabase.from('orders').select('id,order_number,customer,email,product,product_ids').eq('id', order.id).maybeSingle();
    if (!row || !row.email) return;
    let ids = Array.isArray(row.product_ids) ? row.product_ids : [];
    if (!ids.length && row.product) {
      // Older orders don't store product IDs — match by product name instead.
      const names = String(row.product).split(', ').map(s => s.replace(/ x\d+$/, '').trim()).filter(Boolean);
      if (names.length) {
        const { data: prods } = await supabase.from('products').select('id,name').in('name', names);
        ids = (prods || []).map(p => p.id);
      }
    }
    if (!ids.length) return;
    const token = require('crypto').randomBytes(24).toString('hex');
    await supabase.from('review_requests').upsert({
      order_id: row.id, order_number: row.order_number, email: row.email, customer_name: row.customer,
      product_ids: ids, token: token, delivered_at: new Date().toISOString()
    }, { onConflict: 'order_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Review request error:', e.message);
  }
}

// Random, non-sequential order numbers (e.g. MC-482917) so customers can't tell
// how many orders the store has had. Checks the database to avoid duplicates.
async function generateOrderNumber() {
  const crypto = require('crypto');
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = 'MC-' + String(crypto.randomInt(100000, 1000000));
    const { data, error } = await supabase.from('orders').select('id').eq('order_number', candidate).limit(1);
    if (!error && (!data || !data.length)) return candidate;
  }
  // Extremely unlikely fallback: longer number
  return 'MC-' + String(crypto.randomInt(10000000, 100000000));
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!(await isAdmin(event))) return { statusCode: 401, body: JSON.stringify({ error: 'Not authorized.' }) };

  try {
    const body = JSON.parse(event.body);
    const action = body.action;

    if (action === 'list') {
      const { data, error } = await supabase.from('orders').select('*').order('id', { ascending: false });
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ orders: data || [] }) };
    }

    if (action === 'upsert') {
      const order = body.order;
      if (!order || !order.id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing order data.' }) };
      const { error } = await supabase.from('orders').upsert(order);
      if (error) throw error;
      if (order.status === 'delivered') await queueReviewRequest(order);
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (action === 'delete') {
      const id = body.id;
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing order id.' }) };
      const { error } = await supabase.from('orders').delete().eq('id', id);
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (action === 'nextOrderNumber') {
      const orderNumber = await generateOrderNumber();
      return { statusCode: 200, body: JSON.stringify({ orderNumber: orderNumber }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    console.error('Admin-orders error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Something went wrong.' }) };
  }
};
