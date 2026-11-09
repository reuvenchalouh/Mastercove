// Fills in the homepage's "New Arrivals" on the server, before it is sent.
// Customers see the same page as before (the page's own script redraws the grid as soon as it
// loads). Google, ChatGPT and link previews (which may not run the page's JavaScript) now see
// real product names, photos, prices and links on the homepage instead of an empty grid.
// If anything goes wrong the normal page is sent unchanged.

import { CAT_SLUG, ROOM_SLUG } from './lib/category-pages.js';

const SB = 'https://slaffkwfwmudvernzjua.supabase.co/rest/v1/products';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsYWZma3dmd211ZHZlcm56anVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzU4MDksImV4cCI6MjA5MTYxMTgwOX0.BEz8_GNKPTQB90LJBJTZFyJYFF-9ypdfbEsLAfEESqY';
const COUNT = 9; // same number of cards the page shows in New Arrivals

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const productUrl = (p) => (p.slug ? `/products/${p.slug}` : `/product-detail.html?id=${p.id}`);

// Is every option of the product out of stock? (Those are skipped, like on the live page.)
function fullyOut(p) {
  const leaves = [];
  for (const s of Array.isArray(p.top_sizes) ? p.top_sizes : []) {
    for (const f of s.finishes || []) {
      if (f.fabrics && f.fabrics.length) leaves.push(...f.fabrics); else leaves.push(f);
    }
  }
  for (const f of Array.isArray(p.finishes) ? p.finishes : []) {
    if (f && typeof f === 'object') {
      if (f.fabrics && f.fabrics.length) leaves.push(...f.fabrics); else leaves.push(f);
    }
  }
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

export default async (request, context) => {
  // Old category links (/?cat=sofa, /?room=bedroom) move to the category pages (/shop/sofas, ...)
  const url = new URL(request.url);
  const qc = url.searchParams.get('cat'), qr = url.searchParams.get('room');
  const to = !url.searchParams.get('search') && ((qc && CAT_SLUG[qc]) || (!qc && qr && ROOM_SLUG[qr]));
  if (to) {
    const rest = new URLSearchParams(url.search); rest.delete('cat'); rest.delete('room');
    const qs = rest.toString();
    return Response.redirect(new URL('/shop/' + to + (qs ? '?' + qs : ''), url), 301);
  }
  const res = await context.next();
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;
  let html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${SB}?status=eq.active&select=id,name,slug,img,price,dims,finishes,top_sizes&order=created_at.desc&limit=40`, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, signal: ctrl.signal
    }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error('db ' + r.status);
    const rows = (await r.json()).filter((p) => !fullyOut(p)).slice(0, COUNT);
    const target = '<div class="prod-grid" id="new-arrivals-grid"></div>';
    if (rows.length && html.includes(target)) {
      html = html.replace(target, () => `<div class="prod-grid" id="new-arrivals-grid">${rows.map(card).join('')}</div>`);
    }
  } catch (e) {
    // leave the page as it is
  }
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return new Response(html, { status: 200, headers });
};

export const config = { path: ['/', '/index.html'] };
