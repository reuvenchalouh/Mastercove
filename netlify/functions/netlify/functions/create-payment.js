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
      const revenue = (Math.round(amount) / 100).toFixed(2);
      const orderNumber = await saveOrder({ email, name, address, city, state, zip, items, amount, stripeId: paymentIntent.id });

      // Notify YOU (the store owner) of the new order
      await sendOwnerNotification({ orderNumber, customerName: name, customerEmail: email, items, address: fullAddress, revenue });

      return { statusCode: 200, body: JSON.stringify({ success: true, orderId: paymentIntent.id, orderNumber }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Payment could not be processed.' }) };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Payment failed.' }) };
  }
};

async function sendOwnerNotification({ orderNumber, customerName, customerEmail, items, address, revenue }) {
  try {
    // Build item rows with qty and supplier link
    const itemRows = (items || []).map(function(i) {
      var label = i.name + (i.finish ? ' (' + i.finish + ')' : '');
      var qty = i.qty || i.quantity || 1;
      var supplierLink = i.supplierLink || i.link || '';
      var linkHtml = supplierLink
        ? '<a href="' + supplierLink + '" style="background:#6B4C35;color:#fff;padding:3px 10px;border-radius:2px;text-decoration:none;font-size:12px;white-space:nowrap;">Buy from Supplier →</a>'
        : '<span style="color:#aaa;font-size:12px;">No link saved</span>';
      return '<tr>'
        + '<td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;">' + label + '</td>'
        + '<td style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;text-align:center;vertical-align:top;">x' + qty + '</td>'
        + '<td style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;vertical-align:top;">' + linkHtml + '</td>'
        + '</tr>';
    }).join('');

    await resend.emails.send({
      from: 'Master Cove <onboarding@resend.dev>',
      to: 'mastercovestore@gmail.com',
      subject: '🛋️ New Order ' + orderNumber + ' — $' + revenue,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:6px;">
          <h2 style="color:#1C1A17;font-family:Georgia,serif;font-weight:400;">New Order Received!</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:16px;">
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;width:30%;">Order #</td><td colspan="2" style="padding:8px 0;font-weight:600;font-size:13px;border-bottom:1px solid #eee;">${orderNumber}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;">Customer</td><td colspan="2" style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;">${customerName} (${customerEmail})</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;">Ship To</td><td colspan="2" style="padding:8px 0;font-size:13px;border-bottom:1px solid #eee;">${address}</td></tr>
            <tr><td style="padding:8px 0;color:#888;font-size:13px;border-bottom:1px solid #eee;">Total</td><td colspan="2" style="padding:8px 0;font-weight:700;font-size:15px;color:#6B4C35;border-bottom:1px solid #eee;">$${revenue}</td></tr>
          </table>
          <div style="margin-top:20px;">
            <div style="font-size:11px;color:#aaa;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">Items to Order</div>
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="text-align:left;font-size:11px;color:#aaa;padding:4px 0;border-bottom:1px solid #eee;">Product</th>
                  <th style="text-align:center;font-size:11px;color:#aaa;padding:4px 0;border-bottom:1px solid #eee;">Qty</th>
                  <th style="text-align:left;font-size:11px;color:#aaa;padding:4px 0;border-bottom:1px solid #eee;">Supplier</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
          </div>
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
    const productNames = (items || []).map(i => {
      var qty = i.qty || i.quantity || 1;
      return i.name + (i.finish ? ' (' + i.finish + ')' : '') + (qty > 1 ? ' x' + qty : '');
    }).join(', ');
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
      link: (items && items[0] && items[0].supplierLink) ? items[0].supplierLink : '',
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
