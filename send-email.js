const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { to, customerName, orderNumber, status, product, address, trackingNumber } = JSON.parse(event.body);
    if (!to || !status || !orderNumber) return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };

    const configs = {
      ordered: {
        subject: 'Your order has been placed with our supplier — ' + orderNumber,
        heading: 'Order Placed with Supplier!',
        message: `<p>Hi ${customerName},</p>
          <p>Great news! We've placed your order with our supplier and it's being prepared for shipment.</p>
          <p>We'll send you another update as soon as your item ships. This typically takes a few days.</p>`
      },
      shipped: {
        subject: 'Your Master Cove order is on its way! — ' + orderNumber,
        heading: 'Your Order Has Shipped! 🚛',
        message: `<p>Hi ${customerName},</p>
          <p>Your furniture is on its way!</p>
          ${trackingNumber ? `<p><strong>Tracking Number:</strong> ${trackingNumber}</p>` : ''}
          <p>You can expect white-glove delivery to your door. We'll be in touch to schedule a delivery window.</p>`
      },
      delivered: {
        subject: 'Your Master Cove order has been delivered — ' + orderNumber,
        heading: 'Order Delivered! 🎉',
        message: `<p>Hi ${customerName},</p>
          <p>Your order has been delivered! We hope you love your new furniture.</p>
          <p>If you have any questions or concerns about your order, don't hesitate to reach out — we're here to help.</p>`
      }
    };

    const config = configs[status];
    if (!config) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status' }) };

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
        .order-box td{padding:6px 0;font-size:13px;border-bottom:1px solid #DDD5C8;}
        .order-box tr:last-child td{border-bottom:none;}
        .order-box td:first-child{color:#A8A09A;width:40%;}
        .order-box td:last-child{font-weight:500;color:#1C1A17;}
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
            <h2>${config.heading}</h2>
            ${config.message}
            <div class="order-box">
              <table>
                <tr><td>Order Number</td><td>${orderNumber}</td></tr>
                ${product ? `<tr><td>Item(s)</td><td>${product}</td></tr>` : ''}
                ${address ? `<tr><td>Ship To</td><td>${address}</td></tr>` : ''}
                ${trackingNumber ? `<tr><td>Tracking #</td><td>${trackingNumber}</td></tr>` : ''}
              </table>
            </div>
          </div>
          <div class="footer">
            <p>Questions? <a href="mailto:mastercovestore@gmail.com">mastercovestore@gmail.com</a> · <a href="tel:+13472060372">(347) 206-0372</a></p>
            <p style="margin-top:8px;">Master Cove LLC · Brooklyn, NY</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: 'Master Cove <onboarding@resend.dev>',
      to: to,
      subject: config.subject,
      html: html
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('Email error:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
  }
};
