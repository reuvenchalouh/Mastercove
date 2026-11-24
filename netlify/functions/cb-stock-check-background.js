// CB2 / Crate & Barrel stock check (background function: can run up to 15 minutes).
// Started every morning by cb-stock-sync.js, or any time from admin with the admin password.
// Opens the supplier page of every CB2 / Crate & Barrel option on your products (active and draft),
// reads its availability line and marks the option in or out of stock:
//   "In stock" / "Arrives ..."                    -> in stock
//   "We'll contact you by <date> ..." (backorder) -> in stock if that date is under PREORDER_CUTOFF_DAYS away,
//                                                    otherwise out of stock (restock date saved)
//   "No longer available"                          -> out of stock
//   custom-order (made to order) options           -> stay in stock unless no longer available
// Owner locks (table stock_locks, key "cb:<sku>") always win. Logs the run (stock_check_runs,
// supplier 'cb') and emails a summary. If most pages can't be read, nothing is changed.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Settings ───────────────────────────────────────────────
const PREORDER_CUTOFF_DAYS = 30;  // same rule as Modway
const OWNER_EMAIL = 'mastercovestore@gmail.com';
const PARALLEL = 2;
const PAGE_TIMEOUT_MS = 15000;
const PAUSE_MS = 900;
const TIME_BUDGET_MS = 13 * 60 * 1000;
const MAX_FAILURE_RATE = 0.6;
// ────────────────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;

const SKU_RE = /(?:cb2\.com|crateandbarrel\.com)\/.*?\/?s(\d{5,7})(?:[/?#]|$)/i;
const isCB = (link) => typeof link === 'string' && SKU_RE.test(link);
const skuOf = (link) => (link.match(SKU_RE) || [])[1] || null;

function collectOptions(p) {
  const out = [];
  const label = (...parts) => parts.filter(Boolean).join(' / ');
  (p.finishes || []).forEach(f => {
    if (isCB(f.link)) out.push({ obj: f, link: f.link, label: label(f.name) });
    (f.fabrics || []).forEach(b => { if (isCB(b.link)) out.push({ obj: b, link: b.link, label: label(f.name !== 'Fabric Only' && f.name, b.name) }); });
  });
  (p.top_sizes || []).forEach(s => {
    let child = 0;
    (s.finishes || []).forEach(f => {
      if (isCB(f.link)) { child++; out.push({ obj: f, link: f.link, label: label(s.name, f.name) }); }
      (f.fabrics || []).forEach(b => { if (isCB(b.link)) { child++; out.push({ obj: b, link: b.link, label: label(s.name, f.name !== 'Fabric Only' && f.name, b.name) }); } });
    });
    if (!child && isCB(s.link)) out.push({ obj: s, link: s.link, label: label(s.name) });
  });
  return out;
}

// A parent (size / "Fabric Only" group) is out of stock only when every linked option under it is out.
function rollupStock(p) {
  const finOut = f => {
    const fabs = (f.fabrics || []).filter(b => b && typeof b === 'object');
    if (fabs.length && fabs.some(b => b.link)) f.outOfStock = fabs.every(b => b.outOfStock === true);
    return f.outOfStock === true;
  };
  (p.finishes || []).forEach(finOut);
  (p.top_sizes || []).forEach(s => {
    const fins = s.finishes || [];
    const outs = fins.map(finOut);
    if (fins.some(f => f.link || (f.fabrics || []).some(b => b.link))) s.outOfStock = outs.every(Boolean);
  });
}

// Decodes the JS string literal inside JSON.parse('...') on the product page
function unescapeJs(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (m, c) => {
    if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] || c;
  });
}

function readPage(html, sku) {
  let text = null;
  const i = html.indexOf('SingleProductPageContainer');
  if (i >= 0) {
    const a = html.indexOf("JSON.parse('", i);
    if (a >= 0) {
      const b = html.indexOf("')", a + 12);
      if (b > a) text = unescapeJs(html.slice(a + 12, b));
    }
  }
  if (!text) return null;
  // The page carries the chosen SKU's details; make sure it's the SKU we asked for
  const skuHit = new RegExp('"sku"\\s*:\\s*"?' + sku + '\\b').test(text);
  const m = text.match(/"availabilityMessage"\s*:\s*"([^"]*)"/);
  const nla = /"isNla"\s*:\s*true/.test(text);
  const custom = /"hasCustomOrderConfirmation"\s*:\s*true/.test(text);
  if (!m && !nla) return null;
  return { msg: m ? m[1].trim() : '', nla, custom, skuHit };
}

