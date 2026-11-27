const { createClient } = require('@supabase/supabase-js');

// Public: tells the site whether a sale is running right now (used by /mc-sale.js for the
// popup, the top bar and auto-applying the code at checkout). The sale is switched on/off
// and dated in admin -> Promo Codes -> Site Sale. Returns { sale: null } when nothing is running.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Midnight at the start of a New York calendar day, as a UTC timestamp (handles daylight saving).
function nyMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 5, 0, 0); // 05:00 UTC = midnight EST
  const hourInNY = Number(new Date(guess).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) % 24;
  return guess - hourInNY * 3600 * 1000;
}

exports.handler = async function () {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' };
  try {
    const { data } = await supabase.from('sync_settings').select('value').eq('key', 'site_sale').maybeSingle();
    let s = null;
    try { s = data && data.value ? JSON.parse(data.value) : null; } catch (e) { s = null; }
    if (!s || !s.on || !/^\d{4}-\d{2}-\d{2}$/.test(s.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.end || '')) {
      return { statusCode: 200, headers, body: JSON.stringify({ sale: null }) };
    }
    const start = nyMidnight(s.start);
    const endDay = new Date(Date.UTC(...s.end.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) + 86400000).toISOString().slice(0, 10);
    const end = nyMidnight(endDay); // midnight after the last sale day
    const now = Date.now();
    if (now < start || now >= end) return { statusCode: 200, headers, body: JSON.stringify({ sale: null }) };
    const sale = { code: s.code, percent: Number(s.percent), min: Number(s.min) || 0, start, end, lastDay: s.end, tag: s.tag || 'Sale', sub: s.sub || '' };
    return { statusCode: 200, headers, body: JSON.stringify({ sale }) };
  } catch (err) {
    console.error('sale-config error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ sale: null }) };
  }
};
