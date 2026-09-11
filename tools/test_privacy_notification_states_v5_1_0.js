#!/usr/bin/env node
/* Regression checks for the Privacy page notification state matrix. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.attributes = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name)
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}

const root = new Element();
root.setAttribute('data-theme', 'dark');
root.setAttribute('data-red', 'on');
root.scrollHeight = 1000;

const status = new Element();
const statusText = new Element();
const statusMark = new Element();
const kicker = new Element();
const heading = new Element();
const body = new Element();
const facts = new Element();
const steps = new Element();
const timeRow = new Element();
const timeHelp = new Element();
const timeStatus = new Element();
const timeInput = new Element();
const saveTime = new Element();
const actions = new Element();
const note = new Element();

function action(name) {
  const node = new Element();
  node.setAttribute('data-notif', name);
  return node;
}
const enable = action('enable');
const dismiss = action('dismiss');
const disable = action('disable');
const menuToggle = new Element();
menuToggle.children = [new Element()];

const cardNodes = {
  '[data-notif-status-text]': statusText,
  '.notif-state-mark': statusMark,
  '[data-notif-kicker]': kicker,
  '[data-notif-heading]': heading,
  '[data-notif-body]': body,
  '[data-notif-facts]': facts,
  '[data-notif-steps]': steps,
  '[data-notif-time-row]': timeRow,
  '[data-notif-time-help]': timeHelp,
  '[data-notif-time-status]': timeStatus,
  '[data-notif-time]': timeInput,
  '[data-save-notif-time]': saveTime,
  '[data-notif-actions]': actions,
  '[data-notif="enable"]': enable,
  '[data-notif="dismiss"]': dismiss,
  '[data-notif="disable"]': disable,
  '[data-notif-note]': note
};
const card = new Element();
card.querySelector = (selector) => cardNodes[selector] || null;

const events = {};
const document = {
  documentElement: root,
  cookie: '',
  title: 'Privacy',
  querySelector(selector) {
    if (selector === '.notif-card') return card;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === '[data-toggle="notify"]') return [menuToggle];
    if (selector === '[data-notif]') return [enable, dismiss, disable];
    return [];
  },
  getElementById(id) { return id === 'notification-status' ? status : null; },
  addEventListener() {}
};
const window = {
  document,
  PushManager: function PushManager() {},
  location: { href: 'http://example.test/privacy.html' },
  innerHeight: 800,
  scrollY: 0,
  addEventListener(name, fn) { events[name] = fn; },
  setInterval() {},
  scrollTo() {}
};
const navigator = { serviceWorker: {} };
const Notification = { permission: 'default' };
window.Notification = Notification;
const context = { window, document, navigator, Notification, localStorage: { setItem() {} } };

const asset = path.join(__dirname, '..', 'assets', 'reader-controls-c8d1b1b6.js');
vm.runInNewContext(fs.readFileSync(asset, 'utf8'), context, { filename: asset });

assert.equal(card.getAttribute('data-notification-state'), 'off');
assert.equal(statusText.textContent, 'Reminders are off for this browser.');
assert.equal(timeRow.hidden, false);
assert.equal(timeInput.disabled, true);
assert.equal(enable.hidden, false);
assert.equal(disable.hidden, true);

Notification.permission = 'granted';
document.cookie = 'dbs_notif_registered=yes; dbs_notif_error=no';
events['dbs-notification-change']();
assert.equal(card.getAttribute('data-notification-state'), 'on');
assert.equal(statusText.textContent, 'Daily reminders are on for this browser.');
assert.equal(timeInput.disabled, false);
assert.equal(saveTime.hidden, false);
assert.equal(enable.hidden, true);
assert.equal(disable.hidden, false);

Notification.permission = 'denied';
events['dbs-notification-change']();
assert.equal(card.getAttribute('data-notification-state'), 'blocked');
assert.equal(statusText.textContent, 'Notifications are blocked in this browser.');
assert.equal(steps.hidden, false);
assert.equal(timeRow.hidden, true);
assert.equal(actions.hidden, true);

Notification.permission = 'granted';
document.cookie = 'dbs_notif_registered=no; dbs_notif_error=yes';
events['dbs-notification-change']();
assert.equal(card.getAttribute('data-notification-state'), 'failed');
assert.equal(statusText.textContent, 'Setup did not finish, so reminders are off.');
assert.equal(enable.textContent, 'Try again');
assert.equal(enable.hidden, false);
assert.equal(dismiss.hidden, false);
assert.equal(timeRow.hidden, true);

delete window.PushManager;
document.cookie = '';
events['dbs-notification-change']();
assert.equal(card.getAttribute('data-notification-state'), 'blocked');
assert.equal(statusText.textContent, 'Notifications are unavailable in this browser.');
assert.equal(steps.hidden, true);
assert.equal(actions.hidden, true);

console.log('v5.1.0 Privacy notification state checks: PASS');
