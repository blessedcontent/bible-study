/**
 * Send Daily Bible Study push notification via Firebase Cloud Messaging.
 * Runs as a frequent GitHub Action check. Each registration carries a local
 * time and IANA time zone; a Firestore date marker makes repeated runs safe.
 *
 * Reads all FCM registrations, sends only those whose local scheduled time is
 * due, and records success before a later run can retry the same local day.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { decodeHtmlEntities } = require('./decode-html-entities');

// Initialize Firebase Admin from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
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

function studyForDate(dateStr, weekday, cache) {
  if (cache[dateStr]) return cache[dateStr];
  const dayOfWeek = weekday === 'Saturday' ? 'Sabbath' : weekday;
  const studyFile = path.join(process.cwd(), `${dateStr}.html`);
  let studyTitle = `${dayOfWeek}'s Bible Study`;
  const studyExists = fs.existsSync(studyFile);
  if (studyExists) {
    const html = fs.readFileSync(studyFile, 'utf8');
    const titleMatch = html.match(/<meta\s+name="study-title"\s+content="([^"]+)"/);
    if (titleMatch) studyTitle = decodeHtmlEntities(titleMatch[1]);
  }
  cache[dateStr] = { exists: studyExists, title: studyTitle };
  return cache[dateStr];
}

async function main() {
  const now = new Date();

  // Get all FCM tokens from Firestore
  const tokensSnapshot = await db.collection('fcm_tokens').get();

  if (tokensSnapshot.empty) {
    console.log('No subscribers found. Skipping notification.');
    process.exit(0);
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
    const study = studyForDate(dateStr, parts.weekday, studies);
    if (!study.exists) {
      console.log(`Study ${dateStr} is unavailable for due registration ${registration.id}.`);
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
  if (failCount || missingStudyCount) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
