const { Resend } = require('resend');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Promo email to the subscriber list (admin -> Subscribers -> "Promo email").
// Admin only (x-admin-password). Each call sends to at most 100 people who have not
// received this campaign yet and have not unsubscribed, and records them in campaign_sends,
// so pressing Send again never emails anyone twice. The admin page keeps calling until done.
// Body: { action: 'status' | 'test' | 'send', campaign, testTo }
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function isAdmin(event) {
  const h = event.headers || {};
  const pw = h['x-admin-password'] || h['X-Admin-Password'] || '';
  if (!pw || pw.length > 200) return false;
  const { data, error } = await supabase.rpc('verify_admin_password', { pw });
  return !error && data === true;
}

// Unsubscribe links are signed so nobody can unsubscribe other people.
const unsubToken = (email) => crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'mc').update('unsub:' + email).digest('hex').slice(0, 24);
const unsubUrl = (email) => 'https://mastercove.com/.netlify/functions/unsubscribe?e=' + encodeURIComponent(email) + '&t=' + unsubToken(email);

const CAMPAIGNS = {
  blackfriday10: {
    subject: 'Black Friday: 10% off orders of $2,000+, through Monday',
    html: (email) => {
      const shop = 'https://mastercove.com/?utm_source=email&utm_medium=newsletter&utm_campaign=blackfriday10';
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f6f1e9;">
<div style="display:none;max-height:0;overflow:hidden;">Our Black Friday sale is on: 10% off orders of $2,000 or more with code BLACKFRIDAY10, through Cyber Monday.</div>
<div style="background:#f6f1e9;padding:24px 0;font-family:Helvetica,Arial,sans-serif;color:#2b2b2b;">
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;margin:0 auto;">
<tr><td><a href="${shop}"><img src="https://mastercove.com/email/blackfriday-10.jpg" alt="Black Friday: 10% off orders of $2,000 or more. Use code BLACKFRIDAY10" width="600" style="display:block;width:100%;height:auto;border:0;"></a></td></tr>
<tr><td style="padding:32px 36px 8px;font-size:16px;line-height:1.6;">
<p style="margin:0 0 14px;">Our Black Friday sale is here.</p>
<p style="margin:0 0 14px;">From now through Cyber Monday, take <b>10% off any order of $2,000 or more</b>, on every solid wood piece on the site: dressers, beds, dining tables, sideboards, media consoles, desks and more. It's a good moment to finish a room or furnish a whole one.</p>
<p style="margin:0 0 22px;">Use code <b style="letter-spacing:1px;color:#8a6a2f;">BLACKFRIDAY10</b> at checkout. Hurry, the sale ends <b>Monday, November 30 at midnight ET</b>.</p>
</td></tr>
<tr><td align="center" style="padding:0 36px 30px;"><a href="${shop}" style="display:inline-block;background:#1f2330;color:#f3ead9;text-decoration:none;font-size:14px;letter-spacing:2px;padding:15px 34px;">SHOP THE SALE</a></td></tr>
<tr><td style="padding:0 36px 30px;font-size:14px;line-height:1.6;color:#555;">Questions about a piece? Just reply to this email, we're happy to help.<br><br>Master Cove<br><a href="https://mastercove.com" style="color:#8a6a2f;">mastercove.com</a></td></tr>
<tr><td style="padding:16px 36px 22px;border-top:1px solid #eee;font-size:11.5px;line-height:1.5;color:#999;">10% off the product subtotal on orders of $2,000 or more. Ends November 30, 2026 at 11:59 pm ET. Can't be combined with other codes.<br><br>You're receiving this because you signed up at mastercove.com. Master Cove LLC, Brooklyn, NY.<br><a href="${unsubUrl(email)}" style="color:#999;">Unsubscribe</a></td></tr>
</table></div></body></html>`;
    },
    text: (email) => `Black Friday at Master Cove: 10% off orders of $2,000 or more. Use code BLACKFRIDAY10 at checkout.

From now through Cyber Monday, take 10% off any order of $2,000 or more, on every solid wood piece on the site. The sale ends Monday, November 30 at midnight ET.

Shop the sale: https://mastercove.com/?utm_source=email&utm_medium=newsletter&utm_campaign=blackfriday10

10% off the product subtotal on orders of $2,000 or more. Can't be combined with other codes.

Master Cove LLC, Brooklyn, NY
Unsubscribe: ${unsubUrl(email)}`
  },
  complete5: {
    subject: 'A little thank-you: 5% off your next piece',
    html: (email) => {
      const shop = 'https://mastercove.com/?utm_source=email&utm_medium=newsletter&utm_campaign=complete5';
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f6f1e9;">
<div style="background:#f6f1e9;padding:24px 0;font-family:Helvetica,Arial,sans-serif;color:#2b2b2b;">
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;margin:0 auto;">
<tr><td><a href="${shop}"><img src="https://mastercove.com/email/promo-5off.jpg" alt="5% off your next piece. Use code COMPLETE5" width="600" style="display:block;width:100%;height:auto;border:0;"></a></td></tr>
<tr><td style="padding:32px 36px 8px;font-size:16px;line-height:1.6;">
<p style="margin:0 0 14px;">Thank you for being part of Master Cove.</p>
<p style="margin:0 0 14px;">We've just added new solid wood pieces, including TV consoles, sideboards, dressers and full bedroom collections, and every order ships free to your door.</p>
<p style="margin:0 0 22px;">As a thank-you, take <b>5% off your next piece</b> with code <b style="letter-spacing:1px;color:#8a6a2f;">COMPLETE5</b> at checkout.</p>
</td></tr>
<tr><td align="center" style="padding:0 36px 30px;"><a href="${shop}" style="display:inline-block;background:#1f2330;color:#f3ead9;text-decoration:none;font-size:14px;letter-spacing:2px;padding:15px 34px;">SHOP NOW</a></td></tr>
<tr><td style="padding:0 36px 30px;font-size:14px;line-height:1.6;color:#555;">Questions? Just reply to this email, we're happy to help.<br><br>Master Cove<br><a href="https://mastercove.com" style="color:#8a6a2f;">mastercove.com</a></td></tr>
<tr><td style="padding:16px 36px 22px;border-top:1px solid #eee;font-size:11.5px;line-height:1.5;color:#999;">You're receiving this because you signed up at mastercove.com. Master Cove LLC, Brooklyn, NY.<br><a href="${unsubUrl(email)}" style="color:#999;">Unsubscribe</a></td></tr>
</table></div></body></html>`;
    },
    text: (email) => `5% off your next piece. Use code COMPLETE5 at checkout.

Thank you for being part of Master Cove. We've just added new solid wood pieces, including TV consoles, sideboards, dressers and full bedroom collections, and every order ships free to your door.

Shop now: https://mastercove.com/?utm_source=email&utm_medium=newsletter&utm_campaign=complete5

Master Cove LLC, Brooklyn, NY
Unsubscribe: ${unsubUrl(email)}`
  }
};

