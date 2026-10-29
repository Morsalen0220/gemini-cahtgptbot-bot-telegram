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
  deposit_second_auto_msg: "✅ We have received your payment screenshot! Our admin team is reviewing your proof now and your wallet balance will be credited shortly.",
  deleted_product_ids: []
};

const LEGACY_REMOVED_IDS = new Set([
  "netflix_1m",
  "duolingo_12m",
  "adobe_express_12m",
  "apple_music_5m"
]);

function buildBulkTiers(basePrice) {
  const p = Number(basePrice) || 0;
  const calcTierPrice = (pctOff) => {
    const raw = p * (1 - pctOff / 100);
    const twoDec = Number(raw.toFixed(2));
    if (pctOff > 0 && twoDec >= p && p > 0) {
      return Number(raw.toFixed(3));
    }
    return Math.max(0.01, twoDec);
  };
  return [
    { min: 1, max: 4, discount_pct: 0, price: Number(p.toFixed(2)) },
    { min: 5, max: 9, discount_pct: 10, price: calcTierPrice(10) },
    { min: 10, max: 24, discount_pct: 15, price: calcTierPrice(15) },
    { min: 25, max: 49, discount_pct: 20, price: calcTierPrice(20) },
    { min: 50, max: 99, discount_pct: 25, price: calcTierPrice(25) },
    { min: 100, max: 999999, discount_pct: 30, price: calcTierPrice(30) }
  ];
}

