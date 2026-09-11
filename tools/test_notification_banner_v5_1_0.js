#!/usr/bin/env node
/* Regression checks for notification invitation, confirmation, and retry states. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const asset = path.join(__dirname, '..', 'assets', 'notifications-ea704e45.js');

function loadBanner(tokenError, initialCookies = {}) {
  const cookies = { ...initialCookies };
  const text = {
    textContent: 'Get a daily reminder?', children: [],
    setAttribute() {}, appendChild(node) { this.children.push(node); }
  };
  const yes = { hidden: false, disabled: false, textContent: 'Yes, notify me' };
  const no = { hidden: false, disabled: false, textContent: 'No thanks' };
  const classes = new Set(['hidden']);
  const banner = {
    attributes: {},
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) {
      return selector === '.notif-banner-text' ? text :
        (selector === '.notif-btn-yes' ? yes :
        (selector === '.notif-btn-no' ? no : null));
    }
  };
  const document = {
    getElementById(id) { return id === 'notifBanner' ? banner : null; },
    createTextNode(value) { return { textContent: value }; },
    createElement() { return { href: '', textContent: '' }; }
  };
  Object.defineProperty(document, 'cookie', {
    get() { return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '); },
    set(value) {
      const [pair] = value.split(';');
      const at = pair.indexOf('=');
      cookies[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
    }
  });
  const local = {};
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(local, key) ? local[key] : null; },
    setItem(key, value) { local[key] = String(value); }
  };
  const firestore = function () {
    return {
      collection() {
        return { doc() { return { set() { return Promise.resolve(); }, delete() { return Promise.resolve(); } }; } };
      }
    };
  };
  firestore.FieldValue = { serverTimestamp() { return 'timestamp'; } };
  const firebase = {
    apps: [], initializeApp() { this.apps.push({}); }, firestore,
    messaging() {
      return {
        getToken() { return tokenError ? Promise.reject(tokenError) : Promise.resolve('fixture-token'); },
        deleteToken() { return Promise.resolve(); }
      };
    }
  };
  const Notification = { permission: 'granted', requestPermission() { return Promise.resolve('granted'); } };
  const navigator = {
    userAgent: 'test browser',
    serviceWorker: { ready: Promise.resolve({}) }
  };
  const timers = [];
  const window = {
    firebase, Notification, PushManager: function PushManager() {},
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {}, dispatchEvent() {}
  };
  const context = {
    window, document, navigator, Notification, firebase, localStorage,
    PushManager: function PushManager() {}, Event: function Event() {},
    console: { log() {}, error: console.error }, Promise, Error, Intl
  };
  vm.runInNewContext(fs.readFileSync(asset, 'utf8'), context, { filename: asset });
  return { window, banner, text, yes, no, cookies, classes, timers, localStorage };
}

(async function () {
  const success = loadBanner();
  const enabling = success.window.dbsNotifOptIn();
  assert.equal(success.text.textContent, 'Turning on daily reminders…');
  assert.equal(success.banner.attributes['aria-busy'], 'true');
  await enabling;
  assert.equal(success.text.textContent, 'Daily reminders are on for this browser.');
  assert.equal(success.text.children.at(-1).textContent, 'Change the reminder time in reader controls.');
  assert.equal(success.yes.hidden, true);
  assert.equal(success.no.hidden, true);
  assert.equal(success.cookies.dbs_notif, 'yes');
  assert.equal(success.timers.at(-1).delay, 10000);

  const failure = loadBanner(new Error('push service error'));
  await failure.window.dbsNotifOptIn();
  assert.match(failure.text.textContent, /did not finish connecting to its messaging service/i);
  assert.equal(failure.yes.textContent, 'Try again');
  assert.equal(failure.yes.hidden, false);
  assert.equal(failure.no.textContent, 'Close');
  failure.window.dbsNotifDismiss();
  assert.equal(failure.cookies.dbs_notif, undefined);

  const rememberedFailure = loadBanner(null, {
    dbs_notif_registered: 'no', dbs_notif_error: 'yes'
  });
  assert.equal(rememberedFailure.timers[0].delay, 2000);
  rememberedFailure.timers[0].fn();
  assert.match(rememberedFailure.text.textContent, /setup did not finish/i);
  assert.equal(rememberedFailure.yes.textContent, 'Try again');

  const declined = loadBanner();
  declined.window.dbsNotifDismiss();
  assert.equal(declined.cookies.dbs_notif, 'no');

  const schedule = loadBanner();
  const savedSchedule = await schedule.window.dbsNotifSetSchedule('08:30');
  assert.equal(savedSchedule.savedLocally, true);
  assert.equal(schedule.localStorage.getItem('dbs_notif_time'), '08:30');
  await assert.rejects(schedule.window.dbsNotifSetSchedule('08:15'), /hour or half hour/i);

  console.log('v5.1.0 notification banner regression checks: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