function message(c, to) {
  return {
    from: 'Master Cove <orders@mastercove.com>',
    reply_to: 'mastercovestore@gmail.com',
    to,
    subject: c.subject,
    html: c.html(to),
    text: c.text(to),
    headers: { 'List-Unsubscribe': '<' + unsubUrl(to) + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

async function pending(campaign) {
  const { data: subs, error } = await supabase.from('subscribers').select('email').is('unsubscribed_at', null).order('created_at');
  if (error) throw error;
  const { data: sent } = await supabase.from('campaign_sends').select('email').eq('campaign', campaign);
  const done = new Set((sent || []).map((r) => r.email));
  // Skip addresses the email service would reject (one bad address fails the whole batch).
  const valid = (e) => /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) && !/\.\.|^\.|\.@/.test(e);
  return [...new Set((subs || []).map((s) => String(s.email).trim().toLowerCase()))].filter((e) => valid(e) && !done.has(e));
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!(await isAdmin(event))) return json(401, { error: 'Not authorized.' });
  try {
    const body = JSON.parse(event.body || '{}');
    const campaign = String(body.campaign || 'complete5');
    const c = CAMPAIGNS[campaign];
    if (!c) return json(400, { error: 'Unknown campaign.' });

    if (body.action === 'status') {
      const left = await pending(campaign);
      const { count } = await supabase.from('campaign_sends').select('email', { count: 'exact', head: true }).eq('campaign', campaign);
      return json(200, { ok: true, sent: count || 0, remaining: left.length });
    }

    if (body.action === 'test') {
      const to = String(body.testTo || 'mastercovestore@gmail.com').trim();
      const r = await resend.emails.send(message(c, to));
      if (r.error) throw new Error(r.error.message);
      return json(200, { ok: true, test: to });
    }

    if (body.action === 'send') {
      const left = await pending(campaign);
      const chunk = left.slice(0, 100);
      if (!chunk.length) return json(200, { ok: true, sentNow: 0, remaining: 0 });
      const r = await resend.batch.send(chunk.map((to) => message(c, to)));
      if (r.error) throw new Error(r.error.message);
      const ids = (r.data && (r.data.data || r.data)) || [];
      await supabase.from('campaign_sends').upsert(chunk.map((email, i) => ({ email, campaign, resend_id: (ids[i] && ids[i].id) || null })));
      return json(200, { ok: true, sentNow: chunk.length, remaining: left.length - chunk.length });
    }
    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('send-campaign error:', err.message);
    return json(500, { error: err.message });
  }
};


