const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

// ---------------------------------------------------------------------------
// SERVER-SIDE PRICING
// Never trust prices sent from the browser. Look every item up in Supabase
// and work out the real subtotal, shipping, tax and total here.
// Mirrors the rules used on the site:
//   - size-mode products: price of the chosen top size (or base price)
//   - finish-mode products: price of the chosen size inside the finish (or base price)
//   - shipping: the highest shipping_cost of any item in the cart
//   - tax: 8.875% of subtotal for New York orders only
// ---------------------------------------------------------------------------
const NY_TAX_RATE = 0.08875;
const NY_STATE_NAMES = ['NY', 'NEW YORK'];

function norm(s) { return String(s || '').trim().toLowerCase(); }
function toCents(n) { return Math.round((Number(n) || 0) * 100); }

function findUnitPrice(p, item) {
  const base = Number(p.price) || 0;
  const wantSize = norm(item.size);
  const topSizes = Array.isArray(p.top_sizes) ? p.top_sizes : [];

  if (p.variant_mode === 'size' && topSizes.length) {
    const sz = topSizes.find(s => String(s.name || '') === String(item.size || ''))
            || topSizes.find(s => norm(s.name) === wantSize);
    if (!sz) return null; // size-mode product must have a real size chosen
    return Number(sz.price) > 0 ? Number(sz.price) : base;
  }

  const finishes = (Array.isArray(p.finishes) ? p.finishes : []).filter(f => f && typeof f === 'object');
  if (!wantSize) return base;
  const anySizes = finishes.some(f => Array.isArray(f.sizes) && f.sizes.length);
  if (!anySizes) return base;

  const wantFinish = norm(item.finish);
  const finishName = f => norm(f.name) || 'default';
  const ordered = finishes.filter(f => finishName(f) === (wantFinish || 'default'))
    .concat(finishes.filter(f => finishName(f) !== (wantFinish || 'default')));
  for (const f of ordered) {
    const sz = (f.sizes || []).find(s => String(s.name || '') === String(item.size || ''))
            || (f.sizes || []).find(s => norm(s.name) === wantSize);
    if (sz) return Number(sz.price) > 0 ? Number(sz.price) : base;
  }
  return null; // size doesn't exist on this product
}

async function priceCart(supabase, items, state) {
  if (!Array.isArray(items) || !items.length) return { error: 'Your cart is empty.' };
  if (items.length > 50) return { error: 'Too many items in cart.' };

  const ids = [...new Set(items.map(i => i && i.id).filter(id => id !== undefined && id !== null))];
  const { data: products, error } = await supabase
    .from('products')
    .select('id,name,price,shipping_cost,status,finishes,top_sizes,variant_mode,supplier_link')
    .in('id', ids);
  if (error) return { error: 'Could not verify prices. Please try again.' };

  const byId = {};
  (products || []).forEach(p => { byId[String(p.id)] = p; });

  let subCents = 0, shipCents = 0;
  const verifiedItems = [];
  const updatedItems = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx] || {};
    const p = byId[String(item.id)];
    const label = (p && p.name) || item.name || 'An item';
    if (!p || p.status !== 'active') {
      return { error: label + ' is no longer available. Please remove it from your cart.' };
    }
    const qty = parseInt(item.qty || item.quantity || 1, 10);
    if (!(qty >= 1 && qty <= 50)) return { error: 'Invalid quantity for ' + label + '.' };

    const unit = findUnitPrice(p, item);
    if (unit === null || unit <= 0) {
      return { error: label + ' — that option is no longer available. Please remove it and add it again.' };
    }
    const shipping = Number(p.shipping_cost) || 0;

    subCents += toCents(unit) * qty;
    shipCents = Math.max(shipCents, toCents(shipping));

    if (toCents(item.price) !== toCents(unit) || toCents(item.shipping) !== toCents(shipping)) {
      updatedItems.push({ index: idx, price: unit, shipping: shipping });
    }

    verifiedItems.push({
      id: p.id,
      name: p.name,
      finish: String(item.finish || ''),
      fabric: String(item.fabric || ''),
      size: String(item.size || ''),
      qty: qty,
      price: unit,
      supplierLink: p.supplier_link || ''
    });
  }

  const isNY = NY_STATE_NAMES.indexOf(String(state || '').trim().toUpperCase()) >= 0;
  const taxCents = isNY ? Math.round(subCents * NY_TAX_RATE) : 0;
  const totalCents = subCents + shipCents + taxCents;

  return { totalCents, subCents, shipCents, taxCents, verifiedItems, updatedItems };
}
// ---------------------------------------------------------------------------


// Called by checkout.html ONLY after a card required 3D Secure verification
// (stripe.confirmCardPayment succeeded client-side). create-payment.js already
// handles the normal, no-verification path — this function exists to finish
// the job for the 3D Secure path, which never reaches that code.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body);
    const { paymentIntentId, email, name, address, city, state, zip } = body;
    if (!paymentIntentId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing payment reference.' }) };

    // Never trust the client's word that payment succeeded — verify with Stripe directly.
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Payment has not completed yet.' }) };
    }

    // Idempotency: if this payment was already recorded (e.g. a retried request),
    // return the existing order instead of creating a duplicate.
    const { data: existing } = await supabase
      .from('orders')
      .select('order_number')
      .eq('stripe_id', paymentIntentId)
      .limit(1);
    if (existing && existing.length) {
      return { statusCode: 200, body: JSON.stringify({ success: true, orderNumber: existing[0].order_number }) };
    }

    // Always record what Stripe actually charged — never the number the browser sent.
    const effectiveAmount = intent.amount;
    let items = body.items;
    const priced = await priceCart(supabase, body.items, state);
    if (!priced.error) {
      items = priced.verifiedItems; // real product names + supplier links from Supabase
      if (Math.abs(priced.totalCents - intent.amount) > 1) {
        console.warn('Amount mismatch on ' + paymentIntentId + ': charged ' + intent.amount + ', expected ' + priced.totalCents);
      }
    }
    const revenue = (Math.round(effectiveAmount) / 100).toFixed(2);
    const orderNumber = await saveOrder({ email, name, address, city, state, zip, items, amount: effectiveAmount, stripeId: paymentIntentId });
    const fullAddress = address + ', ' + city + ', ' + state + ' ' + zip;
    await sendOwnerNotification({ orderNumber, customerName: name, customerEmail: email, items, address: fullAddress, revenue });

    return { statusCode: 200, body: JSON.stringify({ success: true, orderNumber }) };
  } catch (err) {
    console.error('Confirm-order error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message || 'Could not finalize order.' }) };
  }
};

async function sendOwnerNotification({ orderNumber, customerName, customerEmail, items, address, revenue }) {
  try {
    const itemRows = (items || []).map(function(i) {
      var variantParts = []; if (i.finish) variantParts.push(i.finish); if (i.fabric) variantParts.push(i.fabric); var label = i.name + (variantParts.length ? ' (' + variantParts.join(' / ') + ')' : '');
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
      return i.name + (qty > 1 ? ' x' + qty : '');
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
      variant: (function(){ var f=items&&items[0]; if(!f)return ''; var vp=[]; if(f.finish)vp.push(f.finish); if(f.fabric)vp.push(f.fabric); return vp.join(' / '); })(),
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
