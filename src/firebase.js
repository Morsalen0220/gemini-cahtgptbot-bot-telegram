const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const fs = require("fs");
const path = require("path");

let dbInstance = null;
let isInitialized = false;

function parseServiceAccount() {
  // 1. Direct JSON or Base64 string in env (ideal for Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    if (raw.startsWith("{")) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
      }
    } else {
      // Try base64 decoding
      try {
        const decoded = Buffer.from(raw, "base64").toString("utf8");
        return JSON.parse(decoded);
      } catch (e) {
        console.error("Failed to decode base64 FIREBASE_SERVICE_ACCOUNT:", e.message);
      }
    }
  }

  // 2. File path in env or default local file
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
  if (fs.existsSync(keyPath)) {
    try {
      return JSON.parse(fs.readFileSync(keyPath, "utf8"));
    } catch (e) {
      console.error(`Failed to read Firebase service account from ${keyPath}:`, e.message);
    }
  }

  return null;
}

function isFirebaseConfigured() {
  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  const serviceAccount = parseServiceAccount();
  return Boolean(dbUrl && serviceAccount);
}

function initFirebase() {
  if (isInitialized) return dbInstance;

  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  const serviceAccount = parseServiceAccount();

  if (!dbUrl || !serviceAccount) {
    console.log("ℹ️ Firebase credentials not provided. Using local storage (./data/bot-data.json).");
    return null;
  }

  try {
    if (!admin.getApps().length) {
      admin.initializeApp({
        credential: admin.cert(serviceAccount),
        databaseURL: dbUrl
      });
    }
    dbInstance = getDatabase();
    isInitialized = true;
    console.log("🔥 Connected to Google Firebase Realtime Database successfully!");
    return dbInstance;
  } catch (err) {
    console.error("❌ Firebase initialization error:", err.message);
    return null;
  }
}

// Fetch all bot data from Firebase
async function fetchFirebaseData() {
  const db = initFirebase();
  if (!db) return null;

  try {
    const snapshot = await db.ref("botData").once("value");
    if (snapshot.exists()) {
      return snapshot.val();
    }
    return null;
  } catch (err) {
    console.error("Error reading from Firebase:", err.message);
    return null;
  }
}

// Save all bot data to Firebase
let syncTimeout = null;
function saveFirebaseData(data) {
  const db = initFirebase();
  if (!db) return;

  // Debounce writes slightly (200ms) to coalesce rapid sequential updates
  if (syncTimeout) clearTimeout(syncTimeout);

  syncTimeout = setTimeout(async () => {
    try {
      await db.ref("botData").set(data);
    } catch (err) {
      console.error("Error saving to Firebase:", err.message);
    }
  }, 200);
}

// Listen to real-time changes made directly in Firebase Console
function listenFirebaseData(callback) {
  const db = initFirebase();
  if (!db || typeof callback !== "function") return;

  db.ref("botData").on("value", (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.val());
    }
  }, (err) => {
    console.error("Firebase live listener error:", err.message);
  });
}

module.exports = {
  isFirebaseConfigured,
  initFirebase,
  fetchFirebaseData,
  saveFirebaseData,
  listenFirebaseData
};

