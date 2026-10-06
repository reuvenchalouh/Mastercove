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
const PARALLEL = 3;           // pages checked at the same time (Modway rate-limits faster checks)
const PAGE_TIMEOUT_MS = 5000; // give up on one page after 5 seconds
const PAUSE_MS = 250;         // short pause between pages, per worker
const TIME_BUDGET_MS = 18000; // Netlify scheduled functions stop at 30s; stay well under
// The catalog is split into 4 parts, one per run at 7:00, 7:15, 7:30 and 7:45am NY
// (schedule in netlify.toml). Each run checks one part, picked by the minute it runs.
const SLICES = 4;
// Lighter version of Modway's product page. If Modway changes its theme this
// stops working and the function quietly falls back to the full page.
const SECTION_ID = 'template--20039205847212__main';
// If too many checks fail (Modway down, blocking us, etc.) change nothing.
const MAX_FAILURE_RATE = 0.25;
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
  return { code: icons[0], text: text.trim() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch with polite retries when Modway says "slow down" (HTTP 429)
async function fetchPolitely(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchText(url);
    } catch (e) {
      if (e && e.message === 'HTTP 429' && attempt < 1) { await sleep(1500); continue; }
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

async function emailOwner(wentOut, cameBack, failed) {
  if (!wentOut.length && !cameBack.length) return;
  const rows = (list) => list.map(c =>
    `<li style="margin:0 0 6px;">${escapeHtml(c.product)} — <b>${escapeHtml(c.label || 'default')}</b>${c.why ? ` <span style="color:#A8A09A;">(${escapeHtml(c.why)})</span>` : ''}</li>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1C1A17;max-width:600px;">
    <h2 style="font-family:Georgia,serif;font-weight:400;">Modway stock sync</h2>
    ${wentOut.length ? `<p><b>Marked OUT of stock (${wentOut.length}):</b></p><ul>${rows(wentOut)}</ul>` : ''}
    ${cameBack.length ? `<p><b>Back IN stock (${cameBack.length}):</b></p><ul>${rows(cameBack)}</ul>` : ''}
    ${failed ? `<p style="color:#A8A09A;">${failed} option(s) couldn't be checked today and were left unchanged.</p>` : ''}
  </div>`;
  try {
    await resend.emails.send({
      from: 'Master Cove <orders@mastercove.com>',
      to: OWNER_EMAIL,
      subject: `Modway stock: ${wentOut.length} out, ${cameBack.length} back in`,
      html
    });
  } catch (e) { console.error('Summary email failed:', e.message); }
}

async function emailFailure(reason, details) {
  try {
    await resend.emails.send({
      from: 'Master Cove <orders@mastercove.com>',
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

// Runs every morning (schedule set in netlify.toml).
exports.handler = async function() {
  try {
    return await runSync();
  } catch (e) {
    console.error('Sync crashed:', e);
    await emailFailure('The sync crashed', e && e.message);
    return { statusCode: 500, body: 'Sync crashed: ' + (e && e.message) };
  }
};

async function runSync() {
  const started = Date.now();
  const slice = Math.floor(new Date().getUTCMinutes() / 15) % SLICES;
  const { data: products, error } = await supabase.from('products').select('id,name,finishes,top_sizes');
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

  // This run's quarter of the catalog
  const allKeys = Object.keys(pages).sort();
  const sliceKeys = allKeys.filter((_, i) => i % SLICES === slice);
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

  // Apply results
  const changed = new Map();
  const wentOut = [], cameBack = [];
  let unchecked = 0;
  for (const o of options) {
    const key = o.handle + '|' + o.variant;
    if (!attempted.has(key)) continue; // checked in another run
    const s = results[key];
    const decision = s && shouldBeOut(s);
    if (!decision) { unchecked++; continue; }
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

  await emailOwner(wentOut, cameBack, unchecked);
  const summary = `Part ${slice + 1}/${SLICES}: checked ${total} of ${sliceKeys.length} Modway variants (${failed} failed). ${wentOut.length} marked out, ${cameBack.length} back in, ${changed.size} products updated.`;
  console.log(summary);
  return { statusCode: 200, body: summary };
}
