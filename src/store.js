const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  isFirebaseConfigured,
  initFirebase,
  fetchFirebaseData,
  saveFirebaseData,
  listenFirebaseData
} = require("./firebase");
const { defaultChannelPosts } = require("./channelPosts");

const file = process.env.DATABASE_FILE || "./data/bot-data.json";
fs.mkdirSync(path.dirname(file), { recursive: true });

const defaultSettings = {
  bot_title: "Gemini AI Shop",
  channel_id: process.env.FORCE_CHANNEL_ID || "",
  channel_link: process.env.FORCE_CHANNEL_LINK || "https://t.me/",
  group_id: process.env.FORCE_GROUP_ID || "",
  group_link: process.env.FORCE_GROUP_LINK || "https://t.me/",
  force_join_enabled: false,
  bep20_usdt_address: process.env.BEP20_USDT_ADDRESS || "0xC3fC8C91A5B26C71DcD0aC1F34944FB298bCeBbF",
  polygon_usdt_address: process.env.POLYGON_USDT_ADDRESS || "0x58F0C60b37E5c84C4C7fE4a553F1fCe6405F412b",
  binance_pay_id: process.env.BINANCE_PAY_ID || "",
  bep20_deposit_desc: "",
  binance_deposit_desc: "",
  support_username: process.env.SUPPORT_USERNAME || "@aibuyshop_support",
  referral_bonus_percent: 5,
  min_crypto_deposit: 1.00,
  fake_sales_broadcast_enabled: true,
  fake_deposits_broadcast_enabled: true,
  channel_auto_post_enabled: true,
  channel_post_morning_time: "10:00",
  channel_post_evening_time: "19:30",
  channel_post_index: 0,
  channel_last_post_slot: "",
  deposit_paid_auto_msg: "⏳ Thank you for clicking I've Paid! We are verifying your payment. Please make sure to send your Transaction Hash (TxID) or screenshot if you haven't already. Your balance will be added shortly!",
  deposit_second_auto_msg: "✅ We have received your payment screenshot! Our admin team is reviewing your proof now and your wallet balance will be credited shortly."
};

