const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Server-side order lookup for the customer-facing Track Order page.
// Runs with the service key so the orders table itself never needs to be
// reachable by the public anon key — this function is the only door in,
// and it only ever returns the single matching order, never a full list.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { orderNumber, email } = JSON.parse(event.body);
    if (!orderNumber || !email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please enter both your order number and email address.' }) };
    }

    const { data, error } = await supabase
      .from('orders')
      .select('order_number, customer, product, address, status, timestamps, tracking_number, created_at')
      .ilike('order_number', orderNumber.trim())
      .ilike('email', email.trim());

    if (error) throw error;
    if (!data || !data.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No order found. Please check your order number and email and try again.' }) };
    }

    const order = data.sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); })[0];
    return { statusCode: 200, body: JSON.stringify({ order: order }) };
  } catch (err) {
    console.error('Track-order error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};
