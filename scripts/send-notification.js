/**
 * Send Daily Bible Study push notification via Firebase Cloud Messaging.
 * Runs as a frequent GitHub Action check. Each registration carries a local
 * time and IANA time zone; a Firestore date marker makes repeated runs safe.
 *
 * Reads all FCM registrations, sends only those whose local scheduled time is
 * due, and records success before a later run can retry the same local day.
 */

const { centralDates, liveStudy } = require('./live-study');
const siteOrigin = (process.env.DBS_SITE_ORIGIN || 'https://blessedcontent.github.io').replace(/\/$/, '');
const siteBasePath = '/' + (process.env.DBS_SITE_BASE_PATH || 'bible-study').replace(/^\/+|\/+$/g, '');

function dateParts(now, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long'
    }).formatToParts(now).filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
}

function validTimeZone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return value; }
  catch (error) { return 'America/Chicago'; }
}

function scheduledMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return 7 * 60 + 30;
  return Number(match[1]) * 60 + Number(match[2]);
}

function studyForDate(dateStr, cache, options) {
  if (!cache[dateStr]) cache[dateStr] = liveStudy(dateStr, options);
  return cache[dateStr];
}

async function main(options = {}) {
  const now = options.now || new Date();
  const checkOptions = {
    root: options.root || process.cwd(), fetchImpl: options.fetchImpl || globalThis.fetch,
    baseUrl: `${siteOrigin}${siteBasePath}/`
  };
  if (options.dryRun) {
    const date = centralDates(now).today;
    const study = await studyForDate(date, {}, checkOptions);
    console.log(`DRY RUN live check ${study.url}: ${study.reason}`);
    console.log('DRY RUN: no Firebase initialization, registration reads, sends or Firestore writes.');
    return { successCount: 0, failCount: 0, notDueCount: 0, missingStudyCount: 0, live: study };
  }
  const admin = options.admin || require('firebase-admin');
  if (!options.admin) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  // Get all FCM tokens from Firestore
  const tokensSnapshot = await db.collection('fcm_tokens').get();

  if (tokensSnapshot.empty) {
    console.log('No subscribers found. Skipping notification.');
    return { successCount: 0, failCount: 0, notDueCount: 0, missingStudyCount: 0 };
  }

  const registrations = [];
  tokensSnapshot.forEach(doc => { if (doc.data().token) registrations.push({ id: doc.id, ...doc.data() }); });
  console.log(`Found ${registrations.length} subscriber(s).`);

  // Send to each token individually (handles token cleanup)
  let successCount = 0;
  let failCount = 0;
  let notDueCount = 0;
  let missingStudyCount = 0;
  const studies = {};

  for (const registration of registrations) {
    const timeZone = validTimeZone(registration.timeZone || 'America/Chicago');
    const parts = dateParts(now, timeZone);
    const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
    const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (registration.lastSentDate === dateStr ||
        localMinutes < scheduledMinutes(registration.notificationTime)) {
      notDueCount++;
      continue;
    }
    const study = await studyForDate(dateStr, studies, checkOptions);
    if (!study.live) {
      console.log(`Skipping registration ${registration.id}: ${study.url} is not live (${study.reason}). No marker written; retry next run.`);
      missingStudyCount++;
      continue;
    }
    const studyUrl = `${siteOrigin}${siteBasePath}/${dateStr}.html`;
    const message = {
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' },
        notification: {
          title: "Today's Study Is Ready", body: study.title,
          icon: `${siteOrigin}${siteBasePath}/icons/icon-192x192.png`,
          badge: `${siteOrigin}${siteBasePath}/icons/badge-96x96.png`,
          tag: `daily-study-${dateStr}`, renotify: 'true'
        },
        fcmOptions: { link: studyUrl }
      },
      data: { url: studyUrl, date: dateStr, title: "Today's Study Is Ready", body: study.title }
    };
    try {
      await admin.messaging().send({ ...message, token: registration.token });
      await db.collection('fcm_tokens').doc(registration.id).set({
        lastSentDate: dateStr,
        lastSentAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      successCount++;
    } catch (error) {
      failCount++;
      // Remove invalid/expired tokens
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        console.log(`Removing invalid token: ${registration.id}`);
        await db.collection('fcm_tokens').doc(registration.id).delete();
      } else {
        console.log(`Send error for ${registration.id}: ${error.code || error.message}`);
      }
    }
  }
  console.log(`Done: ${successCount} sent, ${failCount} failed, ${notDueCount} not due, ${missingStudyCount} missing study.`);
  return { successCount, failCount, notDueCount, missingStudyCount };
}

module.exports = { main, studyForDate, dateParts, validTimeZone, scheduledMinutes };

if (require.main === module) {
  main({ dryRun: process.argv.includes('--dry-run') }).then(result => {
    if (result.failCount || result.missingStudyCount) process.exitCode = 1;
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}
