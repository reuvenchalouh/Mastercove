// Modway stock check (background function: can run up to 15 minutes).
// Started every morning by modway-stock-sync.js, or any time from admin ("Check stock now").
// Checks every Modway variant your products link to in one run, marks options in/out of stock,
// logs the run (table stock_check_runs) and emails a summary. Owner locks (table stock_locks,
// key "mw:<variant id>") always win. Variants Modway now marks "Closeout" are listed in the email.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Settings ───────────────────────────────────────────────
// Preorder items stay IN STOCK if Modway restocks within this many days,
// and go OUT OF STOCK if the restock date is further away (or unknown).
const PREORDER_CUTOFF_DAYS = 30;
const OWNER_EMAIL = 'mastercovestore@gmail.com';
const PARALLEL = 2;           // pages checked at the same time (Modway rate-limits faster checks)
const PAGE_TIMEOUT_MS = 8000; // give up on one page after 8 seconds
const PAUSE_MS = 600;         // pause between pages, per worker
const TIME_BUDGET_MS = 13 * 60 * 1000; // background functions stop at 15 minutes
// Lighter version of Modway's product page. If Modway changes its theme this
// stops working and the function quietly falls back to the full page.
const SECTION_ID = 'template--20039205847212__main';
// If too many checks fail (Modway down, blocking us, etc.) change nothing.
const MAX_FAILURE_RATE = 0.6; // pages that fail are simply skipped and rechecked tomorrow
// Shipping method (table modway_shipping). Modway shows "Ships via Freight" (3-4 weeks in transit)
// or "Ships via FedEx" on the full product page, only while a color is in stock.
const SHIP_LOOKUPS_PER_RUN = 25;  // new / unknown / old products looked up per run
const SHIP_REFRESH_DAYS = 30;     // re-confirm each product's shipping method about once a month
// ────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

function isModway(link) {
  return typeof link === 'string' && /modway\.com\/products\//i.test(link);
}

