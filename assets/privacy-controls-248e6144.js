/* Local reader-preference controls for the privacy page. */
(function () {
  'use strict';
  var clear = document.querySelector('[data-clear-local]');
  var timeInput = document.querySelector('[data-notif-time]');
  var saveTime = document.querySelector('[data-save-notif-time]');
  if (!clear && !timeInput) return;
  function makeStatus(after) {
    var status = document.createElement('p');
    status.className = 'form-note';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    after.parentNode.insertBefore(status, after.nextSibling);
    return status;
  }
  var localStatus = clear ? makeStatus(clear.closest('.control-row')) : null;
  var scheduleStatus = timeInput ? document.querySelector('[data-notif-time-status]') : null;
  if (timeInput && !scheduleStatus) scheduleStatus = makeStatus(timeInput.closest('.control-row'));
  function isHalfHourTime(value) {
    return /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value || '');
  }
  if (timeInput) {
    try {
      var savedTime = localStorage.getItem('dbs_notif_time');
      timeInput.value = isHalfHourTime(savedTime) ? savedTime : '07:30';
    }
    catch (error) { timeInput.value = '07:30'; }
  }
  function expireCookie(name, path) {
    document.cookie = name + '=;path=' + path + ';max-age=0;SameSite=Lax;Secure';
  }
  if (clear) clear.addEventListener('click', function () {
    try {
      localStorage.removeItem('dbs_theme');
      localStorage.removeItem('dbs_red_letter');
      localStorage.removeItem('dbs_notif_time');
    } catch (error) {}
    ['dbs_notif', 'dbs_notif_error'].forEach(function (name) {
      expireCookie(name, '/bible-study/');
      expireCookie(name, '/');
    });
    localStatus.textContent = 'Local display and notification-choice preferences were cleared. Your saved reminder time stays in effect until you choose a new one. Notifications were not turned off. To remove this browser’s registration, use “Turn notifications off” below.';
  });
  if (saveTime && timeInput) saveTime.addEventListener('click', function () {
    scheduleStatus.hidden = false;
    if (!window.dbsNotifSetSchedule) {
      scheduleStatus.textContent = 'Notification scheduling is not available in this browser.';
      return;
    }
    window.dbsNotifSetSchedule(timeInput.value).then(function (result) {
      scheduleStatus.textContent = result.savedLocally
        ? 'Preferred time saved. It will be applied when notifications are turned on.'
        : 'Notification time updated for this browser.';
    }).catch(function () {
      scheduleStatus.textContent = 'The notification time could not be saved. Please try again.';
    });
  });
})();
