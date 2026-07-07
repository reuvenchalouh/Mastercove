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
  bar:        { google: 'Furniture > Bar Furniture', type: 'Living Room Furniture > Bar Cabinets' },
  bed:        { google: 'Furniture > Bedroom Furniture > Beds & Bed Frames', type: 'Bedroom Furniture > Beds' },
  other:      { google: 'Furniture', type: 'Furniture' }
};

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
      const price = Number(p.price || 0).toFixed(2);
      const link = 'https://mastercove.com/product-detail.html?id=' + p.id;
      const description = escapeXml(
        (p.description || p.tagline || p.name || '').toString().slice(0, 5000)
      );

      items += '  <item>\n';
      items += '    <g:id>' + escapeXml(p.id) + '</g:id>\n';
      items += '    <title>' + escapeXml(p.name) + '</title>\n';
      items += '    <description>' + description + '</description>\n';
      items += '    <link>' + escapeXml(link) + '</link>\n';
      items += '    <g:image_link>' + escapeXml(mainImg) + '</g:image_link>\n';
      extraImages.forEach(function(img){
        items += '    <g:additional_image_link>' + escapeXml(img) + '</g:additional_image_link>\n';
      });
      items += '    <g:availability>' + (inStock ? 'in stock' : 'out of stock') + '</g:availability>\n';
      items += '    <g:price>' + price + ' USD</g:price>\n';
      items += '    <g:condition>new</g:condition>\n';
      items += '    <g:brand>' + escapeXml(getBrand(p)) + '</g:brand>\n';
      items += '    <g:google_product_category>' + escapeXml(catInfo.google) + '</g:google_product_category>\n';
      items += '    <g:product_type>' + escapeXml(catInfo.type) + '</g:product_type>\n';
      items += '    <g:identifier_exists>no</g:identifier_exists>\n';
      items += '    <g:shipping>\n';
      items += '      <g:country>US</g:country>\n';
      items += '      <g:service>Standard</g:service>\n';
      items += '      <g:price>0.00 USD</g:price>\n';
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
      '  <description>Master Cove — Premium solid wood furniture</description>\n' +
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
