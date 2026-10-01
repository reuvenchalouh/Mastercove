const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

// "Sarah Johnson" -> "Sarah J."
function displayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Verified Buyer';
  return parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : '');
}

const clean = (s, max) => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, max);

// Public review endpoint.
//  GET  ?product=ID  -> published reviews for a product (names shortened, no emails)
//  GET  ?t=TOKEN     -> what a customer can review (from their review-request email)
//  POST {token, reviews:[{product_id, rating, title, body}]}  -> save reviews
//  POST {token, stop:true} -> stop reminder emails
exports.handler = async function(event) {
  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};

      if (q.product) {
        const { data, error } = await supabase.from('reviews')
          .select('customer_name,rating,title,body,created_at')
          .eq('product_id', q.product).eq('status', 'published')
          .order('created_at', { ascending: false }).limit(50);
        if (error) throw error;
        return json(200, { reviews: (data || []).map(r => ({
          name: displayName(r.customer_name), rating: r.rating, title: r.title || '', body: r.body || '', date: r.created_at
        })) });
      }

      if (q.t) {
        const { data: reqRow } = await supabase.from('review_requests').select('*').eq('token', q.t).maybeSingle();
        if (!reqRow) return json(404, { error: 'This review link is not valid.' });
        if (reqRow.completed_at) return json(200, { done: true });
        const ids = Array.isArray(reqRow.product_ids) ? reqRow.product_ids : [];
        const { data: prods } = await supabase.from('products').select('id,name,img').in('id', ids.length ? ids : [-1]);
        return json(200, {
          firstName: String(reqRow.customer_name || '').split(' ')[0] || '',
          orderNumber: reqRow.order_number,
          products: (prods || []).map(p => ({ id: p.id, name: p.name, img: p.img || '' }))
        });
      }
      return json(400, { error: 'Missing parameters.' });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { data: reqRow } = await supabase.from('review_requests').select('*').eq('token', String(body.token || '')).maybeSingle();
      if (!reqRow) return json(404, { error: 'This review link is not valid.' });
      if (reqRow.completed_at) return json(200, { success: true, already: true });

      if (body.stop) {
        await supabase.from('review_requests').update({ completed_at: new Date().toISOString() }).eq('id', reqRow.id);
        return json(200, { success: true, stopped: true });
      }

      const allowed = (Array.isArray(reqRow.product_ids) ? reqRow.product_ids : []).map(String);
      const rows = (Array.isArray(body.reviews) ? body.reviews : [])
        .filter(r => r && allowed.indexOf(String(r.product_id)) !== -1)
        .map(r => ({ product_id: Number(r.product_id), rating: parseInt(r.rating, 10), title: clean(r.title, 120), body: clean(r.body, 3000) }))
        .filter(r => r.rating >= 1 && r.rating <= 5)
        .map(r => Object.assign(r, { order_number: reqRow.order_number, customer_name: reqRow.customer_name, status: 'published' }));
      if (!rows.length) return json(400, { error: 'Please choose a star rating for at least one item.' });

      const { error } = await supabase.from('reviews').insert(rows);
      if (error) throw error;
      await supabase.from('review_requests').update({ completed_at: new Date().toISOString() }).eq('id', reqRow.id);
      return json(200, { success: true, count: rows.length });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    console.error('Reviews error:', err.message);
    return json(400, { error: 'Something went wrong. Please try again.' });
  }
};
