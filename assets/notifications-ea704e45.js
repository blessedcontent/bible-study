/* Daily Bible Study notification controls.
   Records opt-in only after browser permission, Firebase registration and the
   Firestore write all succeed. Public functions are always defined so the
   reader menu and Privacy page work in every state. */
(function () {
  'use strict';

  var firebaseConfig = {
    apiKey: 'AIzaSyCkxvPgrgtVOVFhE3iprkZsM9iQT_xf-do',
    authDomain: 'blessed-content-bible-study.firebaseapp.com',
    projectId: 'blessed-content-bible-study',
    storageBucket: 'blessed-content-bible-study.firebasestorage.app',
    messagingSenderId: '707607010200',
    appId: '1:707607010200:web:7f15b6b0fd3d662ab469ed',
    measurementId: 'G-BY2BM5HTX4'
  };
  var vapidKey = 'BNBrwPnK6OvDZ-QdVztthcprC77oHv2NY3tD1NKa2Fu4ls1yWbtQ_SC9DL1WhMkj0DC_YfFzHAgRJiidhiN96HI';
  var supported = 'Notification' in window &&
    'serviceWorker' in navigator && 'PushManager' in window;
  var bannerMode = 'invite';
  var confirmationTimer = null;

  function isHalfHourTime(value) {
    return /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value || '');
  }

  function notificationSchedule() {
    var time = '07:30';
    try { time = localStorage.getItem('dbs_notif_time') || time; } catch (error) {}
    if (!isHalfHourTime(time)) time = '07:30';
    var timeZone = 'America/Chicago';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone; } catch (error) {}
    return { notificationTime: time, timeZone: timeZone };
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }
  function setCookie(name, value) {
    document.cookie = name + '=' + encodeURIComponent(value) +
      ';path=/bible-study/;max-age=31536000;SameSite=Lax;Secure';
  }
  function notifyChange() {
    window.dispatchEvent(new Event('dbs-notification-change'));
  }
  function banner() { return document.getElementById('notifBanner'); }
  function bannerText() {
    var node = banner();
    return node ? node.querySelector('.notif-banner-text') : null;
  }
  function bannerButtons() {
    var node = banner();
    return node ? {
      yes: node.querySelector('.notif-btn-yes'),
      no: node.querySelector('.notif-btn-no')
    } : { yes: null, no: null };
  }
  function writeBannerMessage(message, linkLabel) {
    var text = bannerText();
    if (!text) return;
    text.textContent = message;
    text.setAttribute('role', 'status');
    text.setAttribute('aria-live', 'polite');
    if (linkLabel) {
      text.appendChild(document.createTextNode(' '));
      var link = document.createElement('a');
      link.href = '/bible-study/privacy.html#notifications';
      link.textContent = linkLabel;
      text.appendChild(link);
    }
  }
  function setBannerState(mode, error) {
    bannerMode = mode;
    var node = banner();
    var buttons = bannerButtons();
    if (!node) return;
    if (confirmationTimer) {
      window.clearTimeout(confirmationTimer);
      confirmationTimer = null;
    }
    node.removeAttribute('aria-busy');
    if (buttons.yes) {
      buttons.yes.hidden = false;
      buttons.yes.disabled = false;
      buttons.yes.textContent = mode === 'failure' ? 'Try again' : 'Yes, notify me';
    }
    if (buttons.no) {
      buttons.no.hidden = false;
      buttons.no.disabled = false;
      buttons.no.textContent = mode === 'invite' ? 'No thanks' : 'Close';
    }
    if (mode === 'pending') {
      writeBannerMessage('Turning on daily reminders…');
      node.setAttribute('aria-busy', 'true');
      if (buttons.yes) buttons.yes.disabled = true;
      if (buttons.no) buttons.no.disabled = true;
      return;
    }
    if (mode === 'success') {
      writeBannerMessage(
        'Daily reminders are on for this browser.',
        'Change the reminder time in reader controls.'
      );
      if (buttons.yes) buttons.yes.hidden = true;
      if (buttons.no) buttons.no.hidden = true;
      confirmationTimer = window.setTimeout(hideBanner, 10000);
      return;
    }
    if (mode === 'failure') {
      var detail = error && (error.message || String(error));
      var blocked = !supported || Notification.permission === 'denied' ||
        /permission was not granted/i.test(detail || '');
      writeBannerMessage(
        !supported ? 'This browser does not support website notifications.' :
          (blocked ? 'Notifications are blocked or were not allowed in this browser.' :
          (/push service error/i.test(detail || '') ?
            'Your browser did not finish connecting to its messaging service. Turn on push messaging in your browser settings, then try again.' :
            'Notification setup did not finish. Check your connection, then try again.')),
        'Open reader controls for help.'
      );
      if (blocked && buttons.yes) buttons.yes.hidden = true;
    }
  }
  function hideBanner() {
    var node = banner();
    if (!node) return;
    node.classList.add('hidden');
    node.setAttribute('aria-hidden', 'true');
  }
  function showBanner() {
    var node = banner();
    if (!node) return;
    node.classList.remove('hidden');
    node.setAttribute('aria-hidden', 'false');
  }
  function setFailure(error) {
    setCookie('dbs_notif_registered', 'no');
    var detail = error && (error.message || String(error));
    setCookie('dbs_notif_error', /push service error/i.test(detail || '') ? 'push-service' : 'yes');
    notifyChange();
  }
  function messagingServices() {
    if (!window.firebase) throw new Error('Firebase is unavailable');
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    return { messaging: firebase.messaging(), db: firebase.firestore() };
  }

  function register(askPermission) {
    if (!supported) return Promise.reject(new Error('Notifications are unsupported'));
    var permission = Promise.resolve(Notification.permission);
    if (askPermission && Notification.permission === 'default') {
      permission = Notification.requestPermission();
    }
    return permission.then(function (result) {
      if (result !== 'granted') throw new Error('Notification permission was not granted');
      var services = messagingServices();
      return navigator.serviceWorker.ready.then(function (swReg) {
        return services.messaging.getToken({
          vapidKey: vapidKey,
          serviceWorkerRegistration: swReg
        });
      }).then(function (token) {
        if (!token) throw new Error('Firebase did not return a notification token');
        var schedule = notificationSchedule();
        return services.db.collection('fcm_tokens').doc(token.substring(0, 32)).set({
          token: token,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          userAgent: navigator.userAgent.substring(0, 100),
          notificationTime: schedule.notificationTime,
          timeZone: schedule.timeZone
        }, { merge: true });
      }).then(function () {
        setCookie('dbs_notif', 'yes');
        setCookie('dbs_notif_registered', 'yes');
        setCookie('dbs_notif_error', 'no');
        notifyChange();
      });
    });
  }

  window.dbsNotifOptIn = function () {
    showBanner();
    setBannerState('pending');
    return register(true).then(function () {
      setBannerState('success');
      return true;
    }).catch(function (error) {
      setFailure(error);
      setBannerState('failure', error);
      console.log('Notification setup error:', error);
      return false;
    });
  };

  window.dbsNotifDismiss = function () {
    hideBanner();
    if (bannerMode === 'invite') {
      setCookie('dbs_notif', 'no');
      setCookie('dbs_notif_error', 'no');
    }
    notifyChange();
    return true;
  };

  window.dbsNotifDisable = function () {
    hideBanner();
    if (!supported || Notification.permission !== 'granted') {
      setCookie('dbs_notif', 'no');
      setCookie('dbs_notif_registered', 'no');
      setCookie('dbs_notif_error', 'no');
      notifyChange();
      return Promise.resolve(true);
    }
    try {
      var services = messagingServices();
      return navigator.serviceWorker.ready.then(function (swReg) {
        return services.messaging.getToken({
          vapidKey: vapidKey,
          serviceWorkerRegistration: swReg
        });
      }).then(function (token) {
        var removeRecord = Promise.resolve();
        if (token) {
          removeRecord = services.db.collection('fcm_tokens')
            .doc(token.substring(0, 32)).delete();
        }
        return removeRecord.then(function () {
          return services.messaging.deleteToken();
        });
      }).then(function () {
        setCookie('dbs_notif', 'no');
        setCookie('dbs_notif_registered', 'no');
        setCookie('dbs_notif_error', 'no');
        notifyChange();
        return true;
      }).catch(function (error) {
        setFailure(error);
        console.log('Notification removal error:', error);
        return false;
      });
    } catch (error) {
      setFailure(error);
      console.log('Notification removal error:', error);
      return Promise.resolve(false);
    }
  };

  window.dbsNotifSetSchedule = function (time) {
    if (!isHalfHourTime(time)) {
      return Promise.reject(new Error('Choose a reminder time on the hour or half hour'));
    }
    try { localStorage.setItem('dbs_notif_time', time); } catch (error) {}
    if (!supported || Notification.permission !== 'granted' ||
        getCookie('dbs_notif_registered') !== 'yes') {
      return Promise.resolve({ savedLocally: true });
    }
    return register(false).then(function () { return { savedLocally: false }; });
  };

  if (!supported || Notification.permission === 'denied' ||
      getCookie('dbs_notif') === 'no') return;
  if (Notification.permission === 'granted' &&
      getCookie('dbs_notif_registered') === 'yes') {
    register(false).catch(function (error) {
      setFailure(error);
      console.log('Notification refresh error:', error);
    });
    return;
  }
  var previousError = getCookie('dbs_notif_error');
  if (previousError === 'push-service' || previousError === 'yes') {
    window.setTimeout(function () {
      showBanner();
      setBannerState('failure', new Error(
        previousError === 'push-service' ? 'push service error' : 'previous setup error'
      ));
    }, 2000);
    return;
  }
  window.setTimeout(showBanner, 2000);
})();
