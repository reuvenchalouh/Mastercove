// Alpine / Origins by Alpine stock check (background function).
// Alpine emails an inventory file (CSV) every evening. A small Google Apps Script in the store's
// Gmail sends those files here (see alpine-gmail-script.gs). This function:
//   1. saves the inventory in table alpine_inventory,
//   2. marks every Alpine / Origins option on mastercove.com in or out of stock by its SKU,
//   3. logs the run (table stock_check_runs, supplier "alpine") and emails a summary.
// Rules (same as Modway): an option with a restock date within PREORDER_CUTOFF_DAYS stays in stock;
// owner locks (table stock_locks, key "al:<SKU>") always win; options out of stock for
// REMOVE_AFTER_DAYS are taken off the listing (copy kept in table removed_options).
// An option made of several pieces (SKUs separated by "+" or ",") is in stock only if every piece is.
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Settings ───────────────────────────────────────────────
const OWNER_EMAIL = 'mastercovestore@gmail.com';
const PREORDER_CUTOFF_DAYS = 30;  // restock within this many days: stays in stock
const REMOVE_AFTER_DAYS = 180;    // out of stock this long: taken off the listing
const MIN_FEED_ROWS = 50;         // a real Alpine feed has hundreds of SKUs
const MAX_NEW_OUT_RATE = 0.5;     // if more than half the in-stock options would go out at once, change nothing
// ────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const BRANDS = { alpine: /alpinefurniture\.(net|com)/i, origins: /originsbyalpine\.com/i };
const BRAND_NAME = { alpine: 'Alpine', origins: 'Origins' };

function brandOf(link) {
  if (typeof link !== 'string') return null;
  for (const b of Object.keys(BRANDS)) if (BRANDS[b].test(link)) return b;
  return null;
}
const normSku = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const skuParts = (s) => String(s || '').split(/[+,&]/).map(normSku).filter(Boolean);

