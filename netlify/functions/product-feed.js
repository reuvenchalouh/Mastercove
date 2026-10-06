const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Map internal category codes to Google product categories / product types
const CATEGORY_MAP = {
  dresser:    { google: 'Furniture > Bedroom Furniture > Dressers', type: 'Bedroom Furniture > Dressers' },
  sideboard:  { google: 'Furniture > Dining Room Furniture > Sideboards & Buffets', type: 'Dining Room Furniture > Sideboards' },
  tv:         { google: 'Furniture > Entertainment Centers & TV Stands', type: 'Living Room Furniture > TV Consoles' },
  sidetable:  { google: 'Furniture > Tables', type: 'Living Room Furniture > Tables' },
  nightstand: { google: 'Furniture > Bedroom Furniture > Nightstands', type: 'Bedroom Furniture > Nightstands' },
  shoe:       { google: 'Furniture > Entryway Furniture > Shoe Storage', type: 'Entryway Furniture > Shoe Storage' },
  bookcase:   { google: 'Furniture > Bookcases', type: 'Living Room Furniture > Bookcases' },
  desk:       { google: 'Furniture > Office Furniture > Desks', type: 'Office Furniture > Desks' },
  chair:      { google: 'Furniture > Chairs', type: 'Dining Room Furniture > Chairs' },
  sofa:       { google: 'Furniture > Sofas', type: 'Living Room Furniture > Sofas' },
  sectional:  { google: 'Furniture > Sofas', type: 'Living Room Furniture > Sectional Sofas' },
  armchair:   { google: 'Furniture > Chairs', type: 'Living Room Furniture > Lounge Chairs & Armchairs' },
  accentchair:{ google: 'Furniture > Chairs', type: 'Living Room Furniture > Accent Chairs' },
  bar:        { google: 'Furniture > Bar Furniture', type: 'Living Room Furniture > Bar Cabinets' },
  bed:        { google: 'Furniture > Beds & Accessories > Beds & Bed Frames', type: 'Bedroom Furniture > Beds' },
  chest:      { google: 'Furniture > Cabinets & Storage > Dressers', type: 'Bedroom Furniture > Chests of Drawers' },
  coffeetable:{ google: 'Furniture > Tables > Accent Tables > Coffee Tables', type: 'Living Room Furniture > Coffee Tables' },
  diningtable:{ google: 'Furniture > Tables > Kitchen & Dining Room Tables', type: 'Dining Room Furniture > Dining Tables' },
  vanity:     { google: 'Furniture > Cabinets & Storage > Bathroom Cabinets', type: 'Bathroom Furniture > Bathroom Vanities' },
  bench:      { google: 'Furniture > Benches', type: 'Entryway Furniture > Benches' },
  outdoor:    { google: 'Furniture > Outdoor Furniture', type: 'Outdoor Furniture' },
  other:      { google: 'Furniture', type: 'Furniture' }
};

// Words that should appear in a title so Google knows what the product is.
// If the product name doesn't already contain one of the words, the noun is added.
const CATEGORY_NOUN = {
  dresser:['Dresser',['dresser']], chest:['Chest of Drawers',['chest']], nightstand:['Nightstand',['nightstand','bedside']],
  sideboard:['Sideboard',['sideboard','buffet','credenza','cabinet']], tv:['TV Stand',['tv','media','entertainment']],
  bookcase:['Bookcase',['bookcase','bookshelf','shelf','etagere']], desk:['Desk',['desk']],
  chair:['Chair',['chair','stool']], accentchair:['Accent Chair',['chair']], armchair:['Armchair',['chair','lounge']],
  sofa:['Sofa',['sofa','loveseat','couch']], sectional:['Sectional Sofa',['sectional']], bed:['Bed',['bed']],
  coffeetable:['Coffee Table',['coffee table','cocktail table']], diningtable:['Dining Table',['dining table','kitchen table']],
  sidetable:['Side Table',['table']], bar:['Bar Cabinet',['bar','wine']], vanity:['Bathroom Vanity',['vanity']],
  shoe:['Shoe Cabinet',['shoe']], bench:['Bench',['bench']], outdoor:['Outdoor Patio Furniture',['outdoor','patio']]
};

// Materials people search for — picked up only from the product's own name and tagline (so titles stay accurate).
const MATERIALS = ['Solid Oak','White Oak','Walnut','Teak','Acacia','Mango Wood','Burl','Travertine','Marble','Sintered Stone',
  'Linen','Velvet','Boucle','Leather','Performance Fabric','Rattan','Cane','Fluted','Reeded','Oak'];