const defaultProducts = [
  // ==========================================
  // 1. GEMINI (2 PLANS)
  // ==========================================
  {
    id: "gemini_18m",
    name: "Gemini Advanced 18M (Redeem Link)",
    group: "Gemini",
    category: "standard",
    price: 0.30,
    stock: 1048,
    outOfStock: false,
    bulk_tiers: buildBulkTiers(0.30),
    description: `✨ Google One AI Premium (Gemini Advanced + 2TB Cloud Storage)
⏳ Validity: 18 Months Official Plan
📧 Activation: Direct Redeem Link on Your Own Gmail
🔥 Bulk Offer: Buy 5+ for 10% OFF • Up to 30% OFF on Bulk!
⚡ Delivery: Instant Automated Delivery • 100% Guaranteed`,
    terms: `• Fresh & valid official redeem link delivered instantly
• Must redeem within 24 hours of delivery
• Full replacement guarantee if link is invalid`,
    codes: []
  },
  {
    id: "gemini_12m_acc",
    name: "Gemini Advanced 12M (Ready Account)",
    group: "Gemini",
    category: "standard",
    price: 0.30,
    stock: 520,
    outOfStock: false,
    bulk_tiers: buildBulkTiers(0.30),
    description: `✨ Google Gemini Advanced + 2TB Google One Cloud Storage
⏳ Validity: 12 Months Pre-Activated Plan
🔐 Access: Private Ready Gmail Account (Full Login Access)
🔥 Bulk Offer: Buy 5+ for 10% OFF • Up to 30% OFF on Bulk!
⚡ Delivery: Instant Automated Account Credentials`,
    terms: `• Full private account login (Email + Password)
• Change password & recovery details after login
• 100% full period warranty`,
    codes: []
  },

  // ==========================================
  // 2. CLAUDE AI (6 PLANS)
  // ==========================================
  {
    id: "claude_plan_1",
    name: "Claude 3.5 Sonnet Pro — 7 Days",
    group: "Claude AI",
    category: "standard",
    price: 1.50,
    stock: 210,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.50 },
      { min: 21, max: 999999, price: 1.35 }
    ],
    description: `🤖 Anthropic Claude Pro (Claude 3.5 Sonnet & Opus)
⏳ Validity: 7 Days Full Pro Access
🔓 Access: Ready Account • 5x More Usage vs Free Tier
⚡ Delivery: Instant Automated Login Delivery`,
    terms: `• Valid for 7 full days from purchase
• Instant replacement if login issue occurs`,
    codes: []
  },
  {
    id: "claude_plan_2",
    name: "Claude Pro — 1 Month (Shared)",
    group: "Claude AI",
    category: "standard",
    price: 4.50,
    stock: 185,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 4.50 },
      { min: 11, max: 999999, price: 4.00 }
    ],
    description: `🤖 Anthropic Claude Pro Subscription (Shared Access)
⏳ Validity: 1 Month (30 Days Full Warranty)
🚀 Features: Claude 3.5 Sonnet, Artifacts & Priority Bandwidth
⚡ Delivery: Instant Automated Credentials`,
    terms: `• Do not change account password or security settings
• Full 30-day warranty included`,
    codes: []
  },
  {
    id: "claude_plan_3",
    name: "Claude Pro — 1 Month (Private)",
    group: "Claude AI",
    category: "standard",
    price: 9.50,
    stock: 110,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 9.50 },
      { min: 11, max: 999999, price: 8.80 }
    ],
    description: `🤖 Anthropic Claude Pro Subscription (100% Private Account)
⏳ Validity: 1 Month (30 Days Full Guarantee)
🔐 Access: Dedicated Private Account • Projects & 200K Context
⚡ Delivery: Instant Automated Delivery`,
    terms: `• 100% private dedicated account for single user
• Full 30-day replacement guarantee`,
    codes: []
  },
  {
    id: "claude_plan_4",
    name: "Claude Pro — 1 Month (On Your Email)",
    group: "Claude AI",
    category: "standard",
    price: 12.50,
    stock: 80,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 12.50 },
      { min: 11, max: 999999, price: 11.50 }
    ],
    description: `🤖 Official Claude Pro Upgrade on Your Personal Account
⏳ Validity: 1 Month Official Subscription
📧 Activation: Direct Upgrade / Invite on Your Own Email
⚡ Delivery: Fast Automated Activation Code / Link`,
    terms: `• Activated directly on your own email address
• 100% safe official billing • Full 30-day guarantee`,
    codes: []
  },
  {
    id: "claude_plan_5",
    name: "Claude Team Plan — 1 Month (Private Seat)",
    group: "Claude AI",
    category: "standard",
    price: 15.00,
    stock: 65,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 15.00 },
      { min: 11, max: 999999, price: 13.80 }
    ],
    description: `🤖 Claude AI Team Workspace (Higher Message Limits than Pro)
⏳ Validity: 1 Month Official Private Team Seat
🚀 Features: 200K Context Window, Projects & Priority Access
⚡ Delivery: Instant Automated Workspace Invite`,
    terms: `• Private seat inside verified Claude Team Workspace
• Higher usage quota than standard Pro plan`,
    codes: []
  },
  {
    id: "claude_plan_6",
    name: "Claude Pro — 3 Months (Private)",
    group: "Claude AI",
    category: "standard",
    price: 24.00,
    stock: 45,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 5, price: 24.00 },
      { min: 6, max: 999999, price: 22.00 }
    ],
    description: `🤖 Anthropic Claude Pro Long-Term Plan (100% Private)
⏳ Validity: 3 Months (90 Days Full Replacement Warranty)
🔐 Access: Full Private Account • Uninterrupted Coding & Writing
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• 100% private account with 90-day full guarantee
• Instant automated delivery upon payment`,
    codes: []
  },

  // ==========================================
  // 3. CHATGPT (3 PLANS)
  // ==========================================
  {
    id: "chatgpt_plan_1",
    name: "ChatGPT Plus — 1 Month (Shared)",
    group: "ChatGPT",
    category: "standard",
    price: 1.80,
    stock: 340,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.80 },
      { min: 21, max: 999999, price: 1.55 }
    ],
    description: `🧠 OpenAI ChatGPT Plus (GPT-4o, o1 Reasoning, DALL·E 3 & Voice)
⏳ Validity: 1 Month (30 Days Full Warranty)
🔓 Access: Premium Shared Account • High Stability
⚡ Delivery: Instant Automated Login Credentials`,
    terms: `• Do not change password or share login outside
• Full 30-day warranty & instant support`,
    codes: []
  },
  {
    id: "chatgpt_plan_2",
    name: "ChatGPT Plus — 1 Month (Private)",
    group: "ChatGPT",
    category: "standard",
    price: 5.50,
    stock: 150,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 5.50 },
      { min: 11, max: 999999, price: 5.00 }
    ],
    description: `🧠 OpenAI ChatGPT Plus (100% Private Personal Account)
⏳ Validity: 1 Month (30 Days Full Replacement Guarantee)
🔐 Access: Full Email & Password Access • All GPT-4o Features
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Dedicated private account for your sole use
• Full 30-day warranty included`,
    codes: []
  },
  {
    id: "chatgpt_plan_3",
    name: "ChatGPT Team Workspace — 1 Month (On Your Email)",
    group: "ChatGPT",
    category: "standard",
    price: 7.50,
    stock: 120,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 7.50 },
      { min: 11, max: 999999, price: 6.80 }
    ],
    description: `🧠 ChatGPT Team Plan on Your Own Email (2x Higher Message Caps)
⏳ Validity: 1 Month Private Workspace Seat
📧 Activation: Direct Official Invite Link to Your Personal Email
⚡ Delivery: Instant Automated Invite Link`,
    terms: `• Private workspace seat on your own OpenAI account
• Data excluded from training by default • 30-day guarantee`,
    codes: []
  },

  // ==========================================
  // 4. CAPCUT (3 PLANS)
  // ==========================================
  {
    id: "capcut_plan_1",
    name: "CapCut Pro — 1 Month",
    group: "CapCut",
    category: "standard",
    price: 0.90,
    stock: 410,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 30, price: 0.90 },
      { min: 31, max: 999999, price: 0.75 }
    ],
    description: `🎬 CapCut Pro Official Subscription (PC, Mobile & Web)
⏳ Validity: 1 Month (30 Days Full Warranty)
✨ Features: All Pro Effects, Auto Captions, AI Tools & 100GB Cloud
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Works on Windows, Mac, iOS & Android
• Full 30-day replacement guarantee`,
    codes: []
  },
  {
    id: "capcut_plan_2",
    name: "CapCut Pro — 6 Months",
    group: "CapCut",
    category: "standard",
    price: 3.50,
    stock: 190,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 3.50 },
      { min: 21, max: 999999, price: 3.10 }
    ],
    description: `🎬 CapCut Pro 6-Month Plan (All Devices Supported)
⏳ Validity: 6 Months (180 Days Full Warranty)
✨ Features: 4K 60fps Export, AI Background Remover & No Watermark
⚡ Delivery: Instant Automated Login Credentials`,
    terms: `• Valid for 6 months across PC and Mobile
• Full period replacement warranty`,
    codes: []
  },
  {
    id: "capcut_plan_3",
    name: "CapCut Pro — 12 Months (1 Year)",
    group: "CapCut",
    category: "standard",
    price: 5.90,
    stock: 140,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 5.90 },
      { min: 11, max: 999999, price: 5.20 }
    ],
    description: `🎬 CapCut Pro Annual Subscription (PC, iOS & Android)
⏳ Validity: 12 Months (365 Days Full Guarantee)
✨ Features: Unlimited Pro Templates, AI Effects & Cloud Storage
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Full 1-year warranty included
• Instant automated login delivery`,
    codes: []
  },

  // ==========================================
  // 5. CANVA (2 PLANS)
  // ==========================================
  {
    id: "canva_plan_1",
    name: "Canva Pro — 1 Year (On Your Email)",
    group: "Canva",
    category: "standard",
    price: 0.60,
    stock: 520,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.60 },
      { min: 51, max: 999999, price: 0.45 }
    ],
    description: `🎨 Canva Pro / Edu Premium (100M+ Pro Stock, Brand Kit & Magic AI)
⏳ Validity: 12 Months (1 Year Full Warranty)
📧 Activation: Direct Invite Link on Your Own Canva Email
⚡ Delivery: Instant Automated Invite Link`,
    terms: `• Activates directly on your personal Canva account
• Designs remain 100% private to you • 1-year guarantee`,
    codes: []
  },
  {
    id: "canva_plan_2",
    name: "Canva Edu Owner / Admin Panel (500 Seats)",
    group: "Canva",
    category: "standard",
    price: 3.50,
    stock: 95,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 3.50 },
      { min: 11, max: 999999, price: 3.00 }
    ],
    description: `🎨 Canva Education Owner / Admin Account (Invite up to 500 Users)
⏳ Validity: Lifetime / Long-Term Verified Admin Panel
🔐 Access: Full Private Owner Login (Changeable Email & Password)
⚡ Delivery: Instant Automated Account Credentials`,
    terms: `• Full admin control to invite and manage up to 500 members
• Change password immediately after first login`,
    codes: []
  },

  // ==========================================
  // 6. GMAIL (2 PLANS)
  // ==========================================
  {
    id: "gmail_plan_1",
    name: "Fresh Verified Gmail Account",
    group: "Gmail",
    category: "standard",
    price: 0.20,
    stock: 1500,
    outOfStock: false,
    bulk_tiers: buildBulkTiers(0.20),
    description: `📧 Fresh High-Quality Google / Gmail Account
🛡️ Status: Clean IP Created • Recovery Email Attached
🔓 Usage: Ready for App Signups, YouTube, Gemini & Social Media
🔥 Bulk Offer: Buy 5+ for 10% OFF • Up to 30% OFF on Bulk!
⚡ Delivery: Instant Automated (Email + Password + Recovery)`,
    terms: `• 100% fresh unused Gmail account
• Update recovery info after first login`,
    codes: []
  },
  {
    id: "gmail_plan_2",
    name: "Aged USA Gmail Account",
    group: "Gmail",
    category: "standard",
    price: 0.45,
    stock: 640,
    outOfStock: false,
    bulk_tiers: buildBulkTiers(0.45),
    description: `📧 Aged USA Google / Gmail Account
🛡️ Status: High Trust Score • Warmed Up & Long-Lasting
🔓 Usage: Ideal for Google Cloud, Ads, Cold Outreach & Business
🔥 Bulk Offer: Buy 5+ for 10% OFF • Up to 30% OFF on Bulk!
⚡ Delivery: Instant Automated (Email + Password + Recovery)`,
    terms: `• Verified aged USA account with recovery mail included
• Replacement guarantee on initial login`,
    codes: []
  },

  // ==========================================
  // 7. AUTODESK (3 PLANS)
  // ==========================================
  {
    id: "autodesk_plan_1",
    name: "Autodesk AutoCAD — 1 Year (On Your Email)",
    group: "Autodesk",
    category: "standard",
    price: 2.50,
    stock: 160,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 2.50 },
      { min: 11, max: 999999, price: 2.15 }
    ],
    description: `📐 Official Autodesk AutoCAD (Windows & macOS)
⏳ Validity: 1 Year (12 Months Official License)
📧 Activation: Direct Upgrade on Your Personal Autodesk Email
⚡ Delivery: Instant Automated Activation / Invite`,
    terms: `• Official download from autodesk.com
• Full 12-month license warranty`,
    codes: []
  },
  {
    id: "autodesk_plan_2",
    name: "Autodesk All Apps Collection — 1 Year",
    group: "Autodesk",
    category: "standard",
    price: 4.50,
    stock: 130,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 4.50 },
      { min: 11, max: 999999, price: 3.90 }
    ],
    description: `📐 Autodesk All Apps Bundle (AutoCAD, Revit, Maya, 3ds Max, Fusion 360 + 40 Apps)
⏳ Validity: 1 Year (12 Months Full Access)
📧 Activation: Activated Directly on Your Autodesk Account
⚡ Delivery: Instant Automated Delivery`,
    terms: `• Includes 45+ official Autodesk desktop & cloud apps
• 100% guaranteed for 12 months`,
    codes: []
  },
  {
    id: "autodesk_plan_3",
    name: "Autodesk All Apps Collection — 3 Years",
    group: "Autodesk",
    category: "standard",
    price: 9.50,
    stock: 75,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 5, price: 9.50 },
      { min: 6, max: 999999, price: 8.50 }
    ],
    description: `📐 Complete Autodesk All Products Bundle (45+ Official Software)
⏳ Validity: 3 Years (36 Months Full Guarantee)
📧 Activation: Direct Activation on Your Autodesk ID
⚡ Delivery: Instant Automated Delivery`,
    terms: `• Long-term 3-year official access on your account
• Supports Windows & Mac • Full warranty`,
    codes: []
  },

  // ==========================================
  // 8. MUSE (2 PLANS)
  // ==========================================
  {
    id: "muse_plan_1",
    name: "MuseScore Pro+ — 1 Month",
    group: "Muse",
    category: "standard",
    price: 1.20,
    stock: 220,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.20 },
      { min: 21, max: 999999, price: 1.00 }
    ],
    description: `🎵 MuseScore Pro+ Official Subscription (Unlimited Sheet Music)
⏳ Validity: 1 Month (30 Days Full Warranty)
✨ Features: Unlimited PDF/MIDI/MP3 Downloads & Official Scores
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Full access to Pro+ sheet music library
• 30-day replacement guarantee`,
    codes: []
  },
  {
    id: "muse_plan_2",
    name: "MuseScore Pro+ — 12 Months (1 Year)",
    group: "Muse",
    category: "standard",
    price: 3.50,
    stock: 115,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 3.50 },
      { min: 11, max: 999999, price: 3.00 }
    ],
    description: `🎵 MuseScore Pro+ Annual Pass (Full Sheet Library & Practice Tools)
⏳ Validity: 12 Months (1 Year Full Replacement Guarantee)
✨ Features: Unlimited Downloads, Track Mixing & Ad-Free Access
⚡ Delivery: Instant Automated Login Credentials`,
    terms: `• Valid for 12 full months
• Instant automated login delivery`,
    codes: []
  },

  // ==========================================
  // SINGLE PRODUCTS (28 ITEMS)
  // ==========================================
  {
    id: "prime_video",
    name: "PRIME VIDEO",
    category: "standard",
    price: 1.35,
    stock: 260,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.35 },
      { min: 21, max: 999999, price: 1.20 }
    ],
    description: `🎬 Amazon Prime Video 4K UHD Subscription
⏳ Validity: 1 Month (30 Days Full Warranty)
📺 Support: Smart TV, PC, Mobile & Fire Stick
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Full 30-day replacement guarantee
• Do not change master account email`,
    codes: []
  },
  {
    id: "shahid",
    name: "SHAHID",
    category: "standard",
    price: 2.70,
    stock: 180,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 2.70 },
      { min: 21, max: 999999, price: 2.40 }
    ],
    description: `📺 Shahid VIP Premium Subscription (Originals, Movies & Live TV)
⏳ Validity: 1 Month (30 Days Full Warranty)
✨ Features: Full HD / 4K Streaming • 100% Ad-Free
⚡ Delivery: Instant Automated Login Credentials`,
    terms: `• Works on Smart TV, Mobile & Web
• Full 30-day warranty included`,
    codes: []
  },
  {
    id: "apple_tv",
    name: "APPLE TV",
    category: "standard",
    price: 2.25,
    stock: 195,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 2.25 },
      { min: 21, max: 999999, price: 2.00 }
    ],
    description: `🍎 Apple TV+ Official Premium Subscription (4K HDR / Dolby Atmos)
⏳ Validity: 1–3 Months Official Access
📺 Support: Apple Devices, Smart TV, Web & Consoles
⚡ Delivery: Instant Automated Account / Redeem Code`,
    terms: `• Instant automated delivery
• Full period warranty included`,
    codes: []
  },
  {
    id: "spotify",
    name: "SPOTIFY",
    category: "standard",
    price: 1.50,
    stock: 340,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 30, price: 1.50 },
      { min: 31, max: 999999, price: 1.30 }
    ],
    description: `🎧 Spotify Premium Individual (Ad-Free Music & Offline Downloads)
⏳ Validity: 1–3 Months Full Warranty
🎵 Features: Very High Audio Quality • Unlimited Skips
⚡ Delivery: Instant Automated Account / Upgrade Link`,
    terms: `• Works on iOS, Android, PC & Smart Speakers
• Full warranty for the subscription period`,
    codes: []
  },
  {
    id: "deezer",
    name: "DEEZER",
    category: "standard",
    price: 1.28,
    stock: 210,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.28 },
      { min: 21, max: 999999, price: 1.10 }
    ],
    description: `🎵 Deezer Premium HiFi Subscription (FLAC Lossless Audio)
⏳ Validity: 1 Month (30 Days Full Guarantee)
✨ Features: Ad-Free Listening & Offline Mode on All Devices
⚡ Delivery: Instant Automated Account Credentials`,
    terms: `• High-fidelity lossless streaming enabled
• 30-day replacement guarantee`,
    codes: []
  },
  {
    id: "edx",
    name: "EDX",
    category: "standard",
    price: 1.50,
    stock: 175,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.50 },
      { min: 21, max: 999999, price: 1.30 }
    ],
    description: `🎓 edX Verified Courses & Official Certificate Access
⏳ Validity: Full Course Access (100% Verified)
✨ Features: Top University Courses (Harvard, MIT, Berkeley, IBM)
⚡ Delivery: Instant Automated Account / Coupon Delivery`,
    terms: `• Unlock verified track & graded assignments
• Instant automated delivery`,
    codes: []
  },
  {
    id: "scribd",
    name: "SCRIBD",
    category: "standard",
    price: 0.90,
    stock: 290,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 30, price: 0.90 },
      { min: 31, max: 999999, price: 0.75 }
    ],
    description: `📚 Scribd + Everand + SlideShare Premium Subscription
⏳ Validity: 1–2 Months Full Warranty
✨ Features: Unlimited eBooks, Audiobooks, Documents & Sheet Music
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Includes access to Scribd, Everand & SlideShare
• Full replacement guarantee`,
    codes: []
  },
  {
    id: "adobe",
    name: "ADOBE",
    category: "standard",
    price: 0.38,
    stock: 420,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.38 },
      { min: 51, max: 999999, price: 0.32 }
    ],
    description: `🎨 Adobe Express Premium + Firefly Generative AI Credits
⏳ Validity: 1–12 Months Promotional Plan
✨ Features: 100GB Cloud Storage, Premium Templates & AI Tools
⚡ Delivery: Instant Automated Redeem / Account Delivery`,
    terms: `• Instant automated delivery to chat
• Full replacement guarantee if invalid on arrival`,
    codes: []
  },
  {
    id: "figma",
    name: "FIGMA",
    category: "standard",
    price: 4.65,
    stock: 130,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 4.65 },
      { min: 11, max: 999999, price: 4.15 }
    ],
    description: `🖌️ Figma Professional Plan (Unlimited Files, Projects & Dev Mode)
⏳ Validity: 1–2 Years Official Education / Pro Plan
📧 Activation: Direct Upgrade or Ready Verified Account
⚡ Delivery: Instant Automated Delivery`,
    terms: `• Full Figma Professional features & Dev Mode unlocked
• Long-term validity guarantee`,
    codes: []
  },
  {
    id: "miro",
    name: "MIRO",
    category: "standard",
    price: 9.75,
    stock: 85,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 9.75 },
      { min: 11, max: 999999, price: 8.80 }
    ],
    description: `📋 Miro Pro / Education Plan (Unlimited Active Boards & Collaborators)
⏳ Validity: 1–2 Years Full Official Access
✨ Features: Private Boards, High-Res Exports & Diagramming Tools
⚡ Delivery: Instant Automated Account / Upgrade`,
    terms: `• Full private workspace access
• Guaranteed active for full validity period`,
    codes: []
  },
  {
    id: "framer",
    name: "FRAMER",
    category: "standard",
    price: 8.25,
    stock: 90,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 8.25 },
      { min: 11, max: 999999, price: 7.40 }
    ],
    description: `🚀 Framer Pro Website Builder Plan
⏳ Validity: 1 Year Official Pro Subscription
✨ Features: Custom Domain Support, CMS Collections & High Bandwidth
⚡ Delivery: Instant Automated Promo Code / Account`,
    terms: `• Build and publish professional no-code sites
• Instant automated delivery`,
    codes: []
  },
  {
    id: "notion",
    name: "NOTION",
    category: "standard",
    price: 1.38,
    stock: 270,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.38 },
      { min: 21, max: 999999, price: 1.18 }
    ],
    description: `📝 Notion Plus Plan (Unlimited Blocks, Pages & File Uploads)
⏳ Validity: 1 Year Official Education / Plus Plan
✨ Features: 30-Day Version History, Custom Sites & Guest Access
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• 100% private workspace access
• Full 1-year warranty included`,
    codes: []
  },
  {
    id: "microsoft",
    name: "MICROSOFT",
    category: "standard",
    price: 0.26,
    stock: 580,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.26 },
      { min: 51, max: 999999, price: 0.20 }
    ],
    description: `💻 Microsoft 365 ProPlus (Office Desktop Apps + 1TB OneDrive)
⏳ Validity: 1 Year / Lifetime Subscription Account
✨ Apps: Word, Excel, PowerPoint, Outlook & OneNote (5 Devices)
⚡ Delivery: Instant Automated Account Credentials`,
    terms: `• Supports Windows, macOS, iOS & Android
• Change password on initial login`,
    codes: []
  },
  {
    id: "ilovepdf",
    name: "ILOVEPDF",
    category: "standard",
    price: 0.44,
    stock: 360,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.44 },
      { min: 51, max: 999999, price: 0.36 }
    ],
    description: `📄 iLovePDF Premium Subscription (Web, Desktop & Mobile App)
⏳ Validity: 1 Year (12 Months Full Warranty)
✨ Features: Unlimited PDF Merge/Convert, OCR, Digital Signatures & No Ads
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Works across Web, Windows/Mac Desktop & Mobile
• Full 12-month warranty`,
    codes: []
  },
  {
    id: "elevenlabs",
    name: "ELEVENLABS",
    category: "standard",
    price: 2.85,
    stock: 165,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 15, price: 2.85 },
      { min: 16, max: 999999, price: 2.50 }
    ],
    description: `🎙️ ElevenLabs AI Voice Generator (Starter / Creator Plan)
⏳ Validity: 1 Month (30,000+ Characters Quota)
✨ Features: Instant Voice Cloning, AI Dubbing & Commercial License
⚡ Delivery: Instant Automated Account / API Access`,
    terms: `• Fresh account with full character quota intact
• Instant automated login delivery`,
    codes: []
  },
  {
    id: "jetbrains",
    name: "JETBRAINS",
    category: "standard",
    price: 4.13,
    stock: 145,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 4.13 },
      { min: 11, max: 999999, price: 3.70 }
    ],
    description: `🧑‍💻 JetBrains All Products Pack (IntelliJ IDEA Ultimate, PyCharm, WebStorm, CLion, PhpStorm)
⏳ Validity: 1 Year (12 Months Official License)
📧 Activation: Official JetBrains Account / Activation Pack
⚡ Delivery: Instant Automated Credentials`,
    terms: `• Unlocks all 15+ JetBrains IDEs on Windows, Mac & Linux
• Full 12-month warranty`,
    codes: []
  },
  {
    id: "replit",
    name: "REPLIT",
    category: "standard",
    price: 4.50,
    stock: 125,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 10, price: 4.50 },
      { min: 11, max: 999999, price: 4.00 }
    ],
    description: `⚡ Replit Core / Pro Plan (Replit AI Agent & Private Repls)
⏳ Validity: 1–12 Months Developer Plan
✨ Features: Unlimited Private Repls, Boosted Machines & AI Coding
⚡ Delivery: Instant Automated Account / Promo Code`,
    terms: `• Full developer access with AI features enabled
• Instant automated delivery`,
    codes: []
  },
  {
    id: "nordvpn",
    name: "NORDVPN",
    category: "standard",
    price: 4.20,
    stock: 230,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 15, price: 4.20 },
      { min: 16, max: 999999, price: 3.75 }
    ],
    description: `🛡️ NordVPN Premium Subscription (6000+ Ultra-Fast Global Servers)
⏳ Validity: 1 Year (12 Months Full Replacement Warranty)
🔐 Features: NordLynx Protocol, Threat Protection & Streaming Unblock
⚡ Delivery: Instant Automated Account Credentials`,
    terms: `• Do not change account email or password
• 100% replacement warranty for 12 months`,
    codes: []
  },
  {
    id: "expressvpn",
    name: "EXPRESSVPN",
    category: "standard",
    price: 1.35,
    stock: 280,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.35 },
      { min: 21, max: 999999, price: 1.15 }
    ],
    description: `🛡️ ExpressVPN Premium (105 Countries • Lightway High-Speed Protocol)
⏳ Validity: 1 Month (30 Days Full Warranty)
🔐 Support: PC, Mac, iOS, Android & Browser (Login + Activation Key)
⚡ Delivery: Instant Automated Account Delivery`,
    terms: `• Full 30-day warranty included
• Instant automated login & activation key`,
    codes: []
  },
  {
    id: "hma_vpn",
    name: "HMA VPN",
    category: "standard",
    price: 0.74,
    stock: 310,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 30, price: 0.74 },
      { min: 31, max: 999999, price: 0.62 }
    ],
    description: `🛡️ HMA (HideMyAss) Pro VPN (290+ Locations Worldwide)
⏳ Validity: 1 Month Official License Key (Up to 5 Devices)
🔐 Features: IP Shuffle, Smart Kill Switch & 20 Gbps Servers
⚡ Delivery: Instant Automated License Key`,
    terms: `• Enter license key directly in HMA VPN app
• Full 30-day warranty`,
    codes: []
  },
  {
    id: "avira",
    name: "AVIRA",
    category: "standard",
    price: 1.20,
    stock: 190,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.20 },
      { min: 21, max: 999999, price: 1.00 }
    ],
    description: `🛡️ Avira Prime Security + Phantom VPN Pro (Unlimited Traffic)
⏳ Validity: 3–12 Months Multi-Device Protection
✨ Features: Real-Time Antivirus, System Optimizer & Unlimited VPN
⚡ Delivery: Instant Automated Account / License`,
    terms: `• Works on Windows, macOS, Android & iOS
• Full period warranty included`,
    codes: []
  },
  {
    id: "v2ray",
    name: "V2RAY",
    category: "standard",
    price: 1.43,
    stock: 400,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 30, price: 1.43 },
      { min: 31, max: 999999, price: 1.20 }
    ],
    description: `🌐 Premium V2Ray / VMess / VLESS High-Speed Private Config
⏳ Validity: 1 Month (30 Days High-Bandwidth Access)
🚀 Features: Ultra-Low Ping, Bypasses Restrictions & 99.9% Uptime
⚡ Delivery: Instant Automated Subscription Link / Config`,
    terms: `• Compatible with v2rayNG, Nekoray, Streisand & Shadowrocket
• Full 30-day uptime guarantee`,
    codes: []
  },
  {
    id: "proxy",
    name: "PROXY",
    category: "standard",
    price: 0.15,
    stock: 1200,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 100, price: 0.15 },
      { min: 101, max: 999999, price: 0.12 }
    ],
    description: `🌐 Clean Dedicated SOCKS5 / HTTP Private Proxy
⏳ Validity: Fresh High-Speed Static IP (USA / Europe / Global)
🔐 Features: High Anonymity, Low Fraud Score & Fast Speeds
⚡ Delivery: Instant Automated (IP:Port:Username:Password)`,
    terms: `• 100% live tested proxy on delivery
• Replacement if dead on arrival`,
    codes: []
  },
  {
    id: "outlook",
    name: "OUTLOOK",
    category: "standard",
    price: 0.03,
    stock: 3500,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 500, price: 0.03 },
      { min: 501, max: 999999, price: 0.02 }
    ],
    description: `📧 Fresh Verified Microsoft Outlook / Hotmail Account
🛡️ Status: 100% Active • Webmail & POP3/IMAP Ready
🔓 Usage: Ideal for Signups, Verifications, Gaming & Bulk Tasks
⚡ Delivery: Instant Automated (Email:Password)`,
    terms: `• Fresh unused Outlook/Hotmail credentials
• Instant automated bulk-ready delivery`,
    codes: []
  },
  {
    id: "edu_mail",
    name: "EDU MAIL",
    category: "standard",
    price: 1.28,
    stock: 330,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 25, price: 1.28 },
      { min: 26, max: 999999, price: 1.10 }
    ],
    description: `🎓 Official Verified .EDU Student Email Account
⏳ Validity: Long-Term Active Student Mailbox
🎁 Benefits: Unlock Student Discounts on GitHub, JetBrains, Figma, Notion, Autodesk & Prime
⚡ Delivery: Instant Automated (Email + Password)`,
    terms: `• Full inbox access for receiving verification codes
• Guaranteed active on arrival`,
    codes: []
  },
  {
    id: "usa",
    name: "USA",
    category: "standard",
    price: 1.50,
    stock: 240,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.50 },
      { min: 21, max: 999999, price: 1.30 }
    ],
    description: `🇺🇸 USA Verified Virtual Number / Account Package
🛡️ Status: Clean US Carrier Profile • High Deliverability
🔓 Usage: Ideal for US OTP Verifications, Social & App Registrations
⚡ Delivery: Instant Automated Access Link / Credentials`,
    terms: `• Clean USA number/account access
• Instant automated delivery`,
    codes: []
  },
  {
    id: "youtube",
    name: "YOUTUBE",
    category: "standard",
    price: 1.73,
    stock: 290,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 20, price: 1.73 },
      { min: 21, max: 999999, price: 1.50 }
    ],
    description: `▶️ YouTube Premium + YouTube Music (100% Ad-Free)
⏳ Validity: 1 Month Official Subscription
✨ Features: Background Play, Offline Downloads & 1080p Enhanced Bitrate
⚡ Delivery: Instant Automated Invite Link / Account`,
    terms: `• Works on Smart TV, iOS, Android & Web
• Full 30-day warranty included`,
    codes: []
  },
  {
    id: "duolingo",
    name: "DUOLINGO",
    category: "standard",
    price: 0.42,
    stock: 450,
    outOfStock: false,
    bulk_tiers: [
      { min: 1, max: 50, price: 0.42 },
      { min: 51, max: 999999, price: 0.35 }
    ],
    description: `🦉 Duolingo Super Official Subscription (40+ Languages)
⏳ Validity: 12 Months (Full Period Guarantee)
✨ Features: Unlimited Hearts, Mistake Review, Practice Hub & Zero Ads
⚡ Delivery: Instant Automated Activation / Account`,
    terms: `• Non-refundable once activated
• Full period replacement warranty`,
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
    bulk_tiers: buildBulkTiers(2.50),
    description: `✅ Official DeepSeek V3 & R1 Reasoning API Key
⚡️ Ultra-low latency, OpenAI compatible • Instant delivery`,
    terms: `• Instant automated token delivery
• Guaranteed 100% active`,
    codes: []
  }
];

