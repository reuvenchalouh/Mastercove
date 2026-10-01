const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = 'Master Cove <orders@mastercove.com>';
const REPLY_TO = 'mastercovestore@gmail.com';
const SITE = 'https://mastercove.com';

// Days after delivery to send each review request. Stops early once the customer leaves a review.
const SEND_ON_DAYS = [3, 7, 14];
const DAY = 24 * 60 * 60 * 1000;

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmail(req, productNames, n) {
  const first = escapeHtml(String(req.customer_name || '').split(' ')[0] || 'there');
  const items = productNames.length === 1 ? escapeHtml(productNames[0]) : 'your new furniture';
  const link = SITE + '/review.html?t=' + encodeURIComponent(req.token);
  const stop = link + '&stop=1';
  const copy = [
    { subject: 'How are you liking ' + (productNames.length === 1 ? productNames[0] : 'your new furniture') + '?',
      intro: `We hope ${items} has settled in nicely. Would you take a minute to tell other shoppers what you think? Honest reviews help small shops like ours more than anything.` },
    { subject: 'Quick favor? Share your thoughts on your Master Cove order',
      intro: `Just a friendly reminder — if you have a moment, we'd love to hear how ${items} is working out. It only takes about a minute.` },
    { subject: 'Last reminder: how is your Master Cove furniture?',
      intro: `This is our last note about it, we promise. If you have a minute to review ${items}, it would really help other shoppers — and us.` }
  ][n];
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;background:#F0EBE3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#FDFBF8;border:1px solid #DDD5C8;border-radius:6px;overflow:hidden;">
    <div style="background:#1C1A17;padding:22px 32px;text-align:center;">
      <img src="${SITE}/android-chrome-192x192.png" alt="Master Cove" style="height:46px;"/>
    </div>
    <div style="padding:32px;">
      <h2 style="font-family:Georgia,serif;font-size:23px;font-weight:400;color:#1C1A17;margin:0 0 16px;">Hi ${first},</h2>
      <p style="font-size:14px;color:#5C5750;line-height:1.7;margin:0 0 22px;">${copy.intro}</p>
      <div style="text-align:center;margin:26px 0;">
        <a href="${link}" style="display:inline-block;background:#6B4C35;color:#fff;text-decoration:none;padding:14px 30px;border-radius:3px;font-size:14px;letter-spacing:0.03em;">Leave a Review ★★★★★</a>
      </div>
      <p style="font-size:13px;color:#A8A09A;line-height:1.6;margin:0;">Order ${escapeHtml(req.order_number || '')}. Questions or a problem with your order? Just reply to this email — it comes straight to us.</p>
    </div>
    <div style="background:#F5EFE6;padding:18px 32px;text-align:center;border-top:1px solid #DDD5C8;">
      <p style="font-size:11.5px;color:#A8A09A;margin:0;">Master Cove LLC · Brooklyn, NY · <a href="${stop}" style="color:#A8A09A;">Stop review reminders</a></p>
    </div>
  </div>
</body></html>`;
  return { subject: copy.subject, html };
}

// Runs once a day (schedule set in netlify.toml).
exports.handler = async function() {
  const now = Date.now();
  const { data: open, error } = await supabase.from('review_requests')
    .select('*').is('completed_at', null).lt('emails_sent', SEND_ON_DAYS.length);
  if (error) { console.error('Load error:', error.message); return { statusCode: 500 }; }

  let sent = 0;
  for (const req of open || []) {
    const n = req.emails_sent || 0;
    const dueAt = new Date(req.delivered_at).getTime() + SEND_ON_DAYS[n] * DAY;
    if (now < dueAt) continue;
    if (req.last_sent_at && now - new Date(req.last_sent_at).getTime() < 2 * DAY) continue; // never send two close together

    const ids = Array.isArray(req.product_ids) ? req.product_ids : [];
    const { data: prods } = await supabase.from('products').select('name').in('id', ids.length ? ids : [-1]);
    const names = (prods || []).map(p => p.name);
    const email = buildEmail(req, names, n);
    try {
      await resend.emails.send({ from: FROM, to: req.email, reply_to: REPLY_TO, subject: email.subject, html: email.html });
      await supabase.from('review_requests').update({ emails_sent: n + 1, last_sent_at: new Date().toISOString() }).eq('id', req.id);
      sent++;
    } catch (e) {
      console.error('Send failed for', req.order_number, e.message);
    }
  }
  console.log('Review reminders sent:', sent);
  return { statusCode: 200, body: JSON.stringify({ sent }) };
};
