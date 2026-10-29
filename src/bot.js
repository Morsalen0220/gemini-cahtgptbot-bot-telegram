require("dotenv").config();

const crypto = require("crypto");
const { Telegraf, Markup, session } = require("telegraf");
const QRCode = require("qrcode");
const express = require("express");

const {
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
  getPromoMessages,
  getPromoMessage,
  updatePromoMessage,
  addPromoMessage,
  deletePromoMessage,
  getNextPromoMessage,
  createTicket,
  getTicket,
  getUserTickets,
  getOpenTickets,
  getAllTickets,
  addTicketMessage,
  updateTicketStatus
} = require("./store");
const { getRandomCustomerName } = require("./names");
const { getRealCryptoTransactionProof } = require("./realTransactions");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || "");

if (!TOKEN) {
  throw new Error("Set BOT_TOKEN in .env");
}

if (!ADMIN_ID) {
  throw new Error("Set ADMIN_TELEGRAM_ID in .env");
}

const https = require("https");

// Prevent stray unhandled promise rejections or network glitches from crashing or freezing the bot
process.on("unhandledRejection", (reason) => {
  console.error("[Anti-Hang Guard] Unhandled Promise Rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Anti-Hang Guard] Uncaught Exception:", err?.message || err);
});

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 25000
});

const bot = new Telegraf(TOKEN, {
  handlerTimeout: 30000,
  telegram: { agent }
});

// =====================================================
// NON-BLOCKING CONCURRENT UPDATE DISPATCHER (PER-USER QUEUE)
// Ensures 1 slow user or admin action NEVER blocks or hangs other users!
// =====================================================
const rawHandleUpdate = bot.handleUpdate.bind(bot);
const userUpdateQueues = new Map();

function withTimeout(promise, ms, label = "Operation") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

bot.handleUpdate = function (update, webhookResponse) {
  // If running in webhook mode with an immediate HTTP response stream, let Telegraf handle it
  if (webhookResponse) {
    return rawHandleUpdate(update, webhookResponse);
  }

  const userId =
    update?.message?.from?.id ||
    update?.callback_query?.from?.id ||
    update?.edited_message?.from?.id ||
    update?.inline_query?.from?.id ||
    update?.my_chat_member?.from?.id;

  const queueKey = userId ? String(userId) : "global";

  // Dispatch asynchronously so Telegraf's polling loop immediately fetches the next update without waiting!
  const prevTask = userUpdateQueues.get(queueKey) || Promise.resolve();
  const nextTask = prevTask
    .then(() => withTimeout(rawHandleUpdate(update), 28000, `Update ${update?.update_id}`))
    .catch((err) => {
      console.error(`[Dispatcher Error] update_id=${update?.update_id}:`, err?.message || err);
    })
    .finally(() => {
      if (userUpdateQueues.get(queueKey) === nextTask) {
        userUpdateQueues.delete(queueKey);
      }
    });

  userUpdateQueues.set(queueKey, nextTask);
  return Promise.resolve();
};

let cachedBotUsername = null;
async function getCachedBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const info = await withTimeout(rawCallApi("getMe", {}), 8000, "getMe");
    if (info && info.username) {
      cachedBotUsername = info.username;
      return cachedBotUsername;
    }
  } catch (_) {}
  return "aibuyshop_bot";
}

bot.catch((err, ctx) => {
  console.error(`[Telegraf Error] update_id=${ctx?.update?.update_id}:`, err.message || err);
});

bot.use(
  session({
    defaultSession: () => ({})
  })
);

bot.use((ctx, next) => {
  ctx.session ??= {};
  return next();
});

// =====================================================
// OUTGOING API INTERCEPTOR, TIMEOUT GUARD & MESSAGE TRACKING
// =====================================================
const rawCallApi = bot.telegram.callApi.bind(bot.telegram);

const OUTGOING_USER_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendAudio",
  "sendVoice",
  "sendVideoNote",
  "sendSticker",
  "sendMediaGroup",
  "copyMessage",
  "copyMessages",
  "forwardMessage",
  "forwardMessages",
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "sendChatAction",
  "pinChatMessage"
]);

function isPrivateCustomerChatId(chatId) {
  if (chatId === undefined || chatId === null) return false;
  const s = String(chatId).trim();
  if (!s || s === ADMIN_ID) return false;
  if (s.startsWith("-") || s.startsWith("@")) return false;
  return /^\d+$/.test(s);
}

bot.telegram.callApi = async function (method, payload = {}, ...rest) {
  const targetChatId = payload?.chat_id !== undefined ? String(payload.chat_id).trim() : null;
  const isCustomerTarget = isPrivateCustomerChatId(targetChatId);

  // Never send any text, media, or update to a blocked user
  if (isCustomerTarget && OUTGOING_USER_METHODS.has(method) && !payload?._allowWhenBlocked && isUserBlocked(targetChatId)) {
    return { message_id: 0, chat: { id: payload.chat_id, type: "private" } };
  }

  let cleanPayload = payload;
  if (payload && payload._allowWhenBlocked) {
    cleanPayload = { ...payload };
    delete cleanPayload._allowWhenBlocked;
  }

  // Timeout guard (22s) + automatic retry on transient network reset or short 429 flood-wait
  let res;
  try {
    res = await withTimeout(rawCallApi(method, cleanPayload, ...rest), 22000, `Telegram API ${method}`);
  } catch (err) {
    const retryAfter = err?.parameters?.retry_after;
    if (retryAfter && retryAfter <= 5) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      res = await withTimeout(rawCallApi(method, cleanPayload, ...rest), 22000, `Telegram API ${method} retry`);
    } else if (
      err?.code === "ECONNRESET" ||
      err?.code === "ETIMEDOUT" ||
      err?.code === "EAI_AGAIN" ||
      err?.code === "EPIPE"
    ) {
      await new Promise((r) => setTimeout(r, 400));
      res = await withTimeout(rawCallApi(method, cleanPayload, ...rest), 22000, `Telegram API ${method} net-retry`);
    } else {
      throw err;
    }
  }

  // Record every message_id sent by the bot to a customer (lightweight debounced save in RAM)
  if (isCustomerTarget && res) {
    if (typeof res.message_id === "number" && res.message_id > 0) {
      recordUserMessageId(targetChatId, res.message_id);
    } else if (Array.isArray(res)) {
      for (const item of res) {
        if (item && typeof item.message_id === "number" && item.message_id > 0) {
          recordUserMessageId(targetChatId, item.message_id);
        }
      }
    }
  }

  return res;
};

// Delete all previously sent bot messages in the user's private chat so they cannot see past messages
async function purgeUserChatMessages(userId) {
  const targetId = String(userId).trim();
  if (!/^\d+$/.test(targetId)) return { deletedCount: 0 };

  const { sentIds, lastMessageId } = getUserSentMessageIds(targetId);
  let maxMsgId = Math.max(lastMessageId || 0, ...(sentIds.length ? sentIds : [0]));

  // Send a brief silent probe with ReplyKeyboardRemove to remove the bottom menu keyboard
  // and discover the latest message_id in the chat in case older messages existed before tracking
  let probeMsgId = 0;
  try {
    const probe = await rawCallApi("sendMessage", {
      chat_id: targetId,
      text: "🚫",
      disable_notification: true,
      reply_markup: { remove_keyboard: true }
    });
    if (probe && probe.message_id) {
      probeMsgId = Number(probe.message_id);
      maxMsgId = Math.max(maxMsgId, probeMsgId);
      await rawCallApi("deleteMessage", {
        chat_id: targetId,
        message_id: probeMsgId
      }).catch(() => {});
    }
  } catch (_) {}

  const uniqueTracked = Array.from(new Set(sentIds.filter(id => Number(id) > 0 && id !== probeMsgId))).sort((a, b) => b - a);
  const trackedSet = new Set(uniqueTracked);

  // Build sweep range of recent message IDs (last 200 messages) to catch any untracked historical bot messages
  const sweepIds = [];
  if (maxMsgId > 0) {
    const minSweep = Math.max(1, maxMsgId - 200);
    for (let id = maxMsgId; id >= minSweep; id--) {
      if (id !== probeMsgId && !trackedSet.has(id)) {
        sweepIds.push(id);
      }
    }
  }

  const allCandidateIds = [...uniqueTracked, ...sweepIds];
  let deletedCount = 0;

  // 1. Try fast batch deletion via Telegram Bot API deleteMessages (up to 100 IDs per call)
  for (let i = 0; i < allCandidateIds.length; i += 100) {
    const chunk = allCandidateIds.slice(i, i + 100);
    if (chunk.length === 0) continue;
    try {
      await rawCallApi("deleteMessages", {
        chat_id: targetId,
        message_ids: chunk
      });
    } catch (_) {}
  }

  // 2. Also run individual deleteMessage calls in parallel batches on tracked IDs + recent 120 sweep IDs
  // to ensure complete removal even if deleteMessages skipped a mixed batch
  const directDeleteList = [...uniqueTracked, ...sweepIds.slice(0, 120)];
  const BATCH_SIZE = 30;
  for (let i = 0; i < directDeleteList.length; i += BATCH_SIZE) {
    const batch = directDeleteList.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(msgId =>
        rawCallApi("deleteMessage", {
          chat_id: targetId,
          message_id: msgId
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) deletedCount++;
    }
  }

  // If there are remaining older sweep IDs beyond 120, clean them asynchronously in the background
  const remainingSweep = sweepIds.slice(120);
  if (remainingSweep.length > 0) {
    (async () => {
      for (let i = 0; i < remainingSweep.length; i += BATCH_SIZE) {
        const batch = remainingSweep.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(msgId =>
            rawCallApi("deleteMessage", {
              chat_id: targetId,
              message_id: msgId
            })
          )
        );
      }
    })().catch(() => {});
  }

  clearUserSentMessageIds(targetId);
  return { deletedCount: Math.max(deletedCount, uniqueTracked.length) };
}

async function blockUserAndPurge(userId) {
  const targetId = String(userId).trim();
  // Purge messages first (while probe can still be sent if needed), then mark blocked
  setUserBlocked(targetId, true);
  const purgeRes = await purgeUserChatMessages(targetId);
  return { user: getUser(targetId), ...purgeRes };
}

// =====================================================
// GLOBAL INCOMING BLOCK GUARD (Before /start & all handlers)
// =====================================================
bot.use(async (ctx, next) => {
  const fromId = ctx.from?.id;
  if (fromId) {
    if (ctx.chat?.type === "private") {
      if (ctx.message?.message_id) {
        recordUserLastSeenMessageId(fromId, ctx.message.message_id);
      }
      if (ctx.callbackQuery?.message?.message_id) {
        recordUserMessageId(fromId, ctx.callbackQuery.message.message_id);
      }
    }

    // If user is blocked (and not admin), give ZERO response and delete any old bot message they interacted with
    if (!isAdmin(ctx) && isUserBlocked(fromId)) {
      if (ctx.callbackQuery?.message?.message_id && ctx.chat?.id) {
        rawCallApi("deleteMessage", {
          chat_id: ctx.chat.id,
          message_id: ctx.callbackQuery.message.message_id
        }).catch(() => {});
      }
      return;
    }
  }
  return next();
});

// =====================================================
// HELPERS
// =====================================================
const money = (amount) => `${Number(amount || 0).toFixed(2)} USDT`;
function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAdmin(ctx) {
  return String(ctx.from?.id) === ADMIN_ID;
}

function adminOnly(ctx) {
  if (!isAdmin(ctx)) {
    ctx.reply("❌ Access denied.");
    return false;
  }
  return true;
}

const userLastVerifiedAt = new Map();

// Check if user has joined required channel/group via live Telegram API
async function verifyLiveMembership(ctx, userId) {
  const settings = getAllSettings();
  if (!settings.force_join_enabled) {
    return { ok: true, channelOk: true, groupOk: true };
  }

  // Bot admin is always allowed
  if (String(userId) === ADMIN_ID) {
    return { ok: true, channelOk: true, groupOk: true };
  }

  const validStatuses = ["creator", "administrator", "member", "restricted"];
  let channelOk = false;
  let groupOk = false;

  // 1. Check Channel Membership
  if (settings.channel_id) {
    try {
      const member = await bot.telegram.getChatMember(settings.channel_id, userId);
      channelOk = validStatuses.includes(member?.status);
    } catch (e) {
      console.warn(`[ForceJoin] Channel check failed for user ${userId}:`, e.message);
      channelOk = false;
    }
  } else {
    channelOk = true;
  }

  // 2. Check Group Membership
  if (settings.group_id) {
    try {
      const member = await bot.telegram.getChatMember(settings.group_id, userId);
      groupOk = validStatuses.includes(member?.status);
    } catch (e) {
      console.warn(`[ForceJoin] Group check failed for user ${userId}:`, e.message);
      groupOk = false;
    }
  } else {
    groupOk = true;
  }

  const ok = Boolean(channelOk && groupOk);
  setUserVerified(userId, ok);

  if (ok) {
    userLastVerifiedAt.set(String(userId), Date.now());
  } else {
    userLastVerifiedAt.delete(String(userId));
  }

  return { ok, channelOk, groupOk };
}

async function checkMembership(ctx, forceLive = false) {
  const settings = getAllSettings();
  if (!settings.force_join_enabled) return true;

  const userId = ctx.from?.id;
  if (!userId) return false;
  if (String(userId) === ADMIN_ID) return true;

  // If forceLive is false and verified recently (within 45 seconds), allow through
  const lastCheck = userLastVerifiedAt.get(String(userId)) || 0;
  const isRecentlyChecked = (Date.now() - lastCheck) < 45 * 1000;
  if (!forceLive && isUserVerified(userId) && isRecentlyChecked) {
    return true;
  }

  // Otherwise perform live verification
  const { ok } = await verifyLiveMembership(ctx, userId);
  return ok;
}

function forceJoinKeyboard() {
  const settings = getAllSettings();
  const buttons = [];

  if (settings.channel_link) {
    buttons.push([Markup.button.url("📢 Join Channel", settings.channel_link)]);
  }
  if (settings.group_link) {
    buttons.push([Markup.button.url("👥 Join Group", settings.group_link)]);
  }
  buttons.push([Markup.button.callback("🔄 Check / I Have Joined", "check_membership")]);

  return Markup.inlineKeyboard(buttons);
}

// 8-Button Main Menu Keyboard matching user UI screenshot
function getMainMenuReplyKeyboard() {
  return Markup.keyboard([
    ["🛍️ Buy", "💰 My Orders"],
    ["👛 Wallet", "📰 Profile"],
    ["🗑️ Recover", "📌 Refer & Earn"],
    ["💬 Support", "🆙 API Key"]
  ]).resize();
}

function getMainMenuInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛍️ Buy", "menu:buy"), Markup.button.callback("💰 My Orders", "menu:orders")],
    [Markup.button.callback("👛 Wallet", "menu:wallet"), Markup.button.callback("📰 Profile", "menu:profile")],
    [Markup.button.callback("🗑️ Recover", "menu:recover"), Markup.button.callback("📌 Refer & Earn", "menu:refer")],
    [Markup.button.callback("💬 Support", "menu:support"), Markup.button.callback("🆙 API Key", "menu:apikey")]
  ]);
}

function welcomeText(user) {
  return `😃 Welcome, ${user.first_name || "there"}!

⚡️ Instant Automated Delivery
✅ Fresh & Guaranteed Accounts / Coupons
👛 Pay with Wallet (Binance Pay / USDT BEP20 / Polygon)
💬 24/7 Dedicated Support

Tap 🛍️ Buy below to explore available products:`;
}

// =====================================================
// /START & FORCE JOIN
// =====================================================
bot.start(async (ctx) => {
  ctx.session = {};

  // Check referral param: /start ref_123456
  const payload = ctx.message?.text?.split(" ")[1] || "";
  let referrerId = null;
  if (payload.startsWith("ref_")) {
    referrerId = payload.replace("ref_", "");
  }

  const user = getOrCreateUser(ctx.from, referrerId);

  if (referrerId) {
    const refUser = getUser(referrerId);
    if (refUser && refUser.referral_count > 0 && refUser.referral_count % 30 === 0) {
      bot.telegram.sendMessage(
        referrerId,
        `🎉 CONGRATULATIONS!\nYou have reached ${refUser.referral_count} referrals! 🎁\nYou unlocked 1 FREE Gemini Links 18M subscription!\n\nOpen 📌 Refer & Earn in the bot to claim your reward!`,
        Markup.inlineKeyboard([[Markup.button.callback("🎁 Claim Free Gemini", "refer:claim")]])
      ).catch(() => {});
    }
  }

  const joined = await checkMembership(ctx, true);
  if (!joined) {
    const settings = getAllSettings();
    return ctx.reply(
      `⚠️ Welcome! To use this bot, please join our official Channel and Group first:\n\n📢 Channel: ${settings.channel_link}\n👥 Group: ${settings.group_link}\n\nAfter joining, tap "Check / I Have Joined" below:`,
      forceJoinKeyboard()
    );
  }

  await ctx.reply(welcomeText(user), getMainMenuReplyKeyboard());
});

// Membership verification callback
bot.action("check_membership", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { ok, channelOk, groupOk } = await verifyLiveMembership(ctx, userId);
  if (!ok) {
    if (!channelOk && !groupOk) {
      return ctx.answerCbQuery("❌ You haven't joined both our Channel & Group yet! Please join both first.", {
        show_alert: true
      });
    }
    if (!channelOk) {
      return ctx.answerCbQuery("❌ You haven't joined our Channel yet! Please join the channel first.", {
        show_alert: true
      });
    }
    if (!groupOk) {
      return ctx.answerCbQuery("❌ You haven't joined our Group yet! Please join the group first.", {
        show_alert: true
      });
    }
    return ctx.answerCbQuery("❌ Membership not found. Please join and try again.", { show_alert: true });
  }

  await ctx.answerCbQuery("🎉 Verified successfully!");

  // Delete the Access Denied / Force Join prompt message so it vanishes cleanly
  try {
    await ctx.deleteMessage();
  } catch (err) {}

  const user = getOrCreateUser(ctx.from);
  await ctx.reply(
    `🎉 Congratulations! You have successfully joined.\nWelcome to Gemini AI Shop!\n\n` + welcomeText(user),
    getMainMenuReplyKeyboard()
  );
});

// =====================================================
// FORCE JOIN GUARD (Blocks Buy/Wallet/etc until joined)
// =====================================================
bot.use(async (ctx, next) => {
  const text = ctx.message?.text || "";
  const cbData = ctx.callbackQuery?.data || "";

  // All admin interactions are completely unrestricted
  if (isAdmin(ctx)) {
    if (text.startsWith("/admin") || cbData.startsWith("adm") || ctx.session?.adminAction) {
      return next();
    }
  }

  if (text.startsWith("/start")) return next();
  if (cbData === "check_membership") return next();

  const settings = getAllSettings();
  if (settings.force_join_enabled) {
    const userId = ctx.from?.id;
    if (userId) {
      const isJoined = await checkMembership(ctx, false);
      if (!isJoined) {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery("⚠️ Access Denied! Please join our Channel and Group first!", { show_alert: true });
        }
        return ctx.reply(
          `⚠️ Access Denied!\nYou must join our Channel and Group before using any bot features.\n\n📢 Channel: ${settings.channel_link}\n👥 Group: ${settings.group_link}\n\n👇 After joining, tap "Check / I Have Joined" below:`,
          forceJoinKeyboard()
        );
      }
    }
  }

  return next();
});

// =====================================================
// MAIN MENU & SLASH COMMAND HANDLERS ("/" MENU)
// =====================================================
const PUBLIC_BOT_COMMANDS = [
  { command: "start", description: "🏠 Start Bot & Main Menu" },
  { command: "buy", description: "🛍️ Browse Products & Plans" },
  { command: "wallet", description: "👛 Check Wallet Balance & History" },
  { command: "deposit", description: "💳 Add Funds (Binance Pay / USDT)" },
  { command: "orders", description: "💰 View My Purchased Orders" },
  { command: "recover", description: "🗑️ Recover Order by Order Code" },
  { command: "refer", description: "📌 Refer Friends & Claim Free Gemini" },
  { command: "apikey", description: "🆙 Buy AI API Keys & Cloud Tokens" },
  { command: "support", description: "💬 24/7 Support Desk & Warranty" },
  { command: "ticket", description: "🎫 Open Support / Replacement Ticket" },
  { command: "profile", description: "📰 My Account Profile & Stats" },
  { command: "help", description: "❓ How to Buy, Bulk Discounts & FAQ" },
  { command: "cancel", description: "❎ Cancel Current Action" }
];

const ADMIN_EXTRA_COMMANDS = [
  { command: "admin", description: "🔐 Open Admin Control Panel" },
  { command: "promos", description: "🎯 1-Click Saved Promo Broadcast (40 Ready)" },
  { command: "products", description: "🛍️ Manage Products, Plans & Prices" },
  { command: "deposits", description: "📥 Review Pending Wallet Deposits" },
  { command: "tickets", description: "🎫 View & Reply to Support Tickets" },
  { command: "customers", description: "👥 Customer List & Direct Message" },
  { command: "broadcast", description: "📢 Broadcast Message to All Users" },
  { command: "pinall", description: "📌 Broadcast & Pin to All Users" },
  { command: "unpinall", description: "🗑️ Remove All Old Pinned Messages" },
  { command: "block", description: "🚫 Block User & Purge Messages" },
  { command: "unblock", description: "🟢 Unblock User by ID / @username" }
];

async function registerBotCommands() {
  try {
    await bot.telegram.setMyCommands(PUBLIC_BOT_COMMANDS);
    await bot.telegram.setMyCommands(PUBLIC_BOT_COMMANDS, {
      scope: { type: "all_private_chats" }
    });
    if (/^\d+$/.test(ADMIN_ID)) {
      await bot.telegram.setMyCommands(
        [...ADMIN_EXTRA_COMMANDS, ...PUBLIC_BOT_COMMANDS],
        { scope: { type: "chat", chat_id: Number(ADMIN_ID) } }
      ).catch(() => {});
    }
    await bot.telegram.setChatMenuButton({
      menu_button: { type: "commands" }
    }).catch(() => {});
    console.log("✅ Registered Telegram '/' slash commands menu successfully!");
  } catch (err) {
    console.error("Failed to register Telegram slash commands:", err.message || err);
  }
}

bot.hears("🛍️ Buy", (ctx) => showCatalog(ctx));
bot.command(["buy", "shop", "catalog"], (ctx) => {
  clearAdminConflictingSession(ctx);
  return showCatalog(ctx);
});
bot.action("menu:buy", (ctx) => showCatalog(ctx));

bot.hears("💰 My Orders", (ctx) => showMyOrders(ctx));
bot.command(["orders", "myorders"], (ctx) => {
  clearAdminConflictingSession(ctx);
  return showMyOrders(ctx);
});
bot.action("menu:orders", (ctx) => showMyOrders(ctx));

bot.hears("👛 Wallet", (ctx) => showWallet(ctx));
bot.command(["wallet", "balance"], (ctx) => {
  clearAdminConflictingSession(ctx);
  return showWallet(ctx);
});
bot.action("menu:wallet", (ctx) => showWallet(ctx));

bot.command(["deposit", "addfunds", "topup"], async (ctx) => {
  clearAdminConflictingSession(ctx);
  const settings = getAllSettings();
  const minCrypto = Number(settings.min_crypto_deposit || 1.00);
  const text = `💳 <b>SELECT DEPOSIT METHOD</b>
━━━━━━━━━━━━━━━━━━━
Please choose your preferred deposit gateway:
• <b>Binance Pay:</b> Binance ID / Pay ID (Min: <b>$${minCrypto.toFixed(2)} USDT</b>)
• <b>USDT (BEP20):</b> BNB Smart Chain (Min: <b>$${minCrypto.toFixed(2)} USDT</b>)
• <b>USDT (Polygon):</b> Polygon / POL (Min: <b>$${minCrypto.toFixed(2)} USDT</b>)`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🟡 Binance Pay (Binance ID)", `deposit:binance:${minCrypto}`)],
    [Markup.button.callback("🟡 USDT (BEP20 / BSC)", `deposit:bep20:${minCrypto}`)],
    [Markup.button.callback("🟣 USDT (Polygon / POL)", `deposit:polygon:${minCrypto}`)],
    [Markup.button.callback("🔙 Back to Wallet", "menu:wallet")]
  ]);
  return ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

bot.hears("📰 Profile", (ctx) => showProfile(ctx));
bot.command("profile", (ctx) => {
  clearAdminConflictingSession(ctx);
  return showProfile(ctx);
});
bot.action("menu:profile", (ctx) => showProfile(ctx));

bot.hears("🗑️ Recover", (ctx) => promptRecover(ctx));
bot.command("recover", (ctx) => {
  clearAdminConflictingSession(ctx);
  return promptRecover(ctx);
});
bot.action("menu:recover", (ctx) => promptRecover(ctx));

bot.hears("📌 Refer & Earn", (ctx) => showRefer(ctx));
bot.command(["refer", "referral", "invite"], (ctx) => {
  clearAdminConflictingSession(ctx);
  return showRefer(ctx);
});
bot.action("menu:refer", (ctx) => showRefer(ctx));

bot.hears("💬 Support", (ctx) => showSupport(ctx));
bot.command("support", (ctx) => {
  clearAdminConflictingSession(ctx);
  return showSupport(ctx);
});
bot.action("menu:support", (ctx) => showSupport(ctx));

bot.command("ticket", (ctx) => {
  clearAdminConflictingSession(ctx);
  const text = `🎫 <b>OPEN NEW SUPPORT TICKET</b>
━━━━━━━━━━━━━━━━━━━━
Please select the category that best describes your issue:`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Order Replacement / Warranty", "ticket:cat:Replacement")],
    [Markup.button.callback("💳 Deposit / Balance Issue", "ticket:cat:Deposit")],
    [Markup.button.callback("🔑 Account / Redeem Link Help", "ticket:cat:Product")],
    [Markup.button.callback("💬 General Question", "ticket:cat:General")],
    [Markup.button.callback("🔙 Back to Support", "menu:support")]
  ]);
  return ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

bot.hears("🆙 API Key", (ctx) => showApiKey(ctx));
bot.command(["apikey", "api"], (ctx) => {
  clearAdminConflictingSession(ctx);
  return showApiKey(ctx);
});
bot.action("menu:apikey", (ctx) => showApiKey(ctx));

