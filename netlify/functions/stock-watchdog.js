// Stock watchdog: runs every morning (schedule in netlify.toml).
// Emails you if any supplier's stock check hasn't finished successfully recently, so no product
// goes more than 2 days without being checked:
//   Modway, HerNest, CB2, Crate & Barrel, Crate & Barrel Kids: a finished run in the last 48 hours
//   (a vendor with no products on the site is skipped)
//   Alpine: a finished run within the last 2 weekdays (Alpine's feed emails skip weekends)
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const OWNER_EMAIL = 'mastercovestore@gmail.com';
const HOUR = 3600 * 1000;

// Hours that count toward Alpine's limit: weekend hours (New York time) are skipped
function weekdayHoursSince(t) {
  let h = 0;
  for (let x = new Date(t).getTime(); x < Date.now(); x += HOUR) {
    const day = new Date(new Date(x).toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
    if (day !== 0 && day !== 6) h++;
  }
  return h;
}

const ok = (r) => r && r.finished_at && !/^(running|crashed)/i.test(r.summary || '') && !/nothing was changed/i.test(r.summary || '');

exports.handler = async function() {
  const suppliers = [
    { key: 'modway', name: 'Modway' },
    { key: 'hernest', name: 'HerNest' },
    { key: 'cb2', name: 'CB2', brand: b => b === 'CB2' },
    { key: 'cnb', name: 'Crate & Barrel', brand: b => b === 'Crate & Barrel' },
    { key: 'cbk', name: 'Crate & Barrel Kids', brand: b => /crate.*kids/i.test(b || '') },
    { key: 'alpine', name: 'Alpine / Origins', weekdays: true }
  ];
  const problems = [];
  const { data: brandRows } = await supabase.from('products').select('brand').in('status', ['active', 'draft']);
  const brands = (brandRows || []).map(r => r.brand);
  for (const s of suppliers) {
    if (s.brand && !brands.some(s.brand)) continue; // no products from this vendor
    const { data } = await supabase.from('stock_check_runs').select('started_at,finished_at,summary,details')
      .eq('supplier', s.key).order('started_at', { ascending: false }).limit(10);
    const last = (data || []).find(ok);
    if (!last) { problems.push(`${s.name}: no successful stock check found.`); continue; }
    const age = s.weekdays ? weekdayHoursSince(last.finished_at) : (Date.now() - new Date(last.finished_at)) / HOUR;
    if (age > 48) problems.push(`${s.name}: last successful check was ${new Date(last.finished_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}${s.weekdays ? ' (more than 2 weekdays ago — check that the feed emails are arriving)' : ''}.`);
    const fails = (data || []).filter(r => r.started_at > new Date(Date.now() - 48 * HOUR).toISOString() && !ok(r));
    if (fails.length) problems.push(`${s.name}: ${fails.length} run(s) in the last 2 days didn't finish properly: ${fails.map(r => (r.summary || '').slice(0, 120)).join(' | ')}`);
  }
  if (!problems.length) { console.log('All stock checks are current'); return { statusCode: 200, body: 'ok' }; }
  try {
    await resend.emails.send({
      from: 'Stock Watchdog <orders@mastercove.com>', to: OWNER_EMAIL,
      subject: 'Stock check overdue: ' + problems.length + ' issue(s)',
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;"><p>Some products may not have been checked against the supplier in the last 2 days:</p><ul>${problems.map(p => `<li>${p.replace(/</g, '&lt;')}</li>`).join('')}</ul></div>`
    });
  } catch (e) { console.error('Watchdog email failed:', e.message); }
  return { statusCode: 200, body: problems.join('\n') };
};