// Ensure every default product has progressive bulk discount tiers (5+ = 10% OFF up to 100+ = 30% OFF)
for (const dp of defaultProducts) {
  dp.bulk_tiers = buildBulkTiers(dp.price);
}

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

  if (!Array.isArray(raw.settings.deleted_product_ids)) {
    raw.settings.deleted_product_ids = [];
  }
  const deletedSet = new Set(raw.settings.deleted_product_ids.map(String));

  // Filter out obsolete placeholder products and admin-deleted products
  raw.products = raw.products.filter(
    p => p && p.id && !LEGACY_REMOVED_IDS.has(String(p.id)) && !deletedSet.has(String(p.id))
  );

  for (const defP of defaultProducts) {
    if (deletedSet.has(String(defP.id))) continue;
    const existing = raw.products.find(p => String(p.id) === String(defP.id));
    if (!existing) {
      raw.products.push(structuredClone(defP));
    } else {
      if (!existing.category) existing.category = defP.category || "standard";
      if (existing.group === undefined && defP.group) existing.group = defP.group;
      if (!existing.admin_modified) {
        if (String(existing.id) === "gemini_18m" && (existing.name === "Gemini Links 18M" || existing.price === 0.55)) {
          existing.name = defP.name;
          existing.group = defP.group;
          existing.price = defP.price;
          existing.description = defP.description;
          existing.bulk_tiers = buildBulkTiers(defP.price);
        }
        if (String(existing.id) === "gemini_12m_acc" && existing.price === 1.20) {
          existing.price = defP.price;
          existing.description = defP.description;
          existing.bulk_tiers = buildBulkTiers(defP.price);
        }
        if (String(existing.id) === "gmail_plan_1" && existing.price === 0.18) {
          existing.price = defP.price;
          existing.description = defP.description;
          existing.bulk_tiers = buildBulkTiers(defP.price);
        }
        if (String(existing.id) === "gmail_plan_2" && (String(existing.name).includes("Phone-Verified") || String(existing.name).includes("PVA"))) {
          existing.name = defP.name;
          existing.description = defP.description;
          existing.bulk_tiers = buildBulkTiers(defP.price);
        }
      }
      if (existing.description === undefined || existing.description === "") {
        existing.description = defP.description;
      }
      if (existing.terms === undefined || existing.terms === "") existing.terms = defP.terms;
      if (existing.price === undefined) existing.price = defP.price;
    }
  }

  // Ensure every product has the progressive bulk discount tiers (5+ = 10% OFF, 10+ = 15% OFF, 25+ = 20% OFF, 50+ = 25% OFF, 100+ = 30% OFF)
  for (const prod of raw.products) {
    if (!Array.isArray(prod.bulk_tiers) || !prod.bulk_tiers.some(t => t.min === 5 && t.discount_pct === 10)) {
      prod.bulk_tiers = buildBulkTiers(prod.price);
    }
  }

  // Keep defaultProducts order first, followed by any custom products added by admin
  const orderMap = new Map(defaultProducts.map((p, idx) => [String(p.id), idx]));
  raw.products.sort((a, b) => {
    const idxA = orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : 9999;
    const idxB = orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : 9999;
    return idxA - idxB;
  });

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
          scheduleLocalWrite(memoryDb, 500);
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

