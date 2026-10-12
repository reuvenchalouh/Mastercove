// Fills in each product page on the server, before it is sent.
// Customers see exactly the same page as before. The difference is for Google, ChatGPT,
// and link previews (Instagram, Pinterest, Facebook, iMessage), which read the page
// without running its JavaScript: they now get the real product name, description,
// photo, price and stock status instead of "Product — Master Cove" and "Loading...".
// If anything goes wrong (database slow, etc.) the normal page is sent unchanged.

const SB = 'https://slaffkwfwmudvernzjua.supabase.co/rest/v1/products';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsYWZma3dmd211ZHZlcm56anVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMzU4MDksImV4cCI6MjA5MTYxMTgwOX0.BEz8_GNKPTQB90LJBJTZFyJYFF-9ypdfbEsLAfEESqY';
const SITE = 'https://mastercove.com';
const CAT_LABELS = { dresser: 'Dressers', chest: 'Chests', sideboard: 'Sideboards', tv: 'TV Consoles', coffeetable: 'Coffee Tables', diningtable: 'Dining Tables', sidetable: 'Side Tables', nightstand: 'Nightstands', shoe: 'Shoe Storage', bookcase: 'Bookcases', desk: 'Desks', chair: 'Chairs', accentchair: 'Accent Chairs', sofa: 'Sofas', sectional: 'Sectionals', armchair: 'Lounge & Armchairs', bar: 'Bars', bed: 'Beds', bench: 'Benches', vanity: 'Vanities', outdoor: 'Outdoor Furniture', island: 'Kitchen Islands', wardrobe: 'Wardrobes' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const objs = (a) => (Array.isArray(a) ? a : []).filter((x) => x && typeof x === 'object');
const num = (x) => (Number(x) > 0 ? Number(x) : 0);
const pick = (a) => a.find((x) => !x.outOfStock) || a[0];

// Same rules as the product page / Google feed: first available option's price
function landingPrice(p) {
  const ts = objs(p.top_sizes);
  if (p.variant_mode === 'size' && ts.length) {
    const sz = pick(ts); const f = pick(objs(sz.finishes)); const b = f ? pick(objs(f.fabrics)) : null;
    return num(b && b.price) || num(f && f.price) || num(sz.price) || num(p.price);
  }
  const fins = objs(p.finishes);
  if (fins.length) {
    const f = pick(fins); const b = pick(objs(f.fabrics)); const s = pick(objs(f.sizes));
    return num(b && b.price) || num(s && s.price) || num(f.price) || num(p.price);
  }
  return num(p.price);
}

function inStock(p) {
  const ts = objs(p.top_sizes);
  const lists = p.variant_mode === 'size' && ts.length ? ts : [{ outOfStock: false, finishes: p.finishes || [] }];
  for (const l of lists) {
    if (l.outOfStock === true) continue;
    const fins = objs(l.finishes);
    if (!fins.length) return true;
    for (const f of fins) {
      if (f.outOfStock) continue;
      const fabs = objs(f.fabrics);
      if (!fabs.length || fabs.some((b) => !b.outOfStock)) return true;
    }
  }
  return false;
}

function mainImage(p) {
  if (p.img) return p.img;
  const ts = objs(p.top_sizes);
  const lists = p.variant_mode === 'size' && ts.length ? ts : [{ finishes: p.finishes || [] }];
  for (const l of lists) for (const f of objs(l.finishes)) {
    if (f.photos && f.photos[0]) return f.photos[0];
    for (const b of objs(f.fabrics)) if (b.photos && b.photos[0]) return b.photos[0];
  }
  return '';
}

function firstDelivery(p) {
  const ts = objs(p.top_sizes);
  const lists = p.variant_mode === 'size' && ts.length ? ts : [{ finishes: p.finishes || [] }];
  for (const l of lists) for (const f of objs(l.finishes)) {
    if (f.outOfStock) continue;
    for (const b of objs(f.fabrics)) if (!b.outOfStock && b.delivery) return b.delivery;
    if (f.delivery) return f.delivery;
  }
  return null;
}

const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function getProduct(slug, id) {
  const q = slug ? 'slug=eq.' + encodeURIComponent(slug) : 'id=eq.' + encodeURIComponent(id);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`${SB}?${q}&select=id,name,slug,status,cat,price,description,tagline,features,img,finishes,top_sizes,variant_mode,collection,rating,review_count,shipping_cost&limit=1`, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, signal: ctrl.signal
    });
    if (!r.ok) throw new Error('db ' + r.status);
    const rows = await r.json();
    return { found: true, row: rows[0] || null };
  } finally { clearTimeout(t); }
}

// Replace one exact piece of the page; if it isn't there (page changed), skip quietly
const swap = (html, find, repl) => (html.includes(find) ? html.replace(find, () => repl) : html);

