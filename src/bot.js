require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const QRCode = require("qrcode");
const express = require("express");

const {
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
  claimReferralReward,
  getChannelPosts,
  getNextChannelPost,
  addChannelPost
} = require("./store");
const { getRandomCustomerName } = require("./names");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || "");

if (!TOKEN) {
  throw new Error("Set BOT_TOKEN in .env");
}

if (!ADMIN_ID) {
  throw new Error("Set ADMIN_TELEGRAM_ID in .env");
}

const https = require("https");

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  timeout: 30000
});

const bot = new Telegraf(TOKEN, {
  telegram: { agent }
});

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
👛 Pay with Wallet (Binance Pay / USDT BEP20)
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
// MAIN MENU HANDLERS
// =====================================================
bot.hears("🛍️ Buy", (ctx) => showCatalog(ctx));
bot.action("menu:buy", (ctx) => showCatalog(ctx));

bot.hears("💰 My Orders", (ctx) => showMyOrders(ctx));
bot.action("menu:orders", (ctx) => showMyOrders(ctx));

bot.hears("👛 Wallet", (ctx) => showWallet(ctx));
bot.action("menu:wallet", (ctx) => showWallet(ctx));

bot.hears("📰 Profile", (ctx) => showProfile(ctx));
bot.action("menu:profile", (ctx) => showProfile(ctx));

bot.hears("🗑️ Recover", (ctx) => promptRecover(ctx));
bot.action("menu:recover", (ctx) => promptRecover(ctx));

bot.hears("📌 Refer & Earn", (ctx) => showRefer(ctx));
bot.action("menu:refer", (ctx) => showRefer(ctx));

bot.hears("💬 Support", (ctx) => showSupport(ctx));
bot.action("menu:support", (ctx) => showSupport(ctx));

bot.hears("🆙 API Key", (ctx) => showApiKey(ctx));
bot.action("menu:apikey", (ctx) => showApiKey(ctx));

bot.action("menu:main", async (ctx) => {
  await ctx.answerCbQuery();
  const user = getOrCreateUser(ctx.from);
  await ctx.reply("🏠 Main Menu", getMainMenuInlineKeyboard());
});

// =====================================================
// CATALOG / BUY FLOW
// =====================================================
async function showCatalog(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

  const products = getStandardProducts();
  const text = `Pick a product below — price and live stock are shown on each button.
⚡️ Delivery is instant once payment clears.`;

  const buttons = products.map((p) => {
    let label;
    if (p.outOfStock || p.stock <= 0) {
      label = `${p.name} • Out of stock`;
    } else {
      label = `${p.name} • ${money(p.price)} | Stock: ${p.stock}`;
    }
    return [Markup.button.callback(label, `prod:${p.id}`)];
  });

  buttons.push([Markup.button.callback("🔙 Go Back", "menu:main")]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
      return;
    } catch (e) {}
  }
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

