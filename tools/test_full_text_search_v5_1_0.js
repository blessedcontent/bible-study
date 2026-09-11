#!/usr/bin/env node
/* Regression checks for v5.1.0 search classification and tier ordering. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const asset = path.join(__dirname, '..', 'assets', 'full-text-search-8eef895a.js');
const corpusDocs = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'search-index.json'), 'utf8')
).docs;
const exactBody = [
  'An earlier paragraph tells the reader to hold fast and names your hope.',
  'It then continues for a while with unrelated material about context, history, audience, setting, and the purpose of the letter before reaching the relevant sentence.',
  'Before this chapter can hold your grief, it has to hold weight.'
].join(' ');
const context = {
  window: {},
  fetch: () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ docs: { ...corpusDocs, 'fixture.html': exactBody } })
  })
};
vm.runInNewContext(fs.readFileSync(asset, 'utf8'), context, { filename: asset });
const search = context.window.DBSFullText;

function study(hay, passage = '', file = 'fixture.html') {
  return { file, hay, passage };
}

assert.equal(search.rank(study('a broken pot was restored'), 'broken pot'), 2);
assert.equal(search.rank(study('a broken pot was restored'), '"broken pot"'), 2);
assert.equal(search.rank(study('a broken clay pot was restored'), 'broken pot'), 3);
assert.equal(search.rank(study('a broken vessel was restored'), 'broken pot'), 4);
assert.equal(
  search.rank(study('god loves a cheerful giver because giving reflects grace'),
    'god loves a cheerful giver because'),
  2
);
assert.equal(
  search.rank(study('a colonnade where crowds read a teacher\'s worth'),
    '“colonnade where crowds read”'),
  2
);

assert.equal(search.rank(study('unrelated metadata', '2 Corinthians 8:1-9'), '2 Cor 8'), 1);
assert.equal(search.rank(study('according courage 2026 8', 'Romans 8:1'), '2 Cor 8'), 0);

assert.equal(search.rank(study('lesson 11 faith and generosity'), 'lesson 11'), 2);
assert.equal(search.rank(study('lesson 1 day 1 published 2026-09-11'), 'lesson 11'), 0);

new Promise((resolve) => search.prime(resolve)).then(() => {
  const query = 'Before this chapter can hold your grief';
  const target = study('unrelated metadata');
  assert.equal(search.rank(target, query), 2);
  const rendered = search.snippet(target, search.terms(query), query, 2);
  const plain = rendered.replace(/<[^>]+>/g, '').replace(/&hellip;/g, '...');
  assert.match(plain, /Before this chapter can hold your grief/);
  assert.doesNotMatch(plain, /^.*hold fast.*Before this chapter/s);

  const liveStudy = study(
    'proclaiming the resurrection of christ the power of christ resurrection',
    '',
    '2026-08-16.html'
  );
  assert.equal(search.rank(liveStudy, query), 2);
  const liveRendered = search.snippet(liveStudy, search.terms(query), query, 2);
  const livePlain = liveRendered.replace(/<[^>]+>/g, '').replace(/&hellip;/g, '...');
  assert.match(livePlain, /Before this chapter can hold your grief/);
  console.log('v5.1.0 full-text search regression checks: PASS');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