// ── CSV ──
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur); if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}
// Reads one Alpine feed. Columns are found by name, so a reordered file still works.
function readFeed(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('empty file');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (re) => head.findIndex(h => re.test(h));
  const cSku = col(/product\s*#|sku|item/), cTot = col(/total/), cNext = col(/next.*date|available/),
        cDisc = col(/discontinued/), cRiv = col(/riverside/), cSfs = col(/santa fe/);
  if (cSku < 0 || cTot < 0) throw new Error('unexpected columns: ' + rows[0].join(', '));
  const out = {};
  for (const r of rows.slice(1)) {
    const sku = normSku(r[cSku]);
    if (!sku) continue;
    const num = (i) => (i < 0 ? null : (Number.isFinite(+r[i]) && String(r[i]).trim() !== '' ? Math.round(+r[i]) : null));
    out[sku] = {
      sku, total: num(cTot) || 0, qty_riverside: num(cRiv), qty_santafe: num(cSfs),
      next_date: cNext >= 0 ? parseDate(r[cNext]) : null,
      discontinued: cDisc >= 0 && /^y(es)?$|^true$|^1$/i.test(String(r[cDisc] || '').trim())
    };
  }
  return out;
}

// ── Options on a product that link to Alpine / Origins (same layout rules as the Modway check) ──
function collectOptions(p) {
  const out = [];
  const label = (...parts) => parts.filter(Boolean).join(' / ');
  const add = (obj, lbl) => { const b = brandOf(obj && obj.link); if (b && skuParts(obj.sku).length) out.push({ obj, brand: b, skus: skuParts(obj.sku), label: lbl }); };
  (p.finishes || []).forEach(f => {
    add(f, label(f.name));
    (f.sizes || []).forEach(sz => sz && add(sz, label(f.name, sz.name)));
    (f.fabrics || []).forEach(b => b && add(b, label(f.name !== 'Fabric Only' && f.name, b.name)));
  });
  (p.top_sizes || []).forEach(s => {
    let child = 0;
    (s.finishes || []).forEach(f => {
      if (brandOf(f.link)) { child++; add(f, label(s.name, f.name)); }
      (f.fabrics || []).forEach(b => { if (b && brandOf(b.link)) { child++; add(b, label(s.name, f.name !== 'Fabric Only' && f.name, b.name)); } });
    });
    if (!child) add(s, label(s.name));
  });
  return out;
}
// Linked options that have no SKU can't be checked: listed for the owner
function missingSku(p) {
  const out = [];
  const visit = (o, lbl) => { if (o && brandOf(o.link) && !skuParts(o.sku).length) out.push(lbl); };
  (p.finishes || []).forEach(f => { visit(f, f.name); (f.fabrics || []).forEach(b => visit(b, [f.name, b && b.name].filter(Boolean).join(' / '))); (f.sizes || []).forEach(z => visit(z, [f.name, z && z.name].filter(Boolean).join(' / '))); });
  (p.top_sizes || []).forEach(s => (s.finishes || []).forEach(f => { visit(f, [s.name, f.name].join(' / ')); (f.fabrics || []).forEach(b => visit(b, [s.name, f.name, b && b.name].filter(Boolean).join(' / '))); }));
  return out;
}
function rollupStock(p) {
  const hasLink = o => !!(o && o.link);
  const finOut = f => {
    const fabs = (f.fabrics || []).filter(b => b && typeof b === 'object');
    if (fabs.length && fabs.some(hasLink)) f.outOfStock = fabs.every(b => b.outOfStock === true);
    return f.outOfStock === true;
  };
  (p.finishes || []).forEach(finOut);
  (p.top_sizes || []).forEach(s => {
    const fins = (s.finishes || []).filter(f => f && typeof f === 'object');
    if (!fins.length) return;
    const linked = fins.some(f => hasLink(f) || (f.fabrics || []).some(hasLink));
    const outs = fins.map(finOut);
    if (linked) s.outOfStock = outs.every(Boolean);
  });
}
function pruneStale(p, staleSet) {
  const keepLeaf = (x) => !(x && staleSet.has(x));
  const pruneFinish = (f) => {
    if (!f || typeof f !== 'object') return f;
    if (staleSet.has(f)) return null;
    for (const k of ['fabrics', 'sizes']) {
      if (Array.isArray(f[k]) && f[k].length) { const kept = f[k].filter(keepLeaf); if (!kept.length) return null; f[k] = kept; }
    }
    return f;
  };
  if (Array.isArray(p.finishes)) p.finishes = p.finishes.map(pruneFinish).filter(Boolean);
  if (Array.isArray(p.top_sizes)) {
    p.top_sizes = p.top_sizes.map(s => {
      if (!s || typeof s !== 'object') return s;
      if (staleSet.has(s)) return null;
      if (Array.isArray(s.finishes) && s.finishes.length) { const kept = s.finishes.map(pruneFinish).filter(Boolean); if (!kept.length) return null; s.finishes = kept; }
      return s;
    }).filter(Boolean);
  }
}

// One SKU's verdict from the feed
function verdict(row, today) {
  if (!row) return null;
  if (row.total > 0) return { out: false };
  const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (row.next_date && row.next_date >= today) {
    const days = Math.ceil((Date.parse(row.next_date) - Date.parse(today)) / DAY);
    if (days < PREORDER_CUTOFF_DAYS) return { out: false, restock: row.next_date, why: 'Restock ' + fmt(row.next_date) };
    return { out: true, restock: row.next_date, why: 'Restock ' + fmt(row.next_date) };
  }
  return { out: true, why: row.discontinued ? 'Discontinued at Alpine' : 'Out of stock, no restock date' };
}

function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
async function email(subject, html) {
  try {
    await resend.emails.send({ from: 'Alpine Stock Update <orders@mastercove.com>', to: OWNER_EMAIL, subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1C1A17;max-width:600px;">${html}</div>` });
  } catch (e) { console.error('Email failed:', e.message); }
}
const rowsHtml = (list) => list.map(c => `<li style="margin:0 0 6px;">${escapeHtml(c.product)} — <b>${escapeHtml(c.label || 'default')}</b>${c.why ? ` <span style="color:#A8A09A;">(${escapeHtml(c.why)})</span>` : ''}</li>`).join('');

async function isAllowed(token) {
  if (!token || String(token).length > 200) return false;
  const { data, error } = await supabase.rpc('verify_feed_token', { p_name: 'alpine_feed', p_token: String(token) });
  return !error && data === true;
}

exports.handler = async function (event) {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Bad request' }; }
  if (!(await isAllowed(body.token))) return { statusCode: 401, body: 'Not authorized' };

  const { data: run } = await supabase.from('stock_check_runs').insert({ supplier: 'alpine', mode: 'apply', summary: 'running' }).select('id').single();
  const runId = run && run.id;
  const finish = async (summary, details) => { if (runId) await supabase.from('stock_check_runs').update({ finished_at: new Date().toISOString(), summary, details: details || null }).eq('id', runId); };
  try {
    const res = await runSync(body.feeds || []);
    await finish(res.summary, res.details);
    return { statusCode: 200, body: res.summary };
  } catch (e) {
    console.error('Alpine sync crashed:', e);
    await finish('crashed: ' + (e && e.message));
    await email('Alpine stock sync FAILED: nothing was changed', `<h2 style="font-family:Georgia,serif;font-weight:400;">Alpine stock check didn't run</h2><p>${escapeHtml(e && e.message)}</p><p>No products were changed.</p>`);
    return { statusCode: 500, body: 'crashed' };
  }
};

async function runSync(feeds) {
  const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10); // New York date
  // 1. Read the files
  const inv = { alpine: null, origins: null }; const feedNotes = [];
  for (const f of feeds) {
    const brand = f && f.brand === 'origins' ? 'origins' : (f && f.brand === 'alpine' ? 'alpine' : null);
    if (!brand) continue;
    let parsed;
    try { parsed = readFeed(f.csv); } catch (e) { feedNotes.push(`${BRAND_NAME[brand]} file unreadable (${e.message})`); continue; }
    const n = Object.keys(parsed).length;
    if (n < MIN_FEED_ROWS) { feedNotes.push(`${BRAND_NAME[brand]} file had only ${n} SKUs — ignored`); continue; }
    inv[brand] = parsed;
    feedNotes.push(`${BRAND_NAME[brand]}: ${n} SKUs (email ${f.date || 'today'})`);
    // Keep a copy (admin and future checks can look up any SKU)
    const rows = Object.values(parsed).map(r => ({ brand, ...r, feed_date: f.date || new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('alpine_inventory').upsert(rows.slice(i, i + 500));
      if (error) console.error('Inventory save failed:', error.message);
    }
  }
  if (!inv.alpine && !inv.origins) {
    const summary = 'Feed rejected: ' + (feedNotes.join('; ') || 'no inventory files received');
    await email('Alpine stock sync FAILED: nothing was changed', `<h2 style="font-family:Georgia,serif;font-weight:400;">Alpine stock check</h2><p>${escapeHtml(summary)}</p><p>No products were changed. Your site still shows the last known stock.</p>`);
    return { summary, details: { errors: { 'feed rejected': 1 } } };
  }

  // 2. Every Alpine / Origins option on the site
  const { data: products, error } = await supabase.from('products').select('id,name,status,finishes,top_sizes');
  if (error) throw new Error('Could not load products: ' + error.message);
  const options = [], noSku = [];
  for (const p of products || []) {
    for (const o of collectOptions(p)) options.push({ ...o, product: p });
    for (const lbl of missingSku(p)) noSku.push({ product: p.name, label: lbl, why: 'No SKU on this option — add the Alpine Product # so it can be checked' });
  }
  const { data: lockRows } = await supabase.from('stock_locks').select('supplier_pid,locked_out');
  const locks = Object.fromEntries((lockRows || []).filter(r => String(r.supplier_pid).startsWith('al:')).map(r => [normSku(String(r.supplier_pid).slice(3)), r.locked_out !== false]));

  // 2b. Alpine's nightly file only lists its warehouse stock. Items it leaves out are checked on
  //     the Alpine / Origins website instead (the product page says whether each SKU can be ordered).
  const webPages = new Map(); // link -> Promise<{ bySku, single }>
  const webPage = (link) => {
    if (!webPages.has(link)) webPages.set(link, (async () => {
      try {
        const u = new URL(link);
        const m = u.pathname.match(/\/products\/([^/?#]+)/);
        if (!m) return null;
        const r = await fetch(`${u.origin}/products/${m[1]}.js`, { headers: { 'User-Agent': 'Mozilla/5.0 (MasterCove stock check)' } });
        if (!r.ok) return { gone: r.status === 404 };
        const j = await r.json();
        const bySku = {};
        (j.variants || []).forEach(v => { if (v.sku) bySku[normSku(v.sku)] = !!v.available; });
        const vs = j.variants || [];
        return { bySku, single: vs.length === 1 ? !!vs[0].available : null };
      } catch (e) { return null; }
    })());
    return webPages.get(link);
  };
  const webVerdict = async (o, sku) => {
    const page = await webPage(o.obj.link);
    if (!page) return null;
    if (page.gone) return { out: true, why: 'Page removed from ' + BRAND_NAME[o.brand] + "'s website" };
    let ok = page.bySku[sku];
    if (ok === undefined && o.skus.length === 1 && page.single !== null) ok = page.single;
    if (ok === undefined) return null;
    return ok ? { out: false, web: true } : { out: true, web: true, why: 'Sold out on ' + BRAND_NAME[o.brand] + "'s website" };
  };

  // 3. Decide
  const decisions = [];
  const notInFeed = [];
  for (const o of options) {
    const lockKey = o.skus.join('+');
    if (lockKey in locks) { decisions.push({ o, out: locks[lockKey], why: 'Locked by owner', locked: true }); continue; }
    const feed = inv[o.brand];
    if (!feed) continue; // that brand's file didn't come today: leave alone
    const parts = o.skus.map(s => ({ s, v: verdict(feed[s], today) }));
    for (const x of parts) if (!x.v) x.v = await webVerdict(o, x.s);
    // A combo page (dresser + mirror) may list one combined SKU instead of each piece
    if (parts.some(x => !x.v) && o.skus.length > 1) {
      const page = await webPage(o.obj.link);
      if (page && page.single !== null) parts.forEach(x => { if (!x.v) x.v = page.single ? { out: false, web: true } : { out: true, web: true, why: 'Sold out on ' + BRAND_NAME[o.brand] + "'s website" }; });
    }
    const missing = parts.filter(x => !x.v).map(x => x.s);
    if (missing.length) { notInFeed.push({ product: o.product.name, label: o.label, why: 'SKU ' + missing.join(', ') + ' not in ' + BRAND_NAME[o.brand] + '\'s feed or on its website' }); continue; }
    const outPart = parts.find(x => x.v.out);
    const restocks = parts.map(x => x.v.restock).filter(Boolean).sort();
    decisions.push({ o, out: !!outPart, why: outPart ? (o.skus.length > 1 ? outPart.s + ': ' : '') + outPart.v.why : (parts.find(x => x.v.why) || {}).v?.why, restock: restocks.length ? restocks[restocks.length - 1] : null,
      discontinued: parts.some(x => feed[x.s] && feed[x.s].discontinued) });
  }
  // Safety: a broken file could mark everything out
  const wouldGoOut = decisions.filter(d => !d.locked && d.out && d.o.obj.outOfStock !== true).length;
  const inNow = decisions.filter(d => d.o.obj.outOfStock !== true).length;
  if (inNow >= 10 && wouldGoOut / inNow > MAX_NEW_OUT_RATE) {
    const summary = `ABORTED: ${wouldGoOut} of ${inNow} in-stock Alpine options would go out at once. Nothing changed. ${feedNotes.join('; ')}`;
    await email('Alpine stock sync FAILED: nothing was changed', `<p>${escapeHtml(summary)}</p><p>This usually means Alpine sent an incomplete file. Tomorrow's file will be checked as normal.</p>`);
    return { summary, details: { errors: { 'too many going out': wouldGoOut } } };
  }

  // 4. Apply
  const changed = new Map(), wentOut = [], cameBack = [], closeouts = [];
  for (const d of decisions) {
    const ob = d.o.obj, p = d.o.product;
    if (!d.locked) {
      if ((ob.restock || null) !== (d.restock || null)) { if (d.restock) ob.restock = d.restock; else delete ob.restock; changed.set(p.id, p); }
      if (d.discontinued && !d.out && p.status === 'active') closeouts.push({ product: p.name, label: d.o.label, why: 'Discontinued at Alpine — sells until stock runs out' });
    }
    if ((ob.outOfStock === true) !== d.out) {
      ob.outOfStock = d.out; changed.set(p.id, p);
      (d.out ? wentOut : cameBack).push({ product: p.name, label: d.o.label, why: d.why });
    }
    if (d.out && !ob.outSince) { ob.outSince = today; changed.set(p.id, p); }
    if (!d.out && ob.outSince) { delete ob.outSince; changed.set(p.id, p); }
  }

  // 5. Options out of stock for REMOVE_AFTER_DAYS (no restock coming) come off the listing
  const removed = [], review = [];
  const cutoff = new Date(Date.now() - REMOVE_AFTER_DAYS * DAY).toISOString().slice(0, 10);
  const stale = new Map();
  for (const d of decisions) {
    const ob = d.o.obj;
    if (d.locked || ob.outOfStock !== true || !ob.outSince || ob.outSince > cutoff) continue;
    if (ob.restock && ob.restock >= today) continue;
    if (!stale.has(d.o.product.id)) stale.set(d.o.product.id, { product: d.o.product, list: [] });
    stale.get(d.o.product.id).list.push(d.o);
  }
  for (const { product: p, list } of stale.values()) {
    const trial = JSON.parse(JSON.stringify({ finishes: p.finishes, top_sizes: p.top_sizes }));
    const all = collectOptions(p), idx = new Set(list.map(o => all.findIndex(x => x.obj === o.obj)));
    const trialOpts = collectOptions(trial);
    pruneStale(trial, new Set(trialOpts.filter((_, i) => idx.has(i)).map(x => x.obj)));
    if (!collectOptions(trial).length) { review.push({ product: p.name, label: 'all options', why: 'out of stock since ' + list.map(o => o.obj.outSince).sort()[0] }); continue; }
    const { error: arcErr } = await supabase.from('removed_options').insert(list.map(o => ({
      product_id: p.id, product_name: p.name, label: o.label, supplier_pid: 'al:' + o.skus.join('+'), out_since: o.obj.outSince, data: o.obj })));
    if (arcErr) { console.error('Archive failed for', p.id, arcErr.message); continue; }
    pruneStale(p, new Set(list.map(o => o.obj)));
    changed.set(p.id, p);
    list.forEach(o => removed.push({ product: p.name, label: o.label, why: 'out of stock since ' + o.obj.outSince }));
  }

  for (const p of changed.values()) {
    rollupStock(p);
    const { error: upErr } = await supabase.from('products').update({ finishes: p.finishes, top_sizes: p.top_sizes }).eq('id', p.id);
    if (upErr) console.error('Update failed for', p.id, upErr.message);
  }

  // 6. Email (only when something changed or needs attention)
  const attention = notInFeed.concat(noSku);
  if (wentOut.length || cameBack.length || closeouts.length || removed.length || review.length || attention.length) {
    await email(`Alpine stock: ${wentOut.length} out, ${cameBack.length} back in` + (removed.length ? `, ${removed.length} removed` : ''),
      `<h2 style="font-family:Georgia,serif;font-weight:400;">Alpine stock check</h2>
       ${wentOut.length ? `<p><b>Marked OUT of stock (${wentOut.length}):</b></p><ul>${rowsHtml(wentOut)}</ul>` : ''}
       ${cameBack.length ? `<p><b>Back IN stock (${cameBack.length}):</b></p><ul>${rowsHtml(cameBack)}</ul>` : ''}
       ${closeouts.length ? `<p><b>Discontinued by Alpine, still in stock (${closeouts.length}):</b></p><ul>${rowsHtml(closeouts)}</ul>` : ''}
       ${removed.length ? `<p><b>Removed after ${Math.round(REMOVE_AFTER_DAYS / 30)}+ months out of stock (${removed.length}):</b> a copy is saved in removed_options.</p><ul>${rowsHtml(removed)}</ul>` : ''}
       ${review.length ? `<p><b>Whole listing out of stock ${Math.round(REMOVE_AFTER_DAYS / 30)}+ months (${review.length}):</b> left for you to decide.</p><ul>${rowsHtml(review)}</ul>` : ''}
       ${attention.length ? `<p><b>Couldn't check (${attention.length}):</b> left unchanged.</p><ul>${rowsHtml(attention)}</ul>` : ''}
       <p style="color:#A8A09A;">${escapeHtml(feedNotes.join(' · '))}</p>`);
  }
  const summary = `Checked ${decisions.length} of ${options.length} Alpine options against ${feedNotes.join('; ')} (${webPages.size} product pages checked on the website for items not in the file). ${wentOut.length} marked out, ${cameBack.length} back in, ${closeouts.length} discontinued, ${removed.length} removed, ${attention.length} couldn't be checked, ${changed.size} products updated.`;
  console.log(summary);
  // "review" holds whole listings and options that couldn't be checked, so the admin shows them under "Needs your attention"
  return { summary, details: { errors: {}, wentOut, cameBack, closeouts, removed, review: review.concat(attention) } };
}

// For tests
exports._test = { readFeed, verdict, collectOptions, parseCsv };
