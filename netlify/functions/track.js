const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Saves one anonymous visitor event from mc-track.js (page view, category, product view,
// add to cart, checkout, purchase, time on page) for the admin Dashboard.
// No IP address, name or email is stored — only the state/country Netlify detects.
const TYPES = new Set(['view', 'cat', 'product', 'cart', 'checkout', 'purchase', 'time']);
const BOT = /bot|crawl|spider|slurp|preview|lighthouse|headless|facebookexternalhit|pingdom|monitor/i;

const str = (v, n) => (v === undefined || v === null || v === '') ? null : String(v).slice(0, n);
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };

function geo(headers) {
  try {
    const raw = headers['x-nf-geo'];
    if (raw) {
      const g = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      return { country: str(g.country && g.country.code, 4), region: str(g.subdivision && g.subdivision.name, 60) };
    }
  } catch (e) {}
  return { country: str(headers['x-country'], 4), region: null };
}

exports.handler = async function (event) {
  const ok = { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const h = event.headers || {};
  if (BOT.test(h['user-agent'] || '')) return ok;
  try {
    if ((event.body || '').length > 4000) return ok;
    const d = JSON.parse(event.body || '{}');
    if (!TYPES.has(d.type)) return ok;
    const vid = str(d.vid, 40), sid = str(d.sid, 40);
    if (!vid || !sid || !/^[a-z0-9]+$/i.test(vid + sid)) return ok;
    const sec = d.type === 'time' ? Math.max(0, Math.min(1800, Math.round(num(d.sec) || 0))) : null;
    if (d.type === 'time' && !sec) return ok;
    const row = {
      vid, sid, type: d.type,
      path: str(d.path, 300),
      cat: str(d.cat, 60),
      product_id: num(d.product_id),
      product_name: str(d.product_name, 150),
      value: num(d.value),
      sec,
      ref: str(d.ref, 200),
      source: str(d.source, 40),
      device: str(d.device, 10)
    };
    if (d.type === 'view') Object.assign(row, geo(h));
    const { error } = await supabase.from('site_events').insert(row);
    if (error) console.error('track insert:', error.message);
  } catch (e) {
    console.error('track error:', e.message);
  }
  return ok;
};
