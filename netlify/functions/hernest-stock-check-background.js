// HerNest stock check (background function: can run up to 15 minutes).
// Started every morning by hernest-stock-sync.js, or any time from admin ("Check HerNest stock now").
//
// What it does:
//   1. Finds every finish / fabric / size on mastercove.com that links to a HerNest product page.
//   2. Opens each HerNest page (politely, a few at a time) and reads its stock signals.
//   3. Also reads HerNest's category pages: sold-out items disappear from those listings.
//   4. In "report" mode it only records what it saw (table stock_check_runs).
//      In "apply" mode it also marks options in/out of stock and emails a summary.
// The mode is stored in Supabase (sync_settings → hernest_mode), so it can be switched without a deploy.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Settings ───────────────────────────────────────────────
const OWNER_EMAIL = 'mastercovestore@gmail.com';
const BASE = 'https://www.hernest.com';
const PARALLEL = 3;            // pages checked at the same time
const PAUSE_MS = 400;          // pause between pages, per worker
const PAGE_TIMEOUT_MS = 12000; // give up on one page after 12 seconds
const TIME_BUDGET_MS = 13 * 60 * 1000; // background functions stop at 15 minutes
const MAX_FAILURE_RATE = 0.5;  // if more than half the pages fail, change nothing
const MAX_OUT_RATE = 0.5;      // if more than half come back sold out, assume something is wrong and change nothing
const WATCH_IDS = ['8742'];    // known sold-out item used to verify the signals (Casimir Side Table)
// Category pages that always get scanned (others are discovered from HerNest's menus)
const SEED_CATEGORIES = [
  'media-consoles-c-52', 'dining-tables-c-62', 'dining-chairs-c-61', 'coffee-tables-c-51',
  'sideboards-and-buffets-c-59', 'sofas-c-315', 'beds-c-1033', 'bathroom-vanities-c-1034',
  'sectional-sofas-c-320', 'end-and-side-tables-c-57', 'dressers-c-67'
];
// ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const syncToken = () => crypto.createHash('sha256').update('hernest-sync:' + (process.env.SUPABASE_SERVICE_KEY || '')).digest('hex');

async function isAllowed(event) {
  const h = event.headers || {};
  if ((h['x-sync-token'] || '') === syncToken()) return true;
  const pw = h['x-admin-password'] || h['X-Admin-Password'] || '';
  if (!pw || pw.length > 200) return false;
  const { data, error } = await supabase.rpc('verify_admin_password', { pw });
  return !error && data === true;
}

function isHernest(link) {
  return typeof link === 'string' && /hernest\.com\/(products|item)\/[^?#]*-p-\d+\.html/i.test(link);
}
function pidOf(link) {
  const m = String(link || '').match(/-p-(\d+)\.html/i);
  return m ? m[1] : null;
}

// Every finish / fabric / size with its own HerNest link. Keeps a reference so the flag can be flipped.
function collectOptions(p) {
  const out = [];
  const label = (...parts) => parts.filter(Boolean).join(' / ');
  (p.finishes || []).forEach(f => {
    if (isHernest(f.link)) out.push({ obj: f, link: f.link, label: label(f.name) });
    (f.sizes || []).forEach(sz => { if (sz && isHernest(sz.link)) out.push({ obj: sz, link: sz.link, label: label(f.name, sz.name) }); });
    (f.fabrics || []).forEach(b => { if (isHernest(b.link)) out.push({ obj: b, link: b.link, label: label(f.name !== 'Fabric Only' && f.name, b.name) }); });
  });
  (p.top_sizes || []).forEach(s => {
    let child = 0;
    (s.finishes || []).forEach(f => {
      if (isHernest(f.link)) { child++; out.push({ obj: f, link: f.link, label: label(s.name, f.name) }); }
      (f.fabrics || []).forEach(b => { if (isHernest(b.link)) { child++; out.push({ obj: b, link: b.link, label: label(s.name, f.name !== 'Fabric Only' && f.name, b.name) }); } });
    });
    if (!child && isHernest(s.link)) out.push({ obj: s, link: s.link, label: label(s.name) });
  });
  // Product with no linked options: use the product's supplier link for all its finishes
  if (!out.length && isHernest(p.supplier_link)) {
    (p.finishes || []).forEach(f => out.push({ obj: f, link: p.supplier_link, label: label(f.name) }));
  }
  return out;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const text = await r.text();
    if (r.status !== 200 && r.status !== 404 && r.status !== 410) throw new Error('HTTP ' + r.status);
    return { status: r.status, finalUrl: r.url || url, html: text };
  } finally {
    clearTimeout(t);
  }
}