// Asynchronous, non-blocking debounced disk writer to prevent event-loop hangs
let localWriteTimer = null;
let isWritingToDisk = false;
let pendingWriteAfterCurrent = false;

async function flushLocalDiskAsync() {
  if (!memoryDb) return;
  if (isWritingToDisk) {
    pendingWriteAfterCurrent = true;
    return;
  }
  isWritingToDisk = true;
  try {
    const payload = JSON.stringify(memoryDb, null, 2);
    await fs.promises.writeFile(file, payload, "utf8");
  } catch (e) {
    console.error("Local async file write error:", e.message);
  } finally {
    isWritingToDisk = false;
    if (pendingWriteAfterCurrent) {
      pendingWriteAfterCurrent = false;
      setImmediate(flushLocalDiskAsync);
    }
  }
}

function scheduleLocalWrite(db, delayMs = 250) {
  memoryDb = db;
  if (localWriteTimer) clearTimeout(localWriteTimer);
  localWriteTimer = setTimeout(() => {
    localWriteTimer = null;
    flushLocalDiskAsync();
  }, delayMs);
}

function flushStoreSync() {
  if (localWriteTimer) {
    clearTimeout(localWriteTimer);
    localWriteTimer = null;
  }
  if (!memoryDb) return;
  try {
    fs.writeFileSync(file, JSON.stringify(memoryDb, null, 2), "utf8");
  } catch (e) {
    console.error("Final sync flush error:", e.message);
  }
}