bot.command("help", async (ctx) => {
  clearAdminConflictingSession(ctx);
  const text = `❓ <b>HOW TO USE THIS BOT & FAQ</b>
━━━━━━━━━━━━━━━━━━━━
🛍️ <b>1. Instant Shopping (<code>/buy</code>)</b>
• Browse Multi-Plan categories (Gemini, Claude AI, ChatGPT, CapCut, Canva, Gmail, Autodesk, Muse) or 28+ direct subscriptions.
• Delivery is <b>100% instant & automated</b> once paid from your wallet.

🔥 <b>2. Progressive Bulk Discounts</b>
• Buy <b>5 – 9 pcs</b> ➔ <b>10% OFF</b> on every item
• Buy <b>10 – 24 pcs</b> ➔ <b>15% OFF</b> on every item
• Buy <b>25 – 49 pcs</b> ➔ <b>20% OFF</b> on every item
• Buy <b>50 – 99 pcs</b> ➔ <b>25% OFF</b> on every item
• Buy <b>100+ pcs</b> ➔ <b>30% OFF</b> on every item

💳 <b>3. Wallet Deposit (<code>/deposit</code>)</b>
• Top up anytime via <b>Binance Pay</b>, <b>USDT (BEP20)</b>, or <b>USDT (Polygon)</b>.

🎁 <b>4. Refer & Earn (<code>/refer</code>)</b>
• Invite 30 friends to unlock <b>1 FREE Gemini Advanced 18M</b> subscription + earn commission on deposits!

🎫 <b>5. 24/7 Support & Warranty (<code>/ticket</code>)</b>
• Every product includes replacement warranty. Open a ticket anytime for fast assistance.`;

  return ctx.reply(text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🛍️ Browse Products", "menu:buy"), Markup.button.callback("💳 Deposit Funds", "deposit:start")],
      [Markup.button.callback("🎫 Open Support Ticket", "ticket:new"), Markup.button.callback("🏠 Main Menu", "menu:main")]
    ])
  });
});

// Admin quick slash commands
bot.command("products", async (ctx) => {
  if (!adminOnly(ctx)) return;
  clearAdminConflictingSession(ctx);
  return showAdminProductsMenu(ctx);
});

bot.command("deposits", async (ctx) => {
  if (!adminOnly(ctx)) return;
  clearAdminConflictingSession(ctx);
  const list = getPendingDeposits();
  if (list.length === 0) {
    return ctx.reply("✅ No pending deposits.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Admin Menu", "adm:menu")]]));
  }
  const buttons = list.slice(0, 10).map((d) => [
    Markup.button.callback(`🔍 ${d.id} • ${money(d.amount)} (${d.user_name})`, `adm_view_dep:${d.id}`)
  ]);
  buttons.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);
  return ctx.reply(`📥 PENDING DEPOSITS (${list.length}):`, Markup.inlineKeyboard(buttons));
});

bot.command("tickets", async (ctx) => {
  if (!adminOnly(ctx)) return;
  clearAdminConflictingSession(ctx);
  const openList = getOpenTickets();
  const allList = getAllTickets();
  const displayList = openList.length > 0 ? openList : allList.slice(0, 10);
  if (displayList.length === 0) {
    return ctx.reply("✅ No support tickets found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Admin Menu", "adm:menu")]]));
  }
  const buttons = displayList.slice(0, 12).map((t) => {
    const icon = t.status === "open" ? "🟢" : t.status === "replied" ? "💬" : "✅";
    return [Markup.button.callback(`${icon} #${t.id} — ${t.user_name} (${t.category.replace(/^[^\s]+\s/, "")})`, `adm_tkt_view:${t.id}`)];
  });
  buttons.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);
  return ctx.reply(`🎫 <b>SUPPORT TICKETS (${displayList.length})</b>\nSelect a ticket below:`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.command("customers", async (ctx) => {
  if (!adminOnly(ctx)) return;
  clearAdminConflictingSession(ctx);
  return ctx.reply(
    "👥 Tap below to open the Customer Directory & Direct Messaging panel:",
    Markup.inlineKeyboard([[Markup.button.callback("👥 Open Customers Directory", "adm:customers:0")]])
  );
});

bot.command("broadcast", async (ctx) => {
  if (!adminOnly(ctx)) return;
  clearAdminConflictingSession(ctx);
  ctx.session.adminAction = { type: "broadcast" };
  return ctx.reply(
    "📢 Send the message you want to broadcast to all registered active bot users:\n\nSend /cancel to cancel.",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]])
  );
});

bot.action("menu:main", async (ctx) => {
  await ctx.answerCbQuery();
  const user = getOrCreateUser(ctx.from);
  await ctx.reply("🏠 Main Menu", getMainMenuInlineKeyboard());
});

// =====================================================
// CATALOG / BUY FLOW (MULTI-PLAN GROUPS & SINGLE ITEMS)
// =====================================================
function pairButtons(btnArray, perRow = 2) {
  const rows = [];
  for (let i = 0; i < btnArray.length; i += perRow) {
    rows.push(btnArray.slice(i, i + perRow));
  }
  return rows;
}

async function showCatalog(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const products = getStandardProducts();
  const text = `🛍️ <b>AVAILABLE PRODUCTS & PLANS</b>
━━━━━━━━━━━━━━━━━━━
Select a category or product below — multi-plan packages and live prices are shown on each button.
🔥 <b>Bulk Discount:</b> Buy <b>5+</b> items to get <b>10% OFF</b> — up to <b>30% OFF</b> on bigger orders!
⚡️ <i>Delivery is instant & automated once payment clears.</i>`;

  // Group multi-plan products by their `group` field in catalog order
  const groupMap = new Map();
  const singleProducts = [];

  for (const p of products) {
    const grp = p.group ? String(p.group).trim() : "";
    if (grp) {
      if (!groupMap.has(grp)) groupMap.set(grp, []);
      groupMap.get(grp).push(p);
    } else {
      singleProducts.push(p);
    }
  }

  const groupButtons = [];
  for (const [grpName, plans] of groupMap.entries()) {
    const planWord = plans.length === 1 ? "Plan" : "Plans";
    const label = `${grpName} ▸ ${plans.length} ${planWord} »`;
    groupButtons.push(Markup.button.callback(label, `grp:${grpName}`));
  }

  const singleButtons = singleProducts.map((p) => {
    let label;
    if (p.outOfStock || p.stock <= 0) {
      label = `${p.name} • Out`;
    } else {
      label = `${p.name} $${Number(p.price || 0).toFixed(2)}`;
    }
    return Markup.button.callback(label, `prod:${p.id}`);
  });

  const rows = [
    ...pairButtons(groupButtons, 2),
    ...pairButtons(singleButtons, 2),
    [Markup.button.callback("🔙 Go Back", "menu:main")]
  ];

  const keyboard = Markup.inlineKeyboard(rows);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
}

// Multi-Plan Group clicked -> Show all plans inside that group
bot.action(/^grp:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const groupName = ctx.match[1];
  await showGroupPlans(ctx, groupName);
});

async function showGroupPlans(ctx, groupName) {
  const plans = getStandardProducts().filter(
    (p) => p.group && String(p.group).trim().toLowerCase() === String(groupName).trim().toLowerCase()
  );

  if (plans.length === 0) {
    return showCatalog(ctx);
  }

  const displayGroup = plans[0].group || groupName;
  let text = `📂 <b>${escapeHtml(displayGroup.toUpperCase())} — AVAILABLE PLANS (${plans.length})</b>\n━━━━━━━━━━━━━━━━━━━\n`;

  plans.forEach((plan, idx) => {
    const statusText = (plan.outOfStock || plan.stock <= 0)
      ? "🚫 Out of stock"
      : `✅ Stock: ${plan.stock}`;
    const firstLineDesc = String(plan.description || "").split("\n")[0] || "";
    text += `\n<b>${idx + 1}. ${escapeHtml(plan.name)}</b> — <b>$${Number(plan.price).toFixed(2)}</b> (${statusText})\n<i>${escapeHtml(firstLineDesc)}</i>\n`;
  });

  text += `\n🔥 <b>Bulk Offer:</b> Buy 5+ for <b>10% OFF</b> • 10+ for <b>15% OFF</b> • Up to <b>30% OFF</b>!\n👇 <b>Select a plan below to view full details & purchase:</b>`;

  const buttons = plans.map((plan) => {
    let label;
    if (plan.outOfStock || plan.stock <= 0) {
      label = `${plan.name} • Out of stock`;
    } else {
      label = `${plan.name} • $${Number(plan.price).toFixed(2)} | Stock: ${plan.stock}`;
    }
    return [Markup.button.callback(label, `prod:${plan.id}`)];
  });

  buttons.push([Markup.button.callback("🔙 Back to Catalog", "menu:buy")]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
}

// Product or Plan clicked -> Show Clean Description, Bulk Discount & Quantity Selector
bot.action(/^prod:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const p = getProduct(productId);
  const backMenu = p && p.category === "api_key"
    ? "menu:apikey"
    : (p && p.group ? `grp:${p.group}` : "menu:buy");
  const backLabel = p && p.category === "api_key"
    ? "🔙 Back to API Keys"
    : (p && p.group ? `🔙 Back to ${p.group} Plans` : "🔙 Back to Catalog");

  if (!p) {
    return ctx.reply("❌ Product not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Catalog", "menu:buy")]]));
  }

  if (p.outOfStock || p.stock <= 0) {
    return ctx.reply(
      `⚠️ <b>${escapeHtml(p.name)}</b> is currently out of stock.\nPlease check back later or choose another item.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback(backLabel, backMenu)]])
      }
    );
  }

  ctx.session.selectedProductId = p.id;

  const tiers = (Array.isArray(p.bulk_tiers) && p.bulk_tiers.some(t => t.min === 5))
    ? p.bulk_tiers
    : buildBulkTiers(p.price);

  let bulkText = `🛍️ <b>${escapeHtml(p.name)}</b>${p.group ? ` <i>(${escapeHtml(p.group)})</i>` : ""}\n━━━━━━━━━━━━━━━━━━━\n`;
  if (p.description) {
    bulkText += `${escapeHtml(p.description)}\n\n━━━━━━━━━━━━━━━━━━━\n`;
  }
  bulkText += `💰 <b>Progressive Bulk Discount Offers:</b>\n`;
  for (const tier of tiers) {
    const maxLabel = tier.max >= 99999 ? "+" : ` – ${tier.max}`;
    const pct = Number(tier.discount_pct || 0);
    const priceDecimals = String(tier.price).split(".")[1]?.length === 3 ? 3 : 2;
    const priceStr = `$${Number(tier.price).toFixed(priceDecimals)}`;
    if (pct > 0) {
      bulkText += `🔥 <b>Buy ${tier.min}${maxLabel} pcs</b> → <b>${priceStr} each</b> <i>(${pct}% OFF!)</i>\n`;
    } else {
      bulkText += `✅ <b>Buy ${tier.min}${maxLabel} pcs</b> → <b>${priceStr} each</b> <i>(Regular Price)</i>\n`;
    }
  }
  bulkText += `\n💎 <b>Available Stock:</b> ${p.stock}\n👇 <b>Select quantity below (Buy 5+ for instant discount!):</b>`;

  const navRow = [Markup.button.callback(backLabel, backMenu)];
  if (p.group) {
    navRow.push(Markup.button.callback("🏠 All Products", "menu:buy"));
  }

  const qtyButtons = [
    [
      Markup.button.callback("1", `qty:${p.id}:1`),
      Markup.button.callback("5 (-10% 🔥)", `qty:${p.id}:5`),
      Markup.button.callback("10 (-15% 🔥)", `qty:${p.id}:10`)
    ],
    [
      Markup.button.callback("25 (-20% 🔥)", `qty:${p.id}:25`),
      Markup.button.callback("50 (-25% 🔥)", `qty:${p.id}:50`),
      Markup.button.callback("100 (-30% 🔥)", `qty:${p.id}:100`)
    ],
    [
      Markup.button.callback("✏️ Custom Quantity", `qty_custom:${p.id}`)
    ],
    navRow
  ];

  try {
    await ctx.editMessageText(bulkText, { parse_mode: "HTML", ...Markup.inlineKeyboard(qtyButtons) });
  } catch (e) {
    await ctx.reply(bulkText, { parse_mode: "HTML", ...Markup.inlineKeyboard(qtyButtons) });
  }
});

// Custom quantity prompt
bot.action(/^qty_custom:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const p = getProduct(productId);
  if (!p) return ctx.reply("❌ Product not found.");

  ctx.session.awaitingCustomQty = productId;
  await ctx.reply(
    `✏️ Please enter the quantity you want to purchase (1 to ${p.stock}):\n🔥 <i>Tip: Enter 5 or more for automatic 10% to 30% bulk discount!</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `prod:${productId}`)]])
    }
  );
});

// Quantity selected -> Step 1: Show Product Information & Features
bot.action(/^qty:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const qty = Number(ctx.match[2]);
  await showProductDetails(ctx, productId, qty);
});

// Step 1: Product Features & Details
async function showProductDetails(ctx, productId, qty) {
  const p = getProduct(productId);
  if (!p) return ctx.reply("❌ Product not found.");

  if (qty > p.stock) {
    return ctx.reply(
      `⚠️ Insufficient stock. Only ${p.stock} available.`,
      Markup.inlineKeyboard([[Markup.button.callback("🔙 Select Quantity", `prod:${p.id}`)]])
    );
  }

  const { unitPrice, totalPrice, discountPct, originalTotal, savedAmount } = calculateProductPrice(p, qty);
  ctx.session.pendingOrder = {
    productId: p.id,
    quantity: qty,
    unitPrice,
    totalPrice
  };

  let discountLine = "";
  if (discountPct > 0) {
    discountLine = `\n🔥 <b>Bulk Discount:</b> <b>${discountPct}% OFF Applied!</b> (You Save <b>$${Number(savedAmount).toFixed(2)}</b>)\n💲 <b>Regular Total:</b> <s>$${Number(originalTotal).toFixed(2)}</s>`;
  }

  const text = `🛍️ <b>PRODUCT DETAILS: ${escapeHtml(p.name)}</b>
━━━━━━━━━━━━━━━━━━━
${escapeHtml(p.description || "")}

━━━━━━━━━━━━━━━━━━━
🔢 <b>Selected Quantity:</b> ${qty}x
💲 <b>Unit Price:</b> $${Number(unitPrice).toFixed(2)} (${money(unitPrice)})${discountLine}
💰 <b>Final Total:</b> <b>$${Number(totalPrice).toFixed(2)} (${money(totalPrice)})</b>`;

  const backMenu = p.category === "api_key"
    ? "menu:apikey"
    : (p.group ? `grp:${p.group}` : "menu:buy");
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`➡️ Continue to Order (${qty}x — $${Number(totalPrice).toFixed(2)})`, `order_summary:${p.id}:${qty}`)],
    [Markup.button.callback("🔢 Change Quantity", `prod:${p.id}`)],
    [Markup.button.callback("❌ Cancel", backMenu)]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
}

// User clicks Continue to Order -> Step 2: Order Summary & Terms
bot.action(/^order_summary:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const qty = Number(ctx.match[2]);
  await showOrderSummary(ctx, productId, qty);
});

bot.action(/^order_info:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const qty = Number(ctx.match[2]);
  await showProductDetails(ctx, productId, qty);
});

// Step 2: Order Details, Pricing & Terms
async function showOrderSummary(ctx, productId, qty) {
  const p = getProduct(productId);
  if (!p) return ctx.reply("❌ Product not found.");

  const { unitPrice, totalPrice, discountPct, originalTotal, savedAmount } = calculateProductPrice(p, qty);
  ctx.session.pendingOrder = {
    productId: p.id,
    quantity: qty,
    unitPrice,
    totalPrice
  };

  let discountSummary = "";
  if (discountPct > 0) {
    discountSummary = `\n🔥 <b>Bulk Discount:</b> <b>${discountPct}% OFF</b> (Saved $${Number(savedAmount).toFixed(2)} from $${Number(originalTotal).toFixed(2)})`;
  }

  const text = `📦 <b>ORDER SUMMARY & TERMS</b>
━━━━━━━━━━━━━━━━━━━
🛍️ <b>Product:</b> ${escapeHtml(p.name)}
🔢 <b>Quantity:</b> ${qty}x
💲 <b>Unit Price:</b> $${Number(unitPrice).toFixed(2)} (${money(unitPrice)})${discountSummary}
💰 <b>Total Due:</b> <b>$${Number(totalPrice).toFixed(2)} (${money(totalPrice)})</b>

━━━━━━━━━━━━━━━━━━━
✍️ <b>Terms of Service:</b>
${escapeHtml(p.terms || "• Instant automated delivery\n• 48 Hours Replacement Guarantee")}`;

  const backMenu = p.category === "api_key"
    ? "menu:apikey"
    : (p.group ? `grp:${p.group}` : "menu:buy");
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Agree & Pay $${Number(totalPrice).toFixed(2)}`, "order:pay_check")],
    [Markup.button.callback("🔙 Back to Product Details", `order_info:${p.id}:${qty}`)],
    [Markup.button.callback("❌ Cancel Order", backMenu)]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
}

// =====================================================
// WALLET CHECK & PAYMENT EXECUTION
// =====================================================
bot.action("order:pay_check", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const pending = ctx.session.pendingOrder;
  if (!pending) {
    return ctx.reply("⚠️ No active order found. Please select a product again.", Markup.inlineKeyboard([[Markup.button.callback("🛍️ Catalog", "menu:buy")]]));
  }

  const user = getOrCreateUser(ctx.from);
  const needed = Number(pending.totalPrice);
  const currentBal = Number(user.wallet_balance || 0);

  if (currentBal < needed) {
    const shortBy = Number((needed - currentBal).toFixed(2));
    const text = `Gemini Shop:
👛 Insufficient wallet balance

Balance: ${money(currentBal)}
Needed: ${money(needed)}
Short by: ${money(shortBy)}

Add funds below, then come back and pay from your wallet.`;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback("💳 Deposit Funds", `deposit:start:${shortBy}`)],
      [Markup.button.callback("🔙 Main Menu", "menu:main")]
    ]);

    try {
      await ctx.editMessageText(text, buttons);
    } catch (e) {
      await ctx.reply(text, buttons);
    }
    return;
  }

  // Sufficient balance: confirm payment
  const p = getProduct(pending.productId);
  const backMenu = p && p.category === "api_key" ? "menu:apikey" : "menu:buy";
  const text = `👛 Confirm Payment

Product: ${p.name}
Quantity: ${pending.quantity}
Total Price: ${money(needed)}
Your Balance: ${money(currentBal)}
Balance After: ${money(currentBal - needed)}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`⚡ Pay ${money(needed)} from Wallet`, "order:execute_pay")],
    [Markup.button.callback("❌ Cancel", backMenu)]
  ]);

  try {
    await ctx.editMessageText(text, buttons);
  } catch (e) {
    await ctx.reply(text, buttons);
  }
});

// Execute payment & instant delivery
bot.action("order:execute_pay", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const pending = ctx.session.pendingOrder;
  if (!pending) return ctx.reply("⚠️ Order session expired. Please try again.");

  const user = getOrCreateUser(ctx.from);
  const needed = Number(pending.totalPrice);
  const currentBal = Number(user.wallet_balance || 0);

  if (currentBal < needed) {
    return ctx.reply("⚠️ Insufficient balance. Please deposit funds first.");
  }

  const p = getProduct(pending.productId);
  if (!p || p.stock < pending.quantity) {
    return ctx.reply("⚠️ Product is out of stock.");
  }

  // Deduct balance
  adjustUserBalance(user.id, -needed);

  // Dispense codes/links from inventory
  const dispensed = dispenseProductCodes(p.id, pending.quantity);

  // Create order record
  const order = createOrder({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    product_id: p.id,
    product_name: p.name,
    quantity: pending.quantity,
    unit_price: pending.unitPrice,
    total_price: needed,
    delivered_codes: dispensed,
    status: "completed"
  });

  ctx.session.pendingOrder = null;

  let deliveryText = `🎉 PAYMENT SUCCESSFUL!

📦 Order Code: \`${order.order_code}\`
🛍️ Product: ${order.product_name}
🔢 Quantity: ${order.quantity}
💰 Total Paid: ${money(order.total_price)}
⚡️ Status: Completed

━━━━━━━━━━━━━━━
🚀 DELIVERED ITEMS:`;

  if (dispensed.length > 0) {
    dispensed.forEach((code, idx) => {
      deliveryText += `\n${idx + 1}. ${code}`;
    });
  } else {
    deliveryText += `\n✅ Your order has been registered! Because live codes are being restocked by the admin, they will be dispatched to your Telegram shortly.`;
  }

  deliveryText += `\n\n🛡️ Remember to redeem your links/codes within 24 hours.\nThank you for choosing Gemini Shop!`;

  const backMenu = p && p.category === "api_key" ? "menu:apikey" : "menu:buy";
  await ctx.reply(deliveryText, Markup.inlineKeyboard([
    [Markup.button.callback("💰 My Orders", "menu:orders"), Markup.button.callback("🎫 Support / Replacement", `ticket:new_order:${order.order_code}`)],
    [Markup.button.callback(p && p.category === "api_key" ? "🔑 API Keys Store" : "🛍️ Buy More", backMenu)],
    [Markup.button.callback("🏠 Main Menu", "menu:main")]
  ]));

  // Notify admin of purchase
  try {
    bot.telegram.sendMessage(
      ADMIN_ID,
      `🛒 NEW SALE COMPLETED!\nOrder: ${order.order_code}\nUser: ${order.user_name} (${order.user_id})\nProduct: ${order.product_name} (x${order.quantity})\nTotal: ${money(order.total_price)}`
    );
  } catch (e) {}

  // Broadcast to group
  try {
    sendGroupPurchaseNotice(p.name, pending.quantity);
  } catch (e) {}
});

// =====================================================
// DEPOSIT FLOW (BINANCE PAY / USDT BEP20 / POLYGON)
// =====================================================
bot.action(/^deposit:start(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const suggestedAmount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;
  const settings = getAllSettings();
  const minCrypto = Number(settings.min_crypto_deposit || 1.00);

  const text = `💳 <b>SELECT DEPOSIT METHOD</b>
━━━━━━━━━━━━━━━━━━━
Please choose your preferred deposit gateway:
• <b>Binance Pay:</b> Binance ID / Pay ID (Min: <b>$${minCrypto.toFixed(2)} USDT</b>)
• <b>USDT (BEP20):</b> BNB Smart Chain (Min: <b>$${minCrypto.toFixed(2)} USDT</b>)
• <b>USDT (Polygon):</b> Polygon / POL (Min: <b>$${minCrypto.toFixed(2)} USDT</b>)`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🟡 Binance Pay (Binance ID)", `deposit:binance:${suggestedAmount}`)],
    [Markup.button.callback("🟡 USDT (BEP20 / BSC)", `deposit:bep20:${suggestedAmount}`)],
    [Markup.button.callback("🟣 USDT (Polygon / POL)", `deposit:polygon:${suggestedAmount}`)],
    [Markup.button.callback("🔙 Back to Wallet", "menu:wallet")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

// Binance Pay deposit
bot.action(/^deposit:binance(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;
  await showBinanceDepositInstructions(ctx, amount);
});

// USDT BEP20 deposit
bot.action(/^deposit:bep20(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;
  await showBep20DepositInstructions(ctx, amount);
});

// USDT Polygon deposit
bot.action(/^deposit:polygon(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;
  await showPolygonDepositInstructions(ctx, amount);
});

// Backwards compatibility alias
bot.action(/^deposit:crypto(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;
  await showBep20DepositInstructions(ctx, amount);
});

async function showBinanceDepositInstructions(ctx, amount) {
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);
  const binancePayId = settings.binance_pay_id || process.env.BINANCE_PAY_ID || "123456789";
  const minCrypto = Number(settings.min_crypto_deposit || 1.00);
  const finalAmount = Math.max(minCrypto, Number(amount) || minCrypto);

  const deposit = createDeposit({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    amount: finalAmount,
    method: "BINANCE_PAY",
    address: binancePayId
  });

  ctx.session.activeDepositId = deposit.id;

  const defaultDesc = `⚠️ <b>Instructions:</b>
1. Open your <b>Binance App</b>.
2. Tap <b>Pay</b> (or scan/tap Send).
3. Select <b>Binance ID / Pay ID</b>.
4. Enter Pay ID: <code>${binancePayId}</code>
5. Enter Amount: <b>$${finalAmount.toFixed(2)} USDT</b> (Min: $${minCrypto.toFixed(2)}) and complete transfer.
6. After payment, tap <b>"✅ I've Paid"</b> below to submit your payment proof / Order ID or screenshot.`;

  const desc = settings.binance_deposit_desc && String(settings.binance_deposit_desc).trim()
    ? String(settings.binance_deposit_desc).trim()
    : defaultDesc;

  const text = `🟡 <b>BINANCE PAY (BINANCE ID) DEPOSIT</b>
━━━━━━━━━━━━━━━━━━━━
💳 <b>Method:</b> Binance Pay
💵 <b>Minimum Deposit:</b> $${minCrypto.toFixed(2)} USDT

📋 <b>Binance ID / Pay ID (Tap to copy):</b>
<code>${binancePayId}</code>

━━━━━━━━━━━━━━━━━━━━
${desc}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("🟡 USDT (BEP20)", `deposit:bep20:${finalAmount}`), Markup.button.callback("🟣 USDT (Polygon)", `deposit:polygon:${finalAmount}`)],
    [Markup.button.callback("🔙 Choose Method", "deposit:start"), Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {
      try {
        return await ctx.editMessageText(text, { ...buttons });
      } catch (e2) {}
    }
  }
  try {
    await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    await ctx.reply(text, { ...buttons });
  }
}

async function showBep20DepositInstructions(ctx, amount) {
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);
  const bep20Address = settings.bep20_usdt_address || "0xC3fC8C91A5B26C71DcD0aC1F34944FB298bCeBbF";
  const minCrypto = Number(settings.min_crypto_deposit || 1.00);
  const finalAmount = Math.max(minCrypto, Number(amount) || minCrypto);

  const deposit = createDeposit({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    amount: finalAmount,
    method: "USDT_BEP20",
    address: bep20Address
  });

  ctx.session.activeDepositId = deposit.id;

  const defaultDesc = `⚠️ <b>Important:</b>\n• Send only <b>USDT</b> on <b>BNB Smart Chain (BEP20)</b>.\n• After payment, tap <b>"✅ I've Paid"</b> below to send proof.`;
  const desc = settings.bep20_deposit_desc && String(settings.bep20_deposit_desc).trim()
    ? String(settings.bep20_deposit_desc).trim()
    : defaultDesc;

  const text = `🟡 <b>USDT (BEP20 / BSC) DEPOSIT</b>
━━━━━━━━━━━━━━━━━━━━
🌐 <b>Network:</b> BNB Smart Chain (BEP20)
💵 <b>Minimum Deposit:</b> $${minCrypto.toFixed(2)} USDT

📋 <b>Deposit Address (Tap to copy):</b>
<code>${bep20Address}</code>

━━━━━━━━━━━━━━━━━━━━
${desc}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("🟡 Binance Pay", `deposit:binance:${finalAmount}`), Markup.button.callback("🟣 Switch to Polygon", `deposit:polygon:${finalAmount}`)],
    [Markup.button.callback("🔙 Choose Method", "deposit:start"), Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {
      try {
        return await ctx.editMessageText(text, { ...buttons });
      } catch (e2) {}
    }
  }
  try {
    await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    await ctx.reply(text, { ...buttons });
  }
}

async function showPolygonDepositInstructions(ctx, amount) {
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);
  const polygonAddress = settings.polygon_usdt_address || "0x58F0C60b37E5c84C4C7fE4a553F1fCe6405F412b";
  const minCrypto = Number(settings.min_crypto_deposit || 1.00);
  const finalAmount = Math.max(minCrypto, Number(amount) || minCrypto);

  const deposit = createDeposit({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    amount: finalAmount,
    method: "USDT_POLYGON",
    address: polygonAddress
  });

  ctx.session.activeDepositId = deposit.id;

  const text = `🟣 <b>USDT (POLYGON) DEPOSIT</b>
━━━━━━━━━━━━━━━━━━━━
🌐 <b>Network:</b> Polygon (POL / MATIC)
💵 <b>Minimum Deposit:</b> $${minCrypto.toFixed(2)} USDT

📋 <b>Deposit Address (Tap to copy):</b>
<code>${polygonAddress}</code>

━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Important:</b>
• Send only <b>USDT</b> on <b>Polygon</b> network.
• After payment, tap <b>"✅ I've Paid"</b> below to send proof.`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("🟡 Binance Pay", `deposit:binance:${finalAmount}`), Markup.button.callback("🟡 Switch to BEP20", `deposit:bep20:${finalAmount}`)],
    [Markup.button.callback("🔙 Choose Method", "deposit:start"), Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {
      try {
        return await ctx.editMessageText(text, { ...buttons });
      } catch (e2) {}
    }
  }
  try {
    await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    await ctx.reply(text, { ...buttons });
  }
}

