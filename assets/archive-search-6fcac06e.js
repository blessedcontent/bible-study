/* ============================================================================
   archive-search v5.1.0 — study discovery + tiered client-side search.

   DISCOVERY (unchanged from production, deliberately):
     1. GET https://api.github.com/repos/{user}/{repo}/contents/
     2. keep files matching /^\d{4}-\d{2}-\d{2}\.html$/
     3. for each, GET raw file and read <meta name="study-title"> and
        <meta name="study-series">

   SEARCHABLE FIELDS — these are the only fields that exist without adding a
   build step.  Body text is NOT searchable and must not be implied to be.
     · title    — <meta name="study-title">
     · series   — <meta name="study-series">  (quarter · lesson · part)
     · date     — parsed from the filename, matched as ISO (2026-08-31),
                  long month ("august"), abbreviated month ("aug"), and year
     · filename — matched so a reader can paste a URL fragment

   SEARCH BEHAVIOUR
     · live, debounced 180ms; no submit required.  The <form> still submits
       to nothing (preventDefault) so Enter is harmless and mobile keyboards
       show a Search key.
     · case- and diacritic-insensitive; results are grouped by match quality:
       verse reference, exact phrase, all words, then any word.
     · reverse-chronological order is preserved inside each tier.
     · quarter grouping is preserved inside each tier; empty groups are dropped.
     · matches in title and series are wrapped in <mark class="hit">.
     · result count announced via aria-live="polite" on .search-status.
     · Escape clears when the input has focus; the × button clears and
       returns focus to the input.  Clearing restores the featured study.
     · the featured (current Central-time day) study is hidden while a query is active,
       because "featured" and "filtered" are contradictory states.

   ERROR MODEL — production currently collapses every failure into the empty
   state.  These are separated:
     · 403 + X-RateLimit-Remaining: 0  → rate-limit state, retry affordance
     · other non-ok / network failure  → error state, retry affordance
     · ok but zero study files         → genuine empty-archive state
   ==========================================================================*/
