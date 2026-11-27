const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

// Email signup popup (index.html + product-detail.html).
// Saves the email in the Supabase table "subscribers" and emails the welcome code.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const WELCOME_CODE = 'WELCOME10';
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---- Bot protection ----
// Bots were posting straight to this function (Nov 2026), signing up hundreds of real people's
// addresses who never visited the site. A real sign-up comes from the popup, which sends:
//   hp  - a hidden field people can't see (must be empty)
//   t   - milliseconds the popup was open before submitting (people take a few seconds)
//   k   - a small token the popup computes from t
// Anything that fails is answered with a normal "ok" (so bots don't adapt) but is NOT saved
// and gets NO email. Blocked attempts are logged in the table blocked_signups.
const JUNK_DOMAINS = /\.(de|ru|cn|jp|nl|fr|se|uk|ua|pl|it|es|at|ch|br|in|kr|tw|by|kz|cz|hu|ro|be|dk|no|fi|pt|gr|tr|il|au|nz|za|mx|ar|vn|id|ph|my|sg|hk)$/;
const JUNK_EXACT = new Set(['qq.com','163.com','126.com','yandex.com','mail.com','vtext.com','tmomail.net','txt.att.net','messaging.sprintpcs.com','gmx.com','gmx.net','web.de']);
const STRICT_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MAX_PER_IP_PER_DAY = 2;
const MAX_TOTAL_PER_HOUR = 15;
const tokenFor = (t) => ((Number(t) * 7 + 1337) % 100003).toString(36);
const ipOf = (event) => {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim().slice(0, 64);
};

async function botReason(event, body, email) {
  if (body.hp) return 'honeypot';
  const t = Number(body.t);
  if (!Number.isFinite(t) || t < 2500) return 'too fast / no popup timing';
  if (String(body.k || '') !== tokenFor(t)) return 'bad token';
  const dom = email.split('@')[1] || '';
  const local = email.split('@')[0] || '';
  if (!STRICT_EMAIL.test(email) || /\.\./.test(local) || /^\.|\.$/.test(local)) return 'invalid address';
  if ((dom === 'gmail.com' || dom === 'googlemail.com') && (local.match(/\./g) || []).length >= 3) return 'dotted gmail (bot pattern)';
  if (JUNK_DOMAINS.test(dom) || JUNK_EXACT.has(dom)) return 'junk domain';
  const ip = ipOf(event);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  if (ip) {
    const { count } = await supabase.from('subscribers').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', dayAgo);
    if ((count || 0) >= MAX_PER_IP_PER_DAY) return 'too many from this IP';
  }
  const { count: hourCount } = await supabase.from('subscribers').select('id', { count: 'exact', head: true }).gte('created_at', hourAgo);
  if ((hourCount || 0) >= MAX_TOTAL_PER_HOUR) return 'hourly limit';
  return null;
}

function welcomeEmail() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
  <body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F0EBE3;margin:0;padding:0;">
    <div style="max-width:560px;margin:40px auto;background:#FDFBF8;border:1px solid #DDD5C8;border-radius:6px;overflow:hidden;">
      <div style="background:#1C1A17;padding:24px 32px;text-align:center;">
        <img src="https://mastercove.com/android-chrome-512x512.png" alt="Master Cove" width="64" height="64" style="width:64px;height:64px;border-radius:8px;"/>
      </div>
      <div style="padding:32px;">
        <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1C1A17;margin:0 0 14px;">Welcome to Master Cove</h2>
        <p style="font-size:14px;color:#5C5750;line-height:1.7;margin:0 0 14px;">Thanks for joining us. Here's 10% off your first order — use this code at checkout:</p>
        <div style="background:#F5EFE6;border:1px dashed #B8895A;border-radius:4px;padding:18px;text-align:center;margin:22px 0;">
          <div style="font-size:26px;letter-spacing:4px;font-weight:600;color:#1C1A17;">${WELCOME_CODE}</div>
          <div style="font-size:12px;color:#A8A09A;margin-top:6px;">10% off · free shipping on most orders</div>
        </div>
        <p style="font-size:14px;color:#5C5750;line-height:1.7;margin:0 0 22px;">Every piece is chosen for real wood, honest materials and lasting build — delivered free to your door, with 30-day returns.</p>
        <div style="text-align:center;"><a href="https://mastercove.com/" style="display:inline-block;background:#1C1A17;color:#fff;text-decoration:none;padding:13px 28px;border-radius:2px;font-size:13px;letter-spacing:.05em;">Shop Now</a></div>
      </div>
      <div style="background:#F5EFE6;padding:18px 32px;text-align:center;border-top:1px solid #DDD5C8;">
        <p style="font-size:12px;color:#A8A09A;margin:0;">Questions? Reply to this email or call (347) 206-0372 · Master Cove LLC, Brooklyn, NY</p>
      </div>
    </div>
  </body></html>`;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const body = JSON.parse(event.body || '{}');
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) return json(400, { error: 'Please enter a valid email address.' });
    const source = String(body.source || 'popup').slice(0, 40);
    const page = String(body.page || '').slice(0, 300);
    const ip = ipOf(event);
    const ua = String((event.headers || {})['user-agent'] || '').slice(0, 300);

    const reason = await botReason(event, body, email);
    if (reason) {
      try { await supabase.from('blocked_signups').insert({ email, ip, ua, reason }); } catch (e) {}
      return json(200, { ok: true, code: WELCOME_CODE, already: false });
    }

    const { data: existing } = await supabase.from('subscribers').select('id').eq('email', email).maybeSingle();
    if (!existing) {
      const { error } = await supabase.from('subscribers').insert({ email, source, page, ip, ua });
      if (error && !/duplicate/i.test(error.message)) throw error;
      try {
        await resend.emails.send({
          from: 'Master Cove <orders@mastercove.com>',
          reply_to: 'mastercovestore@gmail.com',
          to: email,
          subject: 'Your 10% off code: ' + WELCOME_CODE,
          html: welcomeEmail()
        });
      } catch (e) { console.error('Welcome email failed:', e.message); }
    }
    return json(200, { ok: true, code: WELCOME_CODE, already: !!existing });
  } catch (err) {
    console.error('subscribe error:', err.message);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};