// User taps "I've Paid"
bot.action(/^deposit_paid:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const depositId = ctx.match[1];
  const deposit = getDeposit(depositId);

  if (!deposit) {
    return ctx.reply("❌ Deposit session not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Wallet", "menu:wallet")]]));
  }

  ctx.session.awaitingProofForDeposit = depositId;

  // Record that user clicked I've Paid
  const targetUserId = ctx.from?.id || deposit.user_id;
  if (targetUserId) {
    recordDepositPaidClick(targetUserId);
  }

  const promptCount = incrementDepositPaidPrompt(depositId);

  // 1st time: NO "Submit without screenshot" button — just write "Add screenshot here"
  if (promptCount <= 1) {
    return ctx.reply(
      `📸 <b>Add screenshot here</b>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("❌ Cancel", "menu:wallet")]
        ])
      }
    );
  }

  // 2nd time (if they didn't give screenshot the 1st time): give the Submit option
  return ctx.reply(
    `📸 <b>Add screenshot here</b>\n\nOr tap <b>"✅ Submit"</b> below to submit your deposit:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Submit", `deposit_submit_noproof:${depositId}`)],
        [Markup.button.callback("❌ Cancel", "menu:wallet")]
      ])
    }
  );
});

// User submits deposit without providing TxID or screenshot
bot.action(/^deposit_submit_noproof:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const depositId = ctx.match[1];
  const deposit = getDeposit(depositId);

  if (!deposit) {
    return ctx.reply("❌ Deposit session not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Wallet", "menu:wallet")]]));
  }

  ctx.session.awaitingProofForDeposit = null;
  deposit.proof = "Submitted without TxID / Screenshot";
  deposit.updated_at = new Date().toISOString();
  await notifyAdminNewDeposit(ctx, deposit);

  return ctx.reply(
    `✅ Thank you! Your Deposit <b>${depositId}</b> has been submitted.\n\nOur team is verifying the payment and your balance will be credited shortly!`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("👛 View Wallet", "menu:wallet")]])
    }
  );
});

// =====================================================
// TEXT / PHOTO INPUT HANDLERS
// =====================================================
function clearAdminConflictingSession(ctx) {
  if (!ctx || !ctx.session) return;
  ctx.session.newProductWizard = null;
  ctx.session.awaitingCustomQty = null;
  ctx.session.awaitingRecoverCode = false;
  ctx.session.awaitingTicketInput = null;
  ctx.session.awaitingTicketReply = null;
  ctx.session.awaitingProofForDeposit = null;
  ctx.session.awaitingSupportReply = false;
}

bot.action("customer:direct_reply", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.awaitingSupportReply = true;
  return ctx.reply(
    "✍️ Write your reply to Admin / Support below:",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "customer:cancel_reply")]])
  );
});

bot.on("text", async (ctx, next) => {
  const text = ctx.message.text.trim();

  // Allow admins or customers to cancel any in-progress action via /cancel
  if (text === "/cancel" || text.startsWith("/cancel@")) {
    if (isAdmin(ctx) && (ctx.session.adminAction || ctx.session.newProductWizard)) {
      ctx.session.adminAction = null;
      ctx.session.newProductWizard = null;
      await ctx.reply("❎ Admin action cancelled.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Admin Menu", "adm:menu")]]));
      return;
    }
    clearAdminConflictingSession(ctx);
    await ctx.reply("❎ Current action cancelled.", getMainMenuInlineKeyboard());
    return;
  }

  // Let slash commands (/admin, /start, /block, /unblock, /pinall, /unpinall) pass through to command handlers
  if (text.startsWith("/") && text !== "/default" && text !== "/cancel") {
    return next();
  }

  // Admin state handlers take priority for admin users so leftover customer states never block admin actions
  if (isAdmin(ctx) && ctx.session.adminAction) {
    return handleAdminTextInput(ctx, text);
  }
  if (isAdmin(ctx) && ctx.session.newProductWizard) {
    return handleNewProductWizardInput(ctx, text);
  }

  // Customer replies to an admin-sent message; forward it to the admin inbox.
  if (!isAdmin(ctx) && ctx.session.awaitingSupportReply) {
    ctx.session.awaitingSupportReply = false;
    const from = ctx.from || {};
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Customer";
    const username = from.username ? `@${from.username}` : "Not set";
    try {
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `📩 CUSTOMER REPLY\n\n👤 ${name} (${username})\n🆔 Telegram ID: ${from.id}\n\n${text}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Reply to Customer", `adm:reply_customer:${from.id}`)],
          [Markup.button.callback(isUserBlocked(from.id) ? "🟢 Unblock User" : "🚫 Block User & Remove Msgs", isUserBlocked(from.id) ? `adm:unblock_user:${from.id}` : `adm:block_user:${from.id}`)]
        ])
      );
      return ctx.reply("✅ Your reply has been sent to support.");
    } catch (e) {
      console.error("Failed to forward customer reply:", e.message || e);
      return ctx.reply("❌ Could not send your reply right now. Please try again later.");
    }
  }

  // If waiting for custom product quantity
  if (ctx.session.awaitingCustomQty) {
    const productId = ctx.session.awaitingCustomQty;
    ctx.session.awaitingCustomQty = null;
    const qty = parseInt(text, 10);
    if (isNaN(qty) || qty <= 0) {
      return ctx.reply("❌ Invalid quantity. Please enter a valid positive number.");
    }
    return showProductDetails(ctx, productId, qty);
  }

  // If waiting for Order Recovery code
  if (ctx.session.awaitingRecoverCode) {
    ctx.session.awaitingRecoverCode = null;
    const order = getOrder(text);
    if (!order) {
      return ctx.reply(
        `❌ No order found with code ${text}.\nPlease check your Order Code and try again.`,
        Markup.inlineKeyboard([[Markup.button.callback("🔙 Recover", "menu:recover")]])
      );
    }
    return displayOrderDetails(ctx, order);
  }

  // If waiting for new support ticket input
  if (ctx.session.awaitingTicketInput) {
    if (text.trim() === "/cancel") {
      ctx.session.awaitingTicketInput = null;
      return ctx.reply("❎ Ticket creation cancelled.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Support", "menu:support")]]));
    }
    return handleCreateTicketFromUser(ctx, text, null);
  }

  // If waiting for follow-up reply on an existing support ticket
  if (ctx.session.awaitingTicketReply) {
    if (text.trim() === "/cancel") {
      ctx.session.awaitingTicketReply = null;
      return ctx.reply("❎ Reply cancelled.", Markup.inlineKeyboard([[Markup.button.callback("📂 My Tickets", "ticket:my_list")]]));
    }
    const ticketId = ctx.session.awaitingTicketReply;
    return handleReplyTicketFromUser(ctx, ticketId, text, null);
  }

  // If waiting for deposit payment proof and user didn't send a screenshot the first time
  if (ctx.session.awaitingProofForDeposit) {
    const depositId = ctx.session.awaitingProofForDeposit;
    const deposit = getDeposit(depositId);
    if (deposit) {
      const promptCount = incrementDepositPaidPrompt(depositId);
      // Since they didn't send a screenshot on the first prompt, give them the Submit option now on the 2nd prompt
      if (promptCount <= 2) {
        deposit.proof = text;
        return ctx.reply(
          `📸 <b>Add screenshot here</b>\n\nIf you don't have a screenshot, tap <b>"✅ Submit"</b> below to submit your deposit:`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("✅ Submit", `deposit_submit_noproof:${depositId}`)],
              [Markup.button.callback("❌ Cancel", "menu:wallet")]
            ])
          }
        );
      }
      ctx.session.awaitingProofForDeposit = null;
      deposit.proof = text;
      deposit.updated_at = new Date().toISOString();
      await notifyAdminNewDeposit(ctx, deposit);
      return ctx.reply(
        `✅ Thank you! Your Deposit ${depositId} has been submitted.\n\nOur team is verifying the payment and your balance will be credited shortly!`,
        Markup.inlineKeyboard([[Markup.button.callback("👛 View Wallet", "menu:wallet")]])
      );
    }
  }

  return next();
});

bot.on("photo", async (ctx, next) => {
  if (ctx.session.awaitingTicketInput) {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const caption = ctx.message.caption || "Screenshot attached";
    return handleCreateTicketFromUser(ctx, caption, fileId);
  }

  if (ctx.session.awaitingTicketReply) {
    const ticketId = ctx.session.awaitingTicketReply;
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const caption = ctx.message.caption || "Screenshot attached";
    return handleReplyTicketFromUser(ctx, ticketId, caption, fileId);
  }

  if (ctx.session.awaitingProofForDeposit) {
    const depositId = ctx.session.awaitingProofForDeposit;
    ctx.session.awaitingProofForDeposit = null;
    const deposit = getDeposit(depositId);
    if (deposit) {
      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      deposit.photo_file_id = fileId;
      deposit.proof = ctx.message.caption || "Screenshot submitted";
      deposit.updated_at = new Date().toISOString();
      await notifyAdminNewDeposit(ctx, deposit, fileId);

      // Automatic message triggered ONLY when user submits a screenshot (proof)
      const targetUserId = ctx.from?.id || deposit.user_id;
      if (targetUserId) {
        if (markDepositAutoMsgSent(targetUserId)) {
          // 1st screenshot submitted -> send 1st auto-message after 1 min 30 seconds (90s)
          setTimeout(() => {
            if (isUserBlocked(targetUserId)) return;
            const autoMsg = getSetting("deposit_paid_auto_msg");
            if (autoMsg && String(autoMsg).trim()) {
              bot.telegram.sendMessage(
                targetUserId,
                String(autoMsg).trim(),
                Markup.inlineKeyboard([
                  [
                    Markup.button.callback("🛍️ Buy", "menu:buy"),
                    Markup.button.callback("💳 Add Funds / Deposit", "deposit:start")
                  ],
                  [
                    Markup.button.callback("🎫 Open Ticket", "ticket:new")
                  ]
                ])
              ).catch(() => {});
            }
          }, 90 * 1000);
        } else if (markSecondDepositScreenshotMsgSent(targetUserId)) {
          // 2nd screenshot submitted -> send 2nd auto-message after 1 min 30 seconds (90s)
          setTimeout(() => {
            if (isUserBlocked(targetUserId)) return;
            const secondMsg = getSetting("deposit_second_auto_msg");
            if (secondMsg && String(secondMsg).trim()) {
              bot.telegram.sendMessage(
                targetUserId,
                String(secondMsg).trim(),
                Markup.inlineKeyboard([
                  [
                    Markup.button.callback("🛍️ Buy", "menu:buy"),
                    Markup.button.callback("💳 Add Funds / Deposit", "deposit:start")
                  ],
                  [
                    Markup.button.callback("🎫 Open Ticket", "ticket:new")
                  ]
                ])
              ).catch(() => {});
            }
          }, 90 * 1000);
        }
      }

      return ctx.reply(
        `✅ Thank you! Your screenshot for Deposit ${depositId} has been submitted.\n\nAdmin will verify and credit your wallet shortly!`,
        Markup.inlineKeyboard([[Markup.button.callback("👛 View Wallet", "menu:wallet")]])
      );
    }
  }
  return next();
});

async function notifyAdminNewDeposit(ctx, deposit, photoFileId = null) {
  const adminMsg = `🔔 NEW DEPOSIT SUBMITTED!

🆔 Deposit ID: ${deposit.id}
👤 User: ${deposit.user_name} (${deposit.user_id})
💰 Amount: ${money(deposit.amount)}
🌐 Method: ${deposit.method}
📝 Proof: ${deposit.proof || "None"}
⏱ Time: ${new Date(deposit.created_at).toLocaleString()}`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback(`✅ Approve (${money(deposit.amount)})`, `adm_dep_app:${deposit.id}`),
      Markup.button.callback("❌ Reject", `adm_dep_rej:${deposit.id}`)
    ],
    [
      Markup.button.callback("✉️ Send Message", `adm:customer_msg:${deposit.user_id}`),
      Markup.button.callback("🚫 Block User", `adm:block_user:${deposit.user_id}`)
    ]
  ]);

  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(ADMIN_ID, photoFileId, {
        caption: adminMsg,
        ...buttons
      });
    } else {
      await bot.telegram.sendMessage(ADMIN_ID, adminMsg, buttons);
    }
  } catch (err) {
    console.error("Failed to notify admin of deposit:", err);
  }
}

// Admin deposit approval / rejection handlers
bot.action(/^adm_dep_app:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const depositId = ctx.match[1];
  try {
    const { deposit, user } = approveDeposit(depositId);
    const textMsg = `✅ DEPOSIT APPROVED!\nDeposit ID: ${deposit.id}\nUser: ${deposit.user_name}\nCredited: ${money(deposit.amount)}\nUser New Balance: ${money(user.wallet_balance)}`;
    const afterButtons = Markup.inlineKeyboard([
      [Markup.button.callback("✉️ Send Message", `adm:customer_msg:${deposit.user_id}`)]
    ]);
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(textMsg, afterButtons);
    } else {
      await ctx.editMessageText(textMsg, afterButtons);
    }

    // Notify user in private chat
    bot.telegram.sendMessage(
      deposit.user_id,
      `🎉 Deposit Approved!\n\nYour deposit of ${money(deposit.amount)} (ID: ${deposit.id}) has been credited to your wallet.\n👛 New Balance: ${money(user.wallet_balance)}`,
      Markup.inlineKeyboard([[Markup.button.callback("🛍️ Start Shopping", "menu:buy")]])
    ).catch(() => {});
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.action(/^adm_dep_rej:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const depositId = ctx.match[1];
  try {
    const deposit = rejectDeposit(depositId);
    const textMsg = `❌ DEPOSIT REJECTED!\nDeposit ID: ${deposit.id}\nUser: ${deposit.user_name}`;
    const afterButtons = Markup.inlineKeyboard([
      [Markup.button.callback("✉️ Send Message", `adm:customer_msg:${deposit.user_id}`)]
    ]);
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(textMsg, afterButtons);
    } else {
      await ctx.editMessageText(textMsg, afterButtons);
    }

    bot.telegram.sendMessage(
      deposit.user_id,
      `❌ Your deposit ${deposit.id} of ${money(deposit.amount)} was rejected by admin. Please open a support ticket if you believe this is an error.`,
      Markup.inlineKeyboard([[Markup.button.callback("🎫 Open Ticket", "ticket:new")]])
    ).catch(() => {});
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

// =====================================================
// OTHER MENU SECTIONS
// =====================================================

// WALLET
async function showWallet(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx.from);
  const deposits = getUserDeposits(user.id);

  let text = `👛 YOUR WALLET

💰 Balance: ${money(user.wallet_balance)}
💳 Total Spent: ${money(user.total_spent)}

Recent Deposits:`;

  if (deposits.length === 0) {
    text += `\n• No recent deposits found.`;
  } else {
    deposits.slice(0, 5).forEach((d) => {
      const statusIcon = d.status === "approved" ? "✅" : d.status === "pending" ? "⏳" : "❌";
      text += `\n• ${statusIcon} ${d.id} — ${money(d.amount)} (${d.method}) [${d.status}]`;
    });
  }

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("💳 Add Funds / Deposit", "deposit:start")],
    [Markup.button.callback("🔙 Main Menu", "menu:main")]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, buttons);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
}

// PROFILE
async function showProfile(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx.from);

  const text = `📰 USER PROFILE

👤 Name: ${user.first_name || ""} ${user.last_name || ""}
🆔 Telegram ID: ${user.id}
👛 Wallet Balance: ${money(user.wallet_balance)}
💳 Total Spent: ${money(user.total_spent)}
📦 Completed Orders: ${user.orders_count || 0}
👥 Referrals: ${user.referral_count || 0} (Earned: ${money(user.referral_earnings || 0)})
🗓 Registered: ${new Date(user.created_at).toLocaleDateString()}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("👛 Wallet", "menu:wallet"), Markup.button.callback("💰 My Orders", "menu:orders")],
    [Markup.button.callback("🔙 Main Menu", "menu:main")]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, buttons);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
}

// MY ORDERS
async function showMyOrders(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx.from);
  const orders = getUserOrders(user.id);

  if (orders.length === 0) {
    const text = `💰 MY ORDERS\n\nYou haven't placed any orders yet.`;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback("🛍️ Browse Products", "menu:buy")],
      [Markup.button.callback("🔙 Main Menu", "menu:main")]
    ]);
    if (ctx.callbackQuery) {
      try { return await ctx.editMessageText(text, buttons); } catch (e) {}
    }
    return ctx.reply(text, buttons);
  }

  let text = `💰 MY ORDERS (Last 10)\nTap any order below to view full details and delivered codes:`;
  const buttons = orders.slice(0, 10).map((o) => [
    Markup.button.callback(
      `📦 ${o.order_code} • ${o.product_name} (x${o.quantity})`,
      `view_ord:${o.order_code}`
    )
  ]);
  buttons.push([Markup.button.callback("🔙 Main Menu", "menu:main")]);

  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, Markup.inlineKeyboard(buttons)); } catch (e) {}
  }
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

bot.action(/^view_ord:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const code = ctx.match[1];
  const order = getOrder(code);
  if (!order) return ctx.reply("❌ Order not found.");
  await displayOrderDetails(ctx, order);
});

async function displayOrderDetails(ctx, order) {
  let text = `📦 ORDER DETAILS

• Code: ${order.order_code}
• Product: ${order.product_name}
• Quantity: ${order.quantity}
• Total: ${money(order.total_price)}
• Date: ${new Date(order.created_at).toLocaleString()}
• Status: ${order.status}

━━━━━━━━━━━━━━━
🚀 DELIVERED ITEMS:`;

  if (order.delivered_codes && order.delivered_codes.length > 0) {
    order.delivered_codes.forEach((c, idx) => {
      text += `\n${idx + 1}. ${c}`;
    });
  } else {
    text += `\n(No digital codes attached / delivered manually)`;
  }

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🎫 Report Issue / Replacement", `ticket:new_order:${order.order_code}`)],
    [Markup.button.callback("💰 Back to Orders", "menu:orders")],
    [Markup.button.callback("🏠 Main Menu", "menu:main")]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, buttons);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
}

// RECOVER
async function promptRecover(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  ctx.session.awaitingRecoverCode = true;

  const text = `🗑️ RECOVER ORDER

Please enter your Order Code (e.g. 2026/09/20-ABCD) to look up and retrieve your delivered coupons or redeem links:`;

  const buttons = Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "menu:main")]]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, buttons);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
}

// REFER & EARN
async function showRefer(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx.from);
  const botUsername = await getCachedBotUsername();
  const refLink = `https://t.me/${botUsername}?start=ref_${user.id}`;
  const settings = getAllSettings();
  const pct = settings.referral_bonus_percent || 5;
  const rewardStatus = getReferralRewardStatus(user.id);

  const text = `📌 REFER & EARN PROGRAM

🎁 30-REFERRAL SPECIAL REWARD:
Invite 30 friends to this bot and get 1 FREE Gemini Links 18M subscription!
(Plus earn ${pct}% commission on all wallet deposits made by your referrals!)

🔗 Your Unique Referral Link:
${refLink}

📊 Your Referral Stats:
• Total Referrals: ${rewardStatus.totalReferrals}
• Progress to Free Gemini: ${rewardStatus.progressInCurrentTier}/30 (${rewardStatus.neededForNext} more needed)
• Free Gemini Claimed: ${rewardStatus.claimed}
• Free Gemini Ready to Claim: ${rewardStatus.claimable} 🎁
• Cash Commission Earned: ${money(user.referral_earnings || 0)}

Share your link with your friends or channels to start earning!`;

  const buttons = [];

  if (rewardStatus.claimable > 0) {
    buttons.push([
      Markup.button.callback(`🎁 Claim Free Gemini (${rewardStatus.claimable} Ready!)`, "refer:claim")
    ]);
  } else {
    buttons.push([
      Markup.button.callback(`🎁 Progress: ${rewardStatus.progressInCurrentTier}/30 (${rewardStatus.neededForNext} needed)`, "refer:progress_info")
    ]);
  }

  buttons.push([
    Markup.button.url("↗️ Share Link", `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent("Join Gemini AI Shop and get instant premium AI accounts!")}`)
  ]);
  buttons.push([Markup.button.callback("🔙 Main Menu", "menu:main")]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
      return;
    } catch (e) {}
  }
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

bot.action("refer:claim", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx.from);
  try {
    const { order, dispensedCode, remainingClaimable } = claimReferralReward(user.id);
    let msg = `🎉 REWARD CLAIMED SUCCESSFULLY!

🎁 You have claimed 1 FREE Gemini Links 18M subscription!
📦 Order Code: ${order.order_code}

🚀 Your Delivered Item:
${dispensedCode ? dispensedCode : "(Digital stock is being refreshed by admin. Your redeem link will be dispatched shortly!)"}

Thank you for inviting friends to Gemini Shop!`;

    if (remainingClaimable > 0) {
      msg += `\n\n🎁 You still have ${remainingClaimable} more free rewards ready to claim!`;
    }

    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.callback("💰 My Orders", "menu:orders")],
      [Markup.button.callback("📌 Back to Refer & Earn", "menu:refer")]
    ]));

    // Notify admin of claimed reward
    try {
      bot.telegram.sendMessage(
        ADMIN_ID,
        `🎁 30-REFERRAL REWARD CLAIMED!\nUser: ${user.first_name} (${user.id})\nProduct: Gemini Links 18M (FREE)\nTotal Referrals: ${user.referral_count}`
      );
    } catch (e) {}
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "menu:refer")]]));
  }
});

bot.action("refer:progress_info", async (ctx) => {
  const user = getOrCreateUser(ctx.from);
  const status = getReferralRewardStatus(user.id);
  await ctx.answerCbQuery(
    `🎁 You have ${status.progressInCurrentTier}/30 referrals. Invite ${status.neededForNext} more friends to get 1 Free Gemini Links 18M!`,
    { show_alert: true }
  );
});

// =====================================================
// IN-BOT SUPPORT & REPLACEMENT TICKET SYSTEM
// =====================================================
const TICKET_CATEGORIES = {
  Replacement: "🔄 Order Replacement / Warranty",
  Deposit: "💳 Deposit / Balance Issue",
  Product: "🔑 Account / Redeem Link Help",
  General: "💬 General Inquiry"
};

function getTicketStatusBadge(status) {
  switch (status) {
    case "open": return "🟢 Open (Awaiting Support)";
    case "replied": return "💬 Admin Replied";
    case "resolved": return "✅ Resolved";
    case "closed": return "🔒 Closed";
    default: return "🟢 Open";
  }
}

async function showSupport(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);
  const userTickets = getUserTickets(user.id);
  const openCount = userTickets.filter(t => t.status === "open" || t.status === "replied").length;

  const rawSupport = settings.support_username || "@aibuyshop_support";
  const cleanSupport = rawSupport.replace(/^https?:\/\/t\.me\//, "").replace("@", "").trim();
  const supportDisplay = cleanSupport ? `@${cleanSupport}` : "@aibuyshop_support";
  const supportUrl = `https://t.me/${cleanSupport || "aibuyshop_support"}`;

  const text = `💬 <b>OFFICIAL SUPPORT & WARRANTY DESK</b>
━━━━━━━━━━━━━━━━━━━━
🟢 <b>Helpdesk Status:</b> Online (24/7 Active)
⚡ <b>Avg. Response Time:</b> &lt; 15 Minutes
🛡️ <b>Replacement Guarantee:</b> 100% Active
🎫 <b>Your Active Tickets:</b> ${openCount} Open (${userTickets.length} Total)

👤 <b>Direct Support:</b> ${escapeHtml(supportDisplay)}
📢 <b>Official Channel:</b> ${escapeHtml(settings.channel_link || "")}
👥 <b>Community Group:</b> ${escapeHtml(settings.group_link || "")}

━━━━━━━━━━━━━━━━━━━━
💡 <i>Open an official <b>Support Ticket</b> below to get a tracking ID (e.g. <code>#TKT-1001</code>), request an instant replacement, or track your issue directly inside the bot!</i>`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🎫 Open Support / Replacement Ticket", "ticket:new")],
    [Markup.button.callback(`📂 My Support Tickets (${userTickets.length})`, "ticket:my_list")],
    [Markup.button.url("💬 Direct Telegram Chat", supportUrl)],
    [Markup.button.callback("🔙 Main Menu", "menu:main")]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", disable_web_page_preview: true, ...buttons });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true, ...buttons });
}

