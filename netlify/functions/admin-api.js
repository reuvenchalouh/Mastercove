const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Checks the admin password (sent by admin.html in the x-admin-password header)
// against the scrambled copy stored in Supabase. The real password is never in the code.
async function isAdmin(event) {
  const h = event.headers || {};
  const pw = h['x-admin-password'] || h['X-Admin-Password'] || '';
  if (!pw || pw.length > 200) return false;
  const { data, error } = await supabase.rpc('verify_admin_password', { pw });
  return !error && data === true;
}

const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Admin-only product management: everything admin.html used to do directly
// against Supabase with the public key now goes through here.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!(await isAdmin(event))) return json(401, { error: 'Not authorized.' });

  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action;

    if (action === 'login') return json(200, { success: true });

    if (action === 'products_list') {
      const { data, error } = await supabase.from('products').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return json(200, { data: data || [] });
    }

    if (action === 'products_upsert') {
      const rows = body.rows;
      if (!Array.isArray(rows) || !rows.length || rows.some(r => !r || r.id === undefined || r.id === null)) {
        return json(400, { error: 'Missing product data.' });
      }
      const { error } = await supabase.from('products').upsert(rows);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === 'products_delete') {
      if (body.id === undefined || body.id === null) return json(400, { error: 'Missing product id.' });
      const { error } = await supabase.from('products').delete().eq('id', body.id);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === 'upload_url') {
      // Gives admin.html a one-time permission slip to upload one photo.
      const path = String(body.path || '').replace(/[^A-Za-z0-9._-]/g, '');
      if (!path || path.length > 200) return json(400, { error: 'Bad file name.' });
      const { data, error } = await supabase.storage.from('product-images').createSignedUploadUrl(path);
      if (error) throw error;
      return json(200, { path: data.path, token: data.token });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('Admin-api error:', err.message);
    return json(400, { error: err.message || 'Something went wrong.' });
  }
};
