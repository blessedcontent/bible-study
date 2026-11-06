'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SITE_URL, studyTitle, centralDates, liveStudy } = require('./live-study');

const html = '<!doctype html><html><head><meta name="study-title" content="God&#39;s Promise"></head><body>Study</body></html>';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-study-'));
  fs.writeFileSync(path.join(root, '2026-11-06.html'), html);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('study-title accepts attribute order, quotes, case and decoded entities', () => {
  assert.equal(studyTitle(html), "God's Promise");
  assert.equal(studyTitle('<head><META content="God&amp;#39;s Promise" NAME=study-title></head>'), "God's Promise");
  assert.throws(() => studyTitle('<head><!-- <meta name="study-title" content="fake"> --></head>'));
  assert.throws(() => studyTitle('<head><script>const x = \'<meta name="study-title" content="fake">\';</script></head>'));
  assert.throws(() => studyTitle(html.replace('</head>', '<meta name="study-title" content="duplicate"></head>')));
});

test('due date retains 15:00 Central cutoff across daylight saving changes', () => {
  assert.deepEqual(centralDates(new Date('2026-07-01T19:59:00Z')), { today: '2026-07-01', target: '2026-07-01' });
  assert.equal(centralDates(new Date('2026-07-01T20:00:00Z')).target, '2026-07-02');
  assert.equal(centralDates(new Date('2026-11-06T20:59:00Z')).target, '2026-11-06');
  assert.equal(centralDates(new Date('2026-11-06T21:00:00Z')).target, '2026-11-07');
  assert.equal(centralDates(new Date('2027-01-01T05:59:00Z')).target, '2027-01-01');
});

test('a committed file needs HTTP 200 and the exact expected title', async t => {
  const root = fixture(t);
  for (const [status, body, reason] of [
    [404, html, /HTTP 404/], [503, html, /HTTP 503/],
    [200, '<head></head>', /study-title/],
    [200, html.replace('God&#39;s Promise', 'A different study'), /mismatch/]
  ]) {
    const result = await liveStudy('2026-11-06', { root, fetchImpl: async () => new Response(body, { status }) });
    assert.equal(result.live, false);
    assert.match(result.reason, reason);
  }
  const result = await liveStudy('2026-11-06', { root, fetchImpl: async (url, options) => {
    assert.equal(url, `${SITE_URL}2026-11-06.html`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    return new Response(html, { status: 200 });
  } });
  assert.equal(result.live, true);
  assert.equal(result.title, "God's Promise");
});

test('network errors and missing local metadata fail closed', async t => {
  const root = fixture(t);
  const failed = await liveStudy('2026-11-06', { root, fetchImpl: async () => { throw new Error('network unavailable'); } });
  assert.equal(failed.live, false);
  assert.match(failed.reason, /network unavailable/);
  const missing = await liveStudy('2026-11-07', { root, fetchImpl: () => assert.fail('No expected local title') });
  assert.equal(missing.live, false);
});

test('a stalled fetch aborts and leaves the date eligible for a later retry', async t => {
  const root = fixture(t);
  const result = await liveStudy('2026-11-06', { root, timeoutMs: 10,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Abort signal was not honored')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) });
  assert.equal(result.live, false);
  assert.match(result.reason, /timeout/i);
  assert.equal((await liveStudy('2026-11-06', { root, fetchImpl: async () => new Response(html) })).live, true);
});

test('real HTTP timeout fails closed and a later HTTP request recovers', { skip: process.env.DBS_SKIP_HTTP_TESTS === '1' }, async t => {
  const root = fixture(t);
  let hold = true;
  const server = http.createServer((request, response) => {
    if (!hold) response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/bible-study/`;
  assert.equal((await liveStudy('2026-11-06', { root, baseUrl, timeoutMs: 50 })).live, false);
  hold = false;
  assert.equal((await liveStudy('2026-11-06', { root, baseUrl })).live, true);
});