function parseLink(link) {
  const m = link.match(/modway\.com\/products\/([^?#/]+)/i);
  const v = link.match(/[?&]variant=(\d+)/);
  return m ? { handle: m[1], variant: v ? v[1] : '' } : null;
}

// Collects every finish / fabric / size on a product that has its own Modway link.
// Each entry keeps a reference to the object so we can flip its outOfStock flag.
function collectOptions(p) {
  const out = [];
  const label = (...parts) => parts.filter(Boolean).join(' / ');
  (p.finishes || []).forEach(f => {
    if (isModway(f.link)) out.push({ obj: f, link: f.link, label: label(f.name) });
    // Sizes inside a finish (e.g. Lippa: each color comes in 48" / 60" / 78")
    (f.sizes || []).forEach(sz => {
      if (sz && isModway(sz.link)) out.push({ obj: sz, link: sz.link, label: label(f.name, sz.name) });
    });
    (f.fabrics || []).forEach(b => {
      if (isModway(b.link)) out.push({ obj: b, link: b.link, label: label(f.name !== 'Fabric Only' && f.name, b.name) });
    });
  });
  (p.top_sizes || []).forEach(s => {
    let childLinks = 0;
    (s.finishes || []).forEach(f => {
      if (isModway(f.link)) { childLinks++; out.push({ obj: f, link: f.link, label: label(s.name, f.name) }); }
      (f.fabrics || []).forEach(b => {
        if (isModway(b.link)) { childLinks++; out.push({ obj: b, link: b.link, label: label(s.name, f.name !== 'Fabric Only' && f.name, b.name) }); }
      });
    });
    // Sizes with no linked finishes underneath (e.g. Rowe sets) are checked at the size level.
    if (!childLinks && isModway(s.link)) out.push({ obj: s, link: s.link, label: label(s.name) });
  });
  return out;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Reads Modway's public stock badge for one variant: in_stock, low, preorder, out_of_stock
function readStatus(html) {
  const icons = [...html.matchAll(/product-inventory__icon-([a-z_]+)/g)].map(m => m[1]).filter(x => x !== 'frame');
  if (!icons.length) return null;
  const text = (html.match(/aria-label="Inventory status"\s*>([^<]*)</) || [])[1] || '';
  const closeout = /<product-variant-badge[\s\S]{0,400}?closeout/i.test(html);
  return { code: icons[0], text: text.trim(), closeout };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch with polite retries when Modway says "slow down" (HTTP 429)
async function fetchPolitely(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchText(url);
    } catch (e) {
      if (e && e.message === 'HTTP 429' && attempt < 1) { await sleep(2500); continue; }
      throw e;
    }
  }
}

async function checkVariant(handle, variant) {
  const base = 'https://modway.com/products/' + handle + '?' + (variant ? 'variant=' + variant + '&' : '');
  try {
    const s = readStatus(await fetchPolitely(base + 'section_id=' + SECTION_ID));
    if (s) return s;
  } catch (e) {
    if (e && e.message === 'HTTP 429') throw e; // don't double the load when rate-limited
  }
  return readStatus(await fetchPolitely(base.replace(/[?&]$/, '')));
}

// Decides whether an option should be out of stock on mastercove.com
function shouldBeOut(status) {
  if (status.code === 'in_stock' || status.code === 'low') return { out: false };
  if (status.code === 'out_of_stock') return { out: true, why: 'Unavailable at Modway' };
  if (status.code === 'preorder') {
    const m = status.text.match(/expected ([A-Z][a-z]+ \d{1,2}, \d{4})/);
    const when = m ? Date.parse(m[1]) : NaN;
    if (isNaN(when)) return { out: true, why: 'Preorder, no restock date' };
    const days = Math.ceil((when - Date.now()) / DAY);
    return days >= PREORDER_CUTOFF_DAYS
      ? { out: true, why: 'Preorder, restock ' + m[1] }
      : { out: false, why: 'Preorder, restock ' + m[1] };
  }
  return null; // unknown badge: leave alone
}

// Reads "Ships via Freight" / "Ships via FedEx" from a full Modway product page.
function readShipMethod(html) {
  const m = String(html || '').match(/callout-text">\s*Ships via (\w+)/i);
  return m ? m[1].toLowerCase() : null; // 'freight', 'fedex', or null (not shown)
}

// Delivery estimate shown on the product page (never touches prices).
// In stock: the page counts from today (FedEx/unknown: 7-12 business days, freight: 24-32 days).
// Preorder: restock date + 5-12 days (FedEx) or + 24-32 days (freight).
function deliveryFor(status, ship) {
  if (!status) return null;
  const freight = ship === 'freight';
  if (status.code === 'in_stock' || status.code === 'low') {
    return freight ? { instock: true, ship: 'freight', src: 'modway' } : { instock: true, src: 'modway' };
  }
  if (status.code === 'preorder') {
    const m = status.text.match(/expected ([A-Z][a-z]+ \d{1,2}, \d{4})/);
    const when = m ? Date.parse(m[1] + ' UTC') : NaN;
    if (isNaN(when)) return null;
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    const [a, b] = freight ? [24, 32] : [5, 12];
    const d = { start: iso(when + a * DAY), end: iso(when + b * DAY), pre: true, src: 'modway' };
    if (freight) d.ship = 'freight';
    return d;
  }
  return null;
}

// Works through items a few at a time; stops starting new ones when time runs low.
async function runPool(items, worker, deadline) {
  let i = 0;
  const runners = Array.from({ length: PARALLEL }, async () => {
    while (i < items.length && Date.now() < deadline) {
      const n = i++;
      await worker(items[n]);
      await sleep(PAUSE_MS);
    }
  });
  await Promise.all(runners);
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function emailOwner(wentOut, cameBack, failed, closeouts) {
  closeouts = closeouts || [];
  if (!wentOut.length && !cameBack.length && !closeouts.length) return;
  const rows = (list) => list.map(c =>
    `<li style="margin:0 0 6px;">${escapeHtml(c.product)} — <b>${escapeHtml(c.label || 'default')}</b>${c.why ? ` <span style="color:#A8A09A;">(${escapeHtml(c.why)})</span>` : ''}</li>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1C1A17;max-width:600px;">
    <h2 style="font-family:Georgia,serif;font-weight:400;">Modway stock sync</h2>
    ${wentOut.length ? `<p><b>Marked OUT of stock (${wentOut.length}):</b></p><ul>${rows(wentOut)}</ul>` : ''}
    ${cameBack.length ? `<p><b>Back IN stock (${cameBack.length}):</b></p><ul>${rows(cameBack)}</ul>` : ''}
    ${closeouts.length ? `<p><b>Now marked CLOSEOUT at Modway (${closeouts.length}):</b> these won't be restocked once they sell out. Consider removing them.</p><ul>${rows(closeouts)}</ul>` : ''}
    ${failed ? `<p style="color:#A8A09A;">${failed} option(s) couldn't be checked today and were left unchanged.</p>` : ''}
  </div>`;
  try {
    await resend.emails.send({
      from: 'Modway Stock Update <orders@mastercove.com>',
      to: OWNER_EMAIL,
      subject: `Modway stock: ${wentOut.length} out, ${cameBack.length} back in` + (closeouts.length ? `, ${closeouts.length} closeout` : ''),
      html
    });
  } catch (e) { console.error('Summary email failed:', e.message); }
}

async function emailFailure(reason, details) {
  try {
    await resend.emails.send({
      from: 'Modway Stock Update <orders@mastercove.com>',
      to: OWNER_EMAIL,
      subject: 'Modway stock sync FAILED: nothing was changed',
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1C1A17;max-width:600px;">
        <h2 style="font-family:Georgia,serif;font-weight:400;">Modway stock sync didn't run</h2>
        <p><b>Reason:</b> ${escapeHtml(reason)}</p>
        ${details ? `<p style="color:#5A5550;">${escapeHtml(details)}</p>` : ''}
        <p>No products were changed. Your site still shows yesterday's stock.</p>
      </div>`
    });
  } catch (e) { console.error('Failure email failed:', e.message); }
}

const syncToken = () => crypto.createHash('sha256').update('modway-sync:' + (process.env.SUPABASE_SERVICE_KEY || '')).digest('hex');
async function isAllowed(event) {
  const h = (event && event.headers) || {};
  if ((h['x-sync-token'] || '') === syncToken()) return true;
  const pw = h['x-admin-password'] || h['X-Admin-Password'] || '';
  if (!pw || pw.length > 200) return false;
  const { data, error } = await supabase.rpc('verify_admin_password', { pw });
  return !error && data === true;
}

exports.handler = async function(event) {
  if (!(await isAllowed(event))) return { statusCode: 401, body: 'Not authorized' };
  const { data: run } = await supabase.from('stock_check_runs').insert({ supplier: 'modway', mode: 'apply', summary: 'running' }).select('id').single();
  const runId = run && run.id;
  try {
    const res = await runSync();
    if (runId) await supabase.from('stock_check_runs').update({ finished_at: new Date().toISOString(), summary: res.body, details: res.details || null }).eq('id', runId);
    return { statusCode: res.statusCode, body: res.body };
  } catch (e) {
    console.error('Sync crashed:', e);
    if (runId) await supabase.from('stock_check_runs').update({ finished_at: new Date().toISOString(), summary: 'crashed: ' + (e && e.message) }).eq('id', runId);
    await emailFailure('The sync crashed', e && e.message);
    return { statusCode: 500, body: 'Sync crashed: ' + (e && e.message) };
  }
};

async function runSync() {
  const started = Date.now();
  const { data: products, error } = await supabase.from('products').select('id,name,status,finishes,top_sizes');
  if (error) {
    console.error(error);
    await emailFailure('Could not load products from the database', error.message);
    return { statusCode: 500, body: 'Could not load products' };
  }

  // Build the list of options to check, and the unique Modway pages behind them
  const options = [];
  for (const p of products || []) {
    for (const o of collectOptions(p)) {
      const parsed = parseLink(o.link);
      if (parsed) options.push({ ...o, ...parsed, product: p });
    }
  }
  const pages = {};
  for (const o of options) pages[o.handle + '|' + o.variant] = { handle: o.handle, variant: o.variant };

  // Owner locks: { "mw:<variant id>": true/false }
  const { data: lockRows } = await supabase.from('stock_locks').select('supplier_pid,locked_out');
  const locks = Object.fromEntries((lockRows || []).filter(r => String(r.supplier_pid).startsWith('mw:')).map(r => [String(r.supplier_pid).slice(3), r.locked_out !== false]));

  const allKeys = Object.keys(pages).sort();
  let sliceKeys = allKeys.slice();
  // Start at a different page each day, so if a run ever runs out of time,
  // it's never the same pages that get skipped two days in a row
  if (sliceKeys.length) {
    const day = Math.floor(Date.now() / 86400000);
    const off = day % sliceKeys.length;
    sliceKeys = sliceKeys.slice(off).concat(sliceKeys.slice(0, off));
  }
  const results = {};
  let failed = 0;
  const errorTypes = {};
  const attempted = new Set();
  await runPool(sliceKeys, async (key) => {
    attempted.add(key);
    try {
      const s = await checkVariant(pages[key].handle, pages[key].variant);
      if (s) results[key] = s; else { failed++; errorTypes['no stock badge on page'] = (errorTypes['no stock badge on page'] || 0) + 1; }
    } catch (e) {
      failed++;
      const msg = (e && e.name === 'AbortError') ? 'timed out' : ((e && e.message) || 'unknown error');
      errorTypes[msg] = (errorTypes[msg] || 0) + 1;
    }
  }, started + TIME_BUDGET_MS);
  const errorSummary = Object.entries(errorTypes).map(([k, v]) => `${k}: ${v}`).join(', ');
  if (failed) console.log('Check errors:', errorSummary);

  const total = attempted.size;
  if (!allKeys.length) return { statusCode: 200, body: 'No Modway products found' };
  if (!total) return { statusCode: 200, body: 'Nothing checked this run' };
  if (failed / total > MAX_FAILURE_RATE) {
    console.error(`Aborting: ${failed}/${total} Modway checks failed (${errorSummary}). Nothing changed.`);
    await emailFailure(`${failed} of ${total} Modway pages couldn't be checked`,
      `Errors: ${errorSummary}. "HTTP 403" or "HTTP 429" means Modway is blocking the server; "no stock badge" means Modway changed its page layout.`);
    return { statusCode: 502, body: 'Too many failed checks; nothing changed' };
  }

  // Shipping method per Modway product page (freight vs FedEx)
  const ship = {};      // handle -> 'freight' | 'fedex' | null
  const shipAge = {};   // handle -> last checked (ms)
  const { data: shipRows } = await supabase.from('modway_shipping').select('handle,method,checked_at');
  for (const r of shipRows || []) { ship[r.handle] = r.method || null; shipAge[r.handle] = Date.parse(r.checked_at) || 0; }
  // Look up new products first, then unknown ones, then ones not confirmed in SHIP_REFRESH_DAYS.
  // Modway only shows the method while the color is in stock, so use a variant that just came back in stock.
  const inStockVariant = {};
  for (const key of Object.keys(results)) {
    const s = results[key];
    if (s && (s.code === 'in_stock' || s.code === 'low') && !inStockVariant[pages[key].handle]) inStockVariant[pages[key].handle] = pages[key].variant;
  }
  const handles = [...new Set(Object.values(pages).map(p => p.handle))];
  const prio = (h) => !(h in ship) ? 0 : (ship[h] === null ? 1 : 2);
  const toLookup = handles
    .filter(h => !(h in ship) || ship[h] === null || (Date.now() - (shipAge[h] || 0)) > SHIP_REFRESH_DAYS * DAY)
    .filter(h => !(h in ship) || inStockVariant[h]) // known-but-sold-out pages won't show the method
    .sort((a, b) => prio(a) - prio(b) || (shipAge[a] || 0) - (shipAge[b] || 0))
    .slice(0, SHIP_LOOKUPS_PER_RUN);
  for (const h of toLookup) {
    if (Date.now() > started + TIME_BUDGET_MS + 60 * 1000) break;
    try {
      const v = inStockVariant[h];
      const method = readShipMethod(await fetchPolitely('https://modway.com/products/' + h + (v ? '?variant=' + v : '')));
      if (method || !(h in ship)) {
        const keep = method || ship[h] || null;
        ship[h] = keep;
        await supabase.from('modway_shipping').upsert({ handle: h, method: keep, checked_at: new Date().toISOString() });
      }
    } catch (e) { /* try again next run */ }
    await sleep(PAUSE_MS);
  }
  // A product page with an unknown method borrows it from its sister options on the same
  // mastercove product (e.g. a sold-out sectional size inherits "freight" from the other sizes).
  const shipFor = (o) => {
    if (ship[o.handle]) return ship[o.handle];
    const sib = new Set(collectOptions(o.product).map(x => (parseLink(x.link) || {}).handle).filter(h => h && ship[h]).map(h => ship[h]));
    return sib.size === 1 ? [...sib][0] : null;
  };

  // Apply results
  const changed = new Map();
  const wentOut = [], cameBack = [], closeouts = [];
  let unchecked = 0;
  for (const o of options) {
    const key = o.handle + '|' + o.variant;
    if (o.variant && (o.variant in locks)) {
      const want = locks[o.variant];
      if ((o.obj.outOfStock === true) !== want) { o.obj.outOfStock = want; changed.set(o.product.id, o.product); (want ? wentOut : cameBack).push({ product: o.product.name, label: o.label, why: 'Locked by owner' }); }
      continue;
    }
    if (!attempted.has(key)) continue; // ran out of time before this page
    const s = results[key];
    if (s && s.closeout && o.product.status === 'active') closeouts.push({ product: o.product.name, label: o.label, why: 'Closeout at Modway' });
    const decision = s && shouldBeOut(s);
    if (!decision) { unchecked++; continue; }
    const est = decision.out ? null : deliveryFor(s, shipFor(o));
    if (JSON.stringify(o.obj.delivery || null) !== JSON.stringify(est)) {
      if (est) o.obj.delivery = est; else delete o.obj.delivery;
      changed.set(o.product.id, o.product);
    }
    // Modway's expected restock date (shown in the admin Out of Stock tab); removed once it's back
    const rm = s.code === 'preorder' && String(s.text || '').match(/expected ([A-Z][a-z]+ \d{1,2}, \d{4})/);
    const rd = rm ? new Date(rm[1] + ' UTC') : null;
    const restock = rd && !isNaN(rd) ? rd.toISOString().slice(0, 10) : null;
    if ((o.obj.restock || null) !== restock) {
      if (restock) o.obj.restock = restock; else delete o.obj.restock;
      changed.set(o.product.id, o.product);
    }
    const now = o.obj.outOfStock === true;
    if (decision.out !== now) {
      o.obj.outOfStock = decision.out;
      changed.set(o.product.id, o.product);
      (decision.out ? wentOut : cameBack).push({ product: o.product.name, label: o.label, why: decision.why });
    }
  }

  for (const p of changed.values()) {
    const { error: upErr } = await supabase.from('products')
      .update({ finishes: p.finishes, top_sizes: p.top_sizes }).eq('id', p.id);
    if (upErr) console.error('Update failed for', p.id, upErr.message);
  }

  await emailOwner(wentOut, cameBack, unchecked, closeouts);
  const summary = `Checked ${total} of ${sliceKeys.length} Modway variants (${failed} failed). ${wentOut.length} marked out, ${cameBack.length} back in, ${closeouts.length} closeout, ${changed.size} products updated.`;
  console.log(summary);
  return { statusCode: 200, body: summary, details: { errors: errorTypes, wentOut, cameBack, closeouts } };
}
