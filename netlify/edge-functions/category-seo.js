// Category and room pages: mastercove.com/shop/sofas, /shop/bedroom-furniture, ...
// netlify.toml shows the shop page (index.html) at every /shop/ address. Before it is sent,
// this fills in what Google needs for that category: its own title, description, address
// (canonical), heading, intro text, the first products as real links, and product-list data.
// The page's own script then opens straight on that category, with the usual filters and sorting.
// Unknown addresses go to the homepage. If the database is slow, the page still works normally.
import { BY_SLUG } from './lib/category-pages.js';

const SITE = 'https://mastercove.com';
const SB = 'https://slaffkwfwmudvernzjua.supabase.co/rest/v1/products';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsYWZma3dmd211ZHZlcm56anVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzU4MDksImV4cCI6MjA5MTYxMTgwOX0.BEz8_GNKPTQB90LJBJTZFyJYFF-9ypdfbEsLAfEESqY';
const CARDS = 24; // same number of products the page shows before "Load more"

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const productUrl = (p) => (p.slug ? `/products/${p.slug}` : `/product-detail.html?id=${p.id}`);

function fullyOut(p) {
  const leaves = [];
  for (const s of Array.isArray(p.top_sizes) ? p.top_sizes : []) for (const f of s.finishes || []) { if (f.fabrics && f.fabrics.length) leaves.push(...f.fabrics); else leaves.push(f); }
  for (const f of Array.isArray(p.finishes) ? p.finishes : []) if (f && typeof f === 'object') { if (f.fabrics && f.fabrics.length) leaves.push(...f.fabrics); else leaves.push(f); }
  return leaves.length > 0 && leaves.every((x) => x && x.outOfStock === true);
}
function card(p) {
  const href = esc(productUrl(p));
  const img = p.img ? `<img src="${esc(p.img)}" alt="${esc(p.name)}" loading="lazy"/>` : '';
  const sized = Array.isArray(p.top_sizes) && p.top_sizes.length;
  return `<div class="prod-card"><div class="prod-img"><a class="prod-img-link" href="${href}" aria-label="${esc(p.name)}">${img}</a></div>` +
    `<div class="prod-info"><a class="prod-name" href="${href}">${esc(p.name)}</a>` +
    (p.dims ? `<div class="prod-dims">${esc(p.dims)}</div>` : '') +
    `<div class="prod-footer"><div><span class="price">${sized ? 'From ' : ''}${money(p.price)}</span><div class="unit-tag">free shipping</div></div></div></div></div>`;
}
// Removes one tag (first match) from the page
const drop = (html, re) => html.replace(re, '');
// Removes everything between two marker comments, markers included
const cut = (html, a, b) => { const i = html.indexOf(a), j = html.indexOf(b); return i >= 0 && j > i ? html.slice(0, i) + html.slice(j + b.length) : html; };

export default async (request, context) => {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/shop\/([^/]+)(\/?)$/);
  if (!m) return Response.redirect(new URL('/', url), 302);
  const slug = decodeURIComponent(m[1]).toLowerCase();
  const page = BY_SLUG[slug];
  if (!page) return Response.redirect(new URL('/', url), 302);
  if (m[2] || m[1] !== slug) return Response.redirect(new URL('/shop/' + slug + url.search, url), 301);

  const res = await context.next();
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;
  let html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('etag');
  headers.set('cache-control', 'public, max-age=0, must-revalidate');

  // Products in this category / room
  let rows = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const filter = page.cat ? `cat=eq.${encodeURIComponent(page.cat)}` : `cat=in.(${page.cats.map(encodeURIComponent).join(',')})`;
    const r = await fetch(`${SB}?status=eq.active&${filter}&select=id,name,slug,img,price,dims,finishes,top_sizes&order=created_at.desc&limit=300`, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, signal: ctrl.signal
    }).finally(() => clearTimeout(t));
    if (r.ok) rows = (await r.json()).filter((p) => !fullyOut(p));
  } catch (e) { /* page still works: its script loads the products */ }

  const canonical = `${SITE}/shop/${page.slug}`;
  const title = `${page.title} | Master Cove`;

  // <head>: replace the homepage's title, description, link-preview tags and address
  html = drop(html, /<title>[\s\S]*?<\/title>/);
  html = drop(html, /<meta name="description"[^>]*>/);
  html = drop(html, /<meta property="og:title"[^>]*>/);
  html = drop(html, /<meta property="og:description"[^>]*>/);
  html = drop(html, /<meta property="og:url"[^>]*>/);
  html = drop(html, /<link rel="canonical"[^>]*>/);
  const crumbs = { '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
    { '@type': 'ListItem', position: 2, name: page.name, item: canonical }] };
  const list = { '@type': 'ItemList', numberOfItems: rows.length, itemListElement: rows.slice(0, 100).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE + productUrl(p), name: p.name })) };
  const schema = { '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', '@id': canonical, url: canonical, name: page.name, description: page.desc, isPartOf: { '@id': SITE + '/#website' }, mainEntity: list }, crumbs] };
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(page.desc)}"/>`,
    `<meta property="og:title" content="${esc(title)}"/>`,
    `<meta property="og:description" content="${esc(page.desc)}"/>`,
    `<meta property="og:url" content="${canonical}"/>`,
    `<link rel="canonical" href="${canonical}"/>`,
    `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`,
    `<script>window.CAT_PAGE=${JSON.stringify({ slug: page.slug, cat: page.cat || null, room: page.room || null, name: page.name })};</script>`,
    `<style>#new-arrivals-section,#best-sellers-section,#why-mc-section{display:none!important}h1.sec-title{margin:0;font-weight:400}.cat-intro{max-width:760px;margin:10px 0 0;font-size:14px;line-height:1.7;color:var(--slate)}</style>`
  ].join('\n');
  html = html.replace('</head>', head + '\n</head>');

  // Body: no homepage intro / about text (it has its own heading); category heading + intro instead
  html = cut(html, '<!-- home-intro:start', '<!-- home-intro:end -->');
  html = cut(html, '<!-- home-about:start', '<!-- home-about:end -->');
  html = html.replace(/<div class="sec-title" id="section-title">[\s\S]*?<\/div>/, `<h1 class="sec-title" id="section-title">${esc(page.name)}</h1>`);
  html = html.replace(/<div class="sec-sub" id="section-sub">[\s\S]*?<\/div>/,
    `<div class="sec-sub" id="section-sub">${rows.length ? rows.length + ' pieces · ' : ''}Free shipping on every order</div><p class="cat-intro" id="cat-intro">${esc(page.intro)}</p>`);
  if (rows.length) html = html.replace('<div class="prod-grid" id="pgrid"></div>', () => `<div class="prod-grid" id="pgrid">${rows.slice(0, CARDS).map(card).join('')}</div>`);

  return new Response(html, { status: 200, headers });
};

export const config = { path: ['/shop/*'] };
