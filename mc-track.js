/* Master Cove visitor stats (for the admin Dashboard).
   Anonymous: a random visitor id stored in this browser, no names, emails or IP addresses.
   Records page views, the category being browsed, products viewed, add-to-cart, checkout,
   purchase, and how long the visitor actively had the page open.
   Your own browsing is skipped on any device where you've logged into the admin. */
(function () {
  try {
    if (window.__mcTrack) return;
    window.__mcTrack = true;
    var ua = navigator.userAgent || '';
    if (navigator.webdriver || /bot|crawl|spider|slurp|preview|lighthouse|headless|facebookexternalhit|pingdom|monitor/i.test(ua)) return;
    var ls = null, ss = null;
    try { ls = window.localStorage; } catch (e) {}
    try { ss = window.sessionStorage; } catch (e) {}
    if (ls && ls.getItem('mc_notrack') === '1') return;
    if (/^\/admin/.test(location.pathname)) return;

    function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
    function get(s, k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
    function set(s, k, v) { try { if (s) s.setItem(k, v); } catch (e) {} }

    var vid = get(ls, 'mc_vid'); if (!vid) { vid = rid(); set(ls, 'mc_vid', vid); }
    // A visit ends after 30 minutes without activity
    var now = Date.now(), sid = get(ls, 'mc_sid'), last = +get(ls, 'mc_sid_t') || 0;
    if (!sid || now - last > 30 * 60 * 1000) { sid = rid(); set(ls, 'mc_sid', sid); set(ss, 'mc_src_sent', ''); }
    function touch() { set(ls, 'mc_sid_t', String(Date.now())); }
    touch();

    var ENDPOINT = '/.netlify/functions/track';
    function send(type, extra, beacon) {
      var d = { vid: vid, sid: sid, type: type, path: location.pathname + (location.search || '') };
      if (extra) for (var k in extra) if (extra[k] !== undefined && extra[k] !== null && extra[k] !== '') d[k] = extra[k];
      var body = JSON.stringify(d);
      touch();
      try {
        if (beacon && navigator.sendBeacon) { navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' })); return; }
        fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      } catch (e) {}
    }

    // Where the visitor came from (only sent once per visit)
    function source() {
      var q = new URLSearchParams(location.search);
      if (q.get('gclid') || q.get('gbraid') || q.get('wbraid') || /google/i.test(q.get('utm_source') || '') && /cpc|ppc|paid|shopping/i.test(q.get('utm_medium') || '')) return 'Google Ads';
      if (q.get('utm_source')) return q.get('utm_source').slice(0, 40);
      var r = document.referrer || '', host = '';
      try { host = r ? new URL(r).hostname.replace(/^www\./, '') : ''; } catch (e) {}
      if (!host || host === location.hostname.replace(/^www\./, '')) return '';
      if (/google\./.test(host)) return 'Google Search';
      if (/bing\./.test(host)) return 'Bing';
      if (/pinterest\./.test(host) || host === 'pin.it') return 'Pinterest';
      if (/instagram\./.test(host)) return 'Instagram';
      if (/facebook\.|fb\.com|m\.me/.test(host)) return 'Facebook';
      if (/duckduckgo|yahoo|ecosia|brave/.test(host)) return 'Other search';
      return host.slice(0, 40);
    }

    // Category from the address: /shop/sofas, ?cat=sofa or ?room=bedroom
    function urlCat() {
      var q = new URLSearchParams(location.search);
      if (window.CAT_PAGE) return window.CAT_PAGE.cat || ('room:' + window.CAT_PAGE.room);
      if (q.get('cat')) return q.get('cat');
      if (q.get('room')) return 'room:' + q.get('room');
      var m = location.pathname.match(/^\/shop\/([a-z0-9-]+)/);
      if (m) return 'shop:' + m[1];
      return '';
    }

    var first = {};
    if (get(ss, 'mc_src_sent') !== sid) {
      first.source = source();
      first.ref = (document.referrer || '').slice(0, 200);
      first.device = /iPad|Tablet/i.test(ua) ? 'tablet' : (/Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop');
      set(ss, 'mc_src_sent', sid);
    }
    first.cat = urlCat();
    send('view', first);

    // Category clicks on the shop page (no page reload)
    var lastCat = first.cat;
    window.mcTrackCat = function (cat) {
      cat = String(cat || '');
      if (!cat || cat === 'all' || cat === lastCat) return;
      lastCat = cat;
      send('cat', { cat: cat });
    };

    // Listen to the shop's existing Google Analytics events
    function item(p) { var it = p && p.items && p.items[0]; return it || {}; }
    function onEvent(name, p) {
      p = p || {};
      if (name === 'view_item') { var a = item(p); send('product', { product_id: +a.item_id || null, product_name: a.item_name, cat: a.item_category, value: a.price }); }
      else if (name === 'add_to_cart') { var b = item(p); send('cart', { product_id: +b.item_id || null, product_name: b.item_name, cat: b.item_category, value: p.value }); }
      else if (name === 'begin_checkout') send('checkout', { value: p.value });
      else if (name === 'purchase') send('purchase', { value: p.value });
    }
    function wrap() {
      var g = window.gtag;
      if (typeof g !== 'function' || g.__mc) return;
      var w = function () { try { if (arguments[0] === 'event') onEvent(arguments[1], arguments[2]); } catch (e) {} return g.apply(this, arguments); };
      w.__mc = true;
      window.gtag = w;
    }
    wrap();
    if (!window.gtag) {
      // Pages without Google Analytics: provide a gtag that only feeds these stats
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      wrap();
    }

    // Time on page: counts only while the tab is visible, sent when the visitor leaves or switches away
    var active = 0, since = document.visibilityState === 'visible' ? Date.now() : 0;
    function flush() {
      if (since) { active += Date.now() - since; since = 0; }
      var secs = Math.round(active / 1000);
      if (secs >= 1) { send('time', { sec: Math.min(secs, 1800) }, true); active = 0; }
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
      else { since = Date.now(); touch(); }
    });
    window.addEventListener('pagehide', flush);
  } catch (e) {}
})();