// Product clicked -> Show Bulk Discount & Quantity
bot.action(/^prod:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const p = getProduct(productId);
  const backMenu = p && p.category === "api_key" ? "menu:apikey" : "menu:buy";

  if (!p) {
    return ctx.reply("❌ Product not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Catalog", backMenu)]]));
  }

  if (p.outOfStock || p.stock <= 0) {
    return ctx.reply(
      `⚠️ ${p.name} is currently out of stock.\nPlease check back later or choose another item.`,
      Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", backMenu)]])
    );
  }

  ctx.session.selectedProductId = p.id;

  let bulkText = "💰 Bulk Discount Offers\n";
  if (Array.isArray(p.bulk_tiers) && p.bulk_tiers.length > 0) {
    for (const tier of p.bulk_tiers) {
      const maxLabel = tier.max >= 99999 ? "+" : ` – ${tier.max}`;
      bulkText += `✅ Buy ${tier.min}${maxLabel} → ${money(tier.price)} each\n`;
    }
  } else {
    bulkText += `✅ Price: ${money(p.price)} each\n`;
  }
  bulkText += `\n💎 Available: ${p.stock}`;

  const qtyButtons = [
    [
      Markup.button.callback("1", `qty:${p.id}:1`),
      Markup.button.callback("5", `qty:${p.id}:5`),
      Markup.button.callback("10", `qty:${p.id}:10`)
    ],
    [
      Markup.button.callback("50", `qty:${p.id}:50`),
      Markup.button.callback("100", `qty:${p.id}:100`),
      Markup.button.callback("✏️ Custom Qty", `qty_custom:${p.id}`)
    ],
    [Markup.button.callback("🔙 Back to Catalog", backMenu)]
  ];

  try {
    await ctx.editMessageText(bulkText, Markup.inlineKeyboard(qtyButtons));
  } catch (e) {
    await ctx.reply(bulkText, Markup.inlineKeyboard(qtyButtons));
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
    `✏️ Please enter the quantity you want to purchase (1 to ${p.stock}):`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `prod:${productId}`)]])
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

  const { unitPrice, totalPrice } = calculateProductPrice(p, qty);
  ctx.session.pendingOrder = {
    productId: p.id,
    quantity: qty,
    unitPrice,
    totalPrice
  };

  const text = `🛍️ PRODUCT DETAILS: ${p.name}
━━━━━━━━━━━━━━━━━━━
${p.description}`;

  const backMenu = p.category === "api_key" ? "menu:apikey" : "menu:buy";
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`➡️ Continue to Order (${qty}x — ${money(totalPrice)})`, `order_summary:${p.id}:${qty}`)],
    [Markup.button.callback("🔢 Change Quantity", `prod:${p.id}`)],
    [Markup.button.callback("❌ Cancel", backMenu)]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, buttons);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
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

  const { unitPrice, totalPrice } = calculateProductPrice(p, qty);
  ctx.session.pendingOrder = {
    productId: p.id,
    quantity: qty,
    unitPrice,
    totalPrice
  };

  const text = `📦 ORDER SUMMARY & TERMS
━━━━━━━━━━━━━━━━━━━
🛍️ Product: ${p.name}
🔢 Quantity: ${qty}x
💲 Unit Price: ${money(unitPrice)}
💰 Total Due: ${money(totalPrice)}

━━━━━━━━━━━━━━━━━━━
✍️ Terms of Service:
${p.terms}`;

  const backMenu = p.category === "api_key" ? "menu:apikey" : "menu:buy";
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Agree & Pay ${money(totalPrice)}`, "order:pay_check")],
    [Markup.button.callback("🔙 Back to Product Details", `order_info:${p.id}:${qty}`)],
    [Markup.button.callback("❌ Cancel Order", backMenu)]
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, buttons);
      return;
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
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
    [Markup.button.callback("💰 My Orders", "menu:orders")],
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
// DEPOSIT FLOW (BINANCE PAY & USDT BEP20 / POLYGON)
// =====================================================
bot.action(/^deposit:start(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const suggestedAmount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;

  const text = `💳 <b>SELECT DEPOSIT METHOD</b>
━━━━━━━━━━━━━━━━━━━
Please choose your preferred deposit gateway:
• <b>Binance Pay:</b> Instant C2C (Min: <b>$0.60 USDT</b>)
• <b>Crypto USDT:</b> BEP20 & Polygon (Min: <b>$1.00 USDT</b>)`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🟡 Binance Pay (Min $0.60)", `deposit:binance:${suggestedAmount}`)],
    [Markup.button.callback("🌐 USDT BEP20 / Polygon (Min $1.00)", `deposit:crypto:${suggestedAmount}`)],
    [Markup.button.callback("🔙 Back to Wallet", "menu:wallet")]
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

// Binance Pay prompt
bot.action(/^deposit:binance(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const suggestedAmount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;

  ctx.session.depositMethod = "BINANCE_PAY";
  ctx.session.awaitingDepositAmount = true;

  const settings = getAllSettings();
  const min = Number(settings.min_binance_deposit || 0.60);
  const text = `🟡 <b>DEPOSIT VIA BINANCE PAY</b>
━━━━━━━━━━━━━━━━━━━
Type any amount in USDT you want to deposit (Minimum: <b>$0.60 USDT</b>).
Or select a quick amount below:`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("0.60 USDT", `dep_bin_set:0.60`),
      Markup.button.callback("1.00 USDT", `dep_bin_set:1.00`),
      Markup.button.callback("5.00 USDT", `dep_bin_set:5.00`),
      Markup.button.callback("10.00 USDT", `dep_bin_set:10.00`)
    ],
    [Markup.button.callback("🔙 Back", "deposit:start")]
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
  } catch (e) {
    await ctx.reply(text, { parse_mode: "HTML", ...buttons });
  }
});

bot.action(/^dep_bin_set:([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = Number(ctx.match[1]);
  await showBinancePayInstructions(ctx, amount);
});

async function showBinancePayInstructions(ctx, amount) {
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);

  const deposit = createDeposit({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    amount: amount,
    method: "BINANCE_PAY",
    address: settings.binance_pay_id
  });

  ctx.session.activeDepositId = deposit.id;

  const binanceId = settings.binance_pay_id || "123456789";

  const text = `🟡 <b>BINANCE PAY DEPOSIT</b>