(function (global) {
  'use strict';

  var GITHUB_USER = 'blessedcontent';
  var GITHUB_REPO = 'bible-study';
  var STUDY_FILE = /^\d{4}-\d{2}-\d{2}\.html$/;
  var DEBOUNCE = 180;

  var d = document;
  var listEl = d.getElementById('studies-container');
  var statusEl = d.getElementById('search-status');
  var searchWrap = d.getElementById('search');
  var inputEl = d.getElementById('search-input');
  var clearEl = d.getElementById('search-clear');
  var featuredEl = d.getElementById('featured');

  var STUDIES = [];   // { file, date, title, series, group, hay }
  var timer = null;
  var featuredDateKey = null;

  /* ------------------------------------------------------------- helpers -- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function decodeEntities(s) {
    if (s == null) return s;
    var t = d.createElement('textarea'); t.innerHTML = s; return t.value;
  }
  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
  function parseDate(name) {
    var m = name.match(/^(\d{4})-(\d{2})-(\d{2})\.html$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  var MONTHS = ['january','february','march','april','may','june','july',
                'august','september','october','november','december'];
  function dateHaystack(date, file) {
    if (!date) return file;
    var mi = date.getMonth();
    return [file, file.replace('.html', ''), MONTHS[mi], MONTHS[mi].slice(0, 3),
            String(date.getFullYear()), String(date.getDate())].join(' ');
  }
  function groupLabel(series) {
    if (!series) return 'Other studies';
    return series.split('\u00b7')[0].trim() || 'Other studies';
  }
  function titleFromFilename(f) { return f.replace('.html', ''); }
  function fmtMonth(dt) { return dt.toLocaleString('en-US', { month: 'short' }); }

  /* highlight every query term inside an already-escaped string */
  function highlight(text, terms) {
    var out = esc(text);
    if (!terms.length) return out;
    terms.forEach(function (t) {
      if (!t) return;
      var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark class="hit">$1</mark>');
    });
    return out;
  }

  /* --------------------------------------------------------------- states -- */
  function renderLoading() {
    var card = '<div class="skeleton-card"><div class="sk sk-badge"></div>' +
               '<div style="flex:1"><div class="sk sk-line w70"></div>' +
               '<div class="sk sk-line w45"></div></div></div>';
    listEl.setAttribute('aria-busy', 'true');
    listEl.innerHTML = card + card + card + card + card;
  }
  function renderState(mark, title, text, actionLabel, onAction) {
    listEl.removeAttribute('aria-busy');
    listEl.innerHTML =
      '<div class="state">' +
        '<div class="state-mark" aria-hidden="true">' + mark + '</div>' +
        '<h2 class="state-title">' + esc(title) + '</h2>' +
        '<p class="state-text">' + esc(text) + '</p>' +
        (actionLabel ? '<button type="button" class="state-action" id="state-action">' +
          esc(actionLabel) + '</button>' : '') +
      '</div>';
    if (actionLabel && onAction) {
      var b = d.getElementById('state-action');
      b.addEventListener('click', function () {
        b.setAttribute('aria-busy', 'true');
        b.textContent = 'Loading\u2026';
        onAction();
      });
    }
  }
  /* Reader-facing language throughout — never maintainer instructions. */
  function stateEmptyArchive() {
    if (searchWrap) searchWrap.hidden = true;
    renderState('\u271D', 'No studies here yet',
      'The first study will appear on this page as soon as it is published. ' +
      'Nothing is missing on your end.');
  }
  function stateNoResults(q) {
    renderState('\u271D', 'No studies match \u201C' + q + '\u201D',
      'Try a shorter word, a lesson name, or a month such as \u201CAugust 2026\u201D.',
      'Clear search', function () { clearSearch(); });
  }
  function stateError() {
    renderState('\u271D', 'The study list could not load',
      'This is usually a brief connection problem. Your studies are safe \u2014 ' +
      'please try again in a moment.',
      'Try again', load);
  }
  function stateRateLimited() {
    renderState('\u271D', 'The study list is temporarily unavailable',
      'This page has reached its hourly limit for loading the study list. ' +
      'It will work again within the hour.',
      'Try again', load);
  }

  /* --------------------------------------------------------------- render -- */
  function render(query) {
    var terms = global.DBSFullText && global.DBSFullText.terms
      ? global.DBSFullText.terms(query)
      : fold(query).split(/\s+/).filter(Boolean);
    var filtering = terms.length > 0;
    var ranked = !filtering
      ? STUDIES.map(function (s) { return { study: s, tier: 0 }; })
      : STUDIES.map(function (s) {
          var tier = global.DBSFullText
            ? global.DBSFullText.rank(s, query)
            : (terms.every(function (t) { return s.hay.indexOf(t) !== -1; }) ? 3 :
              (terms.some(function (t) { return s.hay.indexOf(t) !== -1; }) ? 4 : 0));
          return { study: s, tier: tier };
        }).filter(function (item) { return item.tier > 0; });
    ranked.sort(function (a, b) { return a.tier - b.tier; });
    var rows = ranked.map(function (item) { return item.study; });

    if (featuredEl) featuredEl.hidden = filtering || !STUDIES.length;

    /* status line — announced politely, never on every keystroke mid-word
       because the debounce means one announcement per settled query */
    if (statusEl) {
      var suffix = (filtering && global.DBSFullText) ? global.DBSFullText.statusSuffix() : '';
      var countEl = d.getElementById('archive-count');
      if (countEl) {
        /* Idle: nothing. The sort order is self-evident and the total is
           trivia; it was a second uppercase eyebrow beside the heading. */
        countEl.textContent = filtering ? rows.length + ' shown' : '';
      }
      statusEl.textContent = (!filtering
        ? ''
        : (rows.length === 0
            ? 'No studies match your search'
            : rows.length + (rows.length === 1 ? ' study matches' : ' studies match') +
              ' \u201C' + query.trim() + '\u201D')) + suffix;
    }
    if (clearEl) clearEl.hidden = !query;

    if (!STUDIES.length) { stateEmptyArchive(); return; }
    if (!rows.length) { stateNoResults(query.trim()); return; }

    listEl.removeAttribute('aria-busy');

    var tiers = [];
    var tierIndex = {};
    ranked.forEach(function (item) {
      var tierKey = filtering ? String(item.tier) : '0';
      if (!(tierKey in tierIndex)) {
        tierIndex[tierKey] = tiers.length;
        tiers.push({ tier: item.tier, groups: [], groupIndex: {} });
      }
      var bucket = tiers[tierIndex[tierKey]];
      if (!(item.study.group in bucket.groupIndex)) {
        bucket.groupIndex[item.study.group] = bucket.groups.length;
        bucket.groups.push({ label: item.study.group, items: [] });
      }
      bucket.groups[bucket.groupIndex[item.study.group]].items.push(item.study);
    });

    var html = '';
    tiers.forEach(function (tier) {
      if (filtering) {
        html += '<section class="search-tier" aria-label="' +
          esc(global.DBSFullText ? global.DBSFullText.tierLabel(tier.tier) : 'Search results') + '">' +
          '<h2 class="search-tier-title">' +
          esc(global.DBSFullText ? global.DBSFullText.tierLabel(tier.tier) : 'Search results') +
          '</h2>';
      }
      html += '<ul class="studies-list">';
      tier.groups.forEach(function (g) {
      html += '<li><div class="group-head">' +
                '<span class="group-label">' + esc(g.label) + '</span>' +
                '<span class="group-line"></span>' +
                '<button type="button" class="group-top" data-top>\u2191 Top</button>' +
              '</div><ul class="studies-list">';
      g.items.forEach(function (s) {
        var meta = shortMeta(s.series) || (s.date
          ? s.date.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
          : 'Daily study');
        /* v5.0.1 — the boxed date badge is gone. The date joins the coordinates
         line it already had, so the title gets the full row width (no wrapping
         across 158 rows) with no extra line — rows come out 3px SHORTER than
         the badge version, which was propped open by the 52px box. The date is
         now real text rather than an aria-hidden decoration, so screen readers
         get it too. Row structure now mirrors the featured card. */
      var shortDate = s.date ? fmtMonth(s.date) + ' ' + s.date.getDate() : '';
      html += '<li><a class="study-card" href="' + esc(s.file) + '">' +
            '<span class="card-body">' +
              '<span class="card-title">' + highlight(s.title, terms) + '</span>' +
              (function () {
                var mp = metaParts(s.series);
                if (!mp) {
                  return '<span class="card-meta card-meta-2">' +
                      '<span class="cm-lesson-title">' + highlight(meta, terms) + '</span>' +
                      (shortDate ? '<span class="cm-facts"><span class="cm-date">' + esc(shortDate) + '</span></span>' : '') +
                    '</span>';
                }
                return '<span class="card-meta card-meta-2">' +
                    '<span class="cm-lesson-title">' + highlight(mp.title, terms) + '</span>' +
                    '<span class="cm-facts">' +
                      (shortDate ? '<span class="cm-date">' + esc(shortDate) + '</span>' : '') +
                      (mp.lesson ? '<span>' + esc(mp.lesson) + '</span>' : '') +
                      (mp.day ? '<span>' + esc(mp.day) + '</span>' : '') +
                    '</span>' +
                  '</span>';
              })() +
              (function () {
                var snip = global.DBSFullText
                  ? global.DBSFullText.snippet(s, terms, query, tier.tier)
                  : '';
                return snip ? '<span class="card-snippet">' + snip + '</span>' : '';
              }()) +
            '</span>' +
          '</a></li>';
      });
      html += '</ul></li>';
      });
      html += '</ul>';
      if (filtering) html += '</section>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('[data-top]').forEach(function (b) {
      b.addEventListener('click', function () {
        var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      });
    });
  }

  function clearSearch() {
    if (inputEl) { inputEl.value = ''; inputEl.focus(); }
    render('');
  }

  /* ----------------------------------------------------------------- load -- */
  function fetchMeta(file) {
    return fetch('https://raw.githubusercontent.com/' + GITHUB_USER + '/' + GITHUB_REPO + '/main/' + file)
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) return null;
        var t = text.match(/<meta\s+name="study-title"\s+content="([^"]+)"/i);
        var s = text.match(/<meta\s+name="study-series"\s+content="([^"]+)"/i);
        return { title: decodeEntities(t && t[1]), series: decodeEntities(s && s[1]) };
      })
      .catch(function () { return null; });
  }

  /* studies.json is the primary source: one same-origin request, service-worker
     cacheable, offline-capable, and immune to the GitHub rate limit.  The
     GitHub API remains a fallback for the case where the manifest is absent.
     The manifest is generated at promotion time and contains PUBLISHED studies
     only — staged and unpublished pages are excluded by the generator. */
  var MANIFEST_URL = 'studies.json';
  function fmtLongDate(dt) {
    if (!dt) return '';
    try {
      return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (e) { return ''; }
  }
  function centralDateKey() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    var values = {};
    parts.forEach(function (part) { if (part.type !== 'literal') values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }
  function dashRef(p) { return (p || '').replace(/-/g, '\u2013'); }



  /* v5.0.1 — split the meta into its three facts so the card lays them out
     instead of letting a 271px sentence wrap inside a 205px box. */
  function metaParts(series) {
    var s = shortMeta(series);
    if (!s) return null;
    var p = s.split(' \u00b7 ');
    var day = '', lesson = '', title = [];
    p.forEach(function (x) {
      if (/^Day \d+ of \d+$/i.test(x)) day = x;
      else if (/^Lesson \d+$/i.test(x)) lesson = x;
      else title.push(x);
    });
    return { lesson: lesson, title: title.join(' \u00b7 '), day: day };
  }


  /* v5.0.1 — card meta drops the quarter title (it is the group heading) and
     renames "Part n of 7" to "Day n of 7". */
  function shortMeta(series) {
    if (!series) return '';
    var parts = series.split(' \u00b7 ');
    if (parts.length > 1 && /lesson/i.test(parts[1])) parts = parts.slice(1);
    return parts.join(' \u00b7 ')
      .replace(/^Lesson (\d+),\s*/i, 'Lesson $1 \u00b7 ')
      .replace(/\bPart (\d+) of (\d+)/i, 'Day $1 of $2');
  }

  function normalise(rows) {
    return rows.map(function (r) {
      var date = r.date ? new Date(r.date + 'T00:00:00') : parseDate(r.url || '');
      var title = r.title || titleFromFilename(r.url || '');
      var series = r.series || null;
      return {
        file: r.url, date: date, title: title, series: series,
        passage: r.passage || null, pageType: r.pageType || null,
        group: groupLabel(series),
        hay: fold([title, series || '', r.passage || '', r.pageType || '',
                   dateHaystack(date, r.url || '')].join(' '))
      };
    }).sort(function (a, b) {
      if (a.date && b.date) return b.date - a.date;
      if (a.date) return -1;
      if (b.date) return 1;
      return String(a.file).localeCompare(String(b.file));
    });
  }

  function finish() {
    if (searchWrap) searchWrap.hidden = false;
    mountFeatured();
    render(inputEl ? inputEl.value : '');
  }

  function load() {
    renderLoading();
    if (statusEl) statusEl.textContent = 'Loading studies\u2026';
    fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('no manifest');
        return res.json();
      })
      .then(function (data) {
        var rows = Array.isArray(data) ? data : (data.studies || []);
        if (!rows.length) { STUDIES = []; stateEmptyArchive(); return; }
        STUDIES = normalise(rows);
        finish();
      })
      .catch(function () { loadFromGitHub(); });
  }

  /* ---- fallback: original discovery, unchanged in behaviour ---- */
  function loadFromGitHub() {
    fetch('https://api.github.com/repos/' + GITHUB_USER + '/' + GITHUB_REPO + '/contents/')
      .then(function (res) {
        if (!res.ok) {
          var limited = res.status === 403 && res.headers.get('X-RateLimit-Remaining') === '0';
          throw { kind: limited ? 'rate' : 'error' };
        }
        return res.json();
      })
      .then(function (files) {
        var studyFiles = files.filter(function (f) { return f.type === 'file' && STUDY_FILE.test(f.name); });
        if (!studyFiles.length) { STUDIES = []; stateEmptyArchive(); return; }
        return Promise.all(studyFiles.map(function (f) { return fetchMeta(f.name); }))
          .then(function (metas) {
            STUDIES = normalise(studyFiles.map(function (f, i) {
              return {
                url: f.name,
                title: (metas[i] && metas[i].title) || null,
                series: (metas[i] && metas[i].series) || null
              };
            }));
            finish();
          });
      })
      .catch(function (e) {
        STUDIES = [];
        if (e && e.kind === 'rate') stateRateLimited(); else stateError();
        if (statusEl) statusEl.textContent = '';
        if (searchWrap) searchWrap.hidden = true;
      });
  }

  function mountFeatured() {
    if (!featuredEl || !STUDIES.length) return;
    var todayKey = centralDateKey();
    featuredDateKey = todayKey;
    /* Tomorrow is promoted in the afternoon so it is ready before the next
       morning. Keep today's study featured until Central midnight; the newly
       promoted page is still available in the complete study list. */
    var s = STUDIES.find(function (study) { return study.file === todayKey + '.html'; }) ||
      STUDIES.find(function (study) { return study.file.slice(0, 10) <= todayKey; }) ||
      STUDIES[0];
    var isToday = s.file === todayKey + '.html';
    featuredEl.innerHTML =
      '<a class="featured-link feat-c" href="' + esc(s.file) + '">' +
        '<span class="feat-eyebrow"><span class="eb-a">' + (isToday ? 'Today' : 'Latest study') + '</span><span class="eb-b">' + esc(fmtLongDate(s.date)) + '</span></span>' +
        '<h2 class="card-title feat-title">' + esc(s.title) + '</h2>' +
        (s.passage ? '<span class="feat-passage">' + esc(dashRef(s.passage)) + '</span>' : '') +
        '<span class="feat-cta">' + (isToday ? 'Read today\u2019s study' : 'Read this study') + ' <span aria-hidden="true">\u2192</span></span>' +
      '</a>';
    featuredEl.hidden = false;
  }

  window.setInterval(function () {
    if (STUDIES.length && centralDateKey() !== featuredDateKey) mountFeatured();
  }, 60000);

  /* ------------------------------------------------------------- bindings -- */
  if (inputEl) {
    inputEl.addEventListener('input', function () {
      clearTimeout(timer);
      var v = inputEl.value;
      /* Full-text index is fetched on the first keystroke only, never on load.
         The callback re-renders when it lands, so a reader who typed before it
         arrived sees results widen rather than having to retype. */
      if (v && global.DBSFullText) { global.DBSFullText.prime(function () { render(inputEl.value); }); }
      timer = setTimeout(function () { render(v); }, DEBOUNCE);
    });
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && inputEl.value) { e.preventDefault(); clearSearch(); }
    });
  }
  if (clearEl) clearEl.addEventListener('click', clearSearch);
  var form = d.getElementById('search-form');
  if (form) form.addEventListener('submit', function (e) { e.preventDefault(); render(inputEl.value); });

  load();
})(window);