// Step 1: Select ticket category
bot.action("ticket:new", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `🎫 <b>OPEN NEW SUPPORT TICKET</b>
━━━━━━━━━━━━━━━━━━━━
Please select the category that best describes your issue:`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Order Replacement / Warranty", "ticket:cat:Replacement")],
    [Markup.button.callback("💳 Deposit / Balance Issue", "ticket:cat:Deposit")],
    [Markup.button.callback("🔑 Account / Redeem Link Help", "ticket:cat:Product")],
    [Markup.button.callback("💬 General Question", "ticket:cat:General")],
    [Markup.button.callback("🔙 Back to Support", "menu:support")]
  ]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

// Shortcut: Open ticket directly from an order
bot.action(/^ticket:new_order:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const orderCode = ctx.match[1];
  const category = TICKET_CATEGORIES.Replacement;
  ctx.session.awaitingTicketInput = { category, orderCode };

  const text = `🎫 <b>NEW REPLACEMENT / SUPPORT TICKET</b>
━━━━━━━━━━━━━━━━━━━━
📂 <b>Category:</b> ${escapeHtml(category)}
📦 <b>Order Code:</b> <code>${escapeHtml(orderCode)}</code>

✍️ <b>Please describe the issue in detail below</b> (or send a screenshot with a caption explaining the problem):`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("❌ Cancel", "menu:support")]
  ]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

// Step 2: Category chosen -> If Replacement or Product and user has orders, let them pick order
bot.action(/^ticket:cat:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const catKey = ctx.match[1];
  const category = TICKET_CATEGORIES[catKey] || "General Support";

  if (catKey === "Replacement" || catKey === "Product") {
    const orders = getUserOrders(ctx.from.id);
    if (orders.length > 0) {
      const text = `🎫 <b>SELECT RELATED ORDER</b>
━━━━━━━━━━━━━━━━━━━━
📂 <b>Category:</b> ${escapeHtml(category)}

Select the order you need help with below, or tap <b>Skip</b> if not listed:`;

      const buttons = orders.slice(0, 5).map((o) => [
        Markup.button.callback(
          `📦 ${o.order_code} — ${o.product_name} (${money(o.total_price)})`,
          `ticket:ord_sel:${catKey}:${o.order_code}`
        )
      ]);
      buttons.push([Markup.button.callback("⏭️ Skip / Other Order", `ticket:ord_sel:${catKey}:NONE`)]);
      buttons.push([Markup.button.callback("🔙 Back", "ticket:new")]);

      try {
        return await ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
      } catch (e) {
        return await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
      }
    }
  }

  ctx.session.awaitingTicketInput = { category, orderCode: null };
  const text = `🎫 <b>DESCRIBE YOUR ISSUE</b>
━━━━━━━━━━━━━━━━━━━━
📂 <b>Category:</b> ${escapeHtml(category)}

✍️ <b>Please write your message below</b> (include any Order ID / Deposit ID, or send a photo screenshot with caption):`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("❌ Cancel", "menu:support")]
  ]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

// Step 2b: Order selected -> Prompt for issue description
bot.action(/^ticket:ord_sel:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const catKey = ctx.match[1];
  const rawOrder = ctx.match[2];
  const category = TICKET_CATEGORIES[catKey] || "General Support";
  const orderCode = rawOrder === "NONE" ? null : rawOrder;

  ctx.session.awaitingTicketInput = { category, orderCode };

  const text = `🎫 <b>DESCRIBE YOUR ISSUE</b>
━━━━━━━━━━━━━━━━━━━━
📂 <b>Category:</b> ${escapeHtml(category)}${orderCode ? `\n📦 <b>Order Ref:</b> <code>${escapeHtml(orderCode)}</code>` : ""}

✍️ <b>Please write your message below</b> (or send a screenshot with caption):`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("❌ Cancel", "menu:support")]
  ]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

// Create ticket handler (called from text or photo handler)
async function handleCreateTicketFromUser(ctx, messageText, photoFileId = null) {
  const draft = ctx.session.awaitingTicketInput;
  ctx.session.awaitingTicketInput = null;

  const user = getOrCreateUser(ctx.from);
  const userName = user.username ? `@${user.username}` : ([user.first_name, user.last_name].filter(Boolean).join(" ") || "Customer");

  const ticket = createTicket({
    user_id: user.id,
    user_name: userName,
    category: draft?.category || "General Support",
    order_code: draft?.orderCode || null,
    message: messageText,
    photo_file_id: photoFileId
  });

  // Notify Customer with official Ticket Receipt
  const receiptText = `✅ <b>OFFICIAL SUPPORT TICKET CREATED</b>
━━━━━━━━━━━━━━━━━━━━
🎫 <b>Ticket ID:</b> <code>#${ticket.id}</code>
📂 <b>Category:</b> ${escapeHtml(ticket.category)}${ticket.order_code ? `\n📦 <b>Order Ref:</b> <code>${escapeHtml(ticket.order_code)}</code>` : ""}
🟢 <b>Status:</b> Open (Assigned to Support Desk)
⏱️ <b>Est. Response:</b> Within 15 Minutes

💬 <b>Your Message:</b>
<i>${escapeHtml(messageText)}</i>

━━━━━━━━━━━━━━━━━━━━
🔔 You will receive an instant notification here as soon as our admin replies to <b>#${ticket.id}</b>.`;

  await ctx.reply(receiptText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`📂 View Ticket #${ticket.id}`, `ticket:view:${ticket.id}`)],
      [Markup.button.callback("🏠 Main Menu", "menu:main")]
    ])
  });

  // Notify Admin
  const adminMsg = `🎫 <b>NEW SUPPORT TICKET OPENED!</b>
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Ticket:</b> <code>#${ticket.id}</code>
👤 <b>Customer:</b> ${escapeHtml(userName)} (<code>${user.id}</code>)
📂 <b>Category:</b> ${escapeHtml(ticket.category)}${ticket.order_code ? `\n📦 <b>Order Code:</b> <code>${escapeHtml(ticket.order_code)}</code>` : ""}
⏰ <b>Time:</b> ${new Date(ticket.created_at).toLocaleString()}

💬 <b>Message:</b>
${escapeHtml(messageText)}`;

  const adminButtons = Markup.inlineKeyboard([
    [
      Markup.button.callback(`↩️ Reply (#${ticket.id})`, `adm_tkt_reply:${ticket.id}`),
      Markup.button.callback("✅ Mark Resolved", `adm_tkt_resolve:${ticket.id}`)
    ],
    [
      Markup.button.callback("📂 View Full Ticket", `adm_tkt_view:${ticket.id}`),
      Markup.button.callback("🚫 Block User", `adm:block_user:${user.id}`)
    ]
  ]);

  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(ADMIN_ID, photoFileId, {
        caption: adminMsg,
        parse_mode: "HTML",
        ...adminButtons
      });
    } else {
      await bot.telegram.sendMessage(ADMIN_ID, adminMsg, {
        parse_mode: "HTML",
        ...adminButtons
      });
    }
  } catch (err) {
    console.error("Failed to notify admin of new ticket:", err.message || err);
  }
}

// Follow-up reply handler (called from text or photo handler)
async function handleReplyTicketFromUser(ctx, ticketId, messageText, photoFileId = null) {
  ctx.session.awaitingTicketReply = null;
  const ticket = addTicketMessage(ticketId, "user", messageText, photoFileId);
  if (!ticket) {
    return ctx.reply("❌ Ticket not found.", Markup.inlineKeyboard([[Markup.button.callback("📂 My Tickets", "ticket:my_list")]]));
  }

  await ctx.reply(
    `✅ Your reply has been added to Ticket <b>#${ticket.id}</b>.\nOur support team has been notified!`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`📂 View Ticket #${ticket.id}`, `ticket:view:${ticket.id}`)],
        [Markup.button.callback("🏠 Main Menu", "menu:main")]
      ])
    }
  );

  // Notify Admin
  const adminMsg = `💬 <b>NEW CUSTOMER REPLY ON #${ticket.id}</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Customer:</b> ${escapeHtml(ticket.user_name)} (<code>${ticket.user_id}</code>)
📂 <b>Category:</b> ${escapeHtml(ticket.category)}${ticket.order_code ? `\n📦 <b>Order:</b> <code>${escapeHtml(ticket.order_code)}</code>` : ""}

💬 <b>Reply:</b>
${escapeHtml(messageText)}`;

  const adminButtons = Markup.inlineKeyboard([
    [
      Markup.button.callback(`↩️ Reply (#${ticket.id})`, `adm_tkt_reply:${ticket.id}`),
      Markup.button.callback("✅ Mark Resolved", `adm_tkt_resolve:${ticket.id}`)
    ],
    [
      Markup.button.callback("📂 View Full Ticket", `adm_tkt_view:${ticket.id}`),
      Markup.button.callback("🚫 Block User", `adm:block_user:${ticket.user_id}`)
    ]
  ]);

  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(ADMIN_ID, photoFileId, {
        caption: adminMsg,
        parse_mode: "HTML",
        ...adminButtons
      });
    } else {
      await bot.telegram.sendMessage(ADMIN_ID, adminMsg, {
        parse_mode: "HTML",
        ...adminButtons
      });
    }
  } catch (err) {
    console.error("Failed to notify admin of ticket reply:", err.message || err);
  }
}

// Customer: List My Tickets
bot.action("ticket:my_list", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const tickets = getUserTickets(ctx.from.id);

  if (tickets.length === 0) {
    const text = `📂 <b>MY SUPPORT TICKETS</b>\n\nYou have not opened any support tickets yet.`;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback("🎫 Open New Ticket", "ticket:new")],
      [Markup.button.callback("🔙 Back to Support", "menu:support")]
    ]);
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {
      return await ctx.reply(text, { parse_mode: "HTML", ...buttons });
    }
  }

  let text = `📂 <b>MY SUPPORT TICKETS (${tickets.length})</b>\n━━━━━━━━━━━━━━━━━━━━\nSelect a ticket below to view messages or reply:`;
  const buttons = tickets.slice(0, 10).map((t) => {
    const icon = t.status === "replied" ? "💬" : t.status === "open" ? "🟢" : "✅";
    return [
      Markup.button.callback(
        `${icon} #${t.id} — ${t.category.replace(/^[^\s]+\s/, "")} [${t.status.toUpperCase()}]`,
        `ticket:view:${t.id}`
      )
    ];
  });
  buttons.push([Markup.button.callback("🎫 Open New Ticket", "ticket:new")]);
  buttons.push([Markup.button.callback("🔙 Support Menu", "menu:support")]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  }
});

// Customer: View Ticket Details & Conversation
bot.action(/^ticket:view:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const ticket = getTicket(ctx.match[1]);
  if (!ticket) {
    return ctx.reply("❌ Ticket not found.");
  }

  let threadText = "";
  const recentMsgs = (ticket.messages || []).slice(-6);
  recentMsgs.forEach((m) => {
    const senderLabel = m.sender === "admin" ? "👨‍💻 <b>Admin Support</b>" : "👤 <b>You</b>";
    const photoTag = m.photo_file_id ? " <i>[📸 Screenshot]</i>" : "";
    threadText += `\n${senderLabel}:${photoTag}\n${escapeHtml(m.text)}\n`;
  });

  const text = `🎫 <b>TICKET #${ticket.id}</b>
━━━━━━━━━━━━━━━━━━━━
📂 <b>Category:</b> ${escapeHtml(ticket.category)}${ticket.order_code ? `\n📦 <b>Order Code:</b> <code>${escapeHtml(ticket.order_code)}</code>` : ""}
📌 <b>Status:</b> ${getTicketStatusBadge(ticket.status)}
📅 <b>Opened:</b> ${new Date(ticket.created_at).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━
💬 <b>CONVERSATION HISTORY:</b>
${threadText}`;

  const rows = [];
  if (ticket.status !== "resolved" && ticket.status !== "closed") {
    rows.push([
      Markup.button.callback("↩️ Add Reply / Screenshot", `ticket:reply:${ticket.id}`),
      Markup.button.callback("✅ Mark Resolved", `ticket:close:${ticket.id}`)
    ]);
  } else {
    rows.push([Markup.button.callback("🔄 Reopen / Reply to Ticket", `ticket:reply:${ticket.id}`)]);
  }
  rows.push([
    Markup.button.callback("📂 My Tickets", "ticket:my_list"),
    Markup.button.callback("🏠 Main Menu", "menu:main")
  ]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
  }
});

// Customer: Reply to existing ticket
bot.action(/^ticket:reply:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const ticketId = ctx.match[1];
  const ticket = getTicket(ticketId);
  if (!ticket) return ctx.reply("❌ Ticket not found.");

  ctx.session.awaitingTicketReply = ticket.id;
  return ctx.reply(
    `✍️ <b>Write your reply for Ticket #${ticket.id} below</b> (you can also send a screenshot):`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `ticket:view:${ticket.id}`)]])
    }
  );
});

// Customer: Close / Resolve ticket
bot.action(/^ticket:close:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Ticket marked as resolved!").catch(() => {});
  const ticket = updateTicketStatus(ctx.match[1], "resolved");
  if (!ticket) return ctx.reply("❌ Ticket not found.");

  const text = `✅ <b>Ticket #${ticket.id} has been marked as Resolved.</b>\n\nThank you for using Gemini Shop Support! If you need anything else, you can reopen or create a new ticket anytime.`;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("📂 My Tickets", "ticket:my_list"), Markup.button.callback("🏠 Main Menu", "menu:main")]
  ]);

  try {
    return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    return await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

// =====================================================
// AI API KEYS & CLOUD TOKENS (Dedicated Store Section)
// =====================================================
async function showApiKey(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const products = getApiKeyProducts();

  const text = `🆙 AI API KEYS & CLOUD TOKENS

Select an API Key or Cloud Token package below to view details, bulk discounts, and buy instantly:
⚡️ Instant automated delivery directly to your chat once payment clears.`;

  const buttons = products.map((p) => {
    let label;
    if (p.outOfStock || p.stock <= 0) {
      label = `${p.name} • Out of stock`;
    } else {
      label = `${p.name} • ${money(p.price)} | Stock: ${p.stock}`;
    }
    return [Markup.button.callback(label, `prod:${p.id}`)];
  });

  buttons.push([Markup.button.callback("🔙 Main Menu", "menu:main")]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
      return;
    } catch (e) {}
  }
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

// =====================================================
// ADMIN PANEL (/admin)
// =====================================================
bot.command("admin", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await showAdminDashboard(ctx);
});

bot.action("adm:menu", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  await showAdminDashboard(ctx);
});

async function showAdminDashboard(ctx) {
  const pendingDeps = getPendingDeposits().length;
  const openTickets = getOpenTickets().length;
  const products = getProducts().length;
  const users = getAllUsers().length;
  const blockedCount = getBlockedUsers().length;
  const totalPromos = getPromoMessages().length;

  const text = `🔐 ADMIN DASHBOARD

📊 Live Bot Stats:
• Registered Users: ${users}
• Blocked Users: ${blockedCount}
• Products: ${products}
• Saved Promo Messages: ${totalPromos} Ready
• Pending Deposits: ${pendingDeps}
• Open Support Tickets: ${openTickets}

Select an action below:`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`🎯 1-Click Saved Promos (${totalPromos} Ready)`, "adm:promos:all:0")],
    [Markup.button.callback(`📥 Pending Deposits (${pendingDeps})`, "adm:deposits")],
    [Markup.button.callback(`🎫 Support Tickets (${openTickets} Open)`, "adm:tickets")],
    [Markup.button.callback("🛍️ Products & Inventory", "adm:products")],
    [Markup.button.callback("👥 Customers & Direct Messages", "adm:customers:0")],
    [Markup.button.callback(`🚫 Block / Unblock Users (${blockedCount} Blocked)`, "adm:blocked_menu")],
    [Markup.button.callback("🆔 Message by Telegram ID", "adm:msg_by_id")],
    [Markup.button.callback("⏱️ Set 1st Deposit Auto-Msg (15s)", "adm_set_dep_auto_msg")],
    [Markup.button.callback("📸 Set 2nd Deposit Auto-Msg (Screenshot)", "adm_set_dep_second_msg")],
    [Markup.button.callback("👤 User Balance Adjuster", "adm:user_bal")],
    [Markup.button.callback("⚙️ Force Join & Payment Settings", "adm:settings")],
    [Markup.button.callback("📢 Channel Auto-Poster (2x/Day)", "adm:channel_poster")],
    [Markup.button.callback("📢 Custom Broadcast Message", "adm:broadcast")],
    [
      Markup.button.callback("📌 Pin New Message (All Users)", "adm:pin_broadcast"),
      Markup.button.callback("🗑️ Remove All Old Pins", "adm:unpin_all_users")
    ],
    [Markup.button.callback("🏠 Customer Menu", "menu:main")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, buttons);
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
}

// Admin: View Support Tickets List
bot.action("adm:tickets", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});

  const openList = getOpenTickets();
  const allList = getAllTickets();
  const displayList = openList.length > 0 ? openList : allList.slice(0, 10);

  if (displayList.length === 0) {
    return ctx.reply(
      "✅ No support tickets found.",
      Markup.inlineKeyboard([[Markup.button.callback("🔙 Admin Menu", "adm:menu")]])
    );
  }

  const headerLabel = openList.length > 0
    ? `🎫 <b>OPEN SUPPORT TICKETS (${openList.length})</b>`
    : `🎫 <b>RECENT SUPPORT TICKETS (${displayList.length})</b>`;

  const text = `${headerLabel}\n━━━━━━━━━━━━━━━━━━━━\nSelect a ticket below to view conversation, reply, or resolve:`;

  const buttons = displayList.slice(0, 12).map((t) => {
    const icon = t.status === "open" ? "🟢" : t.status === "replied" ? "💬" : "✅";
    return [
      Markup.button.callback(
        `${icon} #${t.id} — ${t.user_name} (${t.category.replace(/^[^\s]+\s/, "")})`,
        `adm_tkt_view:${t.id}`
      )
    ];
  });
  buttons.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
});

// Admin: View Individual Ticket
bot.action(/^adm_tkt_view:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const ticket = getTicket(ctx.match[1]);
  if (!ticket) return ctx.reply("❌ Ticket not found.");

  let threadText = "";
  const recentMsgs = (ticket.messages || []).slice(-8);
  let lastPhotoId = null;
  recentMsgs.forEach((m) => {
    const senderLabel = m.sender === "admin" ? "👨‍💻 <b>Admin</b>" : `👤 <b>${escapeHtml(ticket.user_name)}</b>`;
    const photoTag = m.photo_file_id ? " <i>[📸 Screenshot]</i>" : "";
    if (m.photo_file_id) lastPhotoId = m.photo_file_id;
    threadText += `\n${senderLabel}:${photoTag}\n${escapeHtml(m.text)}\n`;
  });

  const text = `🎫 <b>ADMIN TICKET VIEW: #${ticket.id}</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>Customer:</b> ${escapeHtml(ticket.user_name)} (<code>${ticket.user_id}</code>)
📂 <b>Category:</b> ${escapeHtml(ticket.category)}${ticket.order_code ? `\n📦 <b>Order Code:</b> <code>${escapeHtml(ticket.order_code)}</code>` : ""}
📌 <b>Status:</b> ${getTicketStatusBadge(ticket.status)}
📅 <b>Created:</b> ${new Date(ticket.created_at).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━
💬 <b>MESSAGES:</b>
${threadText}`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback(`↩️ Reply (#${ticket.id})`, `adm_tkt_reply:${ticket.id}`),
      Markup.button.callback("✅ Mark Resolved", `adm_tkt_resolve:${ticket.id}`)
    ],
    [
      Markup.button.callback(
        isUserBlocked(ticket.user_id) ? "🟢 Unblock Customer" : "🚫 Block Customer & Remove Msgs",
        isUserBlocked(ticket.user_id) ? `adm:unblock_user:${ticket.user_id}` : `adm:block_user:${ticket.user_id}`
      )
    ],
    [Markup.button.callback("🔙 Tickets List", "adm:tickets"), Markup.button.callback("🏠 Admin Menu", "adm:menu")]
  ]);

  if (lastPhotoId) {
    return ctx.replyWithPhoto(lastPhotoId, { caption: text, parse_mode: "HTML", ...buttons });
  }

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

// Admin: Reply to Ticket prompt
bot.action(/^adm_tkt_reply:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const ticket = getTicket(ctx.match[1]);
  if (!ticket) return ctx.reply("❌ Ticket not found.");
  if (isUserBlocked(ticket.user_id)) {
    return ctx.reply(
      `🚫 Customer ${ticket.user_name} (ID: ${ticket.user_id}) is currently BLOCKED. Unblock them first if you want to reply to their ticket.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🟢 Unblock Customer", `adm:unblock_user:${ticket.user_id}`)],
        [Markup.button.callback("🔙 Back to Ticket", `adm_tkt_view:${ticket.id}`)]
      ])
    );
  }

  ctx.session.adminAction = { type: "ticket_reply", ticketId: ticket.id };
  return ctx.reply(
    `✍️ <b>Write your reply for Ticket #${ticket.id}</b> (Customer: ${escapeHtml(ticket.user_name)}):\n\nSend <code>/cancel</code> to cancel.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_tkt_view:${ticket.id}`)]])
    }
  );
});

// Admin: Resolve Ticket
bot.action(/^adm_tkt_resolve:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery("Ticket marked as resolved!").catch(() => {});
  const ticket = updateTicketStatus(ctx.match[1], "resolved");
  if (!ticket) return ctx.reply("❌ Ticket not found.");

  // Notify Customer
  try {
    await bot.telegram.sendMessage(
      ticket.user_id,
      `✅ <b>SUPPORT TICKET RESOLVED (#${ticket.id})</b>\n━━━━━━━━━━━━━━━━━━━━\nYour support ticket <b>#${ticket.id}</b> (${escapeHtml(ticket.category)}) has been marked as <b>Resolved</b> by our Support Team.\n\nIf you still need assistance, you can reply below to reopen it anytime!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`🔄 Reopen / Reply (#${ticket.id})`, `ticket:reply:${ticket.id}`)],
          [Markup.button.callback("🏠 Main Menu", "menu:main")]
        ])
      }
    );
  } catch (e) {}

  return ctx.reply(
    `✅ Ticket <b>#${ticket.id}</b> marked as Resolved and customer notified.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎫 Back to Tickets", "adm:tickets")],
        [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
      ])
    }
  );
});

// Backwards compatibility: if customer taps an older message's button, open the Support Ticket flow
bot.action("customer:reply", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const text = `🎫 <b>OPEN NEW SUPPORT TICKET</b>
━━━━━━━━━━━━━━━━━━━━
Please select the category that best describes your issue:`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Order Replacement / Warranty", "ticket:cat:Replacement")],
    [Markup.button.callback("💳 Deposit / Balance Issue", "ticket:cat:Deposit")],
    [Markup.button.callback("🔑 Account / Redeem Link Help", "ticket:cat:Product")],
    [Markup.button.callback("💬 General Question", "ticket:cat:General")],
    [Markup.button.callback("🔙 Back to Support", "menu:support")]
  ]);

  return ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

bot.action("customer:cancel_reply", async (ctx) => {
  ctx.session.awaitingSupportReply = false;
  await ctx.answerCbQuery("Reply cancelled.").catch(() => {});
  return ctx.reply("Reply cancelled.");
});

// Admin taps this button on an incoming customer message to reply directly.
bot.action(/^adm:reply_customer:([^:]+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.match[1]).trim();
  clearAdminConflictingSession(ctx);
  if (isUserBlocked(userId)) {
    return ctx.reply(
      `🚫 User ${userId} is currently BLOCKED. No messages can be sent to blocked users.\nUnblock them first if you want to reply.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${userId}`)],
        [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
      ])
    );
  }
  const user = getUser(userId);
  ctx.session.adminAction = { type: "customer_reply", userId };
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || userId) : userId;
  return ctx.reply(
    `↩️ Write your reply to ${name} (ID: ${userId}) below:\n\nSend /cancel to cancel.`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:customers:0")]])
  );
});

// Admin: Message customer directly by Telegram ID
bot.action("adm:msg_by_id", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  clearAdminConflictingSession(ctx);
  ctx.session.adminAction = { type: "msg_by_id_prompt" };
  const text = "🆔 Enter the Customer's Telegram ID (e.g. `123456789`), or enter ID and message separated by space:\n\nSend /cancel to cancel.";
  const markup = Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]]);
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, markup); } catch (_) {}
  }
  return ctx.reply(text, markup);
});

// =====================================================
// ADMIN: BLOCK / UNBLOCK USERS & PURGE CHAT MESSAGES
// =====================================================
bot.command("block", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const arg = (ctx.message?.text || "").split(/\s+/)[1]?.trim();
  if (!arg) {
    return ctx.reply("Usage: `/block <telegram_id_or_username>`\nExample: `/block 123456789`", { parse_mode: "Markdown" });
  }
  const matched = findUserByIdOrUsername(arg);
  const targetId = matched ? String(matched.id) : (/^\d+$/.test(arg) ? arg : null);
  if (!targetId) {
    return ctx.reply("❌ User not found. Please provide a numeric Telegram ID (e.g. `/block 123456789`).", { parse_mode: "Markdown" });
  }
  if (targetId === ADMIN_ID) {
    return ctx.reply("❌ Cannot block the admin account.");
  }
  await ctx.reply(`⏳ Blocking user ${targetId} and deleting all previously sent messages from their chat...`);
  const { user, deletedCount } = await blockUserAndPurge(targetId);
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;
  return ctx.reply(
    `🚫 User Blocked Successfully!\n\n👤 User: ${name} (ID: ${targetId})\n🗑️ Previous Bot Messages Removed: ${deletedCount} deleted\n🔇 Status: Completely Blocked (No bot replies, no updates, and excluded from all broadcasts/messages).`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${targetId}`)],
      [Markup.button.callback("🚫 Blocked Users Menu", "adm:blocked_menu")]
    ])
  );
});