━━━━━━━━━━━━━━━━━━━
💰 <b>Amount to send:</b> <b>${money(deposit.amount)}</b>

💵 <b>Binance Pay ID:</b>
<code>${binanceId}</code>
<i>👆 (Tap ID above to auto-copy to clipboard)</i>
━━━━━━━━━━━━━━━━━━━

⚠️ <b>Quick Instructions:</b>
1. Open your <b>Binance App</b> ➔ Go to <b>Pay</b> ➔ <b>Send</b>
2. Tap the Binance Pay ID above to copy it automatically
3. Send exactly <b>${money(deposit.amount)}</b>
4. Once sent, tap <b>"✅ I've Paid"</b> below to submit your payment proof!`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
}

// USDT BEP20 / Polygon deposit
bot.action(/^deposit:crypto(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 1.0;
  await showCryptoDepositInstructions(ctx, amount);
});

async function showCryptoDepositInstructions(ctx, amount) {
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);
  const bep20Address = settings.bep20_usdt_address || "0xC3fC8C91A5B26C71DcD0aC1F34944FB298bCeBbF";
  const polygonAddress = settings.polygon_usdt_address || "0x58F0C60b37E5c84C4C7fE4a553F1fCe6405F412b";
  const finalAmount = Math.max(1.0, Number(amount) || 1.0);

  const deposit = createDeposit({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    amount: finalAmount,
    method: "USDT_BEP20_POLYGON",
    address: bep20Address
  });

  ctx.session.activeDepositId = deposit.id;

  const text = `🌐 <b>USDT DEPOSIT (BEP20 & POLYGON)</b>
━━━━━━━━━━━━━━━━━━━
💰 <b>Amount to send:</b> <b>${Number(deposit.amount).toFixed(2)} USDT</b>
<i>(Minimum: 1.00 USDT — wallet is credited with exact on-chain arrival)</i>

━━━━━━━━━━━━━━━━━━━
🟡 <b>BEP20 (BNB Smart Chain) USDT Address:</b>
<code>${bep20Address}</code>
<i>👆 (Tap address above to copy automatically)</i>

🟣 <b>Polygon (MATIC/POL) USDT Address:</b>
<code>${polygonAddress}</code>
<i>👆 (Tap address above to copy automatically)</i>
━━━━━━━━━━━━━━━━━━━

⚠️ <b>Important Guidelines:</b>
• Only send USDT on <b>BEP20 (BSC)</b> or <b>Polygon</b> network.
• Minimum deposit: <b>1.00 USDT</b>.
• Tap on either address above to auto-copy instantly without manual selection.
• After transferring, tap <b>"✅ I've Paid"</b> below to submit proof and get credited!`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  try {
    const qrBuffer = await QRCode.toBuffer(bep20Address, { width: 300, margin: 1 });
    await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption: text,
        parse_mode: "HTML",
        ...buttons
      }
    );
  } catch (err) {
    await ctx.reply(text, { parse_mode: "HTML", ...buttons });
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

  await ctx.reply(
    `📩 Please send your Transaction Hash (TxID) or payment screenshot below for Deposit <b>${depositId}</b>:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "menu:wallet")]])
    }
  );
});

