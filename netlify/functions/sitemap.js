const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Generates sitemap.xml dynamically from the live product catalog, so it
// never goes stale as products are added/removed. Excludes transactional
// pages (checkout, order-confirmed, admin, track-order) that should never
// be indexed by search engines.
exports.handler = async function(event) {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('id, created_at')
      .eq('status', 'active');

    if (error) throw error;

    const baseUrl = 'https://mastercove.com';
    const today = new Date().toISOString().split('T')[0];

    const staticPages = [
      { loc: '/', priority: '1.0', changefreq: 'daily' },
      { loc: '/about.html', priority: '0.6', changefreq: 'monthly' },
      { loc: '/faq.html', priority: '0.5', changefreq: 'monthly' },
      { loc: '/returns.html', priority: '0.4', changefreq: 'monthly' },
      { loc: '/shipping.html', priority: '0.4', changefreq: 'monthly' },
      { loc: '/privacy.html', priority: '0.3', changefreq: 'yearly' },
      { loc: '/collections.html', priority: '0.7', changefreq: 'weekly' }
    ];

    let urls = staticPages.map(function(p) {
      return '  <url>\n    <loc>' + baseUrl + p.loc + '</loc>\n    <lastmod>' + today + '</lastmod>\n    <changefreq>' + p.changefreq + '</changefreq>\n    <priority>' + p.priority + '</priority>\n  </url>';
    });

    (products || []).forEach(function(p) {
      var lastmod = today;
      if (p.created_at) {
        try { lastmod = new Date(p.created_at).toISOString().split('T')[0]; } catch (e) {}
      }
      urls.push('  <url>\n    <loc>' + baseUrl + '/product-detail.html?id=' + encodeURIComponent(p.id) + '</loc>\n    <lastmod>' + lastmod + '</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>');
    });

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.join('\n') + '\n</urlset>';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      body: xml
    };
  } catch (err) {
    console.error('Sitemap error:', err.message);
    return { statusCode: 500, body: 'Error generating sitemap.' };
  }
};