bot.command("unblock", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const arg = (ctx.message?.text || "").split(/\s+/)[1]?.trim();
  if (!arg) {
    return ctx.reply("Usage: `/unblock <telegram_id_or_username>`\nExample: `/unblock 123456789`", { parse_mode: "Markdown" });
  }
  const matched = findUserByIdOrUsername(arg);
  const targetId = matched ? String(matched.id) : (/^\d+$/.test(arg) ? arg : null);
  if (!targetId) {
    return ctx.reply("❌ User not found. Please provide a numeric Telegram ID.");
  }
  const user = setUserBlocked(targetId, false);
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;
  return ctx.reply(
    `🟢 User Unblocked!\n\n👤 User: ${name} (ID: ${targetId})\nStatus: Active again.`,
    Markup.inlineKeyboard([[Markup.button.callback("🚫 Blocked Users Menu", "adm:blocked_menu")]])
  );
});

bot.action("adm:blocked_menu", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  return showBlockedUsersMenu(ctx, 0);
});

bot.action(/^adm:blocked_list:(\d+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  return showBlockedUsersMenu(ctx, Number(ctx.match[1]) || 0);
});

async function showBlockedUsersMenu(ctx, page = 0) {
  clearAdminConflictingSession(ctx);
  const blocked = getBlockedUsers()
    .filter(u => u && u.id !== undefined && u.id !== null)
    .sort((a, b) => {
      const aTime = Date.parse(a?.blocked_at || a?.created_at || 0) || 0;
      const bTime = Date.parse(b?.blocked_at || b?.created_at || 0) || 0;
      return bTime - aTime;
    });

  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(blocked.length / pageSize));
  const curPage = Math.min(Math.max(0, page), pageCount - 1);
  const visible = blocked.slice(curPage * pageSize, (curPage + 1) * pageSize);

  let text = `🚫 BLOCKED USERS MANAGEMENT (${blocked.length} Blocked)\n━━━━━━━━━━━━━━━━━━━━\n• Blocked users receive NO replies, NO updates, and NO broadcast/all-sender messages.\n• All previous bot messages are automatically deleted from their chat when blocked.\n\n`;

  const rows = [
    [
      Markup.button.callback("🚫 Block User by ID / @Username", "adm:block_by_id"),
      Markup.button.callback("🟢 Unblock by ID", "adm:unblock_by_id")
    ]
  ];

  if (blocked.length === 0) {
    text += `✅ Currently no users are blocked.`;
  } else {
    text += `Blocked Users (Page ${curPage + 1}/${pageCount}):\n`;
    for (const u of visible) {
      const uid = String(u.id).trim();
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "User";
      const shortName = safeLabelSlice(name, 14) || "User";
      const uname = u.username ? ` (@${u.username})` : "";
      text += `🚫 ${name}${uname} — ID: ${uid}\n`;
      rows.push([
        Markup.button.callback(`👤 ${shortName} (${uid})`, `adm:customer:${uid}`),
        Markup.button.callback("🟢 Unblock", `adm:unblock_user:${uid}`)
      ]);
    }
  }

  const nav = [];
  if (curPage > 0) nav.push(Markup.button.callback("⬅️ Previous", `adm:blocked_list:${curPage - 1}`));
  if (curPage < pageCount - 1) nav.push(Markup.button.callback("Next ➡️", `adm:blocked_list:${curPage + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("👥 All Customers", "adm:customers:0"), Markup.button.callback("🔙 Admin Menu", "adm:menu")]);

  const markup = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, markup); } catch (_) {}
  }
  return ctx.reply(text, markup);
}

bot.action("adm:block_by_id", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "block_by_id_prompt" };
  return ctx.reply(
    "🚫 Enter the Customer's Telegram ID (e.g. `123456789`) or `@username` to BLOCK them and delete all bot messages sent to them:\n\nSend /cancel to cancel.",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:blocked_menu")]])
  );
});

bot.action("adm:unblock_by_id", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "unblock_by_id_prompt" };
  return ctx.reply(
    "🟢 Enter the Customer's Telegram ID (e.g. `123456789`) or `@username` to UNBLOCK them:\n\nSend /cancel to cancel.",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:blocked_menu")]])
  );
});

bot.action(/^adm:block_user:([^:]+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const targetId = String(ctx.match[1]).trim();
  if (targetId === ADMIN_ID) {
    return ctx.answerCbQuery("❌ Cannot block the admin account.", { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery("🚫 Blocking user & removing sent messages...").catch(() => {});
  const { user, deletedCount } = await blockUserAndPurge(targetId);
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;

  const msg = `🚫 USER BLOCKED & MESSAGES REMOVED\n━━━━━━━━━━━━━━━━━━━━\n👤 User: ${name}\n🆔 Telegram ID: ${targetId}\n🗑️ Previous Messages Deleted: ${deletedCount}\n🔇 Status: BLOCKED (Will not receive any text, updates, or broadcast messages, and cannot get any reply from the bot).`;

  const markup = Markup.inlineKeyboard([
    [
      Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${targetId}`),
      Markup.button.callback("🗑️ Clean Messages Again", `adm:purge_msgs:${targetId}`)
    ],
    [
      Markup.button.callback("👤 Customer Details", `adm:customer:${targetId}`),
      Markup.button.callback("🚫 Blocked List", "adm:blocked_menu")
    ],
    [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
  ]);

  return ctx.reply(msg, markup);
});

bot.action(/^adm:unblock_user:([^:]+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const targetId = String(ctx.match[1]).trim();
  await ctx.answerCbQuery("🟢 User unblocked!").catch(() => {});
  const user = setUserBlocked(targetId, false);
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;

  const msg = `🟢 USER UNBLOCKED\n━━━━━━━━━━━━━━━━━━━━\n👤 User: ${name}\n🆔 Telegram ID: ${targetId}\n✅ Status: Active (Can now use the bot and receive messages again).`;

  const markup = Markup.inlineKeyboard([
    [
      Markup.button.callback("🚫 Block User Again", `adm:block_user:${targetId}`),
      Markup.button.callback("👤 Customer Details", `adm:customer:${targetId}`)
    ],
    [
      Markup.button.callback("🚫 Blocked List", "adm:blocked_menu"),
      Markup.button.callback("🔙 Admin Menu", "adm:menu")
    ]
  ]);

  return ctx.reply(msg, markup);
});

bot.action(/^adm:purge_msgs:([^:]+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const targetId = String(ctx.match[1]).trim();
  await ctx.answerCbQuery("🗑️ Removing messages from user chat...").catch(() => {});
  const { deletedCount } = await purgeUserChatMessages(targetId);
  return ctx.reply(
    `🗑️ Cleaned bot messages from chat with User ID ${targetId} (${deletedCount} messages removed).`,
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 Customer Details", `adm:customer:${targetId}`)],
      [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
    ])
  );
});

// Admin: Customer directory with pagination and one-to-one messaging.
const CUSTOMER_PAGE_SIZE = 8;

function safeLabelSlice(str, maxChars = 14) {
  const clean = String(str || "").replace(/[\r\n]+/g, " ").trim();
  return Array.from(clean).slice(0, maxChars).join("");
}

bot.action(/^adm:customers(?::(\d+))?$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  clearAdminConflictingSession(ctx);

  const users = getAllUsers()
    .filter(u => u && u.id !== undefined && u.id !== null && String(u.id).trim() !== "")
    .sort((a, b) => {
      const aTime = Date.parse(a?.created_at || 0) || 0;
      const bTime = Date.parse(b?.created_at || 0) || 0;
      return bTime - aTime;
    });

  const pageCount = Math.max(1, Math.ceil(users.length / CUSTOMER_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(ctx.match[1]) || 0, pageCount - 1));
  const visible = users.slice(page * CUSTOMER_PAGE_SIZE, (page + 1) * CUSTOMER_PAGE_SIZE);

  let text = `👥 CUSTOMERS & DIRECT MESSAGES (${users.length})\nPage ${page + 1}/${pageCount}\n\n`;
  if (visible.length === 0) {
    text += `No registered customers yet.\n\n`;
  }

  const rows = [];
  for (const u of visible) {
    const uid = String(u.id).trim();
    const rawName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "Customer";
    const shortName = safeLabelSlice(rawName, 14) || "Customer";
    const username = u.username ? ` @${u.username}` : "";
    const statusBadge = u.is_blocked ? " 🚫 [BLOCKED]" : "";
    text += `👤 ${rawName}${username}${statusBadge}\n🆔 ${uid}  •  Wallet: ${money(Number(u.wallet_balance || 0))}\n\n`;

    rows.push([
      Markup.button.callback(`${u.is_blocked ? "🚫 " : "👤 "}${shortName} (${uid})`, `adm:customer:${uid}`),
      Markup.button.callback("✉️ Direct Msg", `adm:customer_msg:${uid}`),
      Markup.button.callback(u.is_blocked ? "🟢 Unblock" : "🚫 Block", u.is_blocked ? `adm:unblock_user:${uid}` : `adm:block_user:${uid}`)
    ]);
  }

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Previous", `adm:customers:${page - 1}`));
  if (page < pageCount - 1) nav.push(Markup.button.callback("Next ➡️", `adm:customers:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([
    Markup.button.callback("🆔 Message by ID", "adm:msg_by_id"),
    Markup.button.callback("🚫 Blocked Users", "adm:blocked_menu")
  ]);
  rows.push([Markup.button.callback("📢 Message All Customers", "adm:broadcast")]);
  rows.push([
    Markup.button.callback("📌 Pin Message (All)", "adm:pin_broadcast"),
    Markup.button.callback("🗑️ Remove Old Pins", "adm:unpin_all_users")
  ]);
  rows.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);

  const markup = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(text, markup); } catch (_) {}
  }
  return ctx.reply(text, markup);
});

bot.action(/^adm:customer:([^:]+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  clearAdminConflictingSession(ctx);
  const userId = String(ctx.match[1]).trim();
  const u = getUser(userId);
  if (!u) return ctx.reply("❌ Customer not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Customers", "adm:customers:0")]]));
  const uid = String(u.id ?? userId).trim();
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "Unnamed customer";
  const blockedStatus = u.is_blocked ? `🚫 BLOCKED${u.blocked_at ? ` (${new Date(u.blocked_at).toLocaleString()})` : ""}` : "🟢 Active";
  const details = `👤 CUSTOMER DETAILS\n\nName: ${name}\nUsername: ${u.username ? `@${u.username}` : "Not set"}\nTelegram ID: ${uid}\nStatus: ${blockedStatus}\nWallet: ${money(Number(u.wallet_balance || 0))}\nTotal spent: ${money(Number(u.total_spent || 0))}\nOrders: ${Number(u.orders_count || 0)}\nJoined: ${u.created_at || "Unknown"}`;
  const actionButtons = [];
  if (!u.is_blocked) {
    actionButtons.push([Markup.button.callback("✉️ Send Direct Message", `adm:customer_msg:${uid}`)]);
    actionButtons.push([Markup.button.callback("🚫 Block User & Remove Sent Messages", `adm:block_user:${uid}`)]);
  } else {
    actionButtons.push([Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${uid}`)]);
    actionButtons.push([Markup.button.callback("🗑️ Delete Sent Messages Again", `adm:purge_msgs:${uid}`)]);
  }
  actionButtons.push([Markup.button.callback("🔙 Customers List", "adm:customers:0"), Markup.button.callback("🏠 Admin Menu", "adm:menu")]);
  const markup = Markup.inlineKeyboard(actionButtons);
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(details, markup); } catch (_) {}
  }
  return ctx.reply(details, markup);
});

bot.action(/^adm:customer_msg:([^:]+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  clearAdminConflictingSession(ctx);
  const userId = String(ctx.match[1]).trim();
  if (isUserBlocked(userId)) {
    return ctx.reply(
      `🚫 Customer ${userId} is currently BLOCKED. No message can be sent while they are blocked.\nUnblock them first if you want to message them.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${userId}`)],
        [Markup.button.callback("🔙 Customers", "adm:customers:0")]
      ])
    );
  }
  const user = getUser(userId);
  ctx.session.adminAction = { type: "customer_message", userId };
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || userId) : userId;
  const promptText = `✉️ Write the direct message for ${name} (ID: ${userId}) below:\n\nSend /cancel to cancel.`;
  const markup = Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm:customer:${userId}`)]]);
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(promptText, markup); } catch (_) {}
  }
  return ctx.reply(promptText, markup);
});

// Admin: Pending Deposits
bot.action("adm:deposits", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});

  const list = getPendingDeposits();
  if (list.length === 0) {
    return ctx.reply("✅ No pending deposits.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Admin Menu", "adm:menu")]]));
  }

  let text = `📥 PENDING DEPOSITS (${list.length}):\n`;
  const buttons = list.slice(0, 10).map((d) => [
    Markup.button.callback(
      `🔍 ${d.id} • ${money(d.amount)} (${d.user_name})`,
      `adm_view_dep:${d.id}`
    )
  ]);
  buttons.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
});

bot.action(/^adm_view_dep:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const deposit = getDeposit(ctx.match[1]);
  if (!deposit) return ctx.reply("Deposit not found.");

  const msg = `Deposit: ${deposit.id}
User: ${deposit.user_name} (${deposit.user_id})
Amount: ${money(deposit.amount)}
Method: ${deposit.method}
Proof: ${deposit.proof || "None"}
Status: ${deposit.status}`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Approve", `adm_dep_app:${deposit.id}`),
      Markup.button.callback("❌ Reject", `adm_dep_rej:${deposit.id}`)
    ],
    [
      Markup.button.callback("✉️ Send Message", `adm:customer_msg:${deposit.user_id}`),
      Markup.button.callback("🚫 Block User", `adm:block_user:${deposit.user_id}`)
    ],
    [Markup.button.callback("🔙 Pending List", "adm:deposits")]
  ]);

  if (deposit.photo_file_id) {
    await ctx.replyWithPhoto(deposit.photo_file_id, { caption: msg, ...buttons });
  } else {
    await ctx.reply(msg, buttons);
  }
});

// Admin: Products & Plans Management
bot.action("adm:products", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  return showAdminProductsMenu(ctx);
});

async function showAdminProductsMenu(ctx) {
  const products = getProducts();
  const standardProds = products.filter(p => p.category !== "api_key");
  const apiKeyProds = products.filter(p => p.category === "api_key");

  const groupMap = new Map();
  const singleProducts = [];
  for (const p of standardProds) {
    const grp = p.group ? String(p.group).trim() : "";
    if (grp) {
      if (!groupMap.has(grp)) groupMap.set(grp, []);
      groupMap.get(grp).push(p);
    } else {
      singleProducts.push(p);
    }
  }

  const text = `🛍️ <b>ADMIN PRODUCTS & PLANS MANAGER</b>
━━━━━━━━━━━━━━━━━━━━━
• <b>Multi-Plan Groups:</b> ${groupMap.size} Groups (${standardProds.length - singleProducts.length} Plans)
• <b>Single Products:</b> ${singleProducts.length} Items
• <b>AI API Keys:</b> ${apiKeyProds.length} Items
• <b>Total Catalog Items:</b> ${products.length}

👇 <i>Tap a Multi-Plan Group (📂) to edit its plans, or tap any Single Product (🛍️) / AI Key (🆙) to edit its Name, Price, Description, Terms, or Stock:</i>`;

  const groupBtns = [];
  for (const [grpName, plans] of groupMap.entries()) {
    groupBtns.push(
      Markup.button.callback(`📂 ${grpName} ▸ ${plans.length} Plans`, `adm_grp:${grpName}`)
    );
  }

  const singleBtns = singleProducts.map((p) => {
    const status = p.outOfStock ? "🚫" : "🛍️";
    return Markup.button.callback(
      `${status} ${p.name} $${Number(p.price || 0).toFixed(2)}`,
      `adm_edit_prod:${p.id}`
    );
  });

  const apiBtns = apiKeyProds.map((p) => {
    return Markup.button.callback(
      `🆙 ${safeLabelSlice(p.name, 18)} $${Number(p.price || 0).toFixed(2)}`,
      `adm_edit_prod:${p.id}`
    );
  });

  const rows = [
    [Markup.button.callback("➕ Add New Product / Plan / AI Key", "adm_add_prod_start")],
    ...pairButtons(groupBtns, 2),
    ...pairButtons(singleBtns, 2),
    ...pairButtons(apiBtns, 2),
    [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
  ];

  const markup = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...markup });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...markup });
}

// Admin: View & Edit Plans inside a Multi-Plan Group
bot.action(/^adm_grp:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const groupName = ctx.match[1];
  return showAdminGroupPlans(ctx, groupName);
});

async function showAdminGroupPlans(ctx, groupName) {
  const plans = getProducts().filter(
    (p) => p.group && String(p.group).trim().toLowerCase() === String(groupName).trim().toLowerCase()
  );

  if (plans.length === 0) {
    return showAdminProductsMenu(ctx);
  }

  const displayGroup = plans[0].group || groupName;
  let text = `📂 <b>MANAGE GROUP: ${escapeHtml(displayGroup.toUpperCase())} (${plans.length} Plans)</b>\n━━━━━━━━━━━━━━━━━━━━━\nSelect any plan below to edit its <b>Name, Price, Description, Terms, or Stock</b>:\n`;

  plans.forEach((plan, idx) => {
    const status = plan.outOfStock ? "🚫 Out" : `Stock: ${plan.stock}`;
    const firstDesc = String(plan.description || "").split("\n")[0] || "";
    text += `\n<b>${idx + 1}. ${escapeHtml(plan.name)}</b> — <b>$${Number(plan.price).toFixed(2)}</b> (${status})\n<i>${escapeHtml(firstDesc)}</i>\n`;
  });

  const rows = plans.map((plan) => [
    Markup.button.callback(
      `✏️ ${plan.name} • $${Number(plan.price).toFixed(2)} (${plan.outOfStock ? "OUT" : `Stock: ${plan.stock}`})`,
      `adm_edit_prod:${plan.id}`
    )
  ]);

  rows.push([Markup.button.callback(`➕ Add New Plan to ${displayGroup}`, `adm_add_plan_grp:${displayGroup}`)]);
  rows.push([Markup.button.callback("🔙 All Products & Groups", "adm:products")]);

  const markup = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...markup });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...markup });
}

// Admin: View & Edit Individual Product or Plan
bot.action(/^adm_edit_prod:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  return showAdminEditProduct(ctx, ctx.match[1]);
});

async function showAdminEditProduct(ctx, productId) {
  const p = getProduct(productId);
  if (!p) return ctx.reply("❌ Product not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Products List", "adm:products")]]));

  const categoryLabel = p.category === "api_key"
    ? "🆙 AI API Key / Cloud Token"
    : (p.group ? `📂 Multi-Plan (${escapeHtml(p.group)})` : "🛍️ Single Product");

  const text = `🛍️ <b>EDIT PRODUCT: ${escapeHtml(p.name)}</b>
━━━━━━━━━━━━━━━━━━━━━
• <b>ID:</b> <code>${escapeHtml(p.id)}</code>
• <b>Type / Group:</b> ${categoryLabel}
• <b>Price:</b> <b>$${Number(p.price).toFixed(2)} (${money(p.price)})</b>
• <b>Current Stock:</b> <b>${p.stock}</b> (${p.outOfStock ? "🚫 Out of Stock" : "✅ In Stock"})
• <b>Digital Codes Loaded:</b> ${Array.isArray(p.codes) ? p.codes.length : 0}

📝 <b>Current Description:</b>
${escapeHtml(p.description || "None")}

✍️ <b>Current Terms:</b>
${escapeHtml(p.terms || "None")}`;

  const backRow = [];
  if (p.group) {
    backRow.push(Markup.button.callback(`🔙 ${p.group} Plans`, `adm_grp:${p.group}`));
  }
  backRow.push(Markup.button.callback("🛍️ All Products", "adm:products"));

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("✏️ Edit Name", `adm_set_name:${p.id}`),
      Markup.button.callback("💲 Set Price", `adm_set_price:${p.id}`)
    ],
    [
      Markup.button.callback("📝 Edit Description", `adm_set_desc:${p.id}`),
      Markup.button.callback("📜 Edit Terms", `adm_set_terms:${p.id}`)
    ],
    [
      Markup.button.callback("🔢 Set Stock Number", `adm_set_stock:${p.id}`),
      Markup.button.callback("📦 Add Digital Codes", `adm_add_codes:${p.id}`)
    ],
    [
      Markup.button.callback("📂 Set Group / Category", `adm_set_group:${p.id}`),
      Markup.button.callback(p.outOfStock ? "🟢 Mark In Stock" : "🔴 Mark Out of Stock", `adm_toggle_stock:${p.id}`)
    ],
    [
      Markup.button.callback("🗑️ Delete Product / Plan", `adm_del_prod_confirm:${p.id}`)
    ],
    backRow
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
}

bot.action(/^adm_toggle_stock:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.answerCbQuery("Product not found").catch(() => {});
  const nextOut = !p.outOfStock;
  updateProduct(p.id, { outOfStock: nextOut });
  await ctx.answerCbQuery(`Updated status to: ${nextOut ? "Out of Stock" : "In Stock"}`).catch(() => {});
  return showAdminEditProduct(ctx, p.id);
});

// Helper to safely truncate string to UTF-8 byte limit for Telegram switch_inline_query_current_chat
function utf8ByteSlice(str, maxBytes = 250) {
  const s = String(str || "");
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, "utf8") > maxBytes) break;
    out += ch;
  }
  return out;
}

// Helper to strip leading @bot_username when admin sends text via switch_inline_query_current_chat
function stripLeadingBotMention(text) {
  return String(text || "").replace(/^@[a-zA-Z0-9_]+[\s\n]+/, "");
}

bot.action(/^adm_set_name:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");
  ctx.session.adminAction = { type: "set_name", productId: p.id };
  const prefillName = utf8ByteSlice(p.name || "", 240);
  await ctx.reply(
    `✏️ <b>Edit Product / Plan Name</b>\n\n` +
    `<b>Current Name (Tap to Copy):</b>\n<code>${escapeHtml(p.name)}</code>\n\n` +
    `💡 নিচের <b>"📲 Load Current Name in Typing Box"</b> বাটনে ক্লিক করলে আগের নামটি সরাসরি আপনার টাইপিং বক্সে চলে আসবে—নতুন করে পুরোটা লিখতে হবে না, শুধু যতটুকু দরকার এডিট করে Send করুন:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📲 Load Current Name in Typing Box", switch_inline_query_current_chat: prefillName }],
          [{ text: "❌ Cancel", callback_data: `adm_edit_prod:${p.id}` }]
        ]
      }
    }
  );
});

bot.action(/^adm_set_price:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  ctx.session.adminAction = { type: "set_price", productId: ctx.match[1] };
  const currPrice = p ? Number(p.price).toFixed(2) : "1.00";
  await ctx.reply(
    `💲 Enter new base price in USD/USDT for <b>${p ? escapeHtml(p.name) : ctx.match[1]}</b>\n` +
    `Current Price: <code>${currPrice}</code>\n\n` +
    `Send the new price (e.g. <code>1.35</code> or <code>0.42</code>):`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: `📲 Load Current Price (${currPrice})`, switch_inline_query_current_chat: currPrice }],
          [{ text: "❌ Cancel", callback_data: `adm_edit_prod:${ctx.match[1]}` }]
        ]
      }
    }
  );
});

bot.action(/^adm_set_desc:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  ctx.session.adminAction = { type: "set_desc", productId: p.id };
  const currentDesc = String(p.description || "").trim();
  const prefillFull = utf8ByteSlice(currentDesc, 250);
  const lines = currentDesc.split("\n").filter((l) => l.trim().length > 0);

  const inlineKeyboard = [
    [{ text: "📲 Load Full Description in Typing Box", switch_inline_query_current_chat: prefillFull }]
  ];

  // Add per-line pre-fill buttons so Admin can also edit any single line in 1 click without touching other lines
  const lineBtnRow = [];
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const prefillLine = utf8ByteSlice(`L${lineNum}: ${line}`, 245);
    lineBtnRow.push({
      text: `✏️ Edit Line ${lineNum}`,
      switch_inline_query_current_chat: prefillLine
    });
    if (lineBtnRow.length === 2) {
      inlineKeyboard.push([...lineBtnRow]);
      lineBtnRow.length = 0;
    }
  });
  if (lineBtnRow.length > 0) inlineKeyboard.push([...lineBtnRow]);

  inlineKeyboard.push([
    { text: "➕ Add New Line at Bottom", switch_inline_query_current_chat: "ADD: ✅ " }
  ]);
  inlineKeyboard.push([
    { text: "❌ Cancel", callback_data: `adm_edit_prod:${p.id}` }
  ]);

  const numberedPreview = lines.length
    ? lines.map((l, i) => `<b>L${i + 1}:</b> <code>${escapeHtml(l)}</code>`).join("\n")
    : "<i>No description set</i>";

  await ctx.reply(
    `📝 <b>Edit Description — ${escapeHtml(p.name)}</b>\n\n` +
    `📋 <b>Current Description (Tap to Copy Full Text):</b>\n<code>${escapeHtml(currentDesc)}</code>\n\n` +
    `🔢 <b>Line-by-Line View:</b>\n${numberedPreview}\n\n` +
    `💡 <b>কীভাবে আগের লেখা রেখে শুধু এডিট করবেন:</b>\n` +
    `1️⃣ নিচের <b>"📲 Load Full Description in Typing Box"</b> বাটনে চাপ দিলে পুরো ডেসক্রিপশনটি সরাসরি আপনার মেসেজ লেখার বক্সে চলে আসবে—এরপর যতটুকু দরকার পরিবর্তন করে Send করুন!\n` +
    `2️⃣ অথবা নির্দিষ্ট কোনো লাইন এডিট করতে চাইলে <b>"✏️ Edit Line 1 / 2..."</b> বাটনে চাপ দিন—শুধু ওই লাইনটি টাইপিং বক্সে আসবে, এডিট করে পাঠালে বাকি সব লাইন আগের মতোই থাকবে!`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard }
    }
  );
});

