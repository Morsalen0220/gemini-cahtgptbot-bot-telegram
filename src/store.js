const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const file = process.env.DATABASE_FILE || "./data/bot-data.json";
fs.mkdirSync(path.dirname(file), { recursive: true });

const defaultSettings = {
  bot_title: "Gemini AI Shop",
  channel_id: process.env.FORCE_CHANNEL_ID || "",
  channel_link: process.env.FORCE_CHANNEL_LINK || "https://t.me/",
  group_id: process.env.FORCE_GROUP_ID || "",
  group_link: process.env.FORCE_GROUP_LINK || "https://t.me/",
  force_join_enabled: false,
  bep20_usdt_address: "0xC3fC8C91A5B26C71DcD0aC1F34944FB298bCeBbF",
  polygon_usdt_address: "0xC3fC8C91A5B26C71DcD0aC1F34944FB298bCeBbF",
  binance_pay_id: "123456789",
  support_username: "@aibuyshop_support",
  referral_bonus_percent: 5,
  min_binance_deposit: 0.50,
  max_binance_deposit: 10.00,
  fake_sales_broadcast_enabled: true
};

const defaultProducts = [
  {
    id: "gemini_18m",
    name: "Gemini Links 18M",
    price: 0.55,
    stock: 1048,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 100, price: 0.55 },
      { min: 101, max: 999999, price: 0.50 }
    ],
    description: `✅ 18 Months Plan
✅ 5TB cloud storage included
✅ You can add 5 users
✅ No Shared
✅ 100% Private 
✅ NO NEED ANY CARD
🚫 Non Warranty
🔥 Works in any country no verification 
✅ Links Expiry in 4-6days ( Not Plan I mean Link )

❕ Important Note:
The redeem link must be used within 24 hours of receiving the order. If you face any issue with the link, you must report it to us within 24 hours. After 24 hours, no replacement or reissue will be provided.
🛡 100% genuine Gemini AI Pro subscription activated on your own Gmail.

🛡 FULL FAMILY ACCOUNT. IT'S NOT AN INVITE
➡️ Paste the received redeem link into your browser and click on “Activate Offer”. Your subscription/offer will then be activated successfully.`,
    terms: `• After delivery coupons cannot be returned or refunded
• Coupons are guaranteed to be fresh and valid
• You must know how to use the coupon before buying

By continuing you agree to these terms.`,
    codes: []
  },
  {
    id: "netflix_1m",
    name: "Netflix 1M 4K HDR",
    price: 2.50,
    stock: 0,
    outOfStock: true,
    bulk_tiers: [],
    description: `✅ 1 Month 4K UHD Profile
✅ Ultra HD (4K) & HDR streaming
✅ Works on phone, tablet, TV & PC
✅ 100% Private Profile with PIN`,
    terms: `• No refunds after credentials are sent
• Do not change account email or master password`,
    codes: []
  },
  {
    id: "duolingo_12m",
    name: "Duolingo 12M",
    price: 0.40,
    stock: 294,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.40 },
      { min: 51, max: 999999, price: 0.35 }
    ],
    description: `✅ Duolingo Super 12 Months
✅ Activated on your personal account
✅ Unlimited hearts & no ads
✅ Offline lessons included`,
    terms: `• Non-refundable once activated
• Guaranteed valid for 12 months`,
    codes: []
  },
  {
    id: "adobe_express_12m",
    name: "Adobe Express 12M",
    price: 1.00,
    stock: 204,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 1.00 },
      { min: 51, max: 999999, price: 0.90 }
    ],
    description: `✅ Adobe Express Premium 12 Months
✅ 100GB Cloud Storage
✅ All Premium templates & fonts
✅ Generative AI credits included`,
    terms: `• Full period replacement guarantee
• Activated directly on Adobe ID`,
    codes: []
  },
  {
    id: "apple_music_5m",
    name: "Apple Music 5M",
    price: 0.85,
    stock: 180,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.85 },
      { min: 51, max: 999999, price: 0.75 }
    ],
    description: `✅ Apple Music 5 Months Individual
✅ Lossless & Spatial Audio with Dolby Atmos
✅ Over 100 million songs ad-free
✅ Download songs for offline listening`,
    terms: `• Single use promo code
• Applicable for new and eligible returning accounts`,
    codes: []
  }
];

const defaults = {
  settings: defaultSettings,
  products: defaultProducts,
  users: {},
  deposits: [],
  orders: []
};

function load() {
  if (!fs.existsSync(file)) {
    save(defaults);
    return structuredClone(defaults);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    let modified = false;

    if (!raw.settings || typeof raw.settings !== "object") {
      raw.settings = defaultSettings;
      modified = true;
    } else {
      for (const [k, v] of Object.entries(defaultSettings)) {
        if (raw.settings[k] === undefined) {
          raw.settings[k] = v;
          modified = true;
        }
      }
    }

    if (!Array.isArray(raw.products) || raw.products.length === 0 || !raw.products[0].bulk_tiers) {
      raw.products = defaultProducts;
      modified = true;
    }

    if (!raw.users || typeof raw.users !== "object") {
      raw.users = {};
      modified = true;
    }

    if (!Array.isArray(raw.deposits)) {
      raw.deposits = [];
      modified = true;
    }

    if (!Array.isArray(raw.orders)) {
      raw.orders = [];
      modified = true;
    }

    if (modified) {
      save(raw);
    }
    return raw;
  } catch (err) {
    console.error("Error reading database file, resetting to defaults:", err);
    save(defaults);
    return structuredClone(defaults);
  }
}

function save(db) {
  fs.writeFileSync(file, JSON.stringify(db, null, 2), "utf8");
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
  const db = load();
  return db.users[String(userId)] || null;
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
  return Object.values(load().users);
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
    method: depositData.method, // 'BINANCE_PAY' or 'USDT_BEP20' or 'USDT_POLYGON'
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

module.exports = {
  getSetting,
  getAllSettings,
  setSetting,
  getProducts,
  getProduct,
  updateProduct,
  addProduct,
  calculateProductPrice,
  addProductCodes,
  dispenseProductCodes,
  getUser,
  getOrCreateUser,
  adjustUserBalance,
  regenerateApiKey,
  getUserByApiKey,
  getAllUsers,
  createDeposit,
  getDeposit,
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
  claimReferralReward
};