const defaultProducts = [
  {
    id: "gemini_18m",
    name: "Gemini Links 18M",
    category: "standard",
    price: 0.55,
    stock: 1048,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 100, price: 0.55 },
      { min: 101, max: 999999, price: 0.50 }
    ],
    description: `✅ Official 18-Month Plan on your Gmail (2TB Cloud Storage)
⚡️ Instant automated redeem link delivery • 100% Guaranteed`,
    terms: `• Fresh & valid redeem link delivered instantly
• Must redeem within 24 hours of delivery
• Non-refundable after delivery`,
    codes: []
  },
  {
    id: "netflix_1m",
    name: "Netflix 1M 4K HDR",
    category: "standard",
    price: 2.50,
    stock: 0,
    outOfStock: true,
    bulk_tiers: [],
    description: `✅ 1 Month 4K UHD Profile (Private PIN)
⚡️ Instant automated delivery • Works on TV, PC & Mobile`,
    terms: `• No refunds after credentials are sent
• Do not change account email or master password`,
    codes: []
  },
  {
    id: "duolingo_12m",
    name: "Duolingo 12M",
    category: "standard",
    price: 0.40,
    stock: 294,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.40 },
      { min: 51, max: 999999, price: 0.35 }
    ],
    description: `✅ Duolingo Super 12 Months (Unlimited hearts & no ads)
⚡️ Instant activation • 100% Full period guarantee`,
    terms: `• Non-refundable once activated
• Guaranteed valid for 12 months`,
    codes: []
  },
  {
    id: "adobe_express_12m",
    name: "Adobe Express 12M",
    category: "standard",
    price: 1.00,
    stock: 204,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 1.00 },
      { min: 51, max: 999999, price: 0.90 }
    ],
    description: `✅ Adobe Express Premium 12 Months + 100GB Cloud
⚡️ Generative AI credits included • Instant delivery`,
    terms: `• Full period replacement guarantee
• Activated directly on Adobe ID`,
    codes: []
  },
  {
    id: "apple_music_5m",
    name: "Apple Music 5M",
    category: "standard",
    price: 0.85,
    stock: 180,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.85 },
      { min: 51, max: 999999, price: 0.75 }
    ],
    description: `✅ Apple Music 5 Months Individual (Lossless & Spatial Audio)
⚡️ Instant official promo code delivery • 100% Active`,
    terms: `• Single use promo code
• Applicable for new and eligible returning accounts`,
    codes: []
  },
  // ==========================================
  // AI API KEYS & CLOUD TOKENS (category: "api_key")
  // ==========================================
  {
    id: "gemini_api_key",
    name: "Gemini 1.5 Pro API Key",
    category: "api_key",
    price: 3.50,
    stock: 250,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 3.50 },
      { min: 11, max: 999999, price: 3.00 }
    ],
    description: `✅ Official Google Gemini 1.5 Pro API Key for Cursor & Python
⚡️ High RPM/TPM limits • Instant automated token delivery`,
    terms: `• Key delivered instantly to your chat
• Guaranteed active & fresh on arrival`,
    codes: []
  },
  {
    id: "chatgpt_api_key",
    name: "ChatGPT OpenAI API Key ($5 / $120 Credit)",
    category: "api_key",
    price: 4.50,
    stock: 180,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 4.50 },
      { min: 11, max: 999999, price: 4.00 }
    ],
    description: `✅ Official OpenAI API Key (GPT-4o & DALL-E 3 supported)
⚡️ Pre-funded Tier 1 credits • Instant automated delivery`,
    terms: `• Instant automated key delivery
• Replacement guarantee if invalid on arrival`,
    codes: []
  },
  {
    id: "claude_api_key",
    name: "Claude 3.5 Sonnet API Key",
    category: "api_key",
    price: 6.50,
    stock: 120,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 6.50 },
      { min: 11, max: 999999, price: 5.80 }
    ],
    description: `✅ Anthropic Claude 3.5 Sonnet API Key (200k Context)
⚡️ Ideal for Cursor, Cline & Claude Dev • Instant delivery`,
    terms: `• Instant automated key delivery
• Fresh token with verified quota`,
    codes: []
  },
  {
    id: "google_cloud_key",
    name: "Google Cloud (GCC) $300 Credits Key",
    category: "api_key",
    price: 9.50,
    stock: 75,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 5, price: 9.50 },
      { min: 6, max: 999999, price: 8.50 }
    ],
    description: `✅ Google Cloud Console $300 Free Trial Credit Account
⚡️ Deploy Vertex AI & Compute VMs • Instant account delivery`,
    terms: `• Digital account credentials delivered instantly
• Valid balance guaranteed on initial login`,
    codes: []
  },
  {
    id: "deepseek_api_key",
    name: "DeepSeek V3 / R1 API Key & Tokens",
    category: "api_key",
    price: 2.50,
    stock: 300,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 2.50 },
      { min: 11, max: 999999, price: 2.00 }
    ],
    description: `✅ Official DeepSeek V3 & R1 Reasoning API Key
⚡️ Ultra-low latency, OpenAI compatible • Instant delivery`,
    terms: `• Instant automated token delivery
• Guaranteed 100% active`,
    codes: []
  }
];

const defaults = {
  settings: defaultSettings,
  products: defaultProducts,
  channel_posts: defaultChannelPosts,
  users: {},
  deposits: [],
  orders: [],
  tickets: []
};

let memoryDb = null;

function normalizeDb(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  if (!raw.settings || typeof raw.settings !== "object") {
    raw.settings = { ...defaultSettings };
  } else {
    for (const [k, v] of Object.entries(defaultSettings)) {
      if (raw.settings[k] === undefined) raw.settings[k] = v;
    }
    if (!raw.settings.binance_pay_id && process.env.BINANCE_PAY_ID) {
      raw.settings.binance_pay_id = process.env.BINANCE_PAY_ID;
    }
    if (typeof raw.settings.min_crypto_deposit !== "number" || isNaN(raw.settings.min_crypto_deposit) || raw.settings.min_crypto_deposit <= 0) {
      raw.settings.min_crypto_deposit = 1.00;
    }
  }

  if (!Array.isArray(raw.products)) {
    if (raw.products && typeof raw.products === "object") {
      raw.products = Object.values(raw.products);
    } else {
      raw.products = [...defaultProducts];
    }
  }

  for (const defP of defaultProducts) {
    const existing = raw.products.find(p => String(p.id) === String(defP.id));
    if (!existing) {
      raw.products.push(defP);
    } else {
      if (!existing.category) existing.category = defP.category || "standard";
      if (existing.description === undefined || existing.description.length > 150) {
        existing.description = defP.description;
      }
      if (existing.terms === undefined) existing.terms = defP.terms;
      if (existing.price === undefined) existing.price = defP.price;
      if (existing.bulk_tiers === undefined) existing.bulk_tiers = defP.bulk_tiers;
    }
  }

  // Ensure channel_posts is populated with at least the 85+ default posts
  if (!Array.isArray(raw.channel_posts) || raw.channel_posts.length === 0) {
    if (raw.channel_posts && typeof raw.channel_posts === "object") {
      raw.channel_posts = Object.values(raw.channel_posts);
    } else {
      raw.channel_posts = [...defaultChannelPosts];
    }
  }
  if (raw.channel_posts.length < defaultChannelPosts.length) {
    for (const cp of defaultChannelPosts) {
      if (!raw.channel_posts.includes(cp)) {
        raw.channel_posts.push(cp);
      }
    }
  }

  if (!raw.users || typeof raw.users !== "object") {
    raw.users = {};
  } else {
    const cleanedUsers = {};
    for (const [k, v] of Object.entries(raw.users)) {
      if (v && typeof v === "object") {
        const uid = String(v.id ?? k).trim();
        if (uid && uid !== "undefined" && uid !== "null") {
          v.id = v.id ?? k;
          cleanedUsers[uid] = v;
        }
      }
    }
    raw.users = cleanedUsers;
  }
  if (!Array.isArray(raw.deposits)) {
    if (raw.deposits && typeof raw.deposits === "object") raw.deposits = Object.values(raw.deposits);
    else raw.deposits = [];
  }
  if (!Array.isArray(raw.orders)) {
    if (raw.orders && typeof raw.orders === "object") raw.orders = Object.values(raw.orders);
    else raw.orders = [];
  }
  if (!Array.isArray(raw.tickets)) {
    if (raw.tickets && typeof raw.tickets === "object") raw.tickets = Object.values(raw.tickets);
    else raw.tickets = [];
  }

  return raw;
}

