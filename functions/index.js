const https = require('https');
const admin = require('firebase-admin');
const functions = require('firebase-functions');
const agent = new https.Agent({ keepAlive: true });
const phin = require('phin');
const pRetry = require('p-retry');

console.log('Start instance!', new Date().toISOString());
admin.initializeApp(functions.config().firebase);
let db = admin.firestore();
let FieldValue = admin.firestore.FieldValue;

const sendNotification = ({ title, body }) => {
  admin.messaging().send({
    notification: {
      title,
      body,
    },
    topic: 'all',
    apns: {
      payload: {
        aps: {
          'mutable-content': 1,
        },
        image_url: 'https://rainshot.now.sh/',
      },
      fcm_options: {
        image: 'https://rainshot.now.sh/',
      },
    },
  });
};

const offset = 8; // Singapore timezone +0800
function datetimeNowStr(customMinutes) {
  // https://stackoverflow.com/a/11124448/20838
  const d = new Date(new Date().getTime() + offset * 3600 * 1000);
  if (customMinutes) d.setUTCMinutes(d.getUTCMinutes() + customMinutes);
  const year = d.getUTCFullYear();
  const month = ('' + (d.getUTCMonth() + 1)).padStart(2, '0');
  const day = ('' + d.getUTCDate()).padStart(2, '0');
  const hour = ('' + d.getUTCHours()).padStart(2, '0');
  const min = ('' + d.getUTCMinutes()).padStart(2, '0');
  return parseInt(year + month + day + hour + min, 10);
}

function datetimeStr(customMinutes) {
  const d = datetimeNowStr(customMinutes);
  return Math.floor(d / 5) * 5;
}

let lastDt;
let prevSgCoverage = 0;
let prevSGCoverageTimestamp = null;
let sgCoverageRef = db.collection('state').doc('sg-coverage');
sgCoverageRef.get().then((doc) => {
  if (doc.exists) {
    const { value, timestamp } = doc.data();
    prevSgCoverage = value;
    prevSGCoverageTimestamp = timestamp;
    console.log('prevSGCoverageTimestamp', prevSGCoverageTimestamp);
  }
});

function minusDts(dt1, dt2) {
  try {
    const time1 = dt1
      .toString()
      .match(/\d{4}$/)[0]
      .replace(/^(\d{2})/, '$1:');
    const time2 = dt2
      .toString()
      .match(/\d{4}$/)[0]
      .replace(/^(\d{2})/, '$1:');
    const date1 = new Date(`01/01/01 ${time1}`);
    const date2 = new Date(`01/01/01 ${time2}`);
    return (date1 - date2) / 1000 / 60;
  } catch (e) {
    return 0;
  }
}

const check = async () => {
  let dt = datetimeStr();
  console.log('✅', dt);
  if (lastDt == dt) return;

  let lastID;
  const snapshot = await db
    .collection('weather')
    .orderBy('id', 'desc')
    .limit(1)
    .get();
  if (!snapshot.empty) {
    lastID = snapshot.docs[0].id;
    if (lastID == dt) return;
  }

  // Sometimes the response might skip >5 or 10 minutes ahead
  // This is to fill up the blanks in between two timestamps
  if (minusDts(dt, lastID) > 5) {
    const missingID = datetimeStr(-5);
    console.log('📥📥', missingID);
    phin({
      url: `https://rain-geojson-sg.now.sh/v2/rainarea?dt=${missingID}`,
      parse: 'json',
      core: { agent },
    })
      .then((res) => {
        const data = res.body;
        if (data.error) return;
        db.collection('weather')
          .doc('' + missingID)
          .set({
            dt: +missingID,
            ...data,
          })
          .then(() => {
            console.log('💾💾', missingID);
          });
      })
      .catch((e) => {
        console.error(e);
      });
  }

  const request = async () => {
    const { body } = await phin({
      url: `https://rain-geojson-sg.now.sh/v2/rainarea?dt=${dt}`,
      parse: 'json',
      core: { agent },
    });
    if (body.error) {
      throw new Error(body.error);
    }
    return body;
  };
  const data = await pRetry(request, {
    retries: 14,
    factor: 1,
    minTimeout: 20 * 1000,
    onFailedAttempt: () => {
      console.log('⚠️ Failed attempt', dt);
    },
  });
  const {
    id,
    coverage_percentage: { all: coverage, sg: sgCoverage },
  } = data;

  console.log('📥', id);
  lastDt = id;
  if (id != lastID) {
    db.collection('weather')
      .doc(id)
      .set({
        dt: +id,
        ...data,
      })
      .then(() => {
        console.log('💾', id);
      });
  }

  if (
    (sgCoverage >= 5 || coverage >= 50) &&
    (Math.abs(prevSgCoverage - sgCoverage) > 15 || prevSgCoverage <= 5)
  ) {
    const fixedCoverage = coverage.toFixed(1).replace(/\.?0+$/, '');
    const fixedSgCoverage = sgCoverage.toFixed(1).replace(/\.?0+$/, '');
    console.log('SEND NOTIFICATION', id, fixedCoverage, fixedSgCoverage);
    sendNotification({
      title: `${'🌧'.repeat(
        Math.ceil(coverage / 20),
      )} Rain coverage: ${fixedCoverage}%`,
      body: `Rain coverage over Singapore: ${fixedSgCoverage}%`,
    });
    console.log('DIFFCOV 1', prevSgCoverage, sgCoverage);
    prevSgCoverage = sgCoverage;
    sgCoverageRef.set({
      value: sgCoverage,
      timestamp: FieldValue.serverTimestamp(),
    });
  } else if (sgCoverage < 5 && prevSgCoverage >= 5) {
    console.log('DIFFCOV 2', prevSgCoverage, sgCoverage);
    prevSgCoverage = 0;
    sgCoverageRef.set({ value: 0, timestamp: FieldValue.serverTimestamp() });
  }

  // Delete old docs every hour
  if (/00$/.test(dt)) {
    const pastDt = datetimeStr(-60 * 12); // older than 12 hours ago
    db.collection('weather')
      .where('dt', '<', pastDt)
      .get()
      .then((snapshot) => {
        if (snapshot.empty) return;

        // Delete documents in a batch
        let batch = db.batch();
        snapshot.docs.forEach((doc) => {
          batch.delete(doc.ref);
        });

        batch.commit().then(() => {
          console.log('Delete count', snapshot.size);
        });
      });
  }
};

exports.check = functions.region('asia-east2').https.onRequest((req, res) => {
  check();
  res.status(200).send('DONE');
});

exports.scheduledCheck = functions
  .runWith({
    timeoutSeconds: 281, // 4min 41s
  })
  .region('asia-east2')
  .pubsub.schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *')
  .timeZone('Asia/Singapore')
  .onRun((context) => {
    return check();
  });
