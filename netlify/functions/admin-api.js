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
      // One product (body.id), or one page (body.limit / body.offset). Netlify can't send back more
      // than 6 MB at once, and the whole catalog is bigger than that, so the admin loads it in pages.
      let q = supabase.from('products').select('*');
      if (body.id !== undefined && body.id !== null) q = q.eq('id', body.id);
      else {
        q = q.order('created_at', { ascending: false }).order('id', { ascending: false });
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 400);
        const offset = Math.max(parseInt(body.offset, 10) || 0, 0);
        q = q.range(offset, offset + limit - 1);
      }
      const { data, error } = await q;
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

    // ---- Dashboard: visitor stats from mc-track.js (site_events table) ----
    if (action === 'dashboard') {
      const from = new Date(body.from), to = new Date(body.to || Date.now());
      if (isNaN(from) || isNaN(to) || to <= from) return json(400, { error: 'Bad date range.' });
      const { data, error } = await supabase.rpc('admin_dashboard', { p_from: from.toISOString(), p_to: to.toISOString() });
      if (error) throw error;
      return json(200, { data: data || {} });
    }

    // ---- Supplier sync report: what the nightly stock checks changed ----
    if (action === 'sync_report') {
      const days = Math.min(Math.max(parseInt(body.days, 10) || 14, 1), 90);
      const { data, error } = await supabase.rpc('admin_sync_report', { p_days: days });
      if (error) throw error;
      return json(200, { data: data || {} });
    }

    // ---- Swatch library: one picture per vendor + fabric type + color ----
    // Products pick these up automatically when they're saved (database trigger).
    if (action === 'swatch_lib_list') {
      const { data, error } = await supabase.from('swatch_library').select('id,vendor,type,name,url,updated_at').order('type').order('name');
      if (error) throw error;
      return json(200, { data: data || [] });
    }

    if (action === 'swatch_lib_save') {
      const s = body.swatch || {};
      const vendor = String(s.vendor || '').trim(), type = String(s.type || '').trim(), name = String(s.name || '').trim(), url = String(s.url || '').trim();
      if (!vendor || !name) return json(400, { error: 'Vendor and color name are required.' });
      if (!/^https:\/\//.test(url) || url.length > 1000) return json(400, { error: 'Missing swatch picture.' });
      // Same vendor + type + color replaces the existing entry (matched without caring about capitals)
      const { data: rows, error: e1 } = await supabase.from('swatch_library').select('id,vendor,type,name');
      if (e1) throw e1;
      const k = (a, b, c) => [a, b, c].map((x) => String(x || '').trim().toLowerCase()).join('|');
      const hit = (rows || []).find((r) => k(r.vendor, r.type, r.name) === k(vendor, type, name));
      const row = { vendor, type, name, url, updated_at: new Date().toISOString() };
      const { error } = hit ? await supabase.from('swatch_library').update(row).eq('id', hit.id)
                            : await supabase.from('swatch_library').insert(row);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === 'swatch_lib_delete') {
      if (body.id === undefined || body.id === null) return json(400, { error: 'Missing swatch id.' });
      const { error } = await supabase.from('swatch_library').delete().eq('id', body.id);
      if (error) throw error;
      return json(200, { success: true });
    }

    // ---- Email subscribers (signup popup) ----
    if (action === 'subscribers_list') {
      const { data, error } = await supabase.from('subscribers').select('id,email,source,page,created_at').order('created_at', { ascending: false });
      if (error) throw error;
      return json(200, { data: data || [] });
    }

    if (action === 'subscribers_delete') {
      if (body.id === undefined || body.id === null) return json(400, { error: 'Missing subscriber id.' });
      const { error } = await supabase.from('subscribers').delete().eq('id', body.id);
      if (error) throw error;
      return json(200, { success: true });
    }

    // ---- Promo codes ----
    if (action === 'promo_list') {
      const { data, error } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return json(200, { data: data || [] });
    }

    if (action === 'promo_upsert') {
      const p = body.promo || {};
      const code = String(p.code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return json(400, { error: 'Code must be 2–40 letters or numbers (no spaces).' });
      const pct = Number(p.percent_off);
      if (!(pct > 0 && pct <= 90)) return json(400, { error: 'Percent off must be between 1 and 90.' });
      const min = Number(p.min_order) || 0;
      if (min < 0) return json(400, { error: 'Minimum order can\'t be negative.' });
      const exp = p.expires_at ? String(p.expires_at).slice(0, 10) : null;
      if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return json(400, { error: 'Bad expiration date.' });
      const row = { code, percent_off: pct, min_order: min, expires_at: exp, active: p.active !== false };
      const { error } = await supabase.from('promo_codes').upsert(row);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === 'promo_delete') {
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) return json(400, { error: 'Missing code.' });
      const { error } = await supabase.from('promo_codes').delete().eq('code', code);
      if (error) throw error;
      return json(200, { success: true });
    }


    // ---- Bulk edit from the Products list: publish / unpublish / change category ----
    if (action === 'products_bulk') {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => x !== null && x !== undefined) : [];
      if (!ids.length || ids.length > 2000) return json(400, { error: 'Pick 1 to 2000 products.' });
      const set = body.set || {};
      const upd = {};
      if (set.status !== undefined) {
        if (!['active', 'draft'].includes(set.status)) return json(400, { error: 'Bad status.' });
        upd.status = set.status;
      }
      if (set.cat !== undefined) {
        const cat = String(set.cat || '').trim();
        if (!/^[a-z]{2,30}$/.test(cat)) return json(400, { error: 'Bad category.' });
        upd.cat = cat;
      }
      if (!Object.keys(upd).length) return json(400, { error: 'Nothing to change.' });
      let changed = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('products').update(upd).in('id', ids.slice(i, i + 200)).select('id');
        if (error) throw error;
        changed += (data || []).length;
      }
      return json(200, { success: true, changed });
    }

    // ---- Site sale (popup + top bar), switched on/off from the Promo Codes page ----
    // Saved in sync_settings under 'site_sale'. Saving also keeps the matching promo code in step
    // (same percent, minimum, last day, and on/off), so the code works exactly while the sale runs.
    if (action === 'sale_get') {
      const { data, error } = await supabase.from('sync_settings').select('value,updated_at').eq('key', 'site_sale').maybeSingle();
      if (error) throw error;
      let sale = null;
      try { sale = data && data.value ? JSON.parse(data.value) : null; } catch (e) { sale = null; }
      return json(200, { data: sale, updated_at: data ? data.updated_at : null });
    }

    if (action === 'sale_set') {
      const s = body.sale || {};
      const code = String(s.code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return json(400, { error: 'Code must be 2–40 letters or numbers (no spaces).' });
      const pct = Number(s.percent);
      if (!(pct > 0 && pct <= 90)) return json(400, { error: 'Percent off must be between 1 and 90.' });
      const min = Math.max(0, Number(s.min) || 0);
      const start = String(s.start || '').slice(0, 10), end = String(s.end || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return json(400, { error: 'Pick a start and end date.' });
      if (end < start) return json(400, { error: 'The end date is before the start date.' });
      const clean = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
      const sale = { on: s.on === true, code, percent: pct, min, start, end, tag: clean(s.tag, 60) || 'Sale', sub: clean(s.sub, 200) };
      const { error } = await supabase.from('sync_settings').upsert({ key: 'site_sale', value: JSON.stringify(sale), updated_at: new Date().toISOString() });
      if (error) throw error;
      const { error: e2 } = await supabase.from('promo_codes').upsert({ code, percent_off: pct, min_order: min, expires_at: end, active: sale.on });
      if (e2) throw e2;
      return json(200, { success: true, data: sale });
    }

    // ---- Crate & Barrel / CB2 stock check through the owner's browser ("Check now" on Supplier Sync) ----
    const CB_HOSTS = ['www.crateandbarrel.com', 'www.cb2.com'];
    if (action === 'cb_prepare') {
      const out = {};
      for (const h of CB_HOSTS) {
        const { data, error } = await supabase.rpc('cb_chrome_prepare', { p_host: h });
        if (error) throw error;
        out[h] = data;
      }
      return json(200, { success: true, data: out });
    }

    if (action === 'cb_status') {
      const keys = CB_HOSTS.flatMap((h) => ['cb-skus-' + h, 'cb-res2-' + h]);
      const { data, error } = await supabase.from('al_stage').select('k,data,created_at').in('k', keys);
      if (error) throw error;
      const by = {};
      (data || []).forEach((r) => { by[r.k] = r; });
      const out = {};
      CB_HOSTS.forEach((h) => {
        const sk = by['cb-skus-' + h], rs = by['cb-res2-' + h];
        const total = sk && Array.isArray(sk.data) ? sk.data.length : 0;
        const done = rs && rs.data && typeof rs.data === 'object' ? Object.keys(rs.data).length : 0;
        out[h] = { total, done, ready: total > 0 && done >= total, at: rs ? rs.created_at : null };
      });
      return json(200, { data: out });
    }

    if (action === 'cb_apply') {
      const h = String(body.host || '');
      if (!CB_HOSTS.includes(h)) return json(400, { error: 'Bad site.' });
      const { data, error } = await supabase.rpc('cb_chrome_apply', { p_host: h });
      if (error) throw error;
      return json(200, { success: true, summary: data });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('Admin-api error:', err.message);
    return json(400, { error: err.message || 'Something went wrong.' });
  }
};