function loadLocalFile() {
  if (!fs.existsSync(file)) {
    const fresh = structuredClone(defaults);
    try {
      fs.writeFileSync(file, JSON.stringify(fresh, null, 2), "utf8");
    } catch (e) {}
    return fresh;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeDb(parsed);
  } catch (err) {
    console.error("Error reading local database file, using defaults:", err.message);
    return structuredClone(defaults);
  }
}

async function initStore() {
  if (isFirebaseConfigured()) {
    try {
      initFirebase();
      const remoteData = await fetchFirebaseData();
      if (remoteData && (remoteData.products || remoteData.users || remoteData.settings)) {
        console.log("📥 Loaded database snapshot from Google Firebase Realtime Database!");
        memoryDb = normalizeDb(remoteData);
        try {
          fs.writeFileSync(file, JSON.stringify(memoryDb, null, 2), "utf8");
        } catch (e) {}
      } else {
        console.log("📤 Initializing Firebase Realtime Database with local database seed...");
        memoryDb = loadLocalFile();
        saveFirebaseData(memoryDb);
      }

      // Realtime listener for console updates
      listenFirebaseData((remoteUpdated) => {
        if (remoteUpdated) {
          memoryDb = normalizeDb(remoteUpdated);
          try {
            fs.writeFileSync(file, JSON.stringify(memoryDb, null, 2), "utf8");
          } catch (e) {}
        }
      });
      return memoryDb;
    } catch (e) {
      console.error("Firebase startup sync error, falling back to local file:", e.message);
      memoryDb = loadLocalFile();
      return memoryDb;
    }
  } else {
    memoryDb = loadLocalFile();
    return memoryDb;
  }
}

function load() {
  if (!memoryDb) {
    memoryDb = loadLocalFile();
  }
  return memoryDb;
}

