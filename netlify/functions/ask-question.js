const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { name, email, question, product } = JSON.parse(event.body);
    if (!name || !email || !question) return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeQuestion = escapeHtml(question);
    const safeProduct = escapeHtml(product);

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"/>
      <style>
        body{font-family:'Helvetica Neue',Arial,sans-serif;background:#F0EBE3;margin:0;padding:0;}
        .wrap{max-width:560px;margin:40px auto;background:#FDFBF8;border:1px solid #DDD5C8;border-radius:6px;overflow:hidden;}
        .header{background:#1C1A17;padding:24px 32px;text-align:center;}
        .header img{height:48px;object-fit:contain;}
        .body{padding:32px;}
        h2{font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1C1A17;margin-bottom:16px;}
        p{font-size:14px;color:#5C5750;line-height:1.7;margin:0 0 14px;}
        .order-box{background:#F5EFE6;border-radius:4px;padding:16px 20px;margin:20px 0;}
        .order-box table{width:100%;border-collapse:collapse;}
        .order-box td{padding:6px 0;font-size:13px;border-bottom:1px solid #DDD5C8;vertical-align:top;}
        .order-box tr:last-child td{border-bottom:none;}
        .order-box td:first-child{color:#A8A09A;width:32%;}
        .order-box td:last-child{font-weight:500;color:#1C1A17;}
        .question-box{background:#FBF4E8;border-left:3px solid #B8895A;border-radius:2px;padding:14px 18px;margin:20px 0;font-size:14px;color:#1C1A17;line-height:1.7;white-space:pre-wrap;}
        .footer{background:#F5EFE6;padding:20px 32px;text-align:center;border-top:1px solid #DDD5C8;}
        .footer p{font-size:12px;color:#A8A09A;margin:0;}
        .footer a{color:#6B4C35;text-decoration:none;}
      </style>
      </head>
      <body>
        <div class="wrap">
          <div class="header">
            <img src="https://slaffkwfwmudvernzjua.supabase.co/storage/v1/object/public/product-images/logo.png" alt="Master Cove"/>
          </div>
          <div class="body">
            <h2>New Question from the FAQ Page</h2>
            <div class="order-box">
              <table>
                <tr><td>Name</td><td>${safeName}</td></tr>
                <tr><td>Email</td><td>${safeEmail}</td></tr>
                ${safeProduct ? `<tr><td>Product</td><td>${safeProduct}</td></tr>` : ''}
              </table>
            </div>
            <p style="margin-bottom:8px;font-weight:500;color:#1C1A17;">Question:</p>
            <div class="question-box">${safeQuestion}</div>
            <p style="margin-top:20px;font-size:12.5px;color:#A8A09A;">Reply directly to this email to respond to ${safeName}.</p>
          </div>
          <div class="footer">
            <p>Master Cove LLC · Brooklyn, NY</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: 'Master Cove <onboarding@resend.dev>',
      to: 'mastercovestore@gmail.com',
      replyTo: email,
      subject: 'New FAQ Question from ' + name + (product ? ' — re: ' + product : ''),
      html: html
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('Ask question error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
  }
};
