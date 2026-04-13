const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
      return { statusCode: 200, body: JSON.stringify({ success: true, orderId: paymentIntent.id }) };
    }
    return { statusCode: 400, body: JSON.stringify({ error: 'Payment could not be processed.' }) };
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Payment failed.' }) };
  }
};
