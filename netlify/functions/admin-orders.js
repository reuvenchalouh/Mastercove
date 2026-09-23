const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Server-side order management for admin.html, using the service key so the
// orders table doesn't need to be reachable by the public anon key at all.
// Supports the same operations admin.html previously ran directly against
// Supabase: listing all orders, creating/updating one (upsert), deleting
// one, and generating the next MC-#### order number for manually-added orders.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

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
      const { count, error } = await supabase.from('orders').select('*', { count: 'exact', head: true });
      if (error) throw error;
      const orderNumber = 'MC-' + String((count || 0) + 1).padStart(4, '0');
      return { statusCode: 200, body: JSON.stringify({ orderNumber: orderNumber }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    console.error('Admin-orders error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Something went wrong.' }) };
  }
};
