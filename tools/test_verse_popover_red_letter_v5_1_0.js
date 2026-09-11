#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const baseUrl = process.argv[2] || 'http://127.0.0.1:8766/bible-study';
const playwrightPath = process.argv[3] || 'playwright';
const browserPath = process.argv[4] || '';
const { chromium } = require(playwrightPath);

function studyPages() {
  const pages = fs.readdirSync(root)
    .filter(name => /^2026-\d\d-\d\d\.html$/.test(name))
    .map(name => ({ path: path.join(root, name), url: name }));
  for (const name of fs.readdirSync(path.join(root, 'staging'))) {
    if (/^2026-\d\d-\d\d\.html$/.test(name)) {
      pages.push({ path: path.join(root, 'staging', name), url: `staging/${name}` });
    }
  }
  return pages;
}

function payloadFor(pagePath) {
  const html = fs.readFileSync(pagePath, 'utf8');
  const match = html.match(/<script\b[^>]*\bid=["']verse-data["'][^>]*>(.*?)<\/script>/s);
  return match ? JSON.parse(match[1]) : null;
}

(async () => {
  const pages = studyPages();
  assert.strictEqual(pages.length, 175, 'expected 175 Lesson 12 release study pages');
  let recordCount = 0;
  let redRecordCount = 0;
  let enhancedPageCount = 0;
  let browserFixture = null;

  for (const item of pages) {
    const records = payloadFor(item.path);
    if (!records) continue;
    enhancedPageCount += 1;
    for (const [key, record] of Object.entries(records)) {
      recordCount += 1;
      assert(Array.isArray(record.segments) && record.segments.length, `${item.url} ${key} has no segments`);
      assert.strictEqual(
        record.segments.map(segment => segment.text).join(''),
        record.text,
        `${item.url} ${key} segment text differs from its pinned display text`,
      );
      if (record.segments.some(segment => segment.red)) {
        redRecordCount += 1;
        if (!browserFixture) browserFixture = { ...item, key };
      }
    }
  }

  assert(recordCount > 0, 'candidate has no embedded popover records');
  assert(redRecordCount > 0, 'candidate has no words-of-Jesus popover records');
  assert(browserFixture, 'no browser fixture was found');

  const browser = await chromium.launch({
    headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/${browserFixture.url}`, { waitUntil: 'networkidle' });
    for (const theme of ['dark', 'paper', 'light']) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 924, height: 900 }, { width: 1080, height: 900 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(selectedTheme => {
          localStorage.setItem('dbs_theme', selectedTheme);
          localStorage.setItem('dbs_red_letter', 'on');
        }, theme);
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator(`.vlink[data-verse="${browserFixture.key}"]`).first().click();
        const result = await page.evaluate(() => {
          const pop = document.querySelector('.verse-pop-text');
          const red = pop && pop.querySelector('.words-of-jesus');
          assertPresent(pop, 'popover text');
          assertPresent(red, 'red-letter span');
          const onColor = getComputedStyle(red).color;
          const baseColor = getComputedStyle(pop).color;
          const popRect = document.querySelector('.verse-pop').getBoundingClientRect();
          document.documentElement.setAttribute('data-red', 'off');
          const offColor = getComputedStyle(red).color;
          return {
            onColor,
            baseColor,
            offColor,
            text: pop.textContent,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            insideViewport: popRect.left >= 0 && popRect.right <= document.documentElement.clientWidth,
          };

          function assertPresent(value, label) {
            if (!value) throw new Error(`missing ${label}`);
          }
        });
        assert.notStrictEqual(result.onColor, result.baseColor, `${theme} ${viewport.width}: red-on text did not receive the red-letter color`);
        assert.strictEqual(result.offColor, result.baseColor, `${theme} ${viewport.width}: red-off text did not return to the ordinary verse color`);
        assert(result.text.length > 0, `${theme} ${viewport.width}: rendered popover is empty`);
        assert.strictEqual(result.overflow, false, `${theme} ${viewport.width}: horizontal overflow`);
        assert.strictEqual(result.insideViewport, true, `${theme} ${viewport.width}: popover exceeds the content viewport`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`Verse popover red-letter test: PASS (${pages.length} pages, ${enhancedPageCount} with popovers, ${recordCount} records, ${redRecordCount} with Jesus' words)`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