bot.action(/^adm_set_terms:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  ctx.session.adminAction = { type: "set_terms", productId: p.id };
  const currentTerms = String(p.terms || "").trim();
  const prefillTerms = utf8ByteSlice(currentTerms, 250);

  await ctx.reply(
    `📜 <b>Edit Terms of Service — ${escapeHtml(p.name)}</b>\n\n` +
    `<b>Current Terms (Tap to Copy):</b>\n<code>${escapeHtml(currentTerms)}</code>\n\n` +
    `💡 নিচের <b>"📲 Load Current Terms in Typing Box"</b> বাটনে ক্লিক করলে আগের Terms লেখাটি সরাসরি আপনার টাইপিং বক্সে চলে আসবে—শুধু এডিট করে Send করুন:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📲 Load Current Terms in Typing Box", switch_inline_query_current_chat: prefillTerms }],
          [{ text: "❌ Cancel", callback_data: `adm_edit_prod:${p.id}` }]
        ]
      }
    }
  );
});

bot.action(/^adm_set_group:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  ctx.session.adminAction = { type: "set_group_name", productId: p.id };
  await ctx.reply(
    `📂 <b>Set Multi-Plan Group for ${escapeHtml(p.name)}</b>\n\nCurrent Group: <b>${escapeHtml(p.group || "None (Single Product)")}</b>\n\n• Send a group name (e.g. <code>Gemini</code>, <code>Claude AI</code>, <code>ChatGPT</code>, <code>CapCut</code>, <code>Canva</code>, <code>Gmail</code>, <code>Autodesk</code>, <code>Muse</code>) to group this plan under that menu.\n• Or send <code>none</code> to make it a standalone Single Product:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_edit_prod:${p.id}`)]])
    }
  );
});

bot.action(/^adm_set_stock:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  ctx.session.adminAction = { type: "set_stock", productId: ctx.match[1] };
  await ctx.reply(
    `🔢 Enter new stock count for <b>${p ? escapeHtml(p.name) : ctx.match[1]}</b> (e.g. <code>500</code>):`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_edit_prod:${ctx.match[1]}`)]])
    }
  );
});

bot.action(/^adm_add_codes:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  ctx.session.adminAction = { type: "add_codes", productId: ctx.match[1] };
  await ctx.reply(
    `📦 Send the digital codes/links/accounts to add to <b>${p ? escapeHtml(p.name) : ctx.match[1]}</b> (one per line):`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_edit_prod:${ctx.match[1]}`)]])
    }
  );
});

bot.action(/^adm_del_prod_confirm:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  const text = `⚠️ <b>CONFIRM DELETION</b>\n\nAre you sure you want to permanently delete <b>${escapeHtml(p.name)}</b> from the catalog?\n\nThis cannot be undone.`;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🗑️ Yes, Permanently Delete", `adm_del_prod_exec:${p.id}`)],
    [Markup.button.callback("❌ Cancel", `adm_edit_prod:${p.id}`)]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

bot.action(/^adm_del_prod_exec:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const p = getProduct(productId);
  const name = p ? p.name : productId;
  const grp = p?.group;
  deleteProduct(productId);

  const navBtns = [];
  if (grp) navBtns.push([Markup.button.callback(`🔙 Back to ${grp} Plans`, `adm_grp:${grp}`)]);
  navBtns.push([Markup.button.callback("🛍️ Back to Products List", "adm:products")]);

  await ctx.reply(
    `🗑️ Product <b>${escapeHtml(name)}</b> has been permanently deleted from the database.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(navBtns)
    }
  );
});

// Admin: Add Product / Plan Multi-Step Wizard
bot.action("adm_add_prod_start", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.newProductWizard = null;
  ctx.session.adminAction = null;

  const text = `➕ <b>ADD NEW PRODUCT, PLAN OR AI KEY</b>
━━━━━━━━━━━━━━━━━━━━━
Choose what type of item you want to add:

• <b>Single Product:</b> Appears directly in 🛍️ Buy with its price (e.g. <code>NETFLIX $2.50</code>).
• <b>Plan in Multi-Plan Group:</b> Appears inside a group like <code>Gemini ▸ X Plans »</code> or <code>Claude AI ▸ X Plans »</code>.
• <b>AI API Key / Token:</b> Appears in the 🆙 API Key menu.`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🛍️ Single Product (Direct in Buy Menu)", "adm_wizard_cat:standard")],
    [Markup.button.callback("📂 Plan in Multi-Plan Group", "adm_wizard_cat:group_plan")],
    [Markup.button.callback("🆙 AI API Key / Cloud Token", "adm_wizard_cat:api_key")],
    [Markup.button.callback("❌ Cancel", "adm:products")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

bot.action(/^adm_add_plan_grp:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const groupName = ctx.match[1];
  ctx.session.newProductWizard = {
    category: "standard",
    group: groupName,
    step: "name"
  };

  await ctx.reply(
    `📌 <b>Step 1 of 4: Enter Plan Name</b>\n\nGroup: <b>📂 ${escapeHtml(groupName)}</b>\nPlease send the name of the new plan:\n<i>(Example: "${escapeHtml(groupName)} Pro — 6 Months")</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_grp:${groupName}`)]])
    }
  );
});

bot.action(/^adm_wizard_cat:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const mode = ctx.match[1];

  if (mode === "group_plan") {
    ctx.session.newProductWizard = {
      category: "standard",
      step: "group"
    };
    return ctx.reply(
      `📂 <b>Step 1 of 5: Enter Group Name</b>\n\nSend the Group Name for this plan (e.g. <code>Gemini</code>, <code>Claude AI</code>, <code>ChatGPT</code>, <code>CapCut</code>, <code>Canva</code>, <code>Gmail</code>, <code>Autodesk</code>, <code>Muse</code>, or a new group name):`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
      }
    );
  }

  ctx.session.newProductWizard = {
    category: mode === "api_key" ? "api_key" : "standard",
    group: undefined,
    step: "name"
  };

  const catName = mode === "api_key" ? "AI API Key / Token" : "Single Standard Product";
  await ctx.reply(
    `📌 <b>Step 1 of 4: Enter Product Name</b>\n\nCategory: <b>${catName}</b>\nPlease send the name of the product:\n<i>(Example: "PRIME VIDEO" or "Midjourney Pro Key")</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
    }
  );
});

async function handleNewProductWizardInput(ctx, text) {
  const wizard = ctx.session.newProductWizard;
  if (!wizard) return;

  if (wizard.step === "group") {
    if (!text || text.trim().length < 2) {
      return ctx.reply("❌ Group name is too short. Please send a valid group name:");
    }
    wizard.group = text.trim();
    wizard.step = "name";
    return ctx.reply(
      `📌 <b>Enter Plan Name</b>\n\nGroup: <b>📂 ${escapeHtml(wizard.group)}</b>\nPlease send the name of the plan:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
      }
    );
  }

  if (wizard.step === "name") {
    if (!text || text.length < 2) {
      return ctx.reply("❌ Product name is too short. Please send a valid name:");
    }
    wizard.name = text.trim();
    wizard.step = "price";
    return ctx.reply(
      `💲 <b>Set Base Price</b>\n\nProduct: <b>${escapeHtml(wizard.name)}</b>\nPlease send the base price in USD/USDT (e.g. <code>1.50</code> or <code>4.20</code>):`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
      }
    );
  }

  if (wizard.step === "price") {
    const price = parseFloat(text.replace("$", "").trim());
    if (isNaN(price) || price <= 0) {
      return ctx.reply("❌ Invalid price number. Please enter a valid positive number (e.g. 1.50):");
    }
    wizard.price = Number(price.toFixed(2));
    wizard.step = "stock";
    return ctx.reply(
      `🔢 <b>Initial Stock</b>\n\nPrice set to: <b>$${wizard.price.toFixed(2)} (${money(wizard.price)})</b>\nPlease send initial stock count (e.g. <code>100</code> or <code>250</code>):`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
      }
    );
  }

  if (wizard.step === "stock") {
    const stock = parseInt(text.trim(), 10);
    if (isNaN(stock) || stock < 0) {
      return ctx.reply("❌ Invalid stock count. Please enter a valid number (e.g. 50):");
    }
    wizard.stock = stock;
    wizard.step = "description";
    return ctx.reply(
      `📝 <b>Product Description</b>\n\nStock set to: <b>${stock}</b>\nPlease send the product description below (supports multiple lines/bullet points):\n\n<i>Example:</i>\n<code>✨ Official Premium Subscription\n⏳ Validity: 1 Month\n🛡️ Guarantee: 48 Hours Replacement Guarantee\n⚡ Delivery: Instant Automated Delivery</code>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
      }
    );
  }

  if (wizard.step === "description") {
    const description = text.trim();
    ctx.session.newProductWizard = null;

    const cleanSlug = wizard.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30);
    const id = `${cleanSlug || "item"}_${Date.now().toString(36)}`;

    const newProduct = {
      id,
      name: wizard.name,
      ...(wizard.group ? { group: wizard.group } : {}),
      category: wizard.category,
      price: wizard.price,
      stock: wizard.stock,
      outOfStock: wizard.stock <= 0,
      description: description,
      terms: "• Instant automated delivery\n• 48 Hours Replacement Guarantee included",
      codes: [],
      bulk_tiers: buildBulkTiers(wizard.price)
    };

    addProduct(newProduct);

    const menuLabel = newProduct.category === "api_key"
      ? "🆙 AI API Key Store"
      : (newProduct.group ? `📂 ${newProduct.group} Plans` : "🛍️ Buy Menu");

    return ctx.reply(
      `🎉 <b>NEW PRODUCT ADDED SUCCESSFULLY!</b>\n━━━━━━━━━━━━━━━━━━━━━\n• <b>ID:</b> <code>${id}</code>\n• <b>Name:</b> <b>${escapeHtml(newProduct.name)}</b>${newProduct.group ? `\n• <b>Group:</b> <b>${escapeHtml(newProduct.group)}</b>` : ""}\n• <b>Price:</b> <b>$${newProduct.price.toFixed(2)} (${money(newProduct.price)})</b>\n• <b>Stock:</b> <b>${newProduct.stock}</b>\n\nCustomers can now view and buy this item under <b>${escapeHtml(menuLabel)}</b>!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✏️ Edit Product", `adm_edit_prod:${id}`), Markup.button.callback("📦 Add Codes", `adm_add_codes:${id}`)],
          [Markup.button.callback("🛍️ View Products List", "adm:products")]
        ])
      }
    );
  }
}

// Admin: User Balance Adjuster
bot.action("adm:user_bal", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "user_bal_prompt" };
  await ctx.reply(
    "Enter Telegram User ID and amount to add/subtract (e.g. 123456789 10.5 or 123456789 -5):"
  );
});

// Admin: Settings & Force Join
bot.action("adm:settings", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const s = getAllSettings();
  const minCrypto = Number(s.min_crypto_deposit ?? 1.00);

  const text = `⚙️ BOT SETTINGS & CONFIGURATION:

• Force Join Enabled: ${s.force_join_enabled ? "✅ YES" : "❌ NO"}
• Channel ID: ${s.channel_id || "Not Set"}
• Channel Link: ${s.channel_link || "Not Set"}
• Group ID: ${s.group_id || "Not Set"}
• Group Link: ${s.group_link || "Not Set"}
• Binance Pay ID: ${s.binance_pay_id || "Not Set"}
• Binance Deposit Description: ${s.binance_deposit_desc ? "✅ Custom" : "Default"}
• USDT BEP20 Address: ${s.bep20_usdt_address}
• USDT Polygon Address: ${s.polygon_usdt_address || s.bep20_usdt_address}
• BEP20 Deposit Description: ${s.bep20_deposit_desc ? "✅ Custom" : "Default"}
• Support Handle: ${s.support_username || "Not Set"}
• Min Crypto Deposit: $${minCrypto.toFixed(2)} USDT
• 1st Deposit Auto-Msg (1m 30s): ${s.deposit_paid_auto_msg ? "✅ Set" : "❌ Empty"}
• 2nd Deposit Auto-Msg (Screenshot, 1m 30s): ${s.deposit_second_auto_msg ? "✅ Set" : "❌ Empty"}
• Group Sales Broadcast: ${s.fake_sales_broadcast_enabled !== false ? "✅ ENABLED (~2 mins)" : "❌ DISABLED"}
• Group Deposits Broadcast: ${s.fake_deposits_broadcast_enabled !== false ? "✅ ENABLED (~20 mins)" : "❌ DISABLED"}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(s.force_join_enabled ? "🔴 Disable Force Join" : "🟢 Enable Force Join", "adm_toggle_fj")],
    [
      Markup.button.callback(s.fake_sales_broadcast_enabled !== false ? "🔴 Sales Off" : "🟢 Sales On", "adm_toggle_fake_sales"),
      Markup.button.callback(s.fake_deposits_broadcast_enabled !== false ? "🔴 Deposits Off" : "🟢 Deposits On", "adm_toggle_fake_deps")
    ],
    [
      Markup.button.callback("🚀 Test Deposit Broadcast", "adm_test_dep_broadcast"),
      Markup.button.callback("🚀 Test Sale Broadcast", "adm_test_sale_broadcast")
    ],
    [Markup.button.callback("✏️ Edit Channel", "adm_set_chan"), Markup.button.callback("✏️ Edit Group", "adm_set_grp")],
    [Markup.button.callback("🟡 Edit Binance Pay ID", "adm_set_binance_pay"), Markup.button.callback("📝 Edit Binance Desc", "adm_set_binance_desc")],
    [Markup.button.callback("✏️ Edit BEP20 USDT", "adm_set_bep20"), Markup.button.callback("✏️ Edit Polygon USDT", "adm_set_polygon")],
    [Markup.button.callback("📝 Edit BEP20 Description", "adm_set_bep20_desc")],
    [Markup.button.callback("✏️ Edit Support", "adm_set_support"), Markup.button.callback("✏️ Edit Min Crypto Dep", "adm_set_min_crypto")],
    [Markup.button.callback("⏱️ Set 1st Deposit Auto-Msg", "adm_set_dep_auto_msg")],
    [Markup.button.callback("📸 Set 2nd Deposit Auto-Msg (Screenshot)", "adm_set_dep_second_msg")],
    [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, buttons);
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
});

bot.action("adm_test_dep_broadcast", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("⏳ Sending test deposit notice to group...");
  const res = await sendGroupDepositNotice();
  if (res && res.success) {
    await ctx.reply(`✅ Test deposit notice sent to group! Message ID: ${res.messageId}`);
  } else {
    await ctx.reply(`❌ Failed to send deposit notice: ${res?.error || "Check group ID or bot admin status"}`);
  }
});

bot.action("adm_test_sale_broadcast", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("⏳ Sending test purchase notice to group...");
  const prod = pickBroadcastProduct();
  const qty = pickBroadcastQuantity();
  const res = await sendGroupPurchaseNotice(prod, qty);
  if (res && res.success) {
    await ctx.reply(`✅ Test purchase notice sent to group! Message ID: ${res.messageId}`);
  } else {
    await ctx.reply(`❌ Failed to send purchase notice: ${res?.error || "Check group ID or bot admin status"}`);
  }
});

bot.action("adm_toggle_fake_sales", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const current = getSetting("fake_sales_broadcast_enabled") !== false;
  setSetting("fake_sales_broadcast_enabled", !current);
  await ctx.reply(`✅ Group Sales Broadcast is now ${!current ? "ENABLED" : "DISABLED"}.`);
});

bot.action("adm_toggle_fake_deps", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const current = getSetting("fake_deposits_broadcast_enabled") !== false;
  setSetting("fake_deposits_broadcast_enabled", !current);
  await ctx.reply(`✅ Group Deposits Broadcast is now ${!current ? "ENABLED" : "DISABLED"}.`);
});

bot.action("adm_toggle_fj", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const current = getSetting("force_join_enabled");
  setSetting("force_join_enabled", !current);
  await ctx.reply(`✅ Force Join is now ${!current ? "ENABLED" : "DISABLED"}.`);
});

bot.action("adm_set_chan", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_channel" };
  await ctx.reply("Enter Channel ID and Link separated by space (e.g. `@mychannel https://t.me/mychannel`):");
});

bot.action("adm_set_grp", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_group" };
  await ctx.reply("Enter Group ID and Link separated by space (e.g. `@mygroup https://t.me/mygroup`):");
});

bot.action("adm_set_binance_pay", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_binance_pay_id" };
  await ctx.reply(
    "🟡 Enter new Binance Pay ID (Binance ID / UID e.g. 123456789):",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:settings")]])
  );
});

bot.action("adm_set_binance_desc", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_binance_desc" };
  const current = getSetting("binance_deposit_desc") || "Default instructions";
  await ctx.reply(
    `📝 <b>Current Binance Pay Deposit Description:</b>\n\n${current}\n\n✍️ Send the new description text below (HTML supported e.g. <b>bold</b>).\n\n💡 Send <code>/default</code> to reset to default instructions, or <code>/cancel</code> to cancel:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:settings")]])
    }
  );
});

bot.action("adm_set_bep20", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_bep20_addr" };
  await ctx.reply("Enter new BEP20 USDT Address (BNB Smart Chain):");
});

bot.action("adm_set_polygon", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_polygon_addr" };
  await ctx.reply("Enter new Polygon USDT Address (MATIC/POL):");
});

bot.action("adm_set_bep20_desc", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_bep20_desc" };
  const current = getSetting("bep20_deposit_desc") || "Default instructions";
  await ctx.reply(
    `📝 <b>Current BEP20 Deposit Description:</b>\n\n${current}\n\n✍️ Send the new description text below (HTML supported e.g. <b>bold</b>).\n\n💡 Send <code>/default</code> to reset to default instructions, or <code>/cancel</code> to cancel:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:settings")]])
    }
  );
});

bot.action("adm_set_support", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_support" };
  await ctx.reply(
    "👤 Enter new Admin Support Telegram username or link (e.g. `@my_support` or `https://t.me/my_support`):",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:settings")]])
  );
});

bot.action("adm_set_min_crypto", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_min_crypto" };
  const current = Number(getSetting("min_crypto_deposit") || 1.00).toFixed(2);
  await ctx.reply(
    `💰 Current Minimum Crypto (BEP20 / Polygon) Deposit: $${current} USDT\n\nEnter new Minimum Deposit amount in USDT (e.g. 1.00 or 2.00):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:settings")]])
  );
});

bot.action("adm_set_dep_auto_msg", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_dep_auto_msg" };
  const current = getSetting("deposit_paid_auto_msg") || "Not set";
  await ctx.reply(
    `⏱️ Current 1st Deposit Auto-Message (1m 30s after 1st screenshot):\n\n${current}\n\n✍️ Send the new 1st auto-message below (or send /cancel to cancel):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]])
  );
});

bot.action("adm_set_dep_second_msg", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_dep_second_msg" };
  const current = getSetting("deposit_second_auto_msg") || "Not set";
  await ctx.reply(
    `📸 Current 2nd Deposit Auto-Message (1m 30s after 2nd screenshot):\n\n${current}\n\n✍️ Send the new 2nd auto-message below (or send /cancel to cancel):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]])
  );
});

// Admin: Broadcast
bot.action("adm:broadcast", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "broadcast" };
  await ctx.reply(
    "📢 Send the message you want to broadcast to all registered active bot users:\n\nSend /cancel to cancel.",
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]])
  );
});

// Admin: Broadcast & Pin New Message to All Users
bot.action("adm:pin_broadcast", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "pin_broadcast" };
  await ctx.reply(
    "📌 <b>PIN NEW MESSAGE TO ALL USERS</b>\n━━━━━━━━━━━━━━━━━━━━\nSend the message you want to broadcast and <b>PIN</b> at the top of every customer's bot chat.\n\n<i>Note: Any old pinned messages in their chat will be automatically unpinned first so only this new message stays pinned. Blocked users are automatically skipped.</i>\n\nSend <code>/cancel</code> to cancel.",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]])
    }
  );
});

// Admin: Remove All Old Pins from All Users (Background Non-Blocking Execution)
async function executeUnpinAllUsers(ctx) {
  const users = getAllUsers();
  const adminChatId = ctx.chat?.id || ADMIN_ID;
  await ctx.reply(`⏳ Removing all old pinned messages from ${users.length} users' chats in the background (bot remains 100% responsive)...`);

  setImmediate(async () => {
    let unpinnedCount = 0;
    let failedCount = 0;

    for (const u of users) {
      try {
        await rawCallApi("unpinAllChatMessages", { chat_id: u.id });
        unpinnedCount++;
      } catch (e) {
        failedCount++;
      }
      await new Promise(resolve => setTimeout(resolve, 35));
    }

    setSetting("pinned_broadcast_text", "");
    bot.telegram.sendMessage(
      adminChatId,
      `🗑️ <b>ALL OLD PINS REMOVED!</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Cleared Pins For: <b>${unpinnedCount}</b> users\n⚠️ Unreachable / Skipped: <b>${failedCount}</b>\n👥 Total Users Checked: <b>${users.length}</b>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📌 Pin a New Message", "adm:pin_broadcast")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      }
    ).catch(() => {});
  });
}

bot.action("adm:unpin_all_users", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery("Removing all old pins...").catch(() => {});
  return executeUnpinAllUsers(ctx);
});

bot.command("unpinall", async (ctx) => {
  if (!adminOnly(ctx)) return;
  return executeUnpinAllUsers(ctx);
});

bot.command("pinall", async (ctx) => {
  if (!adminOnly(ctx)) return;
  const msgText = (ctx.message?.text || "").replace(/^\/pinall(@\S+)?\s*/i, "").trim();
  if (!msgText) {
    ctx.session.adminAction = { type: "pin_broadcast" };
    return ctx.reply(
      "📌 Send the message you want to broadcast and PIN to all active users (or use `/pinall <message>`):\n\nSend /cancel to cancel.",
      Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:menu")]])
    );
  }
  return executePinBroadcastToAllUsers(ctx, msgText);
});

async function executePinBroadcastToAllUsers(ctx, text) {
  const allUsers = getAllUsers();
  const activeUsers = allUsers.filter(u => !u.is_blocked && !isUserBlocked(u.id));
  const blockedSkipped = allUsers.length - activeUsers.length;
  const adminChatId = ctx.chat?.id || ADMIN_ID;

  await ctx.reply(`⏳ Sending & pinning message to ${activeUsers.length} active users in the background (bot remains 100% responsive)...`);

  setImmediate(async () => {
    let sent = 0;
    let pinned = 0;
    let failed = 0;

    for (const u of activeUsers) {
      if (isUserBlocked(u.id)) continue;
      try {
        // 1. Remove any old pinned messages in this user's chat first
        await rawCallApi("unpinAllChatMessages", { chat_id: u.id }).catch(() => {});

        // 2. Send the new message
        const sentMsg = await bot.telegram.sendMessage(
          u.id,
          text,
          Markup.inlineKeyboard([
            [
              Markup.button.callback("🛍️ Buy", "menu:buy"),
              Markup.button.callback("🎫 Open Ticket", "ticket:new")
            ]
          ])
        );
        sent++;

        // 3. Pin the newly sent message
        if (sentMsg && sentMsg.message_id) {
          await rawCallApi("pinChatMessage", {
            chat_id: u.id,
            message_id: sentMsg.message_id,
            disable_notification: false
          });
          pinned++;
        }
      } catch (e) {
        failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 45));
    }

    setSetting("pinned_broadcast_text", text);

    bot.telegram.sendMessage(
      adminChatId,
      `📌 <b>BROADCAST & PIN COMPLETED!</b>\n━━━━━━━━━━━━━━━━━━━━\n✅ Message Sent: <b>${sent}</b>\n📌 Successfully Pinned: <b>${pinned}</b>\n❌ Failed: <b>${failed}</b>\n🚫 Blocked (Skipped): <b>${blockedSkipped}</b>\n👥 Total Active Customers: <b>${activeUsers.length}</b>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🗑️ Remove All Pins", "adm:unpin_all_users")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      }
    ).catch(() => {});
  });
}

// Admin: Channel Auto-Poster Dashboard
bot.action("adm:channel_poster", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const s = getAllSettings();
  const posts = getChannelPosts();
  const currentIndex = Number(s.channel_post_index || 0);
  const isEnabled = s.channel_auto_post_enabled !== false;
  const { timeStr } = getCurrentBSTTime();

  const text = `📢 CHANNEL AUTO-POSTER DASHBOARD
━━━━━━━━━━━━━━━━━━━━━
Status: ${isEnabled ? "🟢 ACTIVE (Auto-posting ON)" : "🔴 DISABLED"}
Target Channel: ${s.channel_id || "⚠️ Not Set"}
Total Library Posts: ${posts.length} unique posts
Current Queue: Post #${currentIndex + 1} of ${posts.length}
Server BST Time: ${timeStr} (UTC+6)

⏰ Scheduled Posting Times (Max 2x Daily):
• Morning: ${s.channel_post_morning_time || "10:00"} BST
• Evening: ${s.channel_post_evening_time || "19:30"} BST
• Last Posted Slot: ${s.channel_last_post_slot || "None"}

Format: Telegram HTML Quote Box (<blockquote>) + [🛒 Buy Now via Bot] button.`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? "🔴 Disable Auto-Poster" : "🟢 Enable Auto-Poster", "adm_toggle_channel_poster")],
    [Markup.button.callback("🚀 Send Test Post Now", "adm_send_channel_post_test")],
    [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, buttons);
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
});

bot.action("adm_toggle_channel_poster", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const s = getAllSettings();
  const current = s.channel_auto_post_enabled !== false;
  setSetting("channel_auto_post_enabled", !current);
  await ctx.reply(`✅ Channel Auto-Poster is now ${!current ? "ENABLED 🟢" : "DISABLED 🔴"}.`);
});

bot.action("adm_send_channel_post_test", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("⏳ Sending next scheduled post from database to channel as a test...");
  const res = await sendChannelScheduledPost();
  if (res.success) {
    await ctx.reply(`✅ Test post sent successfully to ${getAllSettings().channel_id}!\nPost ID: ${res.post.id} (${res.post.category})`);
  } else {
    await ctx.reply(`❌ Failed to send test post: ${res.error || res.reason}`);
  }
});

// =====================================================
// ADMIN: 1-CLICK SAVED PROMO BROADCAST MANAGER (40 READY MESSAGES)
// =====================================================
const PROMO_PAGE_SIZE = 8;

bot.command("promos", async (ctx) => {
  if (!adminOnly(ctx)) return;
  clearAdminConflictingSession(ctx);
  return showAdminPromosMenu(ctx, "all", 0);
});

bot.action(/^adm:promos:([^:]+):(\d+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const cat = ctx.match[1] || "all";
  const page = parseInt(ctx.match[2], 10) || 0;
  return showAdminPromosMenu(ctx, cat, page);
});