// =====================================================
// TEXT / PHOTO INPUT HANDLERS
// =====================================================
bot.on("text", async (ctx, next) => {
  const text = ctx.message.text.trim();

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

  // If waiting for Binance Pay custom deposit amount
  if (ctx.session.awaitingDepositAmount) {
    ctx.session.awaitingDepositAmount = null;
    const amt = parseFloat(text);
    const settings = getAllSettings();
    const min = Number(settings.min_binance_deposit || 0.60);
    if (isNaN(amt) || amt < min) {
      return ctx.reply(`❌ Invalid amount. Minimum Binance Pay deposit is ${money(min)} USDT.`);
    }
    return showBinancePayInstructions(ctx, amt);
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

  // If waiting for deposit payment proof (text TxID)
  if (ctx.session.awaitingProofForDeposit) {
    const depositId = ctx.session.awaitingProofForDeposit;
    ctx.session.awaitingProofForDeposit = null;
    const deposit = getDeposit(depositId);
    if (deposit) {
      deposit.proof = text;
      deposit.updated_at = new Date().toISOString();
      await notifyAdminNewDeposit(ctx, deposit);
      return ctx.reply(
        `✅ Thank you! Your payment proof for Deposit ${depositId} has been submitted.\n\nOur team is verifying the on-chain arrival and your balance will be credited shortly!`,
        Markup.inlineKeyboard([[Markup.button.callback("👛 View Wallet", "menu:wallet")]])
      );
    }
  }

  // Admin state handlers
  if (isAdmin(ctx) && ctx.session.newProductWizard) {
    return handleNewProductWizardInput(ctx, text);
  }
  if (isAdmin(ctx) && ctx.session.adminAction) {
    return handleAdminTextInput(ctx, text);
  }

  return next();
});

bot.on("photo", async (ctx, next) => {
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
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(textMsg);
    } else {
      await ctx.editMessageText(textMsg);
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
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(textMsg);
    } else {
      await ctx.editMessageText(textMsg);
    }

    bot.telegram.sendMessage(
      deposit.user_id,
      `❌ Your deposit ${deposit.id} of ${money(deposit.amount)} was rejected by admin. Please contact support if you believe this is an error.`,
      Markup.inlineKeyboard([[Markup.button.callback("💬 Support", "menu:support")]])
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
  const botInfo = await bot.telegram.getMe();
  const refLink = `https://t.me/${botInfo.username}?start=ref_${user.id}`;
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

// SUPPORT
async function showSupport(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const settings = getAllSettings();

  const text = `💬 CUSTOMER SUPPORT

Need assistance with an order, redeem link, or deposit?
Our team is available 24/7.

👤 Admin Support: ${settings.support_username || "@aibuyshop_support"}
📢 Channel: ${settings.channel_link}
👥 Group: ${settings.group_link}

Please include your Order Code or Deposit ID when contacting support for fastest assistance!`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.url("💬 Contact Support", `https://t.me/${(settings.support_username || "aibuyshop_support").replace("@", "")}`)],
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
  const products = getProducts().length;
  const users = getAllUsers().length;

  const text = `🔐 ADMIN DASHBOARD

📊 Live Bot Stats:
• Registered Users: ${users}
• Products: ${products}
• Pending Deposits: ${pendingDeps}

Select an action below:`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`📥 Pending Deposits (${pendingDeps})`, "adm:deposits")],
    [Markup.button.callback("🛍️ Products & Inventory", "adm:products")],
    [Markup.button.callback("👤 User Balance Adjuster", "adm:user_bal")],
    [Markup.button.callback("⚙️ Force Join & Payment Settings", "adm:settings")],
    [Markup.button.callback("📢 Channel Auto-Poster (2x/Day)", "adm:channel_poster")],
    [Markup.button.callback("📢 Broadcast Message", "adm:broadcast")],
    [Markup.button.callback("🏠 Customer Menu", "menu:main")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, buttons);
    } catch (e) {}
  }
  await ctx.reply(text, buttons);
}

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
    [Markup.button.callback("🔙 Pending List", "adm:deposits")]
  ]);

  if (deposit.photo_file_id) {
    await ctx.replyWithPhoto(deposit.photo_file_id, { caption: msg, ...buttons });
  } else {
    await ctx.reply(msg, buttons);
  }
});

