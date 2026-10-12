// Fills in the Collections page on the server, before it is sent.
// Customers see the same page as before. Google, ChatGPT and link previews (which don't run
// the page's JavaScript) now see the real collections and their pieces instead of
// "Loading collections…" and "0 pieces".
//   /collections.html                      → list of all collections (with links)
//   /collections.html?collection=The%20Rolf → that collection's name, photo and pieces
// If anything goes wrong the normal page is sent unchanged.

const SB = 'https://slaffkwfwmudvernzjua.supabase.co/rest/v1/products';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsYWZma3dmd211ZHZlcm56anVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzU4MDksImV4cCI6MjA5MTYxMTgwOX0.BEz8_GNKPTQB90LJBJTZFyJYFF-9ypdfbEsLAfEESqY';
const SITE = 'https://mastercove.com';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const swap = (html, find, repl) => (html.includes(find) ? html.replace(find, () => repl) : html);
const shortName = (n) => String(n).trim().replace(/^the\s+/i, '').replace(/\s+collection$/i, '');
// Hidden from view but readable by search engines and screen readers; the page's own script
// draws the visual collection grid on top as usual.
const HIDDEN = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';

export default async (request, context) => {
  const res = await context.next();
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;
  let html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');

  let rows;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${SB}?status=eq.active&collection=not.is.null&select=id,name,slug,collection,collection_cover,img&order=price.desc`, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, signal: ctrl.signal
    }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error('db ' + r.status);
    rows = await r.json();
  } catch (e) {
    return new Response(html, { status: 200, headers });
  }

  // Group products by collection
  const groups = new Map();
  for (const p of rows || []) {
    const c = String(p.collection || '').trim();
    if (!c) continue;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(p);
  }
  const coverOf = (list) => (list.find((p) => p.collection_cover && p.collection_cover.trim()) || {}).collection_cover || (list.find((p) => p.img) || {}).img || '';
  const productUrl = (p) => (p.slug ? `/products/${p.slug}` : `/product-detail.html?id=${p.id}`);

  const url = new URL(request.url);
  const want = (url.searchParams.get('collection') || '').trim();
  const list = want ? groups.get(want) : null;

  let title, desc, canonical, img, links;
  if (list && list.length) {
    const nm = shortName(want);
    title = `The ${nm} Collection — Master Cove`;
    const names = list.slice(0, 4).map((p) => String(p.name).replace(/^The\s+/i, '')).join(', ');
    desc = `Shop the ${nm} Collection at Master Cove: ${list.length} coordinated piece${list.length === 1 ? '' : 's'}, including ${names}. Free shipping on every order.`;
    canonical = `${SITE}/collections.html?collection=${encodeURIComponent(want)}`;
    img = coverOf(list);
    links = `<nav aria-label="${esc(nm)} collection pieces" style="${HIDDEN}"><h2>The ${esc(nm)} Collection</h2><ul>` +
      list.map((p) => `<li><a href="${esc(productUrl(p))}">${esc(p.name)}</a></li>`).join('') + '</ul></nav>';
    html = swap(html, '<h2 id="collection-title">Collection <em>Name</em></h2>', `<h2 id="collection-title">${esc(nm)} <em>Collection</em></h2>`);
    html = swap(html, '<p id="collection-subtitle">0 pieces</p>', `<p id="collection-subtitle">${list.length} piece${list.length === 1 ? '' : 's'} in this collection</p>`);
  } else {
    const keys = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    title = 'Furniture Collections — Master Cove';
    desc = `Shop ${keys.length} furniture collections at Master Cove: coordinated bedroom, living, dining and entryway pieces designed to work together. Free shipping on every order.`;
    canonical = `${SITE}/collections.html`;
    img = keys.length ? coverOf(groups.get(keys[0])) : '';
    links = `<nav aria-label="All collections" style="${HIDDEN}"><ul>` +
      keys.map((k) => `<li><a href="/collections.html?collection=${esc(encodeURIComponent(k))}">The ${esc(shortName(k))} Collection (${groups.get(k).length} pieces)</a></li>`).join('') + '</ul></nav>';
    html = swap(html, '<h2 id="collection-title">Collection <em>Name</em></h2>', '<h2 id="collection-title"></h2>');
    html = swap(html, '<p id="collection-subtitle">0 pieces</p>', '<p id="collection-subtitle"></p>');
  }

  const head = [
    `<meta name="description" content="${esc(desc)}"/>`,
    `<link rel="canonical" href="${esc(canonical)}"/>`,
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:site_name" content="Master Cove"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(desc)}"/>`,
    `<meta property="og:url" content="${esc(canonical)}"/>`,
    img ? `<meta property="og:image" content="${esc(img)}"/>` : '',
    `<meta name="twitter:card" content="summary_large_image"/>`
  ].filter(Boolean).join('\n');
  html = swap(html, '<title>Collections — Master Cove</title>', `<title>${esc(title)}</title>\n${head}`);
  html = swap(html, '<div class="loading" id="loading-msg">Loading collections…</div>', `<div class="loading" id="loading-msg">Loading collections…</div>\n${links}`);

  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return new Response(html, { status: 200, headers });
};

export const config = { path: ['/collections.html', '/collections'] };
