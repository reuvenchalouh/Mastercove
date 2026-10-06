const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Called by checkout.html when a customer taps "Apply" on a promo code.
// Only tells the customer whether the code works; the real discount is
// re-checked and applied by create-payment.js at the moment of payment.
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

function todayNY() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const body = JSON.parse(event.body || '{}');
    const code = String(body.code || '').trim().toUpperCase();
    const subtotal = Number(body.subtotal) || 0;
    if (!code || code.length > 40) return json(200, { valid: false, error: 'Please enter a promo code.' });

    const { data, error } = await supabase.from('promo_codes').select('code,percent_off,min_order,expires_at,active').eq('code', code).maybeSingle();
    if (error || !data || !data.active) return json(200, { valid: false, error: "That promo code isn't valid." });
    if (data.expires_at && todayNY() > String(data.expires_at)) return json(200, { valid: false, error: 'That promo code has expired.' });
    const min = Number(data.min_order) || 0;
    if (subtotal < min) {
      return json(200, { valid: false, error: 'This code requires a minimum order of $' + min.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '.' });
    }
    return json(200, { valid: true, code: data.code, percent: Number(data.percent_off), minOrder: min });
  } catch (err) {
    console.error('validate-promo error:', err.message);
    return json(200, { valid: false, error: 'Could not check that code. Please try again.' });
  }
};