export default async (request, context) => {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/products\/([^\/?#]+)\/?$/);
  const slug = m ? decodeURIComponent(m[1]) : '';
  const id = url.searchParams.get('id') || '';
  if (!slug && !id) return; // nothing to fill in: send the normal page

  const res = await context.next();
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;

  let html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');

  let result;
  try { result = await getProduct(slug, id); } catch (e) {
    return new Response(html, { status: 200, headers }); // database slow/down: normal page
  }
  const p = result.row;

  if (!p) {
    // Unknown or deleted product: a real "not found" so Google drops it
    html = swap(html, '<title>Product — Master Cove</title>', '<title>Product not found — Master Cove</title>\n<meta name="robots" content="noindex, nofollow"/>');
    return new Response(html, { status: 404, headers });
  }

  const name = String(p.name || '').trim();
  const title = `${name} — Master Cove`;
  const descText = String(p.description || '').replace(/\s+/g, ' ').trim();
  const metaDesc = descText ? (descText.length > 155 ? descText.slice(0, 155).replace(/\s+\S*$/, '') + '…' : descText) : `Shop the ${name} at Master Cove. Quality furniture with free shipping.`;
  const canonical = p.slug ? `${SITE}/products/${p.slug}` : `${SITE}/product-detail.html?id=${encodeURIComponent(p.id)}`;
  const img = mainImage(p);
  const price = landingPrice(p);
  const available = inStock(p);
  const cat = CAT_LABELS[p.cat] || 'Shop';

  // <head>: title, description, link-preview tags, canonical, Google product data
  html = swap(html, '<title>Product — Master Cove</title>', `<title>${esc(title)}</title>`);
  html = html.replace(/(<meta name="description" id="meta-desc" content=")[^"]*(")/, (_, a, b) => a + esc(metaDesc) + b);
  html = html.replace(/(<meta property="og:title" id="og-title" content=")[^"]*(")/, (_, a, b) => a + esc(title) + b);
  html = html.replace(/(<meta property="og:description" id="og-desc" content=")[^"]*(")/, (_, a, b) => a + esc(metaDesc) + b);
  html = html.replace(/(<link rel="canonical" id="canonical-link" href=")[^"]*(")/, (_, a, b) => a + esc(canonical) + b);
  const extra = [
    `<meta property="og:url" content="${esc(canonical)}"/>`,
    `<meta property="og:site_name" content="Master Cove"/>`,
    img ? `<meta property="og:image" content="${esc(img)}"/>` : '',
    img ? `<meta property="og:image:alt" content="${esc(name)}"/>` : '',
    price ? `<meta property="product:price:amount" content="${price.toFixed(2)}"/>` : '',
    price ? `<meta property="product:price:currency" content="USD"/>` : '',
    `<meta property="product:availability" content="${available ? 'in stock' : 'out of stock'}"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    p.status !== 'active' ? `<meta name="robots" content="noindex, nofollow"/>` : ''
  ].filter(Boolean).join('\n');
  html = swap(html, '<meta property="og:type" content="product"/>', '<meta property="og:type" content="product"/>\n' + extra);

  const schema = {
    '@context': 'https://schema.org/', '@type': 'Product', name, description: metaDesc, sku: String(p.id),
    brand: { '@type': 'Brand', name: 'Master Cove' }, category: cat,
    offers: {
      '@type': 'Offer', url: canonical, priceCurrency: 'USD', price: price || undefined,
      availability: available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition'
    }
  };
  if (img) schema.image = img;
  if (Number(p.review_count) > 0 && Number(p.rating) > 0) schema.aggregateRating = { '@type': 'AggregateRating', ratingValue: Number(p.rating), reviewCount: Number(p.review_count), bestRating: 5, worstRating: 1 };
  html = swap(html, '<script type="application/ld+json" id="ld-json"></script>',
    `<script type="application/ld+json" id="ld-json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`);

  // <body>: name, category, price, stock, description (the page's own script then takes over as usual)
  html = swap(html, '<span id="bc-name">Loading...</span>', `<span id="bc-name">${esc(name)}</span>`);
  html = swap(html, '<a href="index.html" id="bc-cat">Shop</a>', `<a href="index.html?cat=${esc(encodeURIComponent(p.cat || ''))}" id="bc-cat">${esc(cat)}</a>`);
  html = swap(html, '<h1 class="pdp-title" id="pdp-title">Loading...</h1>', `<h1 class="pdp-title" id="pdp-title">${esc(name)}</h1>`);
  if (price) html = html.replace(/(<span class="pdp-price" id="pdp-price">)(<\/span>)/, (_, a, b) => a + money(price) + b);
  if (!available) html = swap(html, '<div class="tmini" id="stock-mini"><span>✓</span> In Stock</div>', '<div class="tmini" id="stock-mini"><span>✕</span> Out of Stock</div>');
  const d = firstDelivery(p);
  if (d && d.ship === 'freight') html = swap(html, '<span id="delivery-text">Ships within <strong>7–12 business days</strong></span>', '<span id="delivery-text">Ships by freight: delivery in about <strong>3–4 weeks</strong></span>');
  if (descText) {
    const paras = String(p.description).split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join('');
    html = html.replace(/(<div id="pdp-description-left"[^>]*>)(<\/div>)/, (_, a, b) => a + paras + b);
  }
  if (p.features && String(p.features).trim()) {
    const items = String(p.features).split('\n').map((t) => t.trim()).filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('');
    html = html.replace(/(<ul id="pdp-features-list-left"[^>]*>)(<\/ul>)/, (_, a, b) => a + items + b);
  }

  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return new Response(html, { status: 200, headers });
};

export const config = { path: ['/products/*', '/product-detail.html', '/product-detail'] };