const SKIP_COLORS = ['', 'default', 'fabric only'];

function cleanText(str) {
  return String(str || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstSize(p) {
  return (p.variant_mode === 'size' && Array.isArray(p.top_sizes) && p.top_sizes.length) ? p.top_sizes[0] : null;
}

// Price the customer sees first on the product page (for size-based items, the first size).
function landingPrice(p) {
  const sz = firstSize(p);
  if (sz) {
    // A finish inside the first size can have its own price (shown first on the page)
    const fins = (Array.isArray(sz.finishes) ? sz.finishes : []).filter(f => f && typeof f === 'object');
    const f = fins.find(x => !x.outOfStock) || fins[0];
    if (f && Number(f.price) > 0) return Number(f.price);
    if (Number(sz.price) > 0) return Number(sz.price);
  }
  return Number(p.price || 0);
}

function getColors(p) {
  const names = [];
  const add = n => { n = String(n || '').trim(); if (SKIP_COLORS.indexOf(n.toLowerCase()) === -1 && names.indexOf(n) === -1) names.push(n); };
  const sz = firstSize(p);
  if (sz) (sz.finishes || []).forEach(f => add(f.name));
  else (p.finishes || []).forEach(f => add(f && f.name));
  return names;
}

function getMaterials(p, already) {
  const text = [p.name, p.tagline].map(cleanText).join(' ').toLowerCase();
  const found = [];
  MATERIALS.forEach(m => {
    const low = m.toLowerCase();
    if (found.length >= 2) return;
    if (text.indexOf(low) === -1) return;
    if (already.indexOf(low) !== -1) return;
    if (found.some(f => f.toLowerCase().indexOf(low) !== -1)) return; // skip "Oak" if "Solid Oak" found
    found.push(m);
  });
  return found;
}

// e.g. "The Orson Nightstand" -> "Orson Fluted Oak Nightstand – Espresso"
function buildTitle(p) {
  let base = String(p.name || '').replace(/^the\s+/i, '').trim();
  const lower = base.toLowerCase();
  const noun = CATEGORY_NOUN[p.cat];
  if (noun && !noun[1].some(w => lower.indexOf(w) !== -1)) base += ' ' + noun[0];
  const mats = getMaterials(p, lower);
  if (mats.length) base += ' – ' + mats.join(' ');
  const used = (lower + ' ' + mats.join(' ')).toLowerCase();
  const colors = getColors(p).filter(c => used.indexOf(c.toLowerCase()) === -1).slice(0, 2);
  if (colors.length) base += (mats.length ? ', ' : ' – ') + colors.join(' / ');
  return base.slice(0, 150);
}

function buildDescription(p) {
  const sz = firstSize(p);
  let d = cleanText(p.description) || cleanText(sz && sz.desc);
  const feats = cleanText(p.features || (sz && sz.features) || '');
  const tag = cleanText(p.tagline);
  if (d.length < 80) d = [tag, d, feats].filter(Boolean).join(' ');
  return (d || p.name || '').slice(0, 5000);
}

function getHighlights(p) {
  const sz = firstSize(p);
  const raw = String(p.features || (sz && sz.features) || '');
  return raw.split(/\n|•/).map(s => cleanText(s).replace(/^[-*•\s]+/, '')).filter(s => s.length > 3).slice(0, 6).map(s => s.slice(0, 150));
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getMainImage(p) {
  if (p.variant_mode === 'size' && p.top_sizes && p.top_sizes.length) {
    for (var si = 0; si < p.top_sizes.length; si++) {
      var fins = p.top_sizes[si].finishes || [];
      for (var fi = 0; fi < fins.length; fi++) {
        if (fins[fi].photos && fins[fi].photos.length) return fins[fi].photos[0];
      }
    }
  }
  if (p.finishes && p.finishes.length) {
    for (var i = 0; i < p.finishes.length; i++) {
      if (p.finishes[i].photos && p.finishes[i].photos.length) return p.finishes[i].photos[0];
    }
  }
  return p.img || '';
}

function getExtraImages(p, mainImg) {
  var imgs = [];
  var pool = [];
  if (p.variant_mode === 'size' && p.top_sizes && p.top_sizes.length) {
    p.top_sizes.forEach(function(sz){
      (sz.finishes||[]).forEach(function(f){ pool = pool.concat(f.photos||[]); });
    });
  } else if (p.finishes && p.finishes.length) {
    p.finishes.forEach(function(f){ pool = pool.concat(f.photos||[]); });
  }
  pool.forEach(function(url){
    if (url && url !== mainImg && imgs.indexOf(url) === -1) imgs.push(url);
  });
  return imgs.slice(0, 10); // Google allows up to 10 additional images
}

function isInStock(p) {
  if (p.variant_mode === 'size' && p.top_sizes && p.top_sizes.length) {
    return p.top_sizes.some(function(sz){
      return (sz.finishes||[]).some(function(f){ return !f.outOfStock; });
    });
  }
  if (p.finishes && p.finishes.length) {
    return p.finishes.some(function(f){ return !f.outOfStock; });
  }
  return true;
}

function getBrand(p) {
  return 'Master Cove';
}

exports.handler = async function(event, context) {
  try {
    const res = await supabase.from('products').select('*').eq('status', 'active');
    if (res.error) throw res.error;
    const products = res.data || [];

    let items = '';
    products.forEach(function(p) {
      const catInfo = CATEGORY_MAP[p.cat] || CATEGORY_MAP.other;
      const mainImg = getMainImage(p);
      if (!mainImg) return; // skip products with no usable image
      const extraImages = getExtraImages(p, mainImg);
      const inStock = isInStock(p);
      const shownPrice = landingPrice(p);
      const wasPrice = Number(p.was || 0);
      const onSale = !firstSize(p) && wasPrice > shownPrice;
      const price = (onSale ? wasPrice : shownPrice).toFixed(2);
      const colors = getColors(p);
      const highlights = getHighlights(p);
      const link = p.slug ? ('https://mastercove.com/products/' + p.slug) : ('https://mastercove.com/product-detail.html?id=' + p.id);
      const description = escapeXml(buildDescription(p));

      items += '  <item>\n';
      items += '    <g:id>' + escapeXml(p.id) + '</g:id>\n';
      items += '    <title>' + escapeXml(buildTitle(p)) + '</title>\n';
      items += '    <description>' + description + '</description>\n';
      items += '    <link>' + escapeXml(link) + '</link>\n';
      items += '    <g:image_link>' + escapeXml(mainImg) + '</g:image_link>\n';
      extraImages.forEach(function(img){
        items += '    <g:additional_image_link>' + escapeXml(img) + '</g:additional_image_link>\n';
      });
      items += '    <g:availability>' + (inStock ? 'in stock' : 'out of stock') + '</g:availability>\n';
      items += '    <g:price>' + price + ' USD</g:price>\n';
      if (onSale) items += '    <g:sale_price>' + shownPrice.toFixed(2) + ' USD</g:sale_price>\n';
      if (colors.length) items += '    <g:color>' + escapeXml(colors[0]) + '</g:color>\n';
      highlights.forEach(function(h){ items += '    <g:product_highlight>' + escapeXml(h) + '</g:product_highlight>\n'; });
      items += '    <g:condition>new</g:condition>\n';
      items += '    <g:brand>' + escapeXml(getBrand(p)) + '</g:brand>\n';
      items += '    <g:google_product_category>' + escapeXml(catInfo.google) + '</g:google_product_category>\n';
      items += '    <g:product_type>' + escapeXml(catInfo.type) + '</g:product_type>\n';
      items += '    <g:identifier_exists>no</g:identifier_exists>\n';
      items += '    <g:shipping>\n';
      items += '      <g:country>US</g:country>\n';
      items += '      <g:service>Standard</g:service>\n';
      items += '      <g:price>' + Number(p.shipping_cost || 0).toFixed(2) + ' USD</g:price>\n';
      items += '    </g:shipping>\n';
      if (p.dims) {
        items += '    <g:product_detail>\n';
        items += '      <g:section_name>Dimensions</g:section_name>\n';
        items += '      <g:attribute_name>Size</g:attribute_name>\n';
        items += '      <g:attribute_value>' + escapeXml(p.dims) + '</g:attribute_value>\n';
        items += '    </g:product_detail>\n';
      }
      items += '  </item>\n';
    });

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n' +
      '<channel>\n' +
      '  <title>Master Cove Product Feed</title>\n' +
      '  <link>https://mastercove.com</link>\n' +
      '  <description>Master Cove — Furniture built to last</description>\n' +
      items +
      '</channel>\n' +
      '</rss>';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=UTF-8',
        'Cache-Control': 'public, max-age=3600'
      },
      body: xml
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Feed generation error: ' + (e.message || e)
    };
  }
};