// Admin: Products List
bot.action("adm:products", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const products = getProducts();

  let text = `🛍️ <b>MANAGE PRODUCTS & AI KEYS</b> (${products.length} Items)\n\nSelect a product to edit price, description, or stock, or tap <b>➕ Add New</b> below:`;
  const buttons = [
    [Markup.button.callback("➕ Add New Product / API Key", "adm_add_prod_start")]
  ];

  for (const p of products) {
    const icon = p.category === "api_key" ? "🆙" : "🛍️";
    const status = p.outOfStock ? "OUT" : `Stock: ${p.stock}`;
    buttons.push([
      Markup.button.callback(
        `${icon} ${p.name} • ${money(p.price)} (${status})`,
        `adm_edit_prod:${p.id}`
      )
    ]);
  }
  buttons.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^adm_edit_prod:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  const categoryLabel = p.category === "api_key" ? "🆙 AI API Key / Cloud Token" : "🛍️ Standard Product";

  const text = `🛍️ <b>EDIT PRODUCT: ${escapeHtml(p.name)}</b>
━━━━━━━━━━━━━━━━━━━━━
• <b>Category:</b> ${categoryLabel}
• <b>Base Price:</b> <b>${money(p.price)}</b>
• <b>Current Stock:</b> <b>${p.stock}</b>
• <b>Status:</b> ${p.outOfStock ? "🚫 Out of Stock" : "✅ Available"}
• <b>Digital Codes in Stock:</b> ${Array.isArray(p.codes) ? p.codes.length : 0}

📝 <b>Current Description:</b>
${escapeHtml(p.description || "None")}`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("💲 Set Price", `adm_set_price:${p.id}`),
      Markup.button.callback("📝 Edit Description", `adm_set_desc:${p.id}`)
    ],
    [
      Markup.button.callback("🔢 Set Stock Number", `adm_set_stock:${p.id}`),
      Markup.button.callback("📦 Add Digital Codes", `adm_add_codes:${p.id}`)
    ],
    [
      Markup.button.callback(p.outOfStock ? "🟢 Mark In Stock" : "🔴 Mark Out of Stock", `adm_toggle_stock:${p.id}`),
      Markup.button.callback("🗑️ Delete Product", `adm_del_prod_confirm:${p.id}`)
    ],
    [Markup.button.callback("🔙 Products List", "adm:products")]
  ]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...buttons });
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: "HTML", ...buttons });
});

bot.action(/^adm_toggle_stock:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (p) {
    updateProduct(p.id, { outOfStock: !p.outOfStock });
    await ctx.reply(`✅ Updated ${p.name} status to: ${!p.outOfStock ? "In Stock" : "Out of Stock"}`);
  }
});

bot.action(/^adm_set_price:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  ctx.session.adminAction = { type: "set_price", productId: ctx.match[1] };
  await ctx.reply(
    `💲 Enter new base price in USDT for <b>${p ? escapeHtml(p.name) : ctx.match[1]}</b> (e.g. <code>0.65</code> or <code>3.50</code>):`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_edit_prod:${ctx.match[1]}`)]])
    }
  );
});

bot.action(/^adm_set_desc:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  ctx.session.adminAction = { type: "set_desc", productId: p.id };
  await ctx.reply(
    `📝 Send the new description for <b>${escapeHtml(p.name)}</b> below.\n\n<i>You can send multiple lines or bullet points (e.g. ✅ Instant delivery):</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `adm_edit_prod:${p.id}`)]])
    }
  );
});

bot.action(/^adm_set_stock:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_stock", productId: ctx.match[1] };
  await ctx.reply(`Enter new stock count for product ${ctx.match[1]} (e.g. 500):`);
});

bot.action(/^adm_add_codes:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "add_codes", productId: ctx.match[1] };
  await ctx.reply(`Send the digital codes/links to add to ${ctx.match[1]} (one per line):`);
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
  deleteProduct(productId);

  await ctx.reply(
    `🗑️ Product <b>${escapeHtml(name)}</b> has been permanently deleted from database.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Back to Products List", "adm:products")]])
    }
  );
});

// Admin: Add Product Multi-Step Wizard
bot.action("adm_add_prod_start", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.newProductWizard = null;
  ctx.session.adminAction = null;

  const text = `➕ <b>ADD NEW PRODUCT OR AI KEY</b>
━━━━━━━━━━━━━━━━━━━━━
Choose the category for the new item:

• <b>Standard Product:</b> Regular accounts, software, subscriptions (appears in 🛍️ Buy menu).
• <b>AI API Key / Token:</b> AI model API tokens, developer cloud keys (appears in 🆙 API Key menu).`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🛍️ Standard Product", "adm_wizard_cat:standard")],
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

bot.action(/^adm_wizard_cat:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const category = ctx.match[1];

  ctx.session.newProductWizard = {
    category,
    step: "name"
  };

  const catName = category === "api_key" ? "AI API Key / Token" : "Standard Product";
  await ctx.reply(
    `📌 <b>Step 1 of 4: Enter Product Name</b>\n\nCategory: <b>${catName}</b>\nPlease send the name of the product:\n<i>(Example: "ChatGPT Plus 1 Month" or "Midjourney Pro Key")</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "adm:products")]])
    }
  );
});

