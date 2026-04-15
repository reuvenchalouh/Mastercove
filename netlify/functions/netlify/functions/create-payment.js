const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  console.log('STRIPE_SECRET_KEY present:', !!process.env.STRIPE_SECRET_KEY);
  console.log('SUPABASE_URL present:', !!process.env.SUPABASE_URL);

  try {
    const { paymentMethodId, amount, currency, email, name, address, city, state, zip, items } = JSON.parse(event.body);
    if (!paymentMethodId || !amount || amount < 50) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payment details.' }) };

    const paymentIntent = await stripe.paymentIntents.create({
      amount, currency: currency || 'usd',
      payment_method: paymentMethodId,
      confirmation_method: 'manual',
      confirm: true,
      receipt_email: email,
      description: 'Master Cove Order',
      shipping: { name, address: { line1: address, city, state, postal_code: zip, country: 'US' } },
      metadata: { customer_name: name, customer_email: email },
      return_url: 'https://mastercove.com/order-confirmed.html'
    });

    if (paymentIntent.status === 'requires_action') {
      return { statusCode: 200, body: JSON.stringify({ requiresAction: true, clientSecret: paymentIntent.client_secret, orderId: paymentIntent.id }) };
    }

    if (paymentIntent.status === 'succeeded') {
      const orderNumber = await saveOrder({ email, name, address, city, state, zip, items, amount, stripeId: paymentIntent.id });
      return { statusCode: 200, body: JSON.stringify({ success: true, orderId: paymentIntent.id, orderNumber }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Payment could not be processed.' }) };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Payment failed.' }) };
  }
};

async function saveOrder({ email, name, address, city, state, zip, items, amount, stripeId }) {
  try {
    const { count } = await supabase.from('orders').select('*', { count: 'exact', head: true });
    const orderNumber = 'MC-' + String((count || 0) + 1).padStart(4, '0');
    const productNames = (items || []).map(i => i.name + (i.finish ? ' (' + i.finish + ')' : '')).join(', ');
    const revenue = Math.round(amount) / 100;
    const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    await supabase.from('orders').insert({
      id: Date.now(),
      order_number: orderNumber,
      customer: name,
      email: email,
      address: address + ', ' + city + ', ' + state + ' ' + zip,
      product: productNames,
      variant: (items && items[0] && items[0].finish) ? items[0].finish : '',
      revenue: revenue,
      cost: 0,
      link: '',
      notes: '',
      status: 'new',
      timestamps: {},
      stripe_id: stripeId,
      supplier_order_num: '',
      tracking_number: '',
      proof_photos: [],
      created_at: now
    });

    console.log('Order saved to Supabase:', orderNumber);
    return orderNumber;
  } catch (e) {
    console.error('Supabase save error:', e.message);
    return 'MC-????';
  }
}
