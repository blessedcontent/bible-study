'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodeHtmlEntities } = require('./decode-html-entities');

const SITE_URL = 'https://blessedcontent.github.io/bible-study/';

function studyTitle(html) {
  const head = html.replace(/<!--[\s\S]*?-->/g, '').match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  if (!head) throw new Error('Missing HTML head');
  const clean = head[1].replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const titles = [];
  for (const meta of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = {};
    for (const attr of meta[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    }
    if (attributes.name?.toLowerCase() === 'study-title') {
      titles.push(decodeHtmlEntities(attributes.content || '').trim());
    }
  }
  if (titles.length !== 1 || !titles[0]) throw new Error('Expected one nonempty study-title meta');
  return titles[0];
}

function centralDates(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const target = Number(parts.hour) >= 15
    ? new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    : today;
  return { today, target };
}

async function liveStudy(date, { root = process.cwd(), fetchImpl = globalThis.fetch,
  baseUrl = SITE_URL, timeoutMs = 10000 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid study date');
  const url = new URL(`${date}.html`, baseUrl).href;
  let title;
  try {
    title = studyTitle(fs.readFileSync(path.join(root, `${date}.html`), 'utf8'));
  } catch (error) {
    return { live: false, url, reason: `Expected local study unavailable: ${error.message}` };
  }
  try {
    const response = await fetchImpl(url, {
      redirect: 'error', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200) return { live: false, url, title, reason: `HTTP ${response.status}` };
    const actual = studyTitle(await response.text());
    if (actual !== title) return { live: false, url, title, reason: `study-title mismatch: ${JSON.stringify(actual)}` };
    return { live: true, url, title, reason: 'HTTP 200 and matching study-title meta' };
  } catch (error) {
    return { live: false, url, title, reason: `Live check failed: ${error.message}` };
  }
}

module.exports = { SITE_URL, studyTitle, centralDates, liveStudy };

if (require.main === module) {
  const [command, date, root] = process.argv.slice(2);
  const result = command === 'dates'
    ? Promise.resolve(centralDates(date ? new Date(date) : undefined))
    : command === 'probe' ? liveStudy(date, { root })
      : Promise.reject(new Error('Usage: live-study.js dates [ISO-time] | probe DATE [ROOT]'));
  result.then(value => console.log(JSON.stringify(value))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