async function handleNewProductWizardInput(ctx, text) {
  const wizard = ctx.session.newProductWizard;
  if (!wizard) return;

  if (wizard.step === "name") {
    if (!text || text.length < 2) {
      return ctx.reply("❌ Product name is too short. Please send a valid name:");
    }
    wizard.name = text.trim();
    wizard.step = "price";
    return ctx.reply(
      `💲 <b>Step 2 of 4: Set Base Price</b>\n\nProduct: <b>${escapeHtml(wizard.name)}</b>\nPlease send the base price in USDT (e.g. <code>2.50</code> or <code>5.00</code>):`,
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
      `🔢 <b>Step 3 of 4: Initial Stock</b>\n\nPrice set to: <b>${money(wizard.price)}</b>\nPlease send initial stock count (e.g. <code>50</code> or <code>100</code>):`,
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
      `📝 <b>Step 4 of 4: Product Description</b>\n\nStock set to: <b>${stock}</b>\nPlease send the product description below (supports multiple lines/bullet points):\n\n<i>Example:</i>\n<code>✅ Official 1 Month Subscription\n✅ Fast instant delivery to chat\n✅ 100% Guaranteed</code>`,
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
      category: wizard.category,
      price: wizard.price,
      stock: wizard.stock,
      outOfStock: wizard.stock <= 0,
      description: description,
      terms: "• Instant automated delivery\n• Full guarantee",
      codes: [],
      bulk_tiers: [
        { min: 1, max: 10, price: wizard.price },
        { min: 11, max: 999999, price: Number((wizard.price * 0.9).toFixed(2)) }
      ]
    };

    addProduct(newProduct);

    const menuLabel = newProduct.category === "api_key" ? "🆙 AI API Key Store" : "🛍️ Buy Menu";
    return ctx.reply(
      `🎉 <b>NEW PRODUCT ADDED SUCCESSFULLY!</b>\n━━━━━━━━━━━━━━━━━━━━━\n• <b>ID:</b> <code>${id}</code>\n• <b>Name:</b> <b>${escapeHtml(newProduct.name)}</b>\n• <b>Category:</b> ${newProduct.category === "api_key" ? "🆙 AI API Key" : "🛍️ Standard"}\n• <b>Price:</b> <b>${money(newProduct.price)}</b>\n• <b>Stock:</b> <b>${newProduct.stock}</b>\n\nCustomers can now view and buy this item under <b>${menuLabel}</b>!`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📦 Add Digital Codes/Links", `adm_add_codes:${id}`)],
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

  const text = `⚙️ BOT SETTINGS & CONFIGURATION:

• Force Join Enabled: ${s.force_join_enabled ? "✅ YES" : "❌ NO"}
• Channel ID: ${s.channel_id || "Not Set"}
• Channel Link: ${s.channel_link || "Not Set"}
• Group ID: ${s.group_id || "Not Set"}
• Group Link: ${s.group_link || "Not Set"}
• USDT BEP20 Address: ${s.bep20_usdt_address}
• USDT Polygon Address: ${s.polygon_usdt_address || s.bep20_usdt_address}
• Binance Pay ID: ${s.binance_pay_id}
• Support Handle: ${s.support_username}
• Group Sales Broadcast: ${s.fake_sales_broadcast_enabled !== false ? "✅ ENABLED (~2 mins)" : "❌ DISABLED"}
• Group Deposits Broadcast: ${s.fake_deposits_broadcast_enabled !== false ? "✅ ENABLED (~20 mins)" : "❌ DISABLED"}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(s.force_join_enabled ? "🔴 Disable Force Join" : "🟢 Enable Force Join", "adm_toggle_fj")],
    [
      Markup.button.callback(s.fake_sales_broadcast_enabled !== false ? "🔴 Sales Off" : "🟢 Sales On", "adm_toggle_fake_sales"),
      Markup.button.callback(s.fake_deposits_broadcast_enabled !== false ? "🔴 Deposits Off" : "🟢 Deposits On", "adm_toggle_fake_deps")
    ],
    [Markup.button.callback("✏️ Edit Channel", "adm_set_chan"), Markup.button.callback("✏️ Edit Group", "adm_set_grp")],
    [Markup.button.callback("✏️ Edit BEP20 USDT", "adm_set_bep20"), Markup.button.callback("✏️ Edit Polygon USDT", "adm_set_polygon")],
    [Markup.button.callback("✏️ Edit Binance Pay ID", "adm_set_binpay")],
    [Markup.button.callback("🔙 Admin Menu", "adm:menu")]
  ]);

  await ctx.reply(text, buttons);
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

bot.action("adm_set_binpay", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_binance_pay" };
  await ctx.reply("Enter new Binance Pay ID:");
});

// Admin: Broadcast
bot.action("adm:broadcast", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "broadcast" };
  await ctx.reply("Send the message you want to broadcast to all registered bot users:");
});

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

// Handle admin text inputs
async function handleAdminTextInput(ctx, text) {
  const action = ctx.session.adminAction;
  ctx.session.adminAction = null;

  switch (action.type) {
    case "set_price": {
      const price = parseFloat(text.replace("$", "").trim());
      if (isNaN(price) || price <= 0) return ctx.reply("❌ Invalid price number. Please enter a valid positive number.");
      const updatedPrice = Number(price.toFixed(2));
      const p = getProduct(action.productId);
      const bulkTiers = Array.isArray(p?.bulk_tiers) ? p.bulk_tiers.map(t => {
        if (t.min === 1) return { ...t, price: updatedPrice };
        return t;
      }) : undefined;
      updateProduct(action.productId, { price: updatedPrice, bulk_tiers: bulkTiers });
      return ctx.reply(
        `✅ <b>Updated price of ${p ? escapeHtml(p.name) : action.productId} to ${money(updatedPrice)}</b>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)]])
        }
      );
    }
    case "set_desc": {
      const p = getProduct(action.productId);
      if (!p) return ctx.reply("❌ Product not found.");
      updateProduct(action.productId, { description: text.trim() });
      return ctx.reply(
        `✅ <b>Description updated for ${escapeHtml(p.name)}!</b>\n\n📝 <b>New Description:</b>\n${escapeHtml(text.trim())}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Back to Product", `adm_edit_prod:${action.productId}`)]])
        }
      );
    }
    case "set_stock": {
      const stock = parseInt(text, 10);
      if (isNaN(stock)) return ctx.reply("❌ Invalid stock number.");
      updateProduct(action.productId, { stock, outOfStock: stock <= 0 });
      return ctx.reply(`✅ Updated stock of ${action.productId} to ${stock}`);
    }
    case "add_codes": {
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return ctx.reply("❌ No valid codes provided.");
      addProductCodes(action.productId, lines);
      return ctx.reply(`✅ Added ${lines.length} codes/links to ${action.productId}! Stock increased automatically.`);
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
    case "set_binance_pay": {
      setSetting("binance_pay_id", text);
      return ctx.reply(`✅ Binance Pay ID updated to: ${text}`);
    }
    case "broadcast": {
      const users = getAllUsers();
      let sent = 0;
      for (const u of users) {
        try {
          await bot.telegram.sendMessage(u.id, text);
          sent++;
        } catch (e) {}
      }
      return ctx.reply(`📢 Broadcast sent to ${sent}/${users.length} users.`);
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
  const groupId = settings.group_id;
  if (!groupId) return;

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
    const botInfo = await bot.telegram.getMe().catch(() => null);
    const botUsername = botInfo?.username || "aibuyshop_bot";
    await bot.telegram.sendMessage(groupId, msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url("🛒 Buy Now via Bot", `https://t.me/${botUsername}?start=buy`)]
      ])
    });
  } catch (err) {
    // Silent fail if bot is not in group or network temporary issue
  }
}