function save(db) {
  memoryDb = db;
  try {
    fs.writeFileSync(file, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("Local file write error:", e.message);
  }
  if (isFirebaseConfigured()) {
    saveFirebaseData(db);
  }
}

// ----------------------------------------------------
// SETTINGS
// ----------------------------------------------------
function getSetting(k) {
  const db = load();
  return db.settings[k] ?? "";
}

function getAllSettings() {
  return load().settings;
}

function setSetting(k, v) {
  const db = load();
  db.settings[k] = v;
  save(db);
}

// ----------------------------------------------------
// PRODUCTS
// ----------------------------------------------------
function getProducts() {
  return load().products;
}

function getStandardProducts() {
  return load().products.filter(p => p.category !== "api_key");
}

function getApiKeyProducts() {
  return load().products.filter(p => p.category === "api_key");
}

function getProduct(id) {
  return load().products.find(p => String(p.id) === String(id));
}

function updateProduct(id, fields) {
  const db = load();
  const idx = db.products.findIndex(p => String(p.id) === String(id));
  if (idx === -1) throw new Error("Product not found");
  db.products[idx] = { ...db.products[idx], ...fields };
  save(db);
  return db.products[idx];
}

function addProduct(product) {
  const db = load();
  db.products.push(product);
  save(db);
  return product;
}

function deleteProduct(id) {
  const db = load();
  const idx = db.products.findIndex(p => String(p.id) === String(id));
  if (idx === -1) return false;
  db.products.splice(idx, 1);
  save(db);
  return true;
}

function calculateProductPrice(product, quantity) {
  const qty = Math.max(1, Number(quantity) || 1);
  if (Array.isArray(product.bulk_tiers) && product.bulk_tiers.length > 0) {
    for (const tier of product.bulk_tiers) {
      if (qty >= tier.min && qty <= tier.max) {
        return {
          unitPrice: Number(tier.price),
          totalPrice: Number((tier.price * qty).toFixed(2))
        };
      }
    }
  }
  return {
    unitPrice: Number(product.price),
    totalPrice: Number((product.price * qty).toFixed(2))
  };
}

function addProductCodes(productId, newCodes) {
  const db = load();
  const p = db.products.find(x => String(x.id) === String(productId));
  if (!p) throw new Error("Product not found");
  if (!Array.isArray(p.codes)) p.codes = [];
  p.codes.push(...newCodes);
  p.stock = (p.stock || 0) + newCodes.length;
  if (p.stock > 0) p.outOfStock = false;
  save(db);
  return p;
}

// Dispenses up to `quantity` codes from inventory
function dispenseProductCodes(productId, quantity) {
  const db = load();
  const p = db.products.find(x => String(x.id) === String(productId));
  if (!p) throw new Error("Product not found");
  if (!Array.isArray(p.codes)) p.codes = [];
  
  const dispensed = p.codes.splice(0, quantity);
  p.stock = Math.max(0, (p.stock || 0) - quantity);
  if (p.stock === 0) p.outOfStock = true;
  save(db);
  return dispensed;
}

// ----------------------------------------------------
// USERS & WALLET
// ----------------------------------------------------
function getUser(userId) {
  if (userId === undefined || userId === null) return null;
  const db = load();
  const idStr = String(userId).trim();
  if (db.users[idStr]) {
    if (!db.users[idStr].id) db.users[idStr].id = idStr;
    return db.users[idStr];
  }
  const match = Object.entries(db.users || {}).find(
    ([k, u]) => u && typeof u === "object" && (String(u.id).trim() === idStr || String(k).trim() === idStr)
  );
  if (match) {
    const [k, u] = match;
    if (!u.id) u.id = k;
    return u;
  }
  return null;
}

function getOrCreateUser(telegramUser, referrerId = null) {
  const db = load();
  const idStr = String(telegramUser.id);
  
  if (!db.users[idStr]) {
    let validReferrer = null;
    if (referrerId && String(referrerId) !== idStr && db.users[String(referrerId)]) {
      validReferrer = String(referrerId);
      db.users[validReferrer].referral_count = (db.users[validReferrer].referral_count || 0) + 1;
    }

    db.users[idStr] = {
      id: telegramUser.id,
      username: telegramUser.username || "",
      first_name: telegramUser.first_name || "",
      last_name: telegramUser.last_name || "",
      wallet_balance: 0.0,
      total_spent: 0.0,
      orders_count: 0,
      referred_by: validReferrer,
      referral_count: 0,
      referral_earnings: 0.0,
      claimed_referral_rewards: 0,
      is_verified: false,
      is_blocked: false,
      blocked_at: null,
      sent_message_ids: [],
      last_message_id: 0,
      api_key: `ak_${crypto.randomBytes(16).toString("hex")}`,
      created_at: new Date().toISOString()
    };
    save(db);
  } else {
    // Update name/username if changed
    if (telegramUser.username && db.users[idStr].username !== telegramUser.username) {
      db.users[idStr].username = telegramUser.username;
    }
    if (telegramUser.first_name && db.users[idStr].first_name !== telegramUser.first_name) {
      db.users[idStr].first_name = telegramUser.first_name;
    }
    if (!db.users[idStr].api_key) {
      db.users[idStr].api_key = `ak_${crypto.randomBytes(16).toString("hex")}`;
      save(db);
    }
  }
  return db.users[idStr];
}

function adjustUserBalance(userId, deltaAmount) {
  const db = load();
  const idStr = String(userId);
  if (!db.users[idStr]) return false;
  
  const current = Number(db.users[idStr].wallet_balance || 0);
  const updated = Math.max(0, Number((current + Number(deltaAmount)).toFixed(2)));
  db.users[idStr].wallet_balance = updated;
  save(db);
  return updated;
}

function regenerateApiKey(userId) {
  const db = load();
  const idStr = String(userId);
  if (!db.users[idStr]) return null;
  const newKey = `ak_${crypto.randomBytes(16).toString("hex")}`;
  db.users[idStr].api_key = newKey;
  save(db);
  return newKey;
}

function getUserByApiKey(apiKey) {
  const db = load();
  return Object.values(db.users).find(u => u.api_key === apiKey) || null;
}

function getAllUsers() {
  const usersObj = load().users || {};
  return Object.entries(usersObj)
    .filter(([k, u]) => u && typeof u === "object" && (u.id !== undefined || k))
    .map(([k, u]) => {
      if (u.id === undefined || u.id === null || String(u.id).trim() === "") {
        u.id = k;
      }
      return u;
    });
}

function isUserBlocked(userId) {
  if (!userId) return false;
  const db = load();
  return Boolean(db.users[String(userId)]?.is_blocked);
}

function setUserBlocked(userId, blocked = true) {
  const db = load();
  const idStr = String(userId);
  if (!db.users[idStr]) {
    db.users[idStr] = {
      id: Number(userId) || userId,
      username: "",
      first_name: "",
      last_name: "",
      wallet_balance: 0.0,
      total_spent: 0.0,
      orders_count: 0,
      referred_by: null,
      referral_count: 0,
      referral_earnings: 0.0,
      claimed_referral_rewards: 0,
      is_verified: false,
      is_blocked: Boolean(blocked),
      blocked_at: blocked ? new Date().toISOString() : null,
      sent_message_ids: [],
      last_message_id: 0,
      api_key: `ak_${crypto.randomBytes(16).toString("hex")}`,
      created_at: new Date().toISOString()
    };
  } else {
    db.users[idStr].is_blocked = Boolean(blocked);
    db.users[idStr].blocked_at = blocked ? new Date().toISOString() : null;
  }
  save(db);
  return db.users[idStr];
}

function getBlockedUsers() {
  return Object.values(load().users).filter(u => Boolean(u.is_blocked));
}

function findUserByIdOrUsername(query) {
  if (!query) return null;
  const clean = String(query).trim();
  const db = load();
  if (db.users[clean]) return db.users[clean];
  const withoutAt = clean.replace(/^@/, "").toLowerCase();
  return Object.values(db.users).find(u => (u.username || "").toLowerCase() === withoutAt) || null;
}

function recordUserMessageId(userId, messageId) {
  const msgId = Number(messageId);
  if (!userId || !msgId || msgId <= 0) return;
  const db = load();
  const idStr = String(userId);
  if (!db.users[idStr]) {
    db.users[idStr] = {
      id: Number(userId) || userId,
      username: "",
      first_name: "",
      last_name: "",
      wallet_balance: 0.0,
      total_spent: 0.0,
      orders_count: 0,
      is_blocked: false,
      sent_message_ids: [msgId],
      last_message_id: msgId,
      api_key: `ak_${crypto.randomBytes(16).toString("hex")}`,
      created_at: new Date().toISOString()
    };
    save(db);
    return;
  }
  const u = db.users[idStr];
  if (!Array.isArray(u.sent_message_ids)) u.sent_message_ids = [];
  if (!u.sent_message_ids.includes(msgId)) {
    u.sent_message_ids.push(msgId);
    if (u.sent_message_ids.length > 500) {
      u.sent_message_ids = u.sent_message_ids.slice(-500);
    }
  }
  if (!u.last_message_id || msgId > u.last_message_id) {
    u.last_message_id = msgId;
  }
  save(db);
}

function recordUserLastSeenMessageId(userId, messageId) {
  const msgId = Number(messageId);
  if (!userId || !msgId || msgId <= 0) return;
  const db = load();
  const idStr = String(userId);
  const u = db.users[idStr];
  if (!u) return;
  if (!u.last_message_id || msgId > u.last_message_id) {
    u.last_message_id = msgId;
    save(db);
  }
}

function getUserSentMessageIds(userId) {
  const db = load();
  const u = db.users[String(userId)];
  if (!u) return { sentIds: [], lastMessageId: 0 };
  return {
    sentIds: Array.isArray(u.sent_message_ids) ? [...u.sent_message_ids] : [],
    lastMessageId: Number(u.last_message_id) || 0
  };
}

function clearUserSentMessageIds(userId) {
  const db = load();
  const u = db.users[String(userId)];
  if (!u) return;
  u.sent_message_ids = [];
  save(db);
}

function recordDepositPaidClick(userId) {
  const db = load();
  const idStr = String(userId);
  if (!db.users[idStr]) {
    db.users[idStr] = {
      id: Number(userId) || userId,
      wallet_balance: 0.0,
      total_spent: 0.0,
      orders_count: 0,
      deposit_paid_clicks: 1,
      created_at: new Date().toISOString()
    };
  } else {
    db.users[idStr].deposit_paid_clicks = (db.users[idStr].deposit_paid_clicks || 0) + 1;
  }
  save(db);
}

function markDepositAutoMsgSent(userId) {
  const db = load();
  const idStr = String(userId);
  if (!db.users[idStr]) {
    db.users[idStr] = {
      id: Number(userId) || userId,
      wallet_balance: 0.0,
      total_spent: 0.0,
      orders_count: 0,
      deposit_paid_clicks: 1,
      deposit_auto_msg_sent: true,
      created_at: new Date().toISOString()
    };
    save(db);
    return true;
  }
  if (db.users[idStr].deposit_auto_msg_sent) {
    return false;
  }
  db.users[idStr].deposit_auto_msg_sent = true;
  save(db);
  return true;
}

function markSecondDepositScreenshotMsgSent(userId) {
  const db = load();
  const idStr = String(userId);
  const u = db.users[idStr];
  if (!u) return false;
  // Trigger strictly when user has clicked "I've Paid" at least a 2nd time AND sent a screenshot, only once per user
  const isSecondTime = (u.deposit_paid_clicks || 0) >= 2;
  if (!isSecondTime || u.deposit_second_auto_msg_sent) {
    return false;
  }
  u.deposit_second_auto_msg_sent = true;
  save(db);
  return true;
}

// ----------------------------------------------------
// DEPOSITS
// ----------------------------------------------------
function createDeposit(depositData) {
  const db = load();
  const depositId = `DEP${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const deposit = {
    id: depositId,
    user_id: depositData.user_id,
    user_name: depositData.user_name || "",
    amount: Number(depositData.amount) || 0,
    method: depositData.method, // 'USDT_BEP20', 'USDT_POLYGON' or 'BINANCE_PAY'
    address: depositData.address || "",
    status: "pending", // pending, approved, rejected
    proof: depositData.proof || "",
    photo_file_id: depositData.photo_file_id || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.deposits.push(deposit);
  save(db);
  return deposit;
}

function getDeposit(depositId) {
  return load().deposits.find(d => d.id === depositId);
}

function incrementDepositPaidPrompt(depositId) {
  const db = load();
  const deposit = db.deposits.find(d => d.id === depositId);
  if (!deposit) return 1;
  deposit.paid_prompt_count = (deposit.paid_prompt_count || 0) + 1;
  deposit.updated_at = new Date().toISOString();
  save(db);
  return deposit.paid_prompt_count;
}

function approveDeposit(depositId, approvedAmount = null) {
  const db = load();
  const deposit = db.deposits.find(d => d.id === depositId);
  if (!deposit) throw new Error("Deposit not found");
  if (deposit.status === "approved") throw new Error("Deposit already approved");

  const creditAmount = approvedAmount !== null ? Number(approvedAmount) : Number(deposit.amount);
  deposit.status = "approved";
  deposit.amount = creditAmount;
  deposit.updated_at = new Date().toISOString();

  const user = db.users[String(deposit.user_id)];
  if (user) {
    user.wallet_balance = Number(((user.wallet_balance || 0) + creditAmount).toFixed(2));

    // Handle referral bonus
    if (user.referred_by && db.users[user.referred_by]) {
      const bonusPct = Number(db.settings.referral_bonus_percent || 5);
      const bonusAmount = Number(((creditAmount * bonusPct) / 100).toFixed(2));
      if (bonusAmount > 0) {
        db.users[user.referred_by].wallet_balance = Number(((db.users[user.referred_by].wallet_balance || 0) + bonusAmount).toFixed(2));
        db.users[user.referred_by].referral_earnings = Number(((db.users[user.referred_by].referral_earnings || 0) + bonusAmount).toFixed(2));
      }
    }
  }

  save(db);
  return { deposit, user };
}

function rejectDeposit(depositId, reason = "Payment not received or invalid proof") {
  const db = load();
  const deposit = db.deposits.find(d => d.id === depositId);
  if (!deposit) throw new Error("Deposit not found");
  deposit.status = "rejected";
  deposit.reject_reason = reason;
  deposit.updated_at = new Date().toISOString();
  save(db);
  return deposit;
}

function getPendingDeposits() {
  return load().deposits.filter(d => d.status === "pending").reverse();
}

function getUserDeposits(userId) {
  return load().deposits.filter(d => String(d.user_id) === String(userId)).slice(-15).reverse();
}

// ----------------------------------------------------
// ORDERS
// ----------------------------------------------------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generateOrderCode() {
  const db = load();
  let code;
  do {
    code = `${todayStr()}-${randomCode()}`;
  } while (db.orders.some(o => o.order_code === code));
  return code;
}

function createOrder(orderData) {
  const db = load();
  const orderCode = orderData.order_code || generateOrderCode();
  const order = {
    order_code: orderCode,
    user_id: orderData.user_id,
    user_name: orderData.user_name || "",
    product_id: orderData.product_id,
    product_name: orderData.product_name,
    quantity: orderData.quantity,
    unit_price: orderData.unit_price,
    total_price: orderData.total_price,
    delivered_codes: orderData.delivered_codes || [],
    status: orderData.status || "completed",
    created_at: new Date().toISOString()
  };

  db.orders.push(order);

  // Update user stats
  const user = db.users[String(orderData.user_id)];
  if (user) {
    user.orders_count = (user.orders_count || 0) + 1;
    user.total_spent = Number(((user.total_spent || 0) + Number(orderData.total_price)).toFixed(2));
  }

  save(db);
  return order;
}

function getOrder(code) {
  return load().orders.find(o => o.order_code === code || o.order_code?.toLowerCase() === code?.toLowerCase());
}

function getUserOrders(userId) {
  return load().orders.filter(o => String(o.user_id) === String(userId)).slice(-20).reverse();
}

function getAllOrders() {
  return load().orders.slice(-50).reverse();
}

function setUserVerified(userId, isVerified = true) {
  const db = load();
  const idStr = String(userId);
  if (db.users[idStr]) {
    db.users[idStr].is_verified = Boolean(isVerified);
    save(db);
    return true;
  }
  return false;
}

function isUserVerified(userId) {
  const db = load();
  const idStr = String(userId);
  return Boolean(db.users[idStr]?.is_verified);
}

function getReferralRewardStatus(userId) {
  const db = load();
  const idStr = String(userId);
  const user = db.users[idStr];
  if (!user) {
    return { totalReferrals: 0, claimed: 0, claimable: 0, progressInCurrentTier: 0, neededForNext: 30 };
  }

  const count = user.referral_count || 0;
  const claimed = user.claimed_referral_rewards || 0;
  const totalEarnable = Math.floor(count / 30);
  const claimable = Math.max(0, totalEarnable - claimed);
  const progressInCurrentTier = count % 30;

  return {
    totalReferrals: count,
    claimed: claimed,
    claimable: claimable,
    progressInCurrentTier: progressInCurrentTier,
    neededForNext: 30 - progressInCurrentTier
  };
}

function claimReferralReward(userId) {
  const db = load();
  const idStr = String(userId);
  const user = db.users[idStr];
  if (!user) throw new Error("User not found");

  const count = user.referral_count || 0;
  const claimed = user.claimed_referral_rewards || 0;
  const totalEarnable = Math.floor(count / 30);
  const claimable = totalEarnable - claimed;

  if (claimable <= 0) {
    throw new Error("You need 30 referrals to claim 1 Free Gemini account!");
  }

  // Dispense 1 code from gemini_18m
  const p = db.products.find(x => x.id === "gemini_18m");
  let dispensedCode = null;
  if (p && Array.isArray(p.codes) && p.codes.length > 0) {
    dispensedCode = p.codes.shift();
    p.stock = Math.max(0, (p.stock || 0) - 1);
    if (p.stock === 0) p.outOfStock = true;
  }

  user.claimed_referral_rewards = claimed + 1;

  const orderCode = generateOrderCode();
  const order = {
    order_code: orderCode,
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    product_id: "gemini_18m",
    product_name: "Gemini Links 18M (30-Referral Free Reward 🎁)",
    quantity: 1,
    unit_price: 0.00,
    total_price: 0.00,
    delivered_codes: dispensedCode ? [dispensedCode] : [],
    status: "completed",
    created_at: new Date().toISOString()
  };

  db.orders.push(order);
  user.orders_count = (user.orders_count || 0) + 1;

  save(db);
  return { order, dispensedCode, remainingClaimable: claimable - 1 };
}

// ----------------------------------------------------
// CHANNEL SCHEDULED POSTS
// ----------------------------------------------------
function getChannelPosts() {
  const db = load();
  if (!Array.isArray(db.channel_posts) || db.channel_posts.length === 0) {
    db.channel_posts = [...defaultChannelPosts];
    save(db);
  }
  return db.channel_posts;
}

function getNextChannelPost() {
  const db = load();
  const posts = getChannelPosts();
  if (!posts || posts.length === 0) return null;

  let currentIndex = Number(db.settings.channel_post_index || 0);
  if (currentIndex >= posts.length || currentIndex < 0) {
    currentIndex = 0;
  }
  const rawPost = posts[currentIndex];
  const nextIndex = (currentIndex + 1) % posts.length;
  db.settings.channel_post_index = nextIndex;
  save(db);

  const content = typeof rawPost === "string" ? rawPost : (rawPost.content || "");
  const id = typeof rawPost === "object" && rawPost.id ? rawPost.id : `post_${currentIndex + 1}`;
  const category = typeof rawPost === "object" && rawPost.category ? rawPost.category : "Promo";

  return {
    id,
    category,
    content,
    postIndex: currentIndex + 1,
    totalPosts: posts.length
  };
}

function addChannelPost(newPost) {
  const db = load();
  if (!Array.isArray(db.channel_posts)) db.channel_posts = [];
  db.channel_posts.push(newPost);
  save(db);
  return db.channel_posts;
}

// ----------------------------------------------------
// SUPPORT TICKETS
// ----------------------------------------------------
function createTicket(ticketData) {
  const db = load();
  if (!Array.isArray(db.tickets)) db.tickets = [];

  const nextNum = 1001 + db.tickets.length;
  const ticketId = `TKT-${nextNum}`;
  const now = new Date().toISOString();

  const ticket = {
    id: ticketId,
    user_id: String(ticketData.user_id),
    user_name: ticketData.user_name || "Customer",
    category: ticketData.category || "General Support",
    order_code: ticketData.order_code || null,
    status: "open", // 'open', 'replied', 'resolved', 'closed'
    messages: [
      {
        sender: "user",
        text: ticketData.message || "",
        photo_file_id: ticketData.photo_file_id || null,
        time: now
      }
    ],
    created_at: now,
    updated_at: now
  };

  db.tickets.push(ticket);
  save(db);
  return ticket;
}

function getTicket(ticketId) {
  const db = load();
  if (!Array.isArray(db.tickets)) return null;
  const cleanId = String(ticketId).trim().toUpperCase().replace(/^#/, "");
  return db.tickets.find(t => t.id.toUpperCase() === cleanId) || null;
}

function getUserTickets(userId) {
  const db = load();
  if (!Array.isArray(db.tickets)) return [];
  return db.tickets
    .filter(t => String(t.user_id) === String(userId))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function getOpenTickets() {
  const db = load();
  if (!Array.isArray(db.tickets)) return [];
  return db.tickets
    .filter(t => t.status === "open" || t.status === "replied")
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function getAllTickets() {
  const db = load();
  if (!Array.isArray(db.tickets)) return [];
  return [...db.tickets].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function addTicketMessage(ticketId, sender, text, photoFileId = null) {
  const db = load();
  if (!Array.isArray(db.tickets)) return null;
  const cleanId = String(ticketId).trim().toUpperCase().replace(/^#/, "");
  const ticket = db.tickets.find(t => t.id.toUpperCase() === cleanId);
  if (!ticket) return null;

  const now = new Date().toISOString();
  if (!Array.isArray(ticket.messages)) ticket.messages = [];
  ticket.messages.push({
    sender, // 'user' or 'admin'
    text: text || "",
    photo_file_id: photoFileId || null,
    time: now
  });

  ticket.status = sender === "admin" ? "replied" : "open";
  ticket.updated_at = now;
  save(db);
  return ticket;
}

function updateTicketStatus(ticketId, status) {
  const db = load();
  if (!Array.isArray(db.tickets)) return null;
  const cleanId = String(ticketId).trim().toUpperCase().replace(/^#/, "");
  const ticket = db.tickets.find(t => t.id.toUpperCase() === cleanId);
  if (!ticket) return null;

  ticket.status = status;
  ticket.updated_at = new Date().toISOString();
  save(db);
  return ticket;
}

module.exports = {
  initStore,
  getSetting,
  getAllSettings,
  setSetting,
  getProducts,
  getStandardProducts,
  getApiKeyProducts,
  getProduct,
  updateProduct,
  addProduct,
  deleteProduct,
  calculateProductPrice,
  addProductCodes,
  dispenseProductCodes,
  getUser,
  getOrCreateUser,
  adjustUserBalance,
  regenerateApiKey,
  getUserByApiKey,
  getAllUsers,
  isUserBlocked,
  setUserBlocked,
  getBlockedUsers,
  findUserByIdOrUsername,
  recordUserMessageId,
  recordUserLastSeenMessageId,
  getUserSentMessageIds,
  clearUserSentMessageIds,
  recordDepositPaidClick,
  markDepositAutoMsgSent,
  markSecondDepositScreenshotMsgSent,
  createDeposit,
  getDeposit,
  incrementDepositPaidPrompt,
  approveDeposit,
  rejectDeposit,
  getPendingDeposits,
  getUserDeposits,
  createOrder,
  getOrder,
  getUserOrders,
  getAllOrders,
  generateOrderCode,
  setUserVerified,
  isUserVerified,
  getReferralRewardStatus,
  claimReferralReward,
  getChannelPosts,
  getNextChannelPost,
  addChannelPost,
  createTicket,
  getTicket,
  getUserTickets,
  getOpenTickets,
  getAllTickets,
  addTicketMessage,
  updateTicketStatus
};
