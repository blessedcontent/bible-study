'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('./send-notification');
const { SITE_URL } = require('./live-study');

const html = '<head><meta name="study-title" content="God&#39;s Promise"></head>';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-'));
  fs.writeFileSync(path.join(root, '2026-11-06.html'), html);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = new Map([['phone1', { token: 'test-token-one', timeZone: 'America/Chicago', notificationTime: '07:30' }],
    ['phone2', { token: 'test-token-two', timeZone: 'America/Chicago', notificationTime: '07:30' }]]);
  const sends = [], writes = [];
  const db = { collection(name) {
    assert.equal(name, 'fcm_tokens');
    return {
      get: async () => ({ empty: records.size === 0, forEach(callback) {
        for (const [id, data] of records) callback({ id, data: () => ({ ...data }) });
      } }),
      doc(id) { return {
        set: async (data, options) => { writes.push({ id, data, options }); Object.assign(records.get(id), data); },
        delete: async () => { records.delete(id); }
      }; }
    };
  } };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => 'fake-timestamp' };
  const admin = { firestore, messaging: () => ({ send: async message => { sends.push(message); } }) };
  return { root, records, sends, writes, admin, now: new Date('2026-11-06T15:00:00Z') };
}

test('missing live lesson sends nothing, writes no marker, then retries both registrations', async t => {
  const f = fixture(t);
  let ready = false, fetches = 0;
  const options = { ...f, fetchImpl: async () => { fetches++; return new Response(html, { status: ready ? 200 : 404 }); } };
  const missing = await main(options);
  assert.equal(missing.missingStudyCount, 2);
  assert.equal(f.sends.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(fetches, 1, 'Cache the date check within each run');
  ready = true;
  assert.equal((await main(options)).successCount, 2);
  assert.equal(f.sends.length, 2);
  assert.equal(f.writes.length, 2);
  assert.equal(fetches, 2, 'A new run must retry the live URL');
  for (const message of f.sends) {
    assert.equal(message.webpush.fcmOptions.link, `${SITE_URL}2026-11-06.html`);
    assert.equal(message.data.url, `${SITE_URL}2026-11-06.html`);
    assert.equal(message.data.body, "God's Promise");
  }
  assert.ok(f.writes.every(write => write.data.lastSentDate === '2026-11-06' && write.options.merge));
  assert.equal((await main(options)).notDueCount, 2);
  assert.equal(f.sends.length, 2, 'Keep the existing once-per-local-day behavior');
});

test('HTTP 200 with a wrong title or missing title sends nothing and writes nothing', async t => {
  const f = fixture(t);
  for (const body of ['<head></head>', html.replace('God&#39;s Promise', 'Wrong date')]) {
    await main({ ...f, fetchImpl: async () => new Response(body) });
    assert.equal(f.sends.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('future local notification time does not fetch, send, or write', async t => {
  const f = fixture(t);
  await main({ ...f, now: new Date('2026-11-06T12:00:00Z'), fetchImpl: () => assert.fail('Not due') });
  assert.equal(f.sends.length, 0);
  assert.equal(f.writes.length, 0);
});

test('dry-run performs a live check without touching Firebase', async t => {
  const f = fixture(t);
  const result = await main({ root: f.root, now: f.now, dryRun: true,
    admin: new Proxy({}, { get: () => assert.fail('Dry-run must not initialize/read Firebase') }),
    fetchImpl: async () => new Response(html) });
  assert.equal(result.live.live, true);
  assert.equal(f.sends.length, 0);
  assert.equal(f.writes.length, 0);
});

test('a failed send does not write the once-per-day marker', async t => {
  const f = fixture(t);
  f.admin.messaging = () => ({ send: async () => { throw new Error('temporary send failure'); } });
  assert.equal((await main({ ...f, fetchImpl: async () => new Response(html) })).failCount, 2);
  assert.equal(f.writes.length, 0);
});
