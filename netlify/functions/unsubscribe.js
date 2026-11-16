const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Unsubscribe link in promo emails: /.netlify/functions/unsubscribe?e=<email>&t=<token>
// GET shows a confirmation page; POST (Gmail/Apple "one-click unsubscribe") just records it.
// The token is signed (same secret as send-campaign.js) so links can't be forged for other people.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const unsubToken = (email) => crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'mc').update('unsub:' + email).digest('hex').slice(0, 24);

const page = (title, msg) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} | Master Cove</title></head>
<body style="margin:0;background:#F5EFE6;font-family:Helvetica,Arial,sans-serif;color:#1C1A17;">
<div style="max-width:480px;margin:80px auto;background:#FDFBF8;border:1px solid #DDD5C8;border-radius:6px;padding:36px;text-align:center;">
<img src="https://mastercove.com/android-chrome-192x192.png" alt="Master Cove" width="56" height="56" style="border-radius:50%;"/>
<h1 style="font-family:Georgia,serif;font-weight:400;font-size:24px;margin:18px 0 10px;">${title}</h1>
<p style="font-size:15px;line-height:1.6;color:#5C5750;margin:0 0 22px;">${msg}</p>
<a href="https://mastercove.com/" style="display:inline-block;background:#1C1A17;color:#fff;text-decoration:none;padding:12px 26px;font-size:13px;letter-spacing:.05em;">Back to Master Cove</a>
</div></body></html>`
});

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const email = String(q.e || '').trim().toLowerCase();
  const t = String(q.t || '');
  if (!email || t !== unsubToken(email)) return page('Link not valid', 'This unsubscribe link is not valid. Reply to any of our emails and we will remove you right away.');
  const { error } = await supabase.from('subscribers').update({ unsubscribed_at: new Date().toISOString() }).eq('email', email).is('unsubscribed_at', null);
  if (error) console.error('unsubscribe error:', error.message);
  if (event.httpMethod === 'POST') return { statusCode: 200, body: 'ok' };
  return page("You're unsubscribed", 'You will not get any more promotional emails from Master Cove. Order and shipping updates are not affected.');
};
