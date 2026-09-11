/* ============================================================================
   full-text-search v5.1.0 — lazily-loaded, tiered archive search.

   Approved 2026-09-01 (option B).  Drop-in companion to archive-search.js:
   it does not replace metadata search, it extends it.

   Behaviour
     · Nothing is fetched on page load.  The archive is exactly as fast as before.
     · The index is fetched on the reader's FIRST keystroke, once, then held in
       memory and left to the service worker to cache.
     · While it is in flight, metadata results show immediately and a quiet line
       reads "Also searching study text..."  Results widen when it lands.
     · Results are ranked in four transparent tiers: verse reference, exact
       phrase, all words, then any word. Reverse chronology is preserved inside
       each tier.
     · A body-only match renders a snippet with the terms highlighted, so the
       reader can see WHY it matched.
     · If the index fails to load, search silently falls back to metadata only
       and says so.  Nothing breaks.

   Loaded before the matching v5.1.0 archive-search asset.
   ==========================================================================*/
(function (global) {
  'use strict';

  var INDEX_URL = 'search-index.json';   // same-origin, resolved from the archive page
  var SNIPPET_RADIUS = 90;               // characters either side of the first hit

  var state = 'idle';        // idle | loading | ready | failed
  var DOCS = null;           // { url: originalText }
  var FOLDED = null;         // { url: foldedText }  — folded once, not per search
  var waiting = [];
  var BOOK_ALIASES = {
    gen: 'genesis', ex: 'exodus', exod: 'exodus', lev: 'leviticus',
    num: 'numbers', deut: 'deuteronomy', josh: 'joshua', judg: 'judges',
    sam: 'samuel', chr: 'chronicles', chron: 'chronicles', neh: 'nehemiah',
    esth: 'esther', ps: 'psalms', psa: 'psalms', psalm: 'psalms',
    prov: 'proverbs', eccl: 'ecclesiastes', ecc: 'ecclesiastes',
    song: 'song of solomon', sos: 'song of solomon', isa: 'isaiah',
    jer: 'jeremiah', lam: 'lamentations', ezek: 'ezekiel', dan: 'daniel',
    hos: 'hosea', obad: 'obadiah', jon: 'jonah', mic: 'micah', nah: 'nahum',
    hab: 'habakkuk', zeph: 'zephaniah', hag: 'haggai', zech: 'zechariah',
    mal: 'malachi', matt: 'matthew', mt: 'matthew', mk: 'mark', lk: 'luke',
    jn: 'john', act: 'acts', rom: 'romans', cor: 'corinthians',
    gal: 'galatians', eph: 'ephesians', phil: 'philippians', col: 'colossians',
    thess: 'thessalonians', thes: 'thessalonians', tim: 'timothy',
    tit: 'titus', philem: 'philemon', heb: 'hebrews', jas: 'james',
    jam: 'james', pet: 'peter', rev: 'revelation'
  };
  var VALID_BOOKS = {};
  [
    'genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua',
    'judges', 'ruth', '1 samuel', '2 samuel', '1 kings', '2 kings',
    '1 chronicles', '2 chronicles', 'ezra', 'nehemiah', 'esther', 'job',
    'psalms', 'proverbs', 'ecclesiastes', 'song of solomon', 'isaiah',
    'jeremiah', 'lamentations', 'ezekiel', 'daniel', 'hosea', 'joel', 'amos',
    'obadiah', 'jonah', 'micah', 'nahum', 'habakkuk', 'zephaniah', 'haggai',
    'zechariah', 'malachi', 'matthew', 'mark', 'luke', 'john', 'acts',
    'romans', '1 corinthians', '2 corinthians', 'galatians', 'ephesians',
    'philippians', 'colossians', '1 thessalonians', '2 thessalonians',
    '1 timothy', '2 timothy', 'titus', 'philemon', 'hebrews', 'james',
    '1 peter', '2 peter', '1 john', '2 john', '3 john', 'jude', 'revelation'
  ].forEach(function (book) { VALID_BOOKS[book] = true; });

  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function normaliseQuery(value) {
    var phrase = fold(value).replace(/\s+/g, ' ').trim();
    if (phrase.length < 2) { return phrase; }
    var pairs = { '"': '"', "'": "'", '“': '”', '‘': '’' };
    var first = phrase.charAt(0);
    if (pairs[first] && pairs[first] === phrase.charAt(phrase.length - 1)) {
      phrase = phrase.slice(1, -1).trim();
    }
    return phrase;
  }

  function queryTerms(query) {
    return normaliseQuery(query).split(' ').filter(Boolean);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------------- load -- */
  function prime(onReady) {
    if (state === 'ready' || state === 'failed') { return; }
    if (typeof onReady === 'function') { waiting.push(onReady); }
    if (state === 'loading') { return; }
    state = 'loading';

    fetch(INDEX_URL, { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('index unavailable'); }
        return r.json();
      })
      .then(function (data) {
        DOCS = (data && data.docs) || {};
        FOLDED = {};
        for (var url in DOCS) {
          if (Object.prototype.hasOwnProperty.call(DOCS, url)) {
            FOLDED[url] = fold(DOCS[url]);
          }
        }
        state = 'ready';
      })
      .catch(function () {
        state = 'failed';
        DOCS = null;
        FOLDED = null;
      })
      .then(function () {
        var q = waiting.slice();
        waiting.length = 0;
        q.forEach(function (fn) { try { fn(); } catch (e) {} });
      });
  }

  /* -------------------------------------------------------------- rank ---- */
  function combinedHaystack(study) {
    var body = (state === 'ready' && FOLDED) ? FOLDED[study.file] : '';
    return study.hay + ' ' + body;
  }

  function normaliseVerse(value) {
    var verse = fold(value).replace(/\./g, '').replace(/\s+/g, ' ')
      .replace(/\s*[-–]\s*/g, '-').trim();
    return verse.replace(/^([1-3]\s*)?([a-z]+(?:\s+of\s+[a-z]+)?)(?=\s+\d)/, function (_match, number, book) {
      return (number || '') + (BOOK_ALIASES[book] || book);
    });
  }

  function isVerseReference(query) {
    var verse = normaliseVerse(query);
    if (!/^(?:[1-3]\s*)?[a-z]+(?:\s+of\s+[a-z]+)?\s+\d{1,3}(?::\d{1,3}(?:-\d{1,3})?)?$/.test(verse)) {
      return false;
    }
    var match = /^(.+?)\s+\d/.exec(verse);
    return !!(match && VALID_BOOKS[match[1]]);
  }

  function containsTerm(hay, term) {
    if (term.length >= 4 && !/^\d+$/.test(term)) { return hay.indexOf(term) !== -1; }
    var escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])').test(hay);
  }

  /* Return 1–4 for a match, or 0 for no match. A multiword query such as
     "broken pot" therefore shows contiguous-phrase hits before pages that
     merely contain both words, and pages with either word remain discoverable. */
  function rank(study, query) {
    var phrase = normaliseQuery(query);
    if (!phrase) { return 1; }
    var terms = queryTerms(phrase);
    var body = (state === 'ready' && FOLDED) ? (FOLDED[study.file] || '') : '';
    var hay = combinedHaystack(study);

    var passage = normaliseVerse(study.passage || '');
    if (isVerseReference(query)) {
      return passage.indexOf(normaliseVerse(query)) === 0 ? 1 : 0;
    }
    /* Check metadata and body separately. Joining them with a space must not
       create an exact phrase that crosses the metadata/body boundary. */
    if (study.hay.indexOf(phrase) !== -1 || body.indexOf(phrase) !== -1) { return 2; }
    if (/^(?:lesson|week|day)\s+\d+$/.test(phrase)) { return 0; }
    if (terms.every(function (term) { return containsTerm(hay, term); })) { return 3; }
    if (terms.some(function (term) { return containsTerm(hay, term); })) { return 4; }
    return 0;
  }

  function tierLabel(tier) {
    return {
      1: 'Verse reference',
      2: 'Exact phrase',
      3: 'All search words',
      4: 'Any search word'
    }[tier] || 'Results';
  }

  /* Did this study match on metadata alone?  Used to decide whether a snippet
     adds anything — a title match needs no explanation. */
  function matchedMetadataOnly(study, terms) {
    for (var i = 0; i < terms.length; i++) {
      if (study.hay.indexOf(terms[i]) === -1) { return false; }
    }
    return true;
  }

  /* ------------------------------------------------------------ snippet --- */
  function snippet(study, terms, query, tier) {
    if (state !== 'ready' || !DOCS || !terms.length) { return ''; }

    var original = DOCS[study.file];
    var folded = FOLDED[study.file];
    if (!original || !folded) { return ''; }

    var at = -1;
    var phrase = normaliseQuery(query);

    if (tier === 2 && phrase) {
      /* An exact metadata match is already visible in the card. A body match
         must preview the whole contiguous phrase, not the first loose word. */
      if (study.hay.indexOf(phrase) !== -1) { return ''; }
      at = folded.indexOf(phrase);
    } else {
      if (matchedMetadataOnly(study, terms)) { return ''; }
      /* Broader tiers anchor on the earliest term in the body. */
      for (var i = 0; i < terms.length; i++) {
        var p = folded.indexOf(terms[i]);
        if (p !== -1 && (at === -1 || p < at)) { at = p; }
      }
    }
    if (at === -1) { return ''; }

    var start = Math.max(0, at - SNIPPET_RADIUS);
    var phraseEnd = tier === 2 ? at + phrase.length + 40 : at + SNIPPET_RADIUS;
    var end = Math.min(original.length, Math.max(at + SNIPPET_RADIUS, phraseEnd));

    /* Trim to word boundaries so the snippet never starts mid-word. */
    if (start > 0) {
      var sp = original.indexOf(' ', start);
      if (sp !== -1 && sp < at) { start = sp + 1; }
    }
    if (end < original.length) {
      var ep = original.lastIndexOf(' ', end);
      if (ep > at) { end = ep; }
    }

    var text = original.slice(start, end);
    var out = esc(text);
    terms.forEach(function (t) {
      if (!t) { return; }
      var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark class="hit">$1</mark>');
    });

    return (start > 0 ? '&hellip;' : '') + out + (end < original.length ? '&hellip;' : '');
  }

  /* -------------------------------------------------------------- status -- */
  function statusSuffix() {
    if (state === 'loading') { return ' \u00b7 also searching study text\u2026'; }
    if (state === 'failed')  { return ' \u00b7 study text unavailable, searching titles only'; }
    return '';
  }

  function isReady() { return state === 'ready'; }

  global.DBSFullText = {
    prime: prime,
    rank: rank,
    terms: queryTerms,
    tierLabel: tierLabel,
    snippet: snippet,
    statusSuffix: statusSuffix,
    isReady: isReady
  };
})(window);