let isBroadcasterStarted = false;
function scheduleNextPurchaseBroadcast() {
  // Random delay between 1 minute (60 seconds) and 10 minutes (600 seconds)
  const minMs = 60 * 1000;    // 1 min
  const maxMs = 600 * 1000;   // 10 mins
  const delayMs = Math.floor(minMs + Math.random() * (maxMs - minMs));

  setTimeout(async () => {
    const settings = getAllSettings();
    if (settings.fake_sales_broadcast_enabled !== false && settings.group_id) {
      const prod = pickBroadcastProduct();
      const qty = pickBroadcastQuantity();
      await sendGroupPurchaseNotice(prod, qty);
    }
    scheduleNextPurchaseBroadcast();
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
  const rand = Math.random();
  // 55% BEP20 USDT, 35% Polygon USDT, 10% Binance Pay
  const method = rand < 0.55 ? "BEP20" : rand < 0.90 ? "POLYGON" : "BINANCE_PAY";

  const rawHex = crypto.randomBytes(32).toString("hex");
  const fullTxHash = `0x${rawHex}`;

  if (method === "BEP20") {
    return {
      methodLabel: "USDT (BEP20)",
      gatewayIcon: "🟡",
      txId: fullTxHash,
      txUrl: `https://bscscan.com/tx/${fullTxHash}`
    };
  } else if (method === "POLYGON") {
    return {
      methodLabel: "USDT (Polygon)",
      gatewayIcon: "🟣",
      txId: fullTxHash,
      txUrl: `https://polygonscan.com/tx/${fullTxHash}`
    };
  } else {
    return {
      methodLabel: "Binance Pay",
      gatewayIcon: "⚡️",
      txId: fullTxHash,
      txUrl: `https://bscscan.com/tx/${fullTxHash}`
    };
  }
}

async function sendGroupDepositNotice() {
  const settings = getAllSettings();
  const groupId = settings.group_id;
  if (!groupId) return;

  const customerName = getRandomCustomerName();
  const depositAmount = pickBroadcastDepositAmount();
  const txProof = generateCryptoTransactionProof();

  // Short, compact format with full unmasked on-chain TxID
  const msg = `<blockquote>💰 <b>WALLET DEPOSIT CONFIRMED</b>
━━━━━━━━━━━━━━━━━━
👤 <b>Customer:</b> <b>${customerName}</b>
💵 <b>Amount:</b> <b>+${money(depositAmount)}</b>
🌐 <b>Method:</b> ${txProof.gatewayIcon} <b>${txProof.methodLabel}</b>
🔗 <b>TxID:</b> <a href="${txProof.txUrl}">${txProof.txId}</a>
✅ <b>Status:</b> <b>Success (Credited)</b></blockquote>`;

  try {
    const botInfo = await bot.telegram.getMe().catch(() => null);
    const botUsername = botInfo?.username || "aibuyshop_bot";
    await bot.telegram.sendMessage(groupId, msg, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.url("🛒 Buy Now via Bot", `https://t.me/${botUsername}?start=buy`)]
      ])
    });
    console.log(`[Group Broadcast] Deposit notice published: ${customerName} (+${depositAmount} USDT)`);
  } catch (err) {
    // Silent fail if bot is not in group or network temporary issue
  }
}

