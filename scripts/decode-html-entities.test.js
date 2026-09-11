'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeHtmlEntities } = require('./decode-html-entities');

test('decodes the hexadecimal apostrophe emitted by Python html.escape', () => {
  assert.equal(
    decodeHtmlEntities('The Power of Christ&#x27;s Resurrection'),
    "The Power of Christ's Resurrection"
  );
});

test('decodes decimal numeric and standard named entities', () => {
  assert.equal(
    decodeHtmlEntities('Paul&#39;s &amp; Peter&#x27;s &quot;witness&quot;'),
    'Paul\'s & Peter\'s "witness"'
  );
});

test('repairs a value that was accidentally encoded twice', () => {
  assert.equal(
    decodeHtmlEntities('Christ&amp;#x27;s Resurrection'),
    "Christ's Resurrection"
  );
});

test('leaves unknown and invalid entities unchanged', () => {
  assert.equal(
    decodeHtmlEntities('Keep &unknown; and &#x110000;'),
    'Keep &unknown; and &#x110000;'
  );
});