function around(html, re, max, width) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(html)) && out.length < max) {
    const s = Math.max(0, m.index - width), e = Math.min(html.length, m.index + m[0].length + width);
    out.push(html.slice(s, e).replace(/\s+/g, ' '));
  }
  return out;
}

// Reads every stock-related signal from one HerNest product page
function readSignals(pid, page, detailed) {
  const html = page.html || '';
  const canon = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1] || '';
  const finalPid = pidOf(page.finalUrl);
  const canonPid = pidOf(canon);
  const title = ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim();
  const sig = {
    http: page.status,
    len: html.length,
    final: page.finalUrl,
    canonical: canon,
    title: title.slice(0, 120),
    // Sold-out HerNest links bounce to the homepage: no product ID left in the final URL or the canonical tag
    gone: page.status === 404 || page.status === 410 || !finalPid || (!!canon && !canonPid),
    // A real redirect to another product. (A canonical tag pointing at a sister listing is normal, so it's only noted.)
    otherProduct: !!(finalPid && finalPid !== pid),
    canonicalOther: !!(canonPid && canonPid !== pid),
    ld: [...html.matchAll(/schema\.org\/(InStock|OutOfStock|PreOrder|BackOrder|SoldOut|Discontinued|LimitedAvailability|InStoreOnly|OnlineOnly)/gi)].map(m => m[1]),
    meta: [...html.matchAll(/<meta[^>]+(?:product:availability|og:availability)[^>]+content=["']([^"']+)["']/gi)].map(m => m[1]),
    soldOutText: (html.match(/sold[\s-]*out/gi) || []).length,
    outOfStockText: (html.match(/out[\s-]*of[\s-]*stock/gi) || []).length,
    preorderText: (html.match(/pre[\s-]*order/gi) || []).length,
    notifyText: (html.match(/notify\s+me/gi) || []).length,
    stockNums: [...html.matchAll(/"(?:stock|stocks|quantity|qty|inventory|inventory_quantity|stockNum|stock_num|availableStock|available_stock)"\s*:\s*"?(-?\d+)/gi)].slice(0, 10).map(m => m[0]),
    flags: [...html.matchAll(/"(?:soldOut|sold_out|isSoldOut|is_sold_out|outOfStock|out_of_stock|available|isAvailable|in_stock|inStock)"\s*:\s*(true|false|0|1|"[^"]{0,20}")/gi)].slice(0, 10).map(m => m[0])
  };
  if (detailed) {
    sig.scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].slice(0, 10).map(m => m[1]);
    sig.apiPaths = [...new Set([...html.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s]*\/api\/[^"'`\s]{0,80}|\/api\/[^"'`\s]{1,80})["'`]/gi)].map(m => m[1]))].slice(0, 15);
    sig.snippets = around(html, /stock|inventory|sold.?out|availab/i, 6, 90);
  }
  return sig;
}

// Turns signals into a decision. null = not sure, leave it alone.
function decide(sig, inCategory) {
  if (!sig) return null;
  if (sig.gone) return { out: true, why: 'Link goes to HerNest homepage (sold out)' };
  if (sig.otherProduct) return { out: true, why: 'Link now opens a different HerNest product' };
  const ld = sig.ld.map(x => x.toLowerCase());
  if (ld.length && ld.every(x => /outofstock|soldout|discontinued/.test(x))) return { out: true, why: 'Marked sold out on HerNest page' };
  // The product page opened normally
  return { out: false, why: 'Product page is live on HerNest' };
}

async function runPool(items, worker, deadline) {
  let i = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (i < items.length && Date.now() < deadline) { const n = i++; await worker(items[n]); await sleep(PAUSE_MS); }
  }));
}

// Collects every product ID shown on HerNest's category pages
async function scanCategories(deadline) {
  const cats = new Set(SEED_CATEGORIES.map(c => BASE + '/category/' + c + '.html'));
  try {
    const home = await fetchPage(BASE + '/');
    for (const m of (home.html || '').matchAll(/\/category\/([a-z0-9-]+-c-\d+)\.html/gi)) cats.add(BASE + '/category/' + m[1] + '.html');
  } catch (e) { /* homepage optional */ }
  const listed = new Set();
  let ok = 0, failed = 0;
  await runPool([...cats], async (url) => {
    try {
      const pg = await fetchPage(url);
      if (pg.status !== 200) { failed++; return; }
      ok++;
      for (const m of (pg.html || '').matchAll(/-p-(\d+)\.html/gi)) listed.add(m[1]);
    } catch (e) { failed++; }
  }, deadline);
  return { listed, categories: cats.size, ok, failed };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function emailOwner(subject, bodyHtml) {
  try {
    await resend.emails.send({ from: 'Master Cove <orders@mastercove.com>', to: OWNER_EMAIL, subject, html:
      `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1C1A17;max-width:600px;">${bodyHtml}</div>` });
  } catch (e) { console.error('Email failed:', e.message); }
}

exports.handler = async function(event) {
  if (!(await isAllowed(event))) return { statusCode: 401, body: 'Not authorized' };
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const { data: setting } = await supabase.from('sync_settings').select('value').eq('key', 'hernest_mode').maybeSingle();
  const mode = (setting && setting.value) === 'apply' ? 'apply' : 'report';
  const { data: run } = await supabase.from('stock_check_runs').insert({ supplier: 'hernest', mode, summary: 'running' }).select('id').single();
  const runId = run && run.id;

  try {
    const { data: products, error } = await supabase.from('products').select('id,name,status,finishes,top_sizes,supplier_link');
    if (error) throw new Error('Could not load products: ' + error.message);

    const options = [];
    for (const p of products || []) for (const o of collectOptions(p)) {
      const pid = pidOf(o.link);
      if (pid) options.push({ ...o, pid, product: p });
    }
    const pages = {};
    for (const o of options) if (!pages[o.pid]) pages[o.pid] = o.link.replace(/[?#].*$/, '').replace('/item/', '/products/');

    // 1) category listings  2) each product page
    const cat = await scanCategories(started + 3 * 60 * 1000);
    const catUsable = cat.ok >= 5 && cat.listed.size >= 50;

    const pids = Object.keys(pages);
    const sigs = {};
    let failed = 0;
    const errors = {};
    let detailedCount = 0;
    await runPool(pids, async (pid) => {
      try {
        const detailed = WATCH_IDS.includes(pid) || detailedCount++ < 4;
        sigs[pid] = readSignals(pid, await fetchPage(pages[pid]), detailed);
      } catch (e) {
        failed++;
        const msg = (e && e.name === 'AbortError') ? 'timed out' : ((e && e.message) || 'error');
        errors[msg] = (errors[msg] || 0) + 1;
      }
    }, deadline);

    const checked = Object.keys(sigs).length + failed;
    const pagesOut = pids.map(pid => {
      const inCat = catUsable ? cat.listed.has(pid) : null;
      const d = decide(sigs[pid], inCat);
      return { pid, url: pages[pid], inCategory: inCat, verdict: d ? (d.out ? 'OUT' : 'IN') : '?', why: d && d.why, sig: sigs[pid] || null };
    });

    let applied = { wentOut: [], cameBack: [], updated: 0 };
    const outCount = pagesOut.filter(x => x.verdict === 'OUT').length;
    const judged = pagesOut.filter(x => x.verdict !== '?').length;
    const suspicious = judged >= 20 && outCount / judged > MAX_OUT_RATE;
    const tooManyFailures = (checked && failed / checked > MAX_FAILURE_RATE) || suspicious;
    if (mode === 'apply' && !tooManyFailures) {
      const byPid = Object.fromEntries(pagesOut.map(x => [x.pid, x]));
      const changed = new Map();
      for (const o of options) {
        const r = byPid[o.pid];
        if (!r || !r.sig || r.verdict === '?') continue;
        const out = r.verdict === 'OUT';
        if ((o.obj.outOfStock === true) !== out) {
          o.obj.outOfStock = out;
          changed.set(o.product.id, o.product);
          (out ? applied.wentOut : applied.cameBack).push({ product: o.product.name, label: o.label, why: r.why });
        }
      }
      for (const p of changed.values()) {
        const { error: upErr } = await supabase.from('products').update({ finishes: p.finishes, top_sizes: p.top_sizes }).eq('id', p.id);
        if (upErr) console.error('Update failed for', p.id, upErr.message); else applied.updated++;
      }
      if (applied.wentOut.length || applied.cameBack.length) {
        const rows = (list) => list.map(c => `<li style="margin:0 0 6px;">${escapeHtml(c.product)} — <b>${escapeHtml(c.label || 'default')}</b> <span style="color:#A8A09A;">(${escapeHtml(c.why)})</span></li>`).join('');
        await emailOwner(`HerNest stock: ${applied.wentOut.length} out, ${applied.cameBack.length} back in`,
          `<h2 style="font-family:Georgia,serif;font-weight:400;">HerNest stock check</h2>
           ${applied.wentOut.length ? `<p><b>Marked OUT of stock (${applied.wentOut.length}):</b></p><ul>${rows(applied.wentOut)}</ul>` : ''}
           ${applied.cameBack.length ? `<p><b>Back IN stock (${applied.cameBack.length}):</b></p><ul>${rows(applied.cameBack)}</ul>` : ''}`);
      }
    }
    if (tooManyFailures) {
      await emailOwner('HerNest stock check FAILED: nothing was changed',
        suspicious ? `<p>${outCount} of ${judged} HerNest pages looked sold out, which is unusually high, so nothing was changed. HerNest may be blocking the check or changed its site.</p>` :
        `<p>${failed} of ${checked} HerNest pages couldn't be checked (${escapeHtml(Object.entries(errors).map(([k, v]) => k + ': ' + v).join(', '))}). No products were changed.</p>`);
    }

    const counts = pagesOut.reduce((a, x) => (a[x.verdict] = (a[x.verdict] || 0) + 1, a), {});
    const summary = `${mode}: ${pids.length} HerNest pages, ${checked} checked, ${failed} failed. Verdicts OUT ${counts.OUT || 0}, IN ${counts.IN || 0}, unsure ${counts['?'] || 0}. Categories ${cat.ok}/${cat.categories} read, ${cat.listed.size} listed IDs.` +
      (mode === 'apply' ? ` Applied: ${applied.wentOut.length} out, ${applied.cameBack.length} back in.` : '') + (tooManyFailures ? ' ABORTED (too many failures).' : '');
    await supabase.from('stock_check_runs').update({
      finished_at: new Date().toISOString(), summary,
      details: { errors, categories: { read: cat.ok, total: cat.categories, listed: cat.listed.size, usable: catUsable }, pages: pagesOut, applied }
    }).eq('id', runId);
    console.log(summary);
    return { statusCode: 200, body: summary };
  } catch (e) {
    console.error('HerNest check crashed:', e);
    if (runId) await supabase.from('stock_check_runs').update({ finished_at: new Date().toISOString(), summary: 'crashed: ' + (e && e.message) }).eq('id', runId);
    await emailOwner('HerNest stock check crashed: nothing was changed', `<p>${escapeHtml(e && e.message)}</p>`);
    return { statusCode: 500, body: 'crashed' };
  }
};

module.exports.syncToken = syncToken;