function save(db, options = {}) {
  memoryDb = db;
  const delayMs = options.lightweight ? 2500 : 200;
  scheduleLocalWrite(db, delayMs);
  if (isFirebaseConfigured()) {
    saveFirebaseData(db, options.lightweight ? 2500 : 400);
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
  const updatedFields = { ...fields, admin_modified: true };
  if (updatedFields.price !== undefined && updatedFields.bulk_tiers === undefined) {
    updatedFields.bulk_tiers = buildBulkTiers(updatedFields.price);
  }
  db.products[idx] = { ...db.products[idx], ...updatedFields };
  save(db);
  return db.products[idx];
}

function addProduct(product) {
  const db = load();
  if (!Array.isArray(product.bulk_tiers) || !product.bulk_tiers.some(t => t.min === 5)) {
    product.bulk_tiers = buildBulkTiers(product.price);
  }
  db.products.push(product);
  save(db);
  return product;
}

function deleteProduct(id) {
  const db = load();
  const idx = db.products.findIndex(p => String(p.id) === String(id));
  if (idx === -1) return false;
  db.products.splice(idx, 1);
  if (!Array.isArray(db.settings.deleted_product_ids)) {
    db.settings.deleted_product_ids = [];
  }
  const strId = String(id);
  if (!db.settings.deleted_product_ids.includes(strId)) {
    db.settings.deleted_product_ids.push(strId);
  }
  save(db);
  return true;
}

function calculateProductPrice(product, quantity) {
  const qty = Math.max(1, Number(quantity) || 1);
  const basePrice = Number(product.price) || 0;
  const originalTotal = Number((basePrice * qty).toFixed(2));
  const tiers = (Array.isArray(product.bulk_tiers) && product.bulk_tiers.some(t => t.min === 5))
    ? product.bulk_tiers
    : buildBulkTiers(basePrice);

  for (const tier of tiers) {
    if (qty >= tier.min && qty <= tier.max) {
      const discountPct = Number(tier.discount_pct || 0);
      const unitPrice = Number(tier.price);
      const rawDiscountedTotal = discountPct > 0
        ? basePrice * qty * (1 - discountPct / 100)
        : unitPrice * qty;
      const totalPrice = Math.max(0.01, Number(rawDiscountedTotal.toFixed(2)));
      const savedAmount = Number(Math.max(0, originalTotal - totalPrice).toFixed(2));
      return {
        unitPrice,
        totalPrice,
        discountPct,
        originalTotal,
        savedAmount
      };
    }
  }
  return {
    unitPrice: basePrice,
    totalPrice: originalTotal,
    discountPct: 0,
    originalTotal,
    savedAmount: 0
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
    save(db, { lightweight: true });
    return;
  }
  const u = db.users[idStr];
  if (!Array.isArray(u.sent_message_ids)) u.sent_message_ids = [];
  let changed = false;
  if (!u.sent_message_ids.includes(msgId)) {
    u.sent_message_ids.push(msgId);
    if (u.sent_message_ids.length > 150) {
      u.sent_message_ids = u.sent_message_ids.slice(-150);
    }
    changed = true;
  }
  if (!u.last_message_id || msgId > u.last_message_id) {
    u.last_message_id = msgId;
    changed = true;
  }
  if (changed) {
    save(db, { lightweight: true });
  }
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
    save(db, { lightweight: true });
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
  flushStoreSync,
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
  buildBulkTiers,
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