let isDepositBroadcasterStarted = false;
function scheduleNextDepositBroadcast() {
  // Most of the time (~75%): delay is random between 1 and 15 minutes
  // Sometimes (~25%): quick burst (45s - 150s) so within 1-15 min period 2 or 3 posts appear
  const isBurst = Math.random() < 0.25;
  let delayMs;
  if (isBurst) {
    delayMs = Math.floor(45 * 1000 + Math.random() * (105 * 1000));
  } else {
    delayMs = Math.floor(60 * 1000 + Math.random() * (14 * 60 * 1000));
  }

  setTimeout(async () => {
    const settings = getAllSettings();
    if (settings.fake_deposits_broadcast_enabled !== false && settings.group_id) {
      await sendGroupDepositNotice();
    }
    scheduleNextDepositBroadcast();
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
    const botInfo = await bot.telegram.getMe().catch(() => null);
    const botUsername = botInfo?.username || "aibuyshop_bot";
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

async function startApp() {
  // Initialize persistent database (Google Firebase or local file fallback)
  await initStore();

  if (WEBHOOK_URL) {
    const cleanUrl = WEBHOOK_URL.replace(/\/+$/, "");
    const secretPath = `/webhook/${bot.secretPathComponent ? bot.secretPathComponent() : "telegraf"}`;
    app.use(bot.webhookCallback(secretPath));

    server = app.listen(PORT, "0.0.0.0", async () => {
      console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
      if (!isBroadcasterStarted) {
        isBroadcasterStarted = true;
        scheduleNextPurchaseBroadcast();
        scheduleNextDepositBroadcast();
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
          console.log("Telegram Gemini AI Shop bot started successfully (polling mode).");
          if (!isBroadcasterStarted) {
            isBroadcasterStarted = true;
            scheduleNextPurchaseBroadcast();
            scheduleNextDepositBroadcast();
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
  console.log(`Stopping bot and server on ${signal}...`);
  isShuttingDown = true;
  if (channelPosterInterval) clearInterval(channelPosterInterval);
  if (server) server.close();
  bot.stop(signal);
};

process.once("SIGINT", () => stopApp("SIGINT"));
process.once("SIGTERM", () => stopApp("SIGTERM"));