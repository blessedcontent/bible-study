/**
 * Send Daily Bible Study push notification via Firebase Cloud Messaging.
 * Runs as a GitHub Action at 8 AM Central daily.
 *
 * Reads all FCM tokens from Firestore, checks that today's study file
 * exists in the repo, then sends a notification to each subscriber.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Day names for notification text
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Sabbath'];

async function main() {
  // Get today's date in YYYY-MM-DD format (Central time)
  const now = new Date();
  // Adjust to Central time (UTC-5 or UTC-6)
  const centralOffset = -5; // CDT; change to -6 for CST in November
  const central = new Date(now.getTime() + (centralOffset * 60 * 60 * 1000));
  const year = central.getUTCFullYear();
  const month = String(central.getUTCMonth() + 1).padStart(2, '0');
  const day = String(central.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  const dayOfWeek = DAYS[central.getUTCDay()];

  console.log(`Date: ${dateStr} (${dayOfWeek})`);

  // Check if today's study file exists in the repo
  const studyFile = path.join(process.cwd(), `${dateStr}.html`);
  const stagingFile = path.join(process.cwd(), 'staging', `${dateStr}.html`);

  let studyTitle = `${dayOfWeek}'s Bible Study`;
  let studyExists = false;

  for (const filePath of [studyFile, stagingFile]) {
    if (fs.existsSync(filePath)) {
      studyExists = true;
      // Try to extract title from the HTML file
      const html = fs.readFileSync(filePath, 'utf8');
      const titleMatch = html.match(/<meta\s+name="study-title"\s+content="([^"]+)"/);
      if (titleMatch) {
        studyTitle = titleMatch[1];
      }
      break;
    }
  }

  if (!studyExists) {
    console.log(`No study file found for ${dateStr}. Skipping notification.`);
    process.exit(0);
  }

  console.log(`Study found: "${studyTitle}"`);

  // Get all FCM tokens from Firestore
  const tokensSnapshot = await db.collection('fcm_tokens').get();

  if (tokensSnapshot.empty) {
    console.log('No subscribers found. Skipping notification.');
    process.exit(0);
  }

  const tokens = [];
  const tokenDocs = {};
  tokensSnapshot.forEach(doc => {
    const data = doc.data();
    if (data.token) {
      tokens.push(data.token);
      tokenDocs[data.token] = doc.id;
    }
  });

  console.log(`Found ${tokens.length} subscriber(s).`);

  // Build the notification message
  const studyUrl = `https://blessedcontent.github.io/bible-study/${dateStr}.html`;

  // No top-level 'notification' key - this prevents FCM from trying
  // to auto-display, and forces the service worker's push event to
  // handle everything. More reliable on Android installed PWAs.
  const message = {
    webpush: {
      headers: {
        Urgency: 'high',
        TTL: '86400'
      },
      notification: {
        title: "Today's Study Is Ready",
        body: studyTitle,
        icon: 'https://blessedcontent.github.io/bible-study/icons/icon-192x192.png',
        badge: 'https://blessedcontent.github.io/bible-study/icons/icon-72x72.png',
        tag: 'daily-study',
        renotify: 'true'
      },
      fcmOptions: {
        link: studyUrl
      }
    },
    data: {
      url: studyUrl,
      date: dateStr,
      title: "Today's Study Is Ready",
      body: studyTitle
    }
  };

  // Send to each token individually (handles token cleanup)
  let successCount = 0;
  let failCount = 0;
  const tokensToDelete = [];

  for (const token of tokens) {
    try {
      await admin.messaging().send({ ...message, token });
      successCount++;
    } catch (error) {
      failCount++;
      // Remove invalid/expired tokens
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        console.log(`Removing invalid token: ${tokenDocs[token]}`);
        tokensToDelete.push(tokenDocs[token]);
      } else {
        console.log(`Send error for ${tokenDocs[token]}: ${error.code || error.message}`);
      }
    }
  }

  // Clean up invalid tokens
  for (const docId of tokensToDelete) {
    await db.collection('fcm_tokens').doc(docId).delete();
  }

  console.log(`Done: ${successCount} sent, ${failCount} failed, ${tokensToDelete.length} cleaned up.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
