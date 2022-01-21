const https = require('https');
const admin = require('firebase-admin');
const functions = require('firebase-functions');
const agent = new https.Agent({ keepAlive: true });
const phin = require('phin');
const pRetry = require('p-retry');

console.log('Start instance!', new Date().toISOString());
admin.initializeApp(functions.config().firebase);
let db = admin.firestore();

const TTL = 120; // 2 mins
const RADAR_IMAGE_URL = 'https://rainshot.checkweather.sg/';
const sendNotification = ({ title, body, id }) => {
  const imageURL = `${RADAR_IMAGE_URL}?dt=${id}`;
  const collapseKey = 'latest-radar';
  admin
    .messaging()
    .send({
      notification: {
        title,
        body,
        imageUrl: imageURL,
      },
      topic: 'all',
      apns: {
        payload: {
          aps: {
            'mutable-content': 1,
          },
        },
        headers: {
          'apns-expiration': '' + Math.round(Date.now() / 1000 + TTL),
          'apns-collapse-id': collapseKey,
        },
      },
      android: {
        ttl: TTL * 60 * 1000,
      },
      webpush: {
        headers: {
          TTL: '' + TTL,
        },
      },
    })
    .then((response) => {
      console.log('SENT NOTIFICATION', response);
    })
    .catch((error) => {
      console.warn('ERROR SENDING NOTIFICATION', error);
    });
};

const triggerWebhook = (data) => {
  const { webhook } = functions.config();
  if (!webhook || !webhook.url) return;
  const imageURL = `${RADAR_IMAGE_URL}?dt=${data.id}`;
  phin({
    url: webhook.url,
    method: 'POST',
    data: {
      ...data,
      imageURL,
    },
    core: { agent },
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

const TIMEOUT_SEC = 270; // 4min 30s
const MIN_TIMEOUT_SEC = 10;
const RETRIES = Math.floor(TIMEOUT_SEC / MIN_TIMEOUT_SEC);

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
    let i = 1;
    const fillBackLimit = 5;
    let currentMissingID;
    do {
      const missingID = (currentMissingID = datetimeStr(i++ * -5));
      console.log('📥📥', missingID);
      phin({
        url: `https://api.checkweather.sg/v2/rainarea?dt=${missingID}`,
        parse: 'json',
        core: { agent },
      })
        .then((res) => {
          const data = res.body;
          if (data.error) return;
          const { id } = data;
          db.collection('weather')
            .doc(id)
            .set(data)
            .then(() => {
              console.log('💾💾', id);
            })
            .catch((e) => {
              console.log('💾⚠️', id);
              console.error(e);
            });
        })
        .catch((e) => {
          console.error(e);
        });
    } while (currentMissingID !== lastID && i < fillBackLimit);
  }

  const request = async () => {
    const { body } = await phin({
      url: `https://api.checkweather.sg/v2/rainarea?dt=${dt}`,
      parse: 'json',
      core: { agent },
    });
    if (body.error) {
      throw new Error(body.error);
    }
    return body;
  };
  const data = await pRetry(request, {
    retries: RETRIES,
    factor: 1,
    minTimeout: MIN_TIMEOUT_SEC * 1000,
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
      .set(data)
      .then(() => {
        console.log('💾', id);
      });
  }

  const sgCoverageTimestamp = Date.now();
  if (
    (sgCoverage >= 5 || coverage >= 50) &&
    sgCoverageTimestamp - prevSGCoverageTimestamp >= 30 * 60 * 1000 &&
    (Math.abs(prevSgCoverage - sgCoverage) > 15 ||
      prevSgCoverage <= 5 ||
      (sgCoverage === 100 && prevSgCoverage < 100) ||
      (sgCoverage >= 99 && prevSgCoverage < 99))
  ) {
    const fixedCoverage = coverage.toFixed(1).replace(/\.?0+$/, '');
    const fixedSgCoverage = sgCoverage.toFixed(1).replace(/\.?0+$/, '');

    const title = `${'🌧'.repeat(
      Math.ceil(coverage / 20),
    )} Rain coverage: ${fixedCoverage}%`;
    const body = `Rain coverage over Singapore: ${fixedSgCoverage}%`;

    console.log('SEND NOTIFICATION', id, fixedCoverage, fixedSgCoverage);
    sendNotification({
      title,
      body,
      id,
    });

    triggerWebhook({
      title,
      body,
      id,
    });

    console.log(
      'DIFFCOV 1',
      prevSgCoverage,
      sgCoverage,
      prevSGCoverageTimestamp,
      sgCoverageTimestamp,
    );
    prevSgCoverage = sgCoverage;
    prevSGCoverageTimestamp = sgCoverageTimestamp;
    sgCoverageRef.set({
      value: sgCoverage,
      timestamp: sgCoverageTimestamp,
    });
  } else if (sgCoverage < 5 && prevSgCoverage >= 5) {
    console.log(
      'DIFFCOV 2',
      prevSgCoverage,
      sgCoverage,
      prevSGCoverageTimestamp,
      sgCoverageTimestamp,
    );
    prevSgCoverage = 0;
    prevSGCoverageTimestamp = 0;
    sgCoverageRef.set({ value: 0, timestamp: 0 });
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
  // check();
  res.status(200).send('DONE');
});

exports.scheduledCheck = functions
  .runWith({
    timeoutSeconds: TIMEOUT_SEC + 1, // Additional 1s for safety
    maxInstances: 1,
  })
  .region('asia-east2')
  .pubsub.schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *')
  .timeZone('Asia/Singapore')
  .onRun((context) => {
    return check();
  });
