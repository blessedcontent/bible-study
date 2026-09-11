/* verse-popover.js — anchored inline verse popover.
   Contract:
     <a class="vlink" href="https://www.bible.com/bible/3034/JHN.15.4"
        data-verse="john-15-4" data-ref="John 15:4"
        aria-expanded="false">John 15:4</a>
   Verse text is embedded per page as JSON so the popover never needs network:
     <script type="application/json" id="verse-data">{ "2co4-7": { ... } }<\/script>
   Each record: { ref, text, segments, bibleUrl }. Red-letter segments use the
   same .words-of-jesus class and reader preference as full Scripture blocks.
   Behaviour: opens directly beneath the reference, clamped inside the viewport,
   never scrolls or reflows the page.  Escape / outside click / second click
   closes and returns focus to the trigger.  If a reference has no record, the
   button degrades to the external Bible link (fallback below). */
(function () {
  'use strict';
  var d = document;
  var dataEl = d.getElementById('verse-data');
  var DATA = {};
  try { DATA = dataEl ? JSON.parse(dataEl.textContent) : {}; } catch (e) {}

  var pop = null, trigger = null;

  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    if (trigger) { trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); trigger = null; }
  }

  function renderVerseText(container, rec) {
    var segments = Array.isArray(rec.segments) ? rec.segments : null;
    if (!segments || !segments.length) { container.textContent = rec.text || ''; return; }
    segments.forEach(function (segment) {
      if (!segment || typeof segment.text !== 'string') return;
      if (segment.red) {
        var span = d.createElement('span');
        span.className = 'words-of-jesus';
        span.textContent = segment.text;
        container.appendChild(span);
      } else {
        container.appendChild(d.createTextNode(segment.text));
      }
    });
  }

  function open(btn) {
    var rec = DATA[btn.getAttribute('data-verse')];
    if (!rec) { if (btn.dataset.bibleUrl) window.open(btn.dataset.bibleUrl, '_blank', 'noopener'); return; }
    close();
    trigger = btn;
    btn.setAttribute('aria-expanded', 'true');

    pop = d.createElement('div');
    pop.className = 'verse-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', rec.ref);
    pop.innerHTML =
      '<div class="verse-pop-head">' +
        '<span class="verse-ref"></span>' +
        '<button type="button" class="verse-pop-close" aria-label="Close verse">\u00d7</button>' +
      '</div>' +
      '<p class="verse-pop-text"></p>' +
      '<a class="verse-pop-fallback" target="_blank" rel="noopener">Open in Bible app \u2197</a>';
    pop.querySelector('.verse-ref').textContent = rec.ref;
    renderVerseText(pop.querySelector('.verse-pop-text'), rec);
    var fb = pop.querySelector('.verse-pop-fallback');
    fb.href = rec.bibleUrl || '#';
    if (!rec.bibleUrl) fb.hidden = true;
    d.body.appendChild(pop);

    /* position: below the trigger, clamped to the viewport, page never moves */
    var r = btn.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var pad = 12;
    var left = Math.min(Math.max(pad, r.left + window.scrollX), window.scrollX + d.documentElement.clientWidth - w - pad);
    var top = r.bottom + window.scrollY + 6;
    if (r.bottom + h + 6 > window.innerHeight - pad) {
      var above = r.top + window.scrollY - h - 6;
      if (above > window.scrollY + pad) top = above;
      else top = window.scrollY + Math.max(pad, window.innerHeight - h - pad);
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.querySelector('.verse-pop-close').focus();
  }

  /* Bind the enhanced references directly. This keeps their ordinary href
     fallback intact if the script is unavailable. */
  d.querySelectorAll('.vlink[data-verse]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (trigger === btn) { close(); } else { open(btn); }
    });
  });
  d.addEventListener('click', function (e) {
    if (e.target.closest('.verse-pop-close')) { close(); return; }
    if (pop && !e.target.closest('.verse-pop')) close();
  });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', close);
})();