async function showAdminPromosMenu(ctx, category = "all", page = 0) {
  const allPromos = getPromoMessages("all");
  const geminiPromos = getPromoMessages("gemini");
  const otherPromos = getPromoMessages("other");
  const list = getPromoMessages(category);

  const pageCount = Math.max(1, Math.ceil(list.length / PROMO_PAGE_SIZE));
  const curPage = Math.min(Math.max(0, page), pageCount - 1);
  const visible = list.slice(curPage * PROMO_PAGE_SIZE, (curPage + 1) * PROMO_PAGE_SIZE);

  const activeUsersCount = getAllUsers().filter(u => !u.is_blocked && !isUserBlocked(u.id)).length;
  const catLabel =
    category === "gemini"
      ? `💎 Gemini Promos (${geminiPromos.length})`
      : category === "other"
      ? `🛍️ Other Products (${otherPromos.length})`
      : `📋 All Saved Promos (${allPromos.length})`;

  let text = `🎯 <b>1-CLICK SAVED PROMO BROADCASTS</b>
━━━━━━━━━━━━━━━━━━━━
📂 <b>Filter:</b> ${catLabel} — Page ${curPage + 1}/${pageCount}
👥 <b>Active Target Users:</b> <b>${activeUsersCount}</b> customers

💡 <b>How to use in 1 Click:</b>
• Tap <b>"🚀 Send"</b> next to any promo below to broadcast it to all ${activeUsersCount} users immediately in 1 click!
• Or tap a promo's title to <b>Preview, Send & Pin, Post to Channel, or Edit</b> it!
• Or use the top <b>⚡ Auto-Rotate 1-Click</b> buttons to send the next promo automatically:`;

  const rows = [
    [
      Markup.button.callback("⚡ 1-Click Send Next Gemini Promo", "adm:promo_quick:gemini"),
      Markup.button.callback("⚡ 1-Click Send Next All-Store Promo", "adm:promo_quick:all")
    ],
    [
      Markup.button.callback(
        `${category === "all" ? "✅ " : ""}📋 All (${allPromos.length})`,
        "adm:promos:all:0"
      ),
      Markup.button.callback(
        `${category === "gemini" ? "✅ " : ""}💎 Gemini (${geminiPromos.length})`,
        "adm:promos:gemini:0"
      ),
      Markup.button.callback(
        `${category === "other" ? "✅ " : ""}🛍️ Others (${otherPromos.length})`,
        "adm:promos:other:0"
      )
    ]
  ];

  visible.forEach((p, idx) => {
    const globalIdx = curPage * PROMO_PAGE_SIZE + idx + 1;
    const shortTitle = safeLabelSlice(p.title || `Promo #${globalIdx}`, 28);
    rows.push([
      Markup.button.callback(`${globalIdx}. ${shortTitle}`, `adm:promo_view:${p.id}:${category}:${curPage}`),
      Markup.button.callback("🚀 Send 1-Click", `adm:promo_send:${p.id}`)
    ]);
  });

  const navRow = [];
  if (curPage > 0) {
    navRow.push(Markup.button.callback("⬅️ Prev Page", `adm:promos:${category}:${curPage - 1}`));
  }
  if (curPage < pageCount - 1) {
    navRow.push(Markup.button.callback("Next Page ➡️", `adm:promos:${category}:${curPage + 1}`));
  }
  if (navRow.length > 0) rows.push(navRow);

  rows.push([
    Markup.button.callback("➕ Add New Saved Promo", "adm:promo_add"),
    Markup.button.callback("🔙 Admin Menu", "adm:menu")
  ]);

  const markup = Markup.inlineKeyboard(rows);
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...markup });
    } catch (_) {}
  }
  return ctx.reply(text, { parse_mode: "HTML", ...markup });
}

// View single saved promo + 1-click actions (Send, Send & Pin, Send to Channel, Edit)
bot.action(/^adm:promo_view:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const promoId = ctx.match[1];
  const category = ctx.match[2] || "all";
  const page = parseInt(ctx.match[3], 10) || 0;
  return showAdminPromoDetail(ctx, promoId, category, page);
});

async function showAdminPromoDetail(ctx, promoId, category = "all", page = 0) {
  const promo = getPromoMessage(promoId);
  if (!promo) {
    return ctx.reply("❌ Promo message not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Back to Promos", "adm:promos:all:0")]]));
  }

  const activeUsersCount = getAllUsers().filter(u => !u.is_blocked && !isUserBlocked(u.id)).length;
  const catBadge = promo.category === "gemini" ? "💎 Gemini Promo" : "🛍️ Store / Multi-Product Promo";

  const text = `🎯 <b>SAVED PROMO PREVIEW</b>
━━━━━━━━━━━━━━━━━━━━
🏷️ <b>Title:</b> <b>${escapeHtml(promo.title)}</b>
📂 <b>Category:</b> ${catBadge}
👥 <b>Target Audience:</b> <b>${activeUsersCount}</b> active bot users

📋 <b>Message Preview (Exactly how users will see it):</b>
━━━━━━━━━━━━━━━━━━━━
${promo.content}
━━━━━━━━━━━━━━━━━━━━
👇 <b>Choose a 1-Click Action below:</b>`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`🚀 1-Click Send to All Users (${activeUsersCount})`, `adm:promo_send:${promo.id}`)],
    [Markup.button.callback(`📌 1-Click Send & PIN to All Users`, `adm:promo_pin:${promo.id}`)],
    [Markup.button.callback("📢 1-Click Post to Channel", `adm:promo_channel:${promo.id}`)],
    [
      Markup.button.callback("📝 Edit Promo Text", `adm:promo_edit_text:${promo.id}`),
      Markup.button.callback("✏️ Edit Title", `adm:promo_edit_title:${promo.id}`)
    ],
    [
      Markup.button.callback("🔙 Back to Promo List", `adm:promos:${category}:${page}`),
      Markup.button.callback("🏠 Admin Menu", "adm:menu")
    ]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (_) {}
  }
  return ctx.reply(text, { parse_mode: "HTML", ...buttons });
}

// Helper to broadcast a saved promo message to all active users (with or without pinning)
async function executeSavedPromoBroadcast(ctx, promo, shouldPin = false) {
  const allUsers = getAllUsers();
  const activeUsers = allUsers.filter(u => !u.is_blocked && !isUserBlocked(u.id));
  const blockedSkipped = allUsers.length - activeUsers.length;
  const adminChatId = ctx.chat?.id || ADMIN_ID;

  const actionLabel = shouldPin ? "Sending & PINNING" : "Broadcasting";
  await ctx.reply(
    `⏳ <b>${actionLabel} Promo:</b> <b>${escapeHtml(promo.title)}</b>\n` +
    `👥 Sending to <b>${activeUsers.length}</b> active users in the background (bot remains 100% smooth & responsive)...`,
    { parse_mode: "HTML" }
  );

  const userInlineKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🛍️ Buy Now", "menu:buy"),
      Markup.button.callback("💎 Gemini $0.30", "grp:Gemini")
    ],
    [
      Markup.button.callback("💳 Deposit Funds", "deposit:start"),
      Markup.button.callback("🎫 Support", "ticket:new")
    ]
  ]);

  setImmediate(async () => {
    let sent = 0;
    let pinned = 0;
    let failed = 0;

    for (const u of activeUsers) {
      if (isUserBlocked(u.id)) continue;
      try {
        if (shouldPin) {
          await rawCallApi("unpinAllChatMessages", { chat_id: u.id }).catch(() => {});
        }
        let sentMsg;
        try {
          sentMsg = await bot.telegram.sendMessage(u.id, promo.content, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...userInlineKeyboard
          });
        } catch (htmlErr) {
          sentMsg = await bot.telegram.sendMessage(u.id, promo.content.replace(/<[^>]+>/g, ""), userInlineKeyboard);
        }
        sent++;

        if (shouldPin && sentMsg && sentMsg.message_id) {
          await rawCallApi("pinChatMessage", {
            chat_id: u.id,
            message_id: sentMsg.message_id,
            disable_notification: false
          }).catch(() => {});
          pinned++;
        }
      } catch (e) {
        failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }

    if (shouldPin) {
      setSetting("pinned_broadcast_text", promo.content);
    }

    bot.telegram.sendMessage(
      adminChatId,
      `✅ <b>1-CLICK PROMO ${shouldPin ? "BROADCAST & PIN " : ""}COMPLETED!</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
      `🏷️ <b>Promo:</b> ${escapeHtml(promo.title)}\n` +
      `📨 <b>Delivered:</b> <b>${sent}</b> users` +
      (shouldPin ? `\n📌 <b>Pinned:</b> <b>${pinned}</b> chats` : "") +
      `\n❌ <b>Failed/Unreachable:</b> <b>${failed}</b>\n` +
      `🚫 <b>Blocked (Skipped):</b> <b>${blockedSkipped}</b>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🎯 Send Another Saved Promo", "adm:promos:all:0")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      }
    ).catch(() => {});
  });
}

// 1-Click Send Saved Promo to All Users
bot.action(/^adm:promo_send:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const promo = getPromoMessage(ctx.match[1]);
  if (!promo) return ctx.answerCbQuery("❌ Promo not found.", { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery(`🚀 Broadcasting: ${promo.title}`).catch(() => {});
  return executeSavedPromoBroadcast(ctx, promo, false);
});

// 1-Click Send & Pin Saved Promo to All Users
bot.action(/^adm:promo_pin:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const promo = getPromoMessage(ctx.match[1]);
  if (!promo) return ctx.answerCbQuery("❌ Promo not found.", { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery(`📌 Broadcasting & Pinning: ${promo.title}`).catch(() => {});
  return executeSavedPromoBroadcast(ctx, promo, true);
});

// 1-Click Quick Auto-Rotate Send (Next Gemini Promo or Next Store Promo)
bot.action(/^adm:promo_quick:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const cat = ctx.match[1] === "gemini" ? "gemini" : null;
  const nextInfo = getNextPromoMessage(cat);
  if (!nextInfo || !nextInfo.promo) {
    return ctx.answerCbQuery("❌ No saved promo messages found.", { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery(`⚡ Sending #${nextInfo.index}/${nextInfo.total}: ${nextInfo.promo.title}`).catch(() => {});
  return executeSavedPromoBroadcast(ctx, nextInfo.promo, false);
});

// 1-Click Post Saved Promo to Official Channel
bot.action(/^adm:promo_channel:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const promo = getPromoMessage(ctx.match[1]);
  if (!promo) return ctx.answerCbQuery("❌ Promo not found.", { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery("📢 Posting promo to channel...").catch(() => {});
  const res = await sendChannelScheduledPost({
    id: promo.id,
    category: promo.category,
    content: promo.content
  });
  if (res.success) {
    return ctx.reply(
      `✅ <b>Promo posted to Channel (${escapeHtml(getAllSettings().channel_id)})!</b>\n🏷️ <b>Promo:</b> ${escapeHtml(promo.title)}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Back to Promo", `adm:promo_view:${promo.id}:all:0`)],
          [Markup.button.callback("🎯 All Saved Promos", "adm:promos:all:0")]
        ])
      }
    );
  }
  return ctx.reply(`❌ Could not post to channel: ${res.error || res.reason}`);
});

// Edit Saved Promo Text (with Typing Box Pre-fill!)
bot.action(/^adm:promo_edit_text:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const promo = getPromoMessage(ctx.match[1]);
  if (!promo) return ctx.reply("❌ Promo not found.");

  ctx.session.adminAction = { type: "edit_promo_text", promoId: promo.id };
  const plainCurrent = String(promo.content || "").trim();
  const prefill = utf8ByteSlice(plainCurrent, 250);

  await ctx.reply(
    `📝 <b>Edit Saved Promo Message — ${escapeHtml(promo.title)}</b>\n\n` +
    `📋 <b>Current Content (Tap to Copy):</b>\n<code>${escapeHtml(plainCurrent)}</code>\n\n` +
    `💡 নিচের <b>"📲 Load Promo in Typing Box"</b> বাটনে চাপ দিলে আগের লেখাটি সরাসরি আপনার টাইপিং বক্সে চলে আসবে—যতটুকু দরকার এডিট করে Send করুন:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📲 Load Promo in Typing Box", switch_inline_query_current_chat: prefill }],
          [{ text: "❌ Cancel", callback_data: `adm:promo_view:${promo.id}:all:0` }]
        ]
      }
    }
  );
});

// Edit Saved Promo Title
bot.action(/^adm:promo_edit_title:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const promo = getPromoMessage(ctx.match[1]);
  if (!promo) return ctx.reply("❌ Promo not found.");

  ctx.session.adminAction = { type: "edit_promo_title", promoId: promo.id };
  const prefillTitle = utf8ByteSlice(promo.title || "", 240);

  await ctx.reply(
    `✏️ <b>Edit Promo Title</b>\n\nCurrent Title: <code>${escapeHtml(promo.title)}</code>\n\nSend the new title below:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📲 Load Current Title in Typing Box", switch_inline_query_current_chat: prefillTitle }],
          [{ text: "❌ Cancel", callback_data: `adm:promo_view:${promo.id}:all:0` }]
        ]
      }
    }
  );
});

// Add New Saved Promo Message
bot.action("adm:promo_add", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "add_new_promo" };
  await ctx.reply(
    `➕ <b>ADD NEW SAVED PROMO MESSAGE</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Send the promotional message you want to save to the 1-Click Promo Library.\n` +
    `• First line will be used as the short button title (or everything as the promo body).\n` +
    `• HTML tags like <code>&lt;b&gt;bold&lt;/b&gt;</code> and emojis are supported!\n\nSend <code>/cancel</code> to cancel.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:promos:all:0")]])
    }
  );
});

// Handle admin text inputs
async function handleAdminTextInput(ctx, rawText) {
  const action = ctx.session.adminAction;
  ctx.session.adminAction = null;
  const text = stripLeadingBotMention(rawText);

  switch (action.type) {
    case "set_name": {
      const p = getProduct(action.productId);
      if (!p) return ctx.reply("❌ Product not found.");
      const newName = text.trim();
      if (newName.length < 2) return ctx.reply("❌ Name is too short.");
      updateProduct(action.productId, { name: newName });
      return ctx.reply(
        `✅ <b>Product Name updated to:</b> <b>${escapeHtml(newName)}</b>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "set_price": {
      const price = parseFloat(text.replace("$", "").trim());
      if (isNaN(price) || price <= 0) return ctx.reply("❌ Invalid price number. Please enter a valid positive number.");
      const updatedPrice = Number(price.toFixed(2));
      const p = getProduct(action.productId);
      const bulkTiers = buildBulkTiers(updatedPrice);
      updateProduct(action.productId, { price: updatedPrice, bulk_tiers: bulkTiers });
      return ctx.reply(
        `✅ <b>Updated price of ${p ? escapeHtml(p.name) : action.productId} to $${updatedPrice.toFixed(2)} (${money(updatedPrice)})</b>\n🔥 <i>Progressive bulk discounts (5+ = 10% OFF up to 30% OFF) updated automatically!</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "set_desc": {
      const p = getProduct(action.productId);
      if (!p) return ctx.reply("❌ Product not found.");
      const cleaned = text.trim();
      let updatedDesc = cleaned;

      // Support single-line edit (e.g. "L2: new line text") so other lines stay untouched
      const lineMatch = cleaned.match(/^L(\d+)\s*:\s*([\s\S]*)$/i);
      const addMatch = cleaned.match(/^ADD\s*:\s*([\s\S]*)$/i);
      if (lineMatch) {
        const lineIndex = parseInt(lineMatch[1], 10) - 1;
        const replacementLine = lineMatch[2].trim();
        const existingLines = String(p.description || "").trim().split("\n").filter((l) => l.trim().length > 0);
        if (lineIndex >= 0 && lineIndex < existingLines.length) {
          if (replacementLine) {
            existingLines[lineIndex] = replacementLine;
          } else {
            existingLines.splice(lineIndex, 1);
          }
          updatedDesc = existingLines.join("\n");
        }
      } else if (addMatch) {
        const newLine = addMatch[1].trim();
        const existing = String(p.description || "").trim();
        updatedDesc = newLine ? (existing ? `${existing}\n${newLine}` : newLine) : existing;
      }

      updateProduct(action.productId, { description: updatedDesc });
      return ctx.reply(
        `✅ <b>Description updated for ${escapeHtml(p.name)}!</b>\n\n📝 <b>Updated Description:</b>\n${escapeHtml(updatedDesc)}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📝 Edit Description Again", `adm_set_desc:${action.productId}`)],
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "set_terms": {
      const p = getProduct(action.productId);
      if (!p) return ctx.reply("❌ Product not found.");
      updateProduct(action.productId, { terms: text.trim() });
      return ctx.reply(
        `✅ <b>Terms of Service updated for ${escapeHtml(p.name)}!</b>\n\n📜 <b>New Terms:</b>\n${escapeHtml(text.trim())}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "set_group_name": {
      const p = getProduct(action.productId);
      if (!p) return ctx.reply("❌ Product not found.");
      const rawGroup = text.trim();
      const newGroup = rawGroup.toLowerCase() === "none" ? "" : rawGroup;
      updateProduct(action.productId, { group: newGroup || undefined });
      return ctx.reply(
        `✅ <b>Group updated for ${escapeHtml(p.name)}!</b>\nNew Group: <b>${escapeHtml(newGroup || "None (Single Product)")}</b>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "set_stock": {
      const stock = parseInt(text, 10);
      if (isNaN(stock) || stock < 0) return ctx.reply("❌ Invalid stock number.");
      const p = getProduct(action.productId);
      updateProduct(action.productId, { stock, outOfStock: stock <= 0 });
      return ctx.reply(
        `✅ <b>Updated stock of ${p ? escapeHtml(p.name) : action.productId} to ${stock}</b>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "add_codes": {
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return ctx.reply("❌ No valid codes provided.");
      const p = addProductCodes(action.productId, lines);
      return ctx.reply(
        `✅ <b>Added ${lines.length} digital codes/links to ${escapeHtml(p.name)}!</b>\nNew Stock: <b>${p.stock}</b>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)],
            [Markup.button.callback("🛍️ All Products", "adm:products")]
          ])
        }
      );
    }
    case "user_bal_prompt": {
      const [userId, deltaStr] = text.split(/\s+/);
      const delta = parseFloat(deltaStr);
      if (!userId || isNaN(delta)) {
        return ctx.reply("❌ Format: `<telegram_id> <amount>` (e.g. `123456789 10`)");
      }
      const newBal = adjustUserBalance(userId, delta);
      if (newBal === false) {
        return ctx.reply("❌ User not found in database.");
      }
      return ctx.reply(`✅ User ${userId} balance updated! New balance: ${money(newBal)}`);
    }
    case "set_channel": {
      const parts = text.split(/\s+/);
      let cId = parts[0];
      let cLink = parts[1];

      if (cLink && cLink.includes("t.me/")) {
        const username = cLink.split("t.me/")[1].replace("/", "").trim();
        if (username) cId = "@" + username.replace("@", "");
      } else if (cId.startsWith("https://t.me/")) {
        cLink = cId;
        cId = "@" + cId.replace("https://t.me/", "").replace("/", "").trim();
      } else if (cId.startsWith("@")) {
        if (!cLink) cLink = `https://t.me/${cId.replace("@", "")}`;
      } else if (!cLink) {
        cLink = `https://t.me/${cId.replace("@", "")}`;
        cId = "@" + cId.replace("@", "");
      }

      setSetting("channel_id", cId);
      setSetting("channel_link", cLink);
      return ctx.reply(`✅ Channel successfully set:\n• ID: ${cId}\n• Link: ${cLink}`);
    }
    case "set_group": {
      const parts = text.split(/\s+/);
      let gId = parts[0];
      let gLink = parts[1];

      if (gLink && gLink.includes("t.me/")) {
        const username = gLink.split("t.me/")[1].replace("/", "").trim();
        if (username) gId = "@" + username.replace("@", "");
      } else if (gId.startsWith("https://t.me/")) {
        gLink = gId;
        gId = "@" + gId.replace("https://t.me/", "").replace("/", "").trim();
      } else if (gId.startsWith("@")) {
        if (!gLink) gLink = `https://t.me/${gId.replace("@", "")}`;
      } else if (!gLink) {
        gLink = `https://t.me/${gId.replace("@", "")}`;
        gId = "@" + gId.replace("@", "");
      }

      setSetting("group_id", gId);
      setSetting("group_link", gLink);
      return ctx.reply(`✅ Group successfully set:\n• ID: ${gId}\n• Link: ${gLink}`);
    }
    case "set_binance_pay_id": {
      setSetting("binance_pay_id", text.trim());
      return ctx.reply(
        `✅ Binance Pay ID updated to:\n<code>${text.trim()}</code>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Back to Settings", "adm:settings")]])
        }
      );
    }
    case "set_binance_desc": {
      if (text.trim() === "/default") {
        setSetting("binance_deposit_desc", "");
        return ctx.reply(
          "✅ Binance Pay Deposit Description reset to default!",
          Markup.inlineKeyboard([
            [Markup.button.callback("⚙️ Settings", "adm:settings")],
            [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
          ])
        );
      }
      setSetting("binance_deposit_desc", text.trim());
      try {
        return await ctx.reply(
          `✅ <b>Binance Pay Deposit Description updated successfully!</b>\n\n<b>Preview:</b>\n${text.trim()}`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("⚙️ Settings", "adm:settings")],
              [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
            ])
          }
        );
      } catch (err) {
        return await ctx.reply(
          `✅ Binance Pay Deposit Description updated successfully!\n\nPreview:\n${text.trim()}`,
          Markup.inlineKeyboard([
            [Markup.button.callback("⚙️ Settings", "adm:settings")],
            [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
          ])
        );
      }
    }
    case "set_bep20_addr": {
      setSetting("bep20_usdt_address", text.trim());
      return ctx.reply(`✅ BEP20 USDT Address updated to:\n<code>${text.trim()}</code>`, { parse_mode: "HTML" });
    }
    case "set_polygon_addr": {
      setSetting("polygon_usdt_address", text.trim());
      return ctx.reply(`✅ Polygon USDT Address updated to:\n<code>${text.trim()}</code>`, { parse_mode: "HTML" });
    }
    case "set_usdt_addr": {
      setSetting("bep20_usdt_address", text.trim());
      setSetting("polygon_usdt_address", text.trim());
      return ctx.reply(`✅ Both USDT Addresses updated to:\n<code>${text.trim()}</code>`, { parse_mode: "HTML" });
    }
    case "set_support": {
      let raw = text.trim();
      if (raw.includes("t.me/")) {
        raw = raw.split("t.me/")[1].replace("/", "").trim();
      }
      raw = raw.replace("@", "").trim();
      if (!raw) {
        return ctx.reply("❌ Invalid support username. Please enter a valid Telegram username.");
      }
      const username = "@" + raw;
      setSetting("support_username", username);
      return ctx.reply(
        `✅ Support Username updated successfully to: <b>${username}</b>\nLink: https://t.me/${raw}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Back to Settings", "adm:settings")]])
        }
      );
    }
    case "set_min_crypto": {
      const minAmt = parseFloat(text.replace("$", "").trim());
      if (isNaN(minAmt) || minAmt <= 0) {
        return ctx.reply("❌ Invalid amount. Please enter a positive number (e.g. 1.00 or 2.00).");
      }
      const cleanAmt = Number(minAmt.toFixed(2));
      setSetting("min_crypto_deposit", cleanAmt);
      return ctx.reply(
        `✅ <b>Minimum Crypto (BEP20 / Polygon) Deposit</b> updated to <b>$${cleanAmt.toFixed(2)} USDT</b>!`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Back to Settings", "adm:settings")]])
        }
      );
    }
    case "set_bep20_desc": {
      if (text.trim() === "/default") {
        setSetting("bep20_deposit_desc", "");
        return ctx.reply(
          "✅ BEP20 Deposit Description reset to default!",
          Markup.inlineKeyboard([
            [Markup.button.callback("⚙️ Settings", "adm:settings")],
            [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
          ])
        );
      }
      setSetting("bep20_deposit_desc", text.trim());
      try {
        return await ctx.reply(
          `✅ <b>BEP20 Deposit Description updated successfully!</b>\n\n<b>Preview:</b>\n${text.trim()}`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("⚙️ Settings", "adm:settings")],
              [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
            ])
          }
        );
      } catch (err) {
        return await ctx.reply(
          `✅ BEP20 Deposit Description updated successfully!\n\nPreview:\n${text.trim()}`,
          Markup.inlineKeyboard([
            [Markup.button.callback("⚙️ Settings", "adm:settings")],
            [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
          ])
        );
      }
    }
    case "set_dep_auto_msg": {
      setSetting("deposit_paid_auto_msg", text.trim());
      return ctx.reply(
        `✅ 1st Deposit Auto-Message (1m 30s) updated successfully!\n\nNew Message:\n${text.trim()}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("⚙️ Settings", "adm:settings")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      );
    }
    case "set_dep_second_msg": {
      setSetting("deposit_second_auto_msg", text.trim());
      return ctx.reply(
        `✅ 2nd Deposit Auto-Message (Screenshot) updated successfully!\n\nNew Message:\n${text.trim()}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("⚙️ Settings", "adm:settings")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      );
    }
    case "ticket_reply": {
      const ticket = addTicketMessage(action.ticketId, "admin", text.trim());
      if (!ticket) {
        return ctx.reply("❌ Ticket not found.", Markup.inlineKeyboard([[Markup.button.callback("🎫 Tickets List", "adm:tickets")]]));
      }
      try {
        await bot.telegram.sendMessage(
          ticket.user_id,
          `🔔 <b>SUPPORT TICKET UPDATE (#${ticket.id})</b>\n━━━━━━━━━━━━━━━━━━━━\n📂 <b>Category:</b> ${escapeHtml(ticket.category)}${ticket.order_code ? `\n📦 <b>Order Code:</b> <code>${escapeHtml(ticket.order_code)}</code>` : ""}\n\n👨‍💻 <b>Support Team Reply:</b>\n${escapeHtml(text.trim())}`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(`↩️ Reply (#${ticket.id})`, `ticket:reply:${ticket.id}`),
                Markup.button.callback("✅ Mark Resolved", `ticket:close:${ticket.id}`)
              ],
              [Markup.button.callback(`📂 View Ticket #${ticket.id}`, `ticket:view:${ticket.id}`)]
            ])
          }
        );
        return ctx.reply(
          `✅ Reply sent to Customer on Ticket <b>#${ticket.id}</b>!`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback(`📂 View Ticket #${ticket.id}`, `adm_tkt_view:${ticket.id}`)],
              [Markup.button.callback("🎫 All Tickets", "adm:tickets")],
              [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
            ])
          }
        );
      } catch (e) {
        return ctx.reply(
          `⚠️ Reply saved to Ticket #${ticket.id}, but could not deliver notification to customer (${e.message || "blocked bot"}).`,
          Markup.inlineKeyboard([[Markup.button.callback("🎫 All Tickets", "adm:tickets")]])
        );
      }
    }
    case "block_by_id_prompt": {
      const query = text.trim().split(/\s+/)[0];
      const matched = findUserByIdOrUsername(query);
      const targetId = matched ? String(matched.id) : (/^\d+$/.test(query) ? query : null);
      if (!targetId) {
        return ctx.reply(
          "❌ Invalid user or Telegram ID not found. Please enter a numeric Telegram ID (e.g. `123456789`) or a registered `@username`.",
          Markup.inlineKeyboard([[Markup.button.callback("🔙 Blocked Users Menu", "adm:blocked_menu")]])
        );
      }
      if (targetId === ADMIN_ID) {
        return ctx.reply("❌ Cannot block the admin account.");
      }
      await ctx.reply(`⏳ Blocking user ${targetId} and deleting all previously sent messages from their chat...`);
      const { user, deletedCount } = await blockUserAndPurge(targetId);
      const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;
      return ctx.reply(
        `🚫 User Blocked & Messages Removed!\n\n👤 User: ${name} (ID: ${targetId})\n🗑️ Previous Bot Messages Removed: ${deletedCount}\n🔇 They will no longer receive any text, updates, or broadcast messages, and will get no replies from the bot.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${targetId}`)],
          [Markup.button.callback("🚫 Blocked Users Menu", "adm:blocked_menu")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      );
    }
    case "unblock_by_id_prompt": {
      const query = text.trim().split(/\s+/)[0];
      const matched = findUserByIdOrUsername(query);
      const targetId = matched ? String(matched.id) : (/^\d+$/.test(query) ? query : null);
      if (!targetId) {
        return ctx.reply(
          "❌ Invalid user or Telegram ID not found. Please enter a numeric Telegram ID (e.g. `123456789`) or a registered `@username`.",
          Markup.inlineKeyboard([[Markup.button.callback("🔙 Blocked Users Menu", "adm:blocked_menu")]])
        );
      }
      const user = setUserBlocked(targetId, false);
      const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;
      return ctx.reply(
        `🟢 User Unblocked Successfully!\n\n👤 User: ${name} (ID: ${targetId})\n✅ Status: Active again.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🚫 Blocked Users Menu", "adm:blocked_menu")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ])
      );
    }
    case "msg_by_id_prompt": {
      const parts = text.trim().split(/\s+/);
      const targetId = parts[0].trim();
      if (!/^\d+$/.test(targetId)) {
        return ctx.reply("❌ Invalid Telegram ID. Please enter a numeric Telegram ID (e.g. 123456789).");
      }
      if (isUserBlocked(targetId)) {
        return ctx.reply(
          `🚫 User ${targetId} is BLOCKED. No message can be sent to a blocked user.\nUnblock them first if you want to send a message.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${targetId}`)],
            [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
          ])
        );
      }
      const inlineMsg = parts.slice(1).join(" ").trim();
      if (!inlineMsg) {
        const user = getUser(targetId);
        const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || targetId) : targetId;
        ctx.session.adminAction = { type: "customer_message", userId: targetId };
        return ctx.reply(`✉️ Write the message for ${name} (ID: ${targetId}).\n\nSend /cancel to cancel.`);
      }
      try {
        await bot.telegram.sendMessage(targetId, inlineMsg, Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Reply to Admin", "customer:direct_reply")],
          [
            Markup.button.callback("🎫 Open Ticket", "ticket:new"),
            Markup.button.callback("🛍️ Buy", "menu:buy")
          ]
        ]));
        return ctx.reply(`✅ Message sent to Telegram ID ${targetId}.`, Markup.inlineKeyboard([
          [Markup.button.callback("🆔 Message Another ID", "adm:msg_by_id")],
          [Markup.button.callback("👥 Back to Customers", "adm:customers:0")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ]));
      } catch (e) {
        return ctx.reply(`❌ Could not message Telegram ID ${targetId}. They may have blocked the bot or never started it.\nReason: ${e.description || e.message || "Telegram API error"}`);
      }
    }
    case "customer_message": {
      const targetId = String(action.userId);
      if (isUserBlocked(targetId)) {
        return ctx.reply(
          `🚫 Customer ${targetId} is BLOCKED. Message was not sent.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${targetId}`)],
            [Markup.button.callback("🔙 Customers", "adm:customers:0")]
          ])
        );
      }
      const user = getUser(targetId);
      const displayName = user ? (user.first_name || targetId) : targetId;
      try {
        await bot.telegram.sendMessage(targetId, text, Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Reply to Admin", "customer:direct_reply")],
          [
            Markup.button.callback("🎫 Open Ticket", "ticket:new"),
            Markup.button.callback("🛍️ Buy", "menu:buy")
          ]
        ]));
        return ctx.reply(`✅ Message sent to ${displayName} (ID: ${targetId}).`, Markup.inlineKeyboard([
          [Markup.button.callback("✉️ Send Another Message", `adm:customer_msg:${targetId}`)],
          [Markup.button.callback("👥 Back to Customers", "adm:customers:0")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ]));
      } catch (e) {
        return ctx.reply(`❌ Could not message customer ${targetId}. They may have blocked the bot or never started it.\nReason: ${e.description || e.message || "Telegram API error"}`);
      }
    }
    case "customer_reply": {
      const targetId = String(action.userId);
      if (isUserBlocked(targetId)) {
        return ctx.reply(
          `🚫 Customer ${targetId} is BLOCKED. Reply was not sent.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("🟢 Unblock User", `adm:unblock_user:${targetId}`)],
            [Markup.button.callback("🔙 Customers", "adm:customers:0")]
          ])
        );
      }
      const user = getUser(targetId);
      const displayName = user ? (user.first_name || targetId) : targetId;
      try {
        await bot.telegram.sendMessage(targetId, text, Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Reply to Admin", "customer:direct_reply")],
          [
            Markup.button.callback("🎫 Open Ticket", "ticket:new"),
            Markup.button.callback("🛍️ Buy", "menu:buy")
          ]
        ]));
        return ctx.reply(`✅ Reply sent to ${displayName} (ID: ${targetId}).`, Markup.inlineKeyboard([
          [Markup.button.callback("✉️ Send Another Message", `adm:customer_msg:${targetId}`)],
          [Markup.button.callback("👥 Back to Customers", "adm:customers:0")],
          [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
        ]));
      } catch (e) {
        return ctx.reply(`❌ Could not reply to customer ${targetId}. They may have blocked the bot.\nReason: ${e.description || e.message || "Telegram API error"}`);
      }
    }
    case "broadcast": {
      const allUsers = getAllUsers();
      const activeUsers = allUsers.filter(u => !u.is_blocked && !isUserBlocked(u.id));
      const blockedSkipped = allUsers.length - activeUsers.length;
      const adminChatId = ctx.chat?.id || ADMIN_ID;

      await ctx.reply(`⏳ Broadcasting message to ${activeUsers.length} active customers in the background (bot remains 100% responsive)...`);

      setImmediate(async () => {
        let sent = 0;
        let failed = 0;
        for (const u of activeUsers) {
          if (isUserBlocked(u.id)) continue;
          try {
            await bot.telegram.sendMessage(u.id, text, Markup.inlineKeyboard([
              [
                Markup.button.callback("🎫 Open Ticket", "ticket:new"),
                Markup.button.callback("🛍️ Buy", "menu:buy")
              ]
            ]));
            sent++;
          } catch (e) {
            failed++;
          }
          // Keep broadcast traffic below Telegram's usual per-chat delivery limits.
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        bot.telegram.sendMessage(
          adminChatId,
          `📢 Broadcast completed.\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n🚫 Blocked (Skipped): ${blockedSkipped}\n👥 Total active customers: ${activeUsers.length}`
        ).catch(() => {});
      });
      return;
    }
    case "pin_broadcast": {
      return executePinBroadcastToAllUsers(ctx, text);
    }
    case "edit_promo_text": {
      const updated = updatePromoMessage(action.promoId, { content: text.trim() });
      if (!updated) return ctx.reply("❌ Promo message not found.");
      return showAdminPromoDetail(ctx, updated.id, "all", 0);
    }
    case "edit_promo_title": {
      const updated = updatePromoMessage(action.promoId, { title: text.trim() });
      if (!updated) return ctx.reply("❌ Promo message not found.");
      return showAdminPromoDetail(ctx, updated.id, "all", 0);
    }
    case "add_new_promo": {
      const cleaned = text.trim();
      const firstLine = cleaned.split("\n")[0].replace(/<[^>]+>/g, "").trim() || "Custom Promo";
      const isGemini = /gemini/i.test(cleaned);
      const created = addPromoMessage({
        category: isGemini ? "gemini" : "other",
        title: firstLine.slice(0, 45),
        content: cleaned
      });
      return showAdminPromoDetail(ctx, created.id, "all", 0);
    }
    default:
      return ctx.reply("Unknown action.");
  }
}