// "We'll contact you by Tue, Dec 29 to schedule delivery." -> Date (year inferred)
function contactDate(msg) {
  const m = String(msg).match(/by\s+(?:[A-Z][a-z]{2},\s*)?([A-Z][a-z]{2,8})\s+(\d{1,2})(?:,\s*(\d{4}))?/);
  if (!m) return null;
  const now = new Date();
  let y = m[3] ? +m[3] : now.getUTCFullYear();
  let d = new Date(m[1] + ' ' + m[2] + ', ' + y + ' UTC');
  if (isNaN(d)) return null;
  if (!m[3] && d.getTime() < now.getTime() - 60 * DAY) d = new Date(m[1] + ' ' + m[2] + ', ' + (y + 1) + ' UTC');
  return d;
}

function decide(s) {
  if (s.nla || /no longer available/i.test(s.msg)) return { out: true, why: 'No longer available' };
  if (s.custom) return { out: false };
  if (/in stock|arrives/i.test(s.msg)) return { out: false };
  const d = contactDate(s.msg);
  if (d) {
    const days = Math.ceil((d.getTime() - Date.now()) / DAY);
    const restock = d.toISOString().slice(0, 10);
    return days >= PREORDER_CUTOFF_DAYS
      ? { out: true, why: 'Backordered, delivery ' + restock, restock }
      : { out: false, restock };
  }
  return null; // unknown wording: leave alone
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function selectAll(cols) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from('products').select(cols).in('brand', ['CB2', 'Crate & Barrel']).order('id').range(from, from + 999);
    if (error) return { data: null, error };
    all = all.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return { data: all, error: null };
}

async function email(subject, html) {
  try { await resend.emails.send({ from: 'Stock Update <orders@mastercove.com>', to: OWNER_EMAIL, subject, html }); }
  catch (e) { console.error('Email failed:', e.message); }
}

const syncToken = () => crypto.createHash('sha256').update('cb-sync:' + (process.env.SUPABASE_SERVICE_KEY || '')).digest('hex');
async function isAllowed(event) {
  const h = (event && event.headers) || {};
  if ((h['x-sync-token'] || '') === syncToken()) return true;
  const pw = h['x-admin-password'] || '';
  if (!pw || pw.length > 200) return false;
  const { data, error } = await supabase.rpc('verify_admin_password', { pw });
  return !error && data === true;
}

exports.handler = async function(event) {
  if (!(await isAllowed(event))) return { statusCode: 401, body: 'Not authorized' };
  const { data: run } = await supabase.from('stock_check_runs').insert({ supplier: 'cb', mode: 'apply', summary: 'running' }).select('id').single();
  const runId = run && run.id;
  try {
    const res = await runSync();
    if (runId) await supabase.from('stock_check_runs').update({ finished_at: new Date().toISOString(), summary: res.body, details: res.details || null }).eq('id', runId);
    return { statusCode: res.statusCode, body: res.body };
  } catch (e) {
    console.error('CB sync crashed:', e);
    if (runId) await supabase.from('stock_check_runs').update({ finished_at: new Date().toISOString(), summary: 'crashed: ' + (e && e.message) }).eq('id', runId);
    await email('CB2 / Crate & Barrel stock check FAILED: nothing was changed', `<p>The check crashed: ${escapeHtml(e && e.message)}</p>`);
    return { statusCode: 500, body: 'crashed' };
  }
};

async function runSync() {
  const started = Date.now();
  const { data: products, error } = await selectAll('id,name,status,brand,finishes,top_sizes');
  if (error) throw new Error('Could not load products: ' + error.message);

  const options = [];
  for (const p of products) for (const o of collectOptions(p)) options.push({ ...o, sku: skuOf(o.link), product: p });
  const pages = {};
  for (const o of options) if (o.sku && !pages[o.sku]) pages[o.sku] = o.link.replace(/[?#].*$/, '');

  const { data: lockRows } = await supabase.from('stock_locks').select('supplier_pid,locked_out');
  const locks = Object.fromEntries((lockRows || []).filter(r => String(r.supplier_pid).startsWith('cb:')).map(r => [String(r.supplier_pid).slice(3), r.locked_out !== false]));

  // Resume where the last run stopped (in case a run ever runs out of time), failed pages first
  let keys = Object.keys(pages).sort();
  try {
    const { data: prev } = await supabase.from('stock_check_runs').select('details').eq('supplier', 'cb')
      .not('details', 'is', null).order('started_at', { ascending: false }).limit(1);
    const d = prev && prev[0] && prev[0].details;
    if (d && d.nextKey) { let off = keys.findIndex(k => k >= d.nextKey); if (off > 0) keys = keys.slice(off).concat(keys.slice(0, off)); }
    const retry = (d && Array.isArray(d.failedKeys) ? d.failedKeys : []).filter(k => k in pages);
    const rs = new Set(retry);
    keys = retry.concat(keys.filter(k => !rs.has(k)));
  } catch (e) { /* start from the top */ }

  const results = {}, attempted = new Set(), errorTypes = {};
  let i = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (i < keys.length && Date.now() < started + TIME_BUDGET_MS) {
      const k = keys[i++];
      attempted.add(k);
      try {
        const s = readPage(await fetchText(pages[k]), k);
        if (s) results[k] = s; else errorTypes['no availability on page'] = (errorTypes['no availability on page'] || 0) + 1;
      } catch (e) {
        const msg = (e && e.name === 'AbortError') ? 'timed out' : ((e && e.message) || 'error');
        errorTypes[msg] = (errorTypes[msg] || 0) + 1;
      }
      await sleep(PAUSE_MS);
    }
  }));
  const failedKeys = [...attempted].filter(k => !results[k]);
  const nextKey = keys.find(k => !attempted.has(k)) || null;
  const errText = Object.entries(errorTypes).map(([k, v]) => `${k}: ${v}`).join(', ');

  if (attempted.size && failedKeys.length / attempted.size > MAX_FAILURE_RATE) {
    const body = `Could not read ${failedKeys.length} of ${attempted.size} supplier pages (${errText}). Nothing was changed.`;
    await email('CB2 / Crate & Barrel stock check FAILED: nothing was changed', `<p>${escapeHtml(body)}</p>`);
    return { statusCode: 200, body, details: { errors: errorTypes, nextKey, failedKeys: failedKeys.slice(0, 500) } };
  }

  const changed = new Map(), wentOut = [], cameBack = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const o of options) {
    if (o.sku in locks) {
      const want = locks[o.sku];
      if ((o.obj.outOfStock === true) !== want) { o.obj.outOfStock = want; changed.set(o.product.id, o.product); (want ? wentOut : cameBack).push({ product: o.product.name, label: o.label, why: 'Locked by owner', status: o.product.status }); }
      continue;
    }
    const s = results[o.sku];
    const dec = s && decide(s);
    if (!dec) continue;
    const restock = dec.restock || null;
    if ((o.obj.restock || null) !== restock) { if (restock) o.obj.restock = restock; else delete o.obj.restock; changed.set(o.product.id, o.product); }
    const now = o.obj.outOfStock === true;
    if (dec.out !== now) {
      o.obj.outOfStock = dec.out;
      changed.set(o.product.id, o.product);
      (dec.out ? wentOut : cameBack).push({ product: o.product.name, label: o.label, why: dec.why || s.msg, status: o.product.status });
    }
    if (dec.out && !o.obj.outSince) { o.obj.outSince = today; changed.set(o.product.id, o.product); }
    if (!dec.out && o.obj.outSince) { delete o.obj.outSince; changed.set(o.product.id, o.product); }
  }
  for (const p of changed.values()) {
    rollupStock(p);
    const { error: upErr } = await supabase.from('products').update({ finishes: p.finishes, top_sizes: p.top_sizes }).eq('id', p.id);
    if (upErr) console.error('Update failed for', p.id, upErr.message);
  }

  const live = (l) => l.filter(x => x.status === 'active');
  if (live(wentOut).length || live(cameBack).length) {
    const rows = (l) => l.map(c => `<li>${escapeHtml(c.product)} — <b>${escapeHtml(c.label || 'default')}</b> <span style="color:#A8A09A;">(${escapeHtml(c.why || '')})</span></li>`).join('');
    await email(`CB2 / Crate & Barrel stock: ${live(wentOut).length} out, ${live(cameBack).length} back in`,
      `<div style="font-family:Arial,sans-serif;font-size:14px;">
        ${live(wentOut).length ? `<p><b>Marked OUT of stock:</b></p><ul>${rows(live(wentOut))}</ul>` : ''}
        ${live(cameBack).length ? `<p><b>Back IN stock:</b></p><ul>${rows(live(cameBack))}</ul>` : ''}
        ${failedKeys.length ? `<p style="color:#A8A09A;">${failedKeys.length} page(s) couldn't be read today and will be retried first next run.</p>` : ''}</div>`);
  }
  const summary = `Checked ${attempted.size - failedKeys.length} of ${keys.length} CB2 / Crate & Barrel pages (${failedKeys.length} failed${errText ? ': ' + errText : ''}). ${wentOut.length} marked out, ${cameBack.length} back in, ${changed.size} products updated.`;
  console.log(summary);
  return { statusCode: 200, body: summary, details: { errors: errorTypes, wentOut, cameBack, nextKey, failedKeys: failedKeys.slice(0, 500) } };
}
