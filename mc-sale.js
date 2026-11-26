/* Master Cove sale popup (loaded by mc-track.js on every page).
   Black Friday / Cyber Monday 2026: 10% off orders of $2,000+ with code BLACKFRIDAY10.
   - Shows a popup shortly after a visitor lands (at most once every 24 hours per browser).
   - At checkout, applies the code automatically once the cart reaches $2,000.
   - Turns itself off after the sale ends; nothing else needs changing.
   To run a future sale, edit SALE below (or set END in the past to switch it off). */
(function () {
  var SALE = {
    code: 'BLACKFRIDAY10',
    percent: 10,
    min: 2000,
    end: Date.parse('2026-12-01T05:00:00Z'), // Mon Nov 30, 11:59 pm New York time
    tag: 'Black Friday · Cyber Monday',
    title: 'Take <em>10% off</em><br/>orders of $2,000+',
    sub: 'Our Black Friday sale is on now through Cyber Monday, across every piece on the site.',
    endsText: 'Ends Monday, November 30 at midnight ET'
  };
  if (Date.now() > SALE.end) return;
  if (window.__mcSale) return;
  window.__mcSale = SALE;

  var path = location.pathname;
  if (/^\/admin/.test(path)) return;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ── Checkout: apply the code automatically once the order qualifies ──
  if (/^\/checkout/.test(path)) {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      try {
        if (typeof applyPromo !== 'function' || typeof getSubtotal !== 'function') { if (tries > 40) clearInterval(t); return; }
        if (typeof appliedPromo !== 'undefined' && appliedPromo) { clearInterval(t); return; }
        var input = document.getElementById('promo-input');
        if (!input) { if (tries > 40) clearInterval(t); return; }
        if (getSubtotal() >= SALE.min) { input.value = SALE.code; applyPromo(); clearInterval(t); }
        else if (tries > 40) clearInterval(t);
      } catch (e) { clearInterval(t); }
    }, 250);
    return;
  }

  // Top announcement bar shows the sale on every page (tap it to see the details).
  function bar() {
    var b = document.querySelector('.ann-bar, .announce');
    if (!b || b.getAttribute('data-sale')) return;
    b.setAttribute('data-sale', '1');
    b.innerHTML = SALE.tag + ': <b>' + SALE.percent + '% off orders $' + SALE.min.toLocaleString('en-US') + '+</b> · code <b>' + SALE.code + '</b>';
    b.style.cursor = 'pointer';
    b.onclick = function () { show(true); };
  }

  // No popup on these pages.
  var noPopup = /^\/(order-confirmed|track-order|review)/.test(path);
  var seen = Number(get('mc_sale_seen_' + SALE.code) || 0);
  var autoShow = !noPopup && Date.now() - seen >= 24 * 3600 * 1000;

  var css = '' +
    '.mcs-ov{position:fixed;inset:0;background:rgba(28,26,23,.5);z-index:1100;opacity:0;pointer-events:none;transition:opacity .3s;}' +
    '.mcs-ov.open{opacity:1;pointer-events:auto;}' +
    '.mcs-box{position:fixed;left:50%;top:50%;transform:translate(-50%,-46%);width:min(440px,calc(100vw - 32px));background:#FDFBF8;border-radius:6px;z-index:1101;box-shadow:0 24px 70px rgba(28,26,23,.3);opacity:0;pointer-events:none;transition:opacity .3s,transform .3s;overflow:hidden;font-family:\'Outfit\',Helvetica,Arial,sans-serif;text-align:center;}' +
    '.mcs-box.open{opacity:1;pointer-events:auto;transform:translate(-50%,-50%);}' +
    '.mcs-top{position:relative;background:#1C1A17;color:#D4AA7D;padding:11px 40px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;}' +
    '.mcs-x{position:absolute;top:5px;right:10px;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:4px;}' +
    '.mcs-body{padding:30px 32px 26px;}' +
    '.mcs-title{font-family:\'Playfair Display\',Georgia,serif;font-size:31px;font-weight:400;color:#1C1A17;line-height:1.2;margin:0 0 10px;}' +
    '.mcs-title em{color:#6B4C35;font-style:italic;}' +
    '.mcs-sub{font-size:14px;color:#5C5750;font-weight:300;line-height:1.6;margin:0 0 18px;}' +
    '.mcs-code{border:1px dashed #B8895A;background:#F5EFE6;border-radius:4px;padding:14px;margin:0 0 6px;font-size:24px;letter-spacing:4px;font-weight:600;color:#1C1A17;}' +
    '.mcs-note{font-size:12px;color:#5C5750;margin:0 0 16px;}' +
    '.mcs-btn{display:block;width:100%;background:#1C1A17;color:#fff;border:none;padding:14px;font-size:13px;letter-spacing:.08em;font-weight:500;border-radius:2px;cursor:pointer;font-family:inherit;}' +
    '.mcs-fine{font-size:11.5px;color:#A8A09A;margin-top:12px;line-height:1.5;}' +
    '@media(max-width:600px){.mcs-box{top:auto;bottom:0;left:0;right:0;width:100%;transform:translateY(100%);border-radius:12px 12px 0 0;}.mcs-box.open{transform:translateY(0);}.mcs-body{padding:24px 20px 26px;}.mcs-title{font-size:27px;}}';

  function build() {
    if (document.getElementById('mcs-box')) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var ov = document.createElement('div'); ov.className = 'mcs-ov'; ov.id = 'mcs-ov';
    var box = document.createElement('div'); box.className = 'mcs-box'; box.id = 'mcs-box';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', SALE.tag + ' sale');
    box.innerHTML =
      '<div class="mcs-top">' + SALE.tag + '<button class="mcs-x" id="mcs-x" aria-label="Close">×</button></div>' +
      '<div class="mcs-body">' +
      '<h3 class="mcs-title">' + SALE.title + '</h3>' +
      '<p class="mcs-sub">' + SALE.sub + '</p>' +
      '<div class="mcs-code">' + SALE.code + '</div>' +
      '<p class="mcs-note">Applied automatically at checkout once your order reaches $' + SALE.min.toLocaleString('en-US') + '.</p>' +
      '<button class="mcs-btn" id="mcs-go" type="button">Shop the Sale</button>' +
      '<div class="mcs-fine">' + SALE.endsText + '. ' + SALE.percent + '% off the product subtotal on orders of $' + SALE.min.toLocaleString('en-US') + ' or more. Can\'t be combined with other codes.</div>' +
      '</div>';
    document.body.appendChild(ov); document.body.appendChild(box);
    function hide() { box.classList.remove('open'); ov.classList.remove('open'); }
    document.getElementById('mcs-x').onclick = hide;
    ov.onclick = hide;
    document.getElementById('mcs-go').onclick = function () {
      try { navigator.clipboard.writeText(SALE.code); } catch (e) {}
      if (typeof gtag === 'function') gtag('event', 'select_promotion', { promotion_name: SALE.code + ' popup' });
      hide();
    };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    return { box: box, ov: ov };
  }

  function show(force) {
    // Don't cover an open cart drawer or the welcome popup.
    var d = document.getElementById('drawer') || document.getElementById('cart-drawer');
    var w = document.getElementById('mcp-box');
    if (!force && ((d && d.classList.contains('open')) || (w && w.classList.contains('open')))) { setTimeout(show, 6000); return; }
    var el = build(); if (!el) return;
    requestAnimationFrame(function () { el.box.classList.add('open'); el.ov.classList.add('open'); });
    set('mc_sale_seen_' + SALE.code, String(Date.now()));
    if (typeof gtag === 'function') gtag('event', 'view_promotion', { promotion_name: SALE.code + ' popup' });
  }

  function start() { bar(); if (autoShow) setTimeout(show, 2500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