// =====================================================
// REST API FOR DEVELOPERS (/api)
// =====================================================
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Gemini AI Shop Telegram Bot is running!");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// GET /api/products
app.get("/api/products", (req, res) => {
  const products = getProducts().map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock,
    outOfStock: p.outOfStock,
    bulk_tiers: p.bulk_tiers
  }));
  res.status(200).json({ ok: true, products });
});

// POST /api/order
app.post("/api/order", (req, res) => {
  const apiKey = req.headers["x-api-key"] || req.query.api_key;
  if (!apiKey) return res.status(401).json({ ok: false, error: "Missing x-api-key header" });

  const user = getUserByApiKey(apiKey);
  if (!user) return res.status(403).json({ ok: false, error: "Invalid API key" });
  if (user.is_blocked || isUserBlocked(user.id)) {
    return res.status(403).json({ ok: false, error: "User is blocked" });
  }

  const { product_id, quantity } = req.body;
  const p = getProduct(product_id);
  if (!p) return res.status(404).json({ ok: false, error: "Product not found" });

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  if (p.outOfStock || p.stock < qty) {
    return res.status(400).json({ ok: false, error: "Insufficient stock" });
  }

  const { unitPrice, totalPrice } = calculateProductPrice(p, qty);
  if ((user.wallet_balance || 0) < totalPrice) {
    return res.status(402).json({
      ok: false,
      error: "Insufficient balance",
      balance: user.wallet_balance,
      needed: totalPrice
    });
  }

  // Deduct balance and dispense
  adjustUserBalance(user.id, -totalPrice);
  const dispensed = dispenseProductCodes(p.id, qty);
  const order = createOrder({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    product_id: p.id,
    product_name: p.name,
    quantity: qty,
    unit_price: unitPrice,
    total_price: totalPrice,
    delivered_codes: dispensed,
    status: "completed"
  });

  res.status(200).json({ ok: true, order });
});

// =====================================================
// AUTOMATIC GROUP PURCHASE BROADCASTER (1 - 10 MINS)
// =====================================================
const GLOBAL_TIMEZONES = [
  { code: "IST", offsetHours: 5.5 },   // India
  { code: "BST", offsetHours: 6.0 },   // Bangladesh
  { code: "UTC", offsetHours: 0.0 },   // Universal UTC
  { code: "EST", offsetHours: -4.0 },  // US Eastern
  { code: "PST", offsetHours: -7.0 },  // US Pacific
  { code: "GMT", offsetHours: 1.0 },   // UK / London
  { code: "CET", offsetHours: 2.0 },   // Central Europe
  { code: "GST", offsetHours: 4.0 },   // Dubai / UAE
  { code: "SGT", offsetHours: 8.0 }    // Singapore
];

function formatTimeRandomCountry(date = new Date()) {
  const tz = GLOBAL_TIMEZONES[Math.floor(Math.random() * GLOBAL_TIMEZONES.length)];
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const targetDate = new Date(utc + (3600000 * tz.offsetHours));

  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, "0");
  const dd = String(targetDate.getDate()).padStart(2, "0");
  let hours = targetDate.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const hh = String(hours).padStart(2, "0");
  const min = String(targetDate.getMinutes()).padStart(2, "0");
  const ss = String(targetDate.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} ${ampm} ${tz.code}`;
}

function generateUniqueMaskedId() {
  // Telegram IDs are typically 9-10 digits, starting with 1, 2, 5, 6, 7
  const startDigits = ["1", "2", "5", "6", "7", "8"];
  const first = startDigits[Math.floor(Math.random() * startDigits.length)];
  const remainingPrefix = Math.floor(100 + Math.random() * 900); // 3 digits
  const prefix = `${first}${remainingPrefix}`; // 4 digits like 6842, 5319, 7028
  
  const suffix = Math.floor(100 + Math.random() * 900); // 3 digits like 849, 127
  const stars = Math.random() < 0.5 ? "*****" : "****";
  return `${prefix}${stars}${suffix}`;
}

function pickBroadcastProduct() {
  const products = getProducts();
  const gemini = products.find(p => p.id === "gemini_18m");

  // 75% chance Gemini Links 18M, 25% other catalog products
  if (gemini && Math.random() < 0.75) {
    return gemini;
  }

  const others = products.filter(p => p.id !== "gemini_18m");
  if (others.length > 0) {
    return others[Math.floor(Math.random() * others.length)];
  }
  return gemini || products[0];
}

function pickBroadcastQuantity() {
  const rand = Math.random();
  if (rand < 0.50) return 1;
  if (rand < 0.75) return 2;
  if (rand < 0.90) return 3;
  if (rand < 0.96) return 5;
  return 10;
}


async function sendGroupPurchaseNotice(productOrName, quantity, maskedId = null) {
  const settings = getAllSettings();
  const groupId = settings.group_id || process.env.FORCE_GROUP_ID || "-1004432303031";
  if (!groupId) return { success: false, error: "No group_id" };

  const prods = getProducts();
  let product = null;
  if (typeof productOrName === "object" && productOrName !== null) {
    product = productOrName;
  } else if (typeof productOrName === "string") {
    product = prods.find(p => p.name === productOrName || p.id === productOrName) || prods.find(p => p.id === "gemini_18m") || prods[0];
  } else {
    product = prods.find(p => p.id === "gemini_18m") || prods[0];
  }

  const productName = product ? product.name : (productOrName || "Gemini Links 18M");
  const qty = Number(quantity) || 1;

  let totalCostStr = "";
  if (product) {
    const { totalPrice } = calculateProductPrice(product, qty);
    totalCostStr = money(totalPrice);
  } else {
    totalCostStr = money(qty * 0.55);
  }

  const id = maskedId || generateUniqueMaskedId();
  const timeStr = formatTimeRandomCountry();

  const msg = `<blockquote>✨ <b>NEW VERIFIED PURCHASE</b> ✨
━━━━━━━━━━━━━━━━━━
👤 <b>Buyer ID:</b> <code>${id}</code>
🛍️ <b>Product:</b> <b>${escapeHtml(productName)}</b>
🔢 <b>Quantity:</b> <b>${qty}x License</b>
💵 <b>Total Cost:</b> <b>${totalCostStr}</b>
⚡ <b>Delivery:</b> <b>Instant Automated</b>
🕒 <b>Order Time:</b> <code>${timeStr}</code>
✅ <b>Payment Status:</b> <b>Success (Confirmed)</b>
━━━━━━━━━━━━━━━━━━
👑 <i>Thank you for choosing Gemini Shop!</i></blockquote>`;

  try {
    const botUsername = await getCachedBotUsername();
    const result = await bot.telegram.sendMessage(groupId, msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url("🛒 Buy Now via Bot", `https://t.me/${botUsername}?start=buy`)]
      ])
    });
    console.log(`[Group Broadcast] Purchase notice published to ${groupId}: ${productName} (x${qty}, msgId: ${result.message_id})`);
    return { success: true, messageId: result.message_id };
  } catch (err) {
    console.error(`[Group Broadcast Error] Failed to send purchase notice to ${groupId}:`, err.message || err);
    return { success: false, error: err.message };
  }
}

let isBroadcasterStarted = false;
function scheduleNextPurchaseBroadcast(isFirstRun = false) {
  // Random delay: first run in 30-45s, subsequently between 1 and 8 minutes
  const minMs = isFirstRun ? 30 * 1000 : 60 * 1000;
  const maxMs = isFirstRun ? 45 * 1000 : 480 * 1000;
  const delayMs = Math.floor(minMs + Math.random() * (maxMs - minMs));

  setTimeout(async () => {
    const settings = getAllSettings();
    if (settings.fake_sales_broadcast_enabled !== false) {
      const prod = pickBroadcastProduct();
      const qty = pickBroadcastQuantity();
      await sendGroupPurchaseNotice(prod, qty);
    }
    scheduleNextPurchaseBroadcast(false);
  }, delayMs);
}

// =====================================================
// AUTOMATIC GROUP WALLET DEPOSIT BROADCASTER (1 - 15 MINS)
// =====================================================
const RANDOM_DEPOSIT_AMOUNTS = [
  0.60, 0.70, 0.85, 1.00, 1.20, 1.50, 1.80, 2.00, 2.50, 2.70,
  3.00, 3.50, 4.00, 4.50, 5.00, 5.50, 6.00, 7.50, 8.00, 10.00,
  10.00, 12.00, 14.50, 15.00, 18.00, 20.00
];

function pickBroadcastDepositAmount() {
  return RANDOM_DEPOSIT_AMOUNTS[Math.floor(Math.random() * RANDOM_DEPOSIT_AMOUNTS.length)];
}

function generateCryptoTransactionProof() {
  return getRealCryptoTransactionProof();
}

async function sendGroupDepositNotice() {
  const settings = getAllSettings();
  const groupId = settings.group_id || process.env.FORCE_GROUP_ID || "-1004432303031";
  if (!groupId) {
    console.warn("[Group Broadcast] No group_id configured.");
    return { success: false, error: "No group_id configured" };
  }

  const customerName = getRandomCustomerName();
  const depositAmount = pickBroadcastDepositAmount();
  const txProof = getRealCryptoTransactionProof();

  // Short, compact format with full unmasked on-chain TxID
  const msg = `<blockquote>💰 <b>WALLET DEPOSIT CONFIRMED</b>
━━━━━━━━━━━━━━━━━━
👤 <b>Customer:</b> <b>${customerName}</b>
💵 <b>Amount:</b> <b>+${money(depositAmount)}</b>
🌐 <b>Method:</b> ${txProof.gatewayIcon} <b>${txProof.methodLabel}</b>
🔗 <b>TxID:</b> <a href="${txProof.txUrl}">${txProof.txId}</a>
✅ <b>Status:</b> <b>Success (Credited)</b></blockquote>`;

  try {
    const botUsername = await getCachedBotUsername();
    const result = await bot.telegram.sendMessage(groupId, msg, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.url("🛒 Buy Now via Bot", `https://t.me/${botUsername}?start=buy`)]
      ])
    });
    console.log(`[Group Broadcast] Deposit notice published to ${groupId}: ${customerName} (+${depositAmount} USDT, msgId: ${result.message_id})`);
    return { success: true, messageId: result.message_id };
  } catch (err) {
    console.error(`[Group Broadcast Error] Failed to send deposit notice to ${groupId}:`, err.message || err);
    return { success: false, error: err.message };
  }
}

let isDepositBroadcasterStarted = false;
function scheduleNextDepositBroadcast(isFirstRun = false) {
  let delayMs;
  if (isFirstRun) {
    delayMs = 15 * 1000; // First deposit post fires in 15 seconds after startup!
  } else {
    // 30% chance quick burst (30s - 90s), 70% chance 1 min to 10 mins
    const isBurst = Math.random() < 0.30;
    if (isBurst) {
      delayMs = Math.floor(30 * 1000 + Math.random() * (60 * 1000));
    } else {
      delayMs = Math.floor(60 * 1000 + Math.random() * (9 * 60 * 1000));
    }
  }

  setTimeout(async () => {
    const settings = getAllSettings();
    if (settings.fake_deposits_broadcast_enabled !== false) {
      await sendGroupDepositNotice();
    }
    scheduleNextDepositBroadcast(false);
  }, delayMs);
}

// =====================================================
// SCHEDULED CHANNEL POST ROTATOR (2x Daily: 10:00 & 19:30 BST)
// =====================================================
function getCurrentBSTTime() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const bstDate = new Date(utcMs + (3600000 * 6.0)); // UTC+6 for Bangladesh Standard Time
  const hours = bstDate.getHours();
  const minutes = bstDate.getMinutes();
  const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const dateStr = bstDate.toISOString().split("T")[0];
  return { timeStr, dateStr, hours, minutes };
}

async function sendChannelScheduledPost(customPost = null) {
  const settings = getAllSettings();
  const channelId = settings.channel_id;
  if (!channelId) {
    console.warn("Channel Auto-Poster: No channel_id set in settings.");
    return { success: false, reason: "No channel_id configured." };
  }

  const post = customPost || getNextChannelPost();
  if (!post) {
    console.warn("Channel Auto-Poster: No posts found in library.");
    return { success: false, reason: "No posts available in database." };
  }

  // Every post is wrapped in HTML quote block (<blockquote>...</blockquote>)
  const postContent = typeof post === "string" ? post : (post.content || "");
  const formattedText = `<blockquote>${postContent}</blockquote>`;

  try {
    const botUsername = await getCachedBotUsername();
    const result = await bot.telegram.sendMessage(channelId, formattedText, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.url("🛒 Buy Now via Bot", `https://t.me/${botUsername}?start=buy`)]
      ])
    });

    console.log(`Channel scheduled post [ID: ${post.id}] published to ${channelId}`);
    return { success: true, post, messageId: result.message_id };
  } catch (err) {
    console.error(`Channel Auto-Poster failed to post to ${channelId}:`, err.message || err);
    return { success: false, error: err.message };
  }
}

let channelPosterInterval = null;
function startChannelDailyPoster() {
  if (channelPosterInterval) return;

  // Run every 60 seconds
  channelPosterInterval = setInterval(async () => {
    try {
      const settings = getAllSettings();
      if (settings.channel_auto_post_enabled === false) return;
      if (!settings.channel_id) return;

      const { timeStr, dateStr, hours, minutes } = getCurrentBSTTime();
      const morningTime = settings.channel_post_morning_time || "10:00";
      const eveningTime = settings.channel_post_evening_time || "19:30";

      const [mH, mM] = morningTime.split(":").map(Number);
      const [eH, eM] = eveningTime.split(":").map(Number);

      let currentSlot = null;
      // 5-minute window for safety across potential network hiccup
      if (hours === mH && minutes >= mM && minutes <= mM + 4) {
        currentSlot = `${dateStr}_morning`;
      } else if (hours === eH && minutes >= eM && minutes <= eM + 4) {
        currentSlot = `${dateStr}_evening`;
      }

      if (currentSlot && settings.channel_last_post_slot !== currentSlot) {
        setSetting("channel_last_post_slot", currentSlot);
        console.log(`[BST ${timeStr}] Triggering scheduled daily channel post for slot: ${currentSlot}`);
        await sendChannelScheduledPost();
      }
    } catch (e) {
      console.error("Channel poster loop error:", e);
    }
  }, 60 * 1000);
}

// =====================================================
// SERVER & WEBHOOK / POLLING INITIALIZATION
// =====================================================
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;

let server;
let isShuttingDown = false;
let pollingStarted = false;

async function startApp() {
  // Initialize persistent database (Google Firebase or local file fallback)
  await initStore();

  // Register official Telegram '/' command menu & chat menu button
  registerBotCommands().catch(() => {});

  if (WEBHOOK_URL) {
    const cleanUrl = WEBHOOK_URL.replace(/\/+$/, "");
    const secretPath = `/webhook/${bot.secretPathComponent ? bot.secretPathComponent() : "telegraf"}`;
    app.use(bot.webhookCallback(secretPath));

    server = app.listen(PORT, "0.0.0.0", async () => {
      console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
      if (!isBroadcasterStarted) {
        isBroadcasterStarted = true;
        scheduleNextPurchaseBroadcast(true);
        scheduleNextDepositBroadcast(true);
        startChannelDailyPoster();
      }
      try {
        await bot.telegram.setWebhook(`${cleanUrl}${secretPath}`);
        console.log(`Telegram webhook registered at: ${cleanUrl}${secretPath}`);
      } catch (err) {
        console.error("Failed to register Telegram webhook:", err.message);
      }
    });
  } else {
    server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`Port ${PORT} in use; skipping extra HTTP listener.`);
      } else {
        console.error("HTTP server error:", err);
      }
    });

    const launchBot = () => {
      if (isShuttingDown) return;
      bot.launch({
        dropPendingUpdates: false
      })
        .then(() => {
          pollingStarted = true;
          console.log("Telegram Gemini AI Shop bot started successfully (polling mode).");
          if (!isBroadcasterStarted) {
            isBroadcasterStarted = true;
            scheduleNextPurchaseBroadcast(true);
            scheduleNextDepositBroadcast(true);
            startChannelDailyPoster();
          }
        })
        .catch((error) => {
          console.error("Bot launch network glitch:", error.message || error);
          if (!isShuttingDown) {
            console.log("Reconnecting in 4 seconds...");
            setTimeout(launchBot, 4000);
          }
        });
    };

    launchBot();
  }
}

startApp().catch((err) => {
  console.error("Fatal startup error:", err);
});

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================
const stopApp = (signal) => {
  if (isShuttingDown) return;

  console.log(`Stopping bot and server on ${signal}...`);
  isShuttingDown = true;

  // Flush any pending debounced database writes synchronously before exit
  try {
    flushStoreSync();
  } catch (_) {}

  if (channelPosterInterval) {
    clearInterval(channelPosterInterval);
    channelPosterInterval = null;
  }

  if (server) {
    server.close();
    server = null;
  }

  // Telegraf's stop() is for polling mode, not webhook mode.
  // Also avoid calling it before polling has actually started.
  if (!WEBHOOK_URL && pollingStarted) {
    try {
      bot.stop(signal);
      pollingStarted = false;
    } catch (error) {
      console.error("Bot shutdown warning:", error.message || error);
    }
  }
};

process.once("SIGINT", () => stopApp("SIGINT"));
process.once("SIGTERM", () => stopApp("SIGTERM"));