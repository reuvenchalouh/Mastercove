const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

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
      const fullAddress = address + ', ' + city + ', ' + state + ' ' + zip;
      const productNames = (items || []).map(i => i.name + (i.finish ? ' (' + i.finish + ')' : '')).join(', ');
      const revenue = (Math.round(amount) / 100).toFixed(2);
      const orderNumber = await saveOrder({ email, name, address, city, state, zip, items, amount, stripeId: paymentIntent.id });

      // Notify YOU (the store owner) of the new order
      await sendOwnerNotification({ orderNumber, customerName: name, customerEmail: email, product: productNames, address: fullAddress, revenue });

      return { statusCode: 200, body: JSON.stringify({ success: true, orderId: paymentIntent.id, orderNumber }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Payment could not be processed.' }) };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Payment failed.' }) };
  }
};

async function sendOwnerNotification({ orderNumber, customerName, customerEmail, product, address, revenue }) {
  try {
    await resend.emails.send({
      from: 'Master Cove <onboarding@resend.dev>',
      to: 'mastercovestore@gmail.com',
      subject: '🛋️ New Order ' + orderNumber + ' — $' + revenue,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:6px;">
          <h2 style="color:#1C1A17;font-family:Georgia,serif;font-weight:400;">New Order Received!</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;">
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;width:40%;">Order #</td><td style="padding:8px 0;font-weight:600;font-size:13px;border-bottom:1px solid #eee;">${orderNumber}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;">Customer</td><td style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;">${customerName} (${customerEmail})</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;">Item(s)</td><td style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;">${product}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;">Ship To</td><td style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;">${address}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;">Total</td><td style="padding:8px 0;font-weight:700;font-size:15px;color:#6B4C35;">$${revenue}</td></tr>
          </table>
          <div style="margin-top:24px;">
            <a href="https://mastercove.com/admin.html" style="background:#1C1A17;color:#fff;padding:11px 22px;border-radius:2px;text-decoration:none;font-size:13px;">View in Admin →</a>
          </div>
        </div>
      `
    });
    console.log('Owner notification sent');
  } catch (e) {
    console.error('Owner email error:', e.message);
  }
}

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
