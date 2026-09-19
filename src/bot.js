require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const QRCode = require("qrcode");
const express = require("express");

const {
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
} = require("./store");

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

// Check if user has joined required channel/group
async function checkMembership(ctx) {
  const settings = getAllSettings();
  if (!settings.force_join_enabled) return true;

  const userId = ctx.from?.id;
  if (!userId) return true;

  // If already verified in database, allow through
  if (isUserVerified(userId)) return true;

  let channelOk = true;
  let groupOk = true;

  if (settings.channel_id) {
    try {
      const member = await ctx.telegram.getChatMember(settings.channel_id, userId);
      channelOk = ["creator", "administrator", "member", "restricted"].includes(member.status);
    } catch (e) {
      console.warn("Could not verify channel membership:", e.message);
      channelOk = false;
    }
  }

  if (settings.group_id) {
    try {
      const member = await ctx.telegram.getChatMember(settings.group_id, userId);
      groupOk = ["creator", "administrator", "member", "restricted"].includes(member.status);
    } catch (e) {
      console.warn("Could not verify group membership:", e.message);
      groupOk = false;
    }
  }

  // If both channel and group pass, mark user verified
  if (channelOk && groupOk) {
    setUserVerified(userId, true);
    return true;
  }

  return false;
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

  const joined = await checkMembership(ctx);
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
  const joined = await checkMembership(ctx);
  if (!joined) {
    return ctx.answerCbQuery("❌ You haven't joined both our Channel and Group yet. Please join and try again.", {
      show_alert: true
    });
  }

  setUserVerified(userId, true);
  await ctx.answerCbQuery("🎉 Verified successfully!");
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
    if (userId && !isUserVerified(userId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("⚠️ Please join our Channel and Group first!", { show_alert: true });
      }
      return ctx.reply(
        `⚠️ Access Denied!\nYou must join our Channel and Group before using any bot features.\n\n📢 Channel: ${settings.channel_link}\n👥 Group: ${settings.group_link}\n\n👇 After joining, tap "Check / I Have Joined" below:`,
        forceJoinKeyboard()
      );
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

  const products = getProducts();
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

  if (!p) {
    return ctx.reply("❌ Product not found.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Catalog", "menu:buy")]]));
  }

  if (p.outOfStock || p.stock <= 0) {
    return ctx.reply(
      `⚠️ ${p.name} is currently out of stock.\nPlease check back later or choose another item.`,
      Markup.inlineKeyboard([[Markup.button.callback("🔙 Back to Products", "menu:buy")]])
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
    [Markup.button.callback("🔙 Back to Products", "menu:buy")]
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

// Quantity selected -> Show Product Description & Terms
bot.action(/^qty:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const productId = ctx.match[1];
  const qty = Number(ctx.match[2]);
  await showOrderConfirmation(ctx, productId, qty);
});

async function showOrderConfirmation(ctx, productId, qty) {
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

  const text = `${p.description}

━━━━━━━━━━━━━━━
✍️ Terms
${p.terms}

━━━━━━━━━━━━━━━
📦 Order Details:
• Product: ${p.name}
• Quantity: ${qty}
• Unit Price: ${money(unitPrice)}
• Total Due: ${money(totalPrice)}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I have read — Continue to Payment", "order:pay_check")],
    [Markup.button.callback("❌ Cancel Order", "menu:buy")]
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
  const text = `👛 Confirm Payment

Product: ${p.name}
Quantity: ${pending.quantity}
Total Price: ${money(needed)}
Your Balance: ${money(currentBal)}
Balance After: ${money(currentBal - needed)}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(`⚡ Pay ${money(needed)} from Wallet`, "order:execute_pay")],
    [Markup.button.callback("❌ Cancel", "menu:buy")]
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

  await ctx.reply(deliveryText, Markup.inlineKeyboard([
    [Markup.button.callback("💰 My Orders", "menu:orders")],
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
  const suggestedAmount = ctx.match[1] ? Number(ctx.match[1]) : 10;

  const text = `💳 Select Deposit Method:

Please choose how you would like to deposit funds to your wallet:`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🟡 Binance Pay (Instant)", `deposit:binance:${suggestedAmount}`)],
    [Markup.button.callback("🌐 USDT (BEP20 / Polygon)", `deposit:crypto:${suggestedAmount}`)],
    [Markup.button.callback("🔙 Back to Wallet", "menu:wallet")]
  ]);

  try {
    await ctx.editMessageText(text, buttons);
  } catch (e) {
    await ctx.reply(text, buttons);
  }
});

// Binance Pay prompt
bot.action(/^deposit:binance(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 1;

  ctx.session.depositMethod = "BINANCE_PAY";
  ctx.session.awaitingDepositAmount = true;

  const settings = getAllSettings();
  const text = `Deposit via Binance Pay

Enter the amount in USDT you want to add to your wallet

Minimum: ${money(settings.min_binance_deposit || 0.5)} · Maximum: ${money(settings.max_binance_deposit || 10)}
For more than $10, use the USDT BEP20 method.`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("0.50 USDT", `dep_bin_set:0.50`),
      Markup.button.callback("1.00 USDT", `dep_bin_set:1.00`),
      Markup.button.callback("5.00 USDT", `dep_bin_set:5.00`),
      Markup.button.callback("10.00 USDT", `dep_bin_set:10.00`)
    ],
    [Markup.button.callback("🔙 Back", "deposit:start")]
  ]);

  try {
    await ctx.editMessageText(text, buttons);
  } catch (e) {
    await ctx.reply(text, buttons);
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

  const text = `🟡 Binance Pay Deposit

Deposit ID: ${deposit.id}

💰 Amount to send: ${money(deposit.amount)}
💵 Binance Pay ID: ${settings.binance_pay_id}

⚠️ Important:
• Open your Binance app, go to Pay -> Send
• Enter Binance Pay ID: ${settings.binance_pay_id}
• Send exactly ${money(deposit.amount)}
• Once sent, tap "I've Paid" below to submit your transaction ID / screenshot`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  await ctx.reply(text, buttons);
}

// USDT BEP20 / Polygon deposit
bot.action(/^deposit:crypto(?::([\d.]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = ctx.match[1] ? Number(ctx.match[1]) : 40.0;
  await showCryptoDepositInstructions(ctx, amount);
});

async function showCryptoDepositInstructions(ctx, amount) {
  const settings = getAllSettings();
  const user = getOrCreateUser(ctx.from);
  const address = settings.bep20_usdt_address || "0xC3fC8C91A5B26C71DcD0aC1F34944FB298bCeBbF";

  const deposit = createDeposit({
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : user.first_name,
    amount: amount,
    method: "USDT_BEP20",
    address: address
  });

  ctx.session.activeDepositId = deposit.id;

  const text = `Deposit ID: ${deposit.id}

💰 Amount to send: ${Number(deposit.amount).toFixed(2)} USDT
Send a little more or less if you like — you're credited with exactly what arrives.

💵 To this address:
${address}

⚠️ Important:
• Send USDT on BEP20 (BSC) or Polygon only — the same address works on each
• This address is yours forever — save it and reuse it anytime
• No hash needed — it's credited automatically once it lands on-chain
• Already sent it? Tap "I've Paid" below to check right now`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Paid", `deposit_paid:${deposit.id}`)],
    [Markup.button.callback("❌ Cancel", "menu:wallet")]
  ]);

  try {
    const qrBuffer = await QRCode.toBuffer(address, { width: 300, margin: 1 });
    await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption: text,
        ...buttons
      }
    );
  } catch (err) {
    await ctx.reply(text, buttons);
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
    `📩 Please send your Transaction Hash (TxID) or payment screenshot below for Deposit ${depositId}:`,
    Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "menu:wallet")]])
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
    return showOrderConfirmation(ctx, productId, qty);
  }

  // If waiting for Binance Pay custom deposit amount
  if (ctx.session.awaitingDepositAmount) {
    ctx.session.awaitingDepositAmount = null;
    const amt = parseFloat(text);
    const settings = getAllSettings();
    const min = settings.min_binance_deposit || 0.5;
    const max = settings.max_binance_deposit || 10;
    if (isNaN(amt) || amt < min || amt > max) {
      return ctx.reply(`❌ Invalid amount. Must be between ${min} and ${max} USDT.`);
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

// API KEY
async function showApiKey(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx.from);

  const text = `🆙 DEVELOPER API

Integrate our instant digital product dispensary into your own bot or website!

🔑 Your API Key:
${user.api_key}

Endpoints:
• GET /api/products — View products & live stock
• POST /api/order — Create automated order

Keep your API key confidential!`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Regenerate Key", "api:regenerate")],
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

bot.action("api:regenerate", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const newKey = regenerateApiKey(ctx.from.id);
  await ctx.reply(
    `✅ New API Key generated:\n${newKey}`,
    Markup.inlineKeyboard([[Markup.button.callback("🔙 API Menu", "menu:apikey")]])
  );
});

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

  let text = "🛍️ MANAGE PRODUCTS:\nSelect a product to edit stock or prices:";
  const buttons = products.map((p) => [
    Markup.button.callback(
      `${p.name} • Stock: ${p.stock} (${p.outOfStock ? "OUT" : "IN"})`,
      `adm_edit_prod:${p.id}`
    )
  ]);
  buttons.push([Markup.button.callback("🔙 Admin Menu", "adm:menu")]);

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
});

bot.action(/^adm_edit_prod:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  const p = getProduct(ctx.match[1]);
  if (!p) return ctx.reply("Product not found.");

  const text = `🛍️ EDIT PRODUCT: ${p.name}
• Base Price: ${money(p.price)}
• Current Stock: ${p.stock}
• Status: ${p.outOfStock ? "🚫 Out of Stock" : "✅ Available"}
• Pre-loaded Codes: ${Array.isArray(p.codes) ? p.codes.length : 0}`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback("📦 Add Digital Codes", `adm_add_codes:${p.id}`),
      Markup.button.callback("🔢 Set Stock Number", `adm_set_stock:${p.id}`)
    ],
    [
      Markup.button.callback("💲 Set Price", `adm_set_price:${p.id}`),
      Markup.button.callback(p.outOfStock ? "🟢 Mark In Stock" : "🔴 Mark Out of Stock", `adm_toggle_stock:${p.id}`)
    ],
    [Markup.button.callback("🔙 Products List", "adm:products")]
  ]);

  await ctx.reply(text, buttons);
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
  ctx.session.adminAction = { type: "set_price", productId: ctx.match[1] };
  await ctx.reply(`Enter new price in USDT for product ${ctx.match[1]} (e.g. 0.65):`);
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
• Binance Pay ID: ${s.binance_pay_id}
• Support Handle: ${s.support_username}
• Group Sales Broadcast: ${s.fake_sales_broadcast_enabled !== false ? "✅ ENABLED (~2 mins)" : "❌ DISABLED"}`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback(s.force_join_enabled ? "🔴 Disable Force Join" : "🟢 Enable Force Join", "adm_toggle_fj")],
    [Markup.button.callback(s.fake_sales_broadcast_enabled !== false ? "🔴 Turn OFF Group Broadcast" : "🟢 Turn ON Group Broadcast", "adm_toggle_fake_sales")],
    [Markup.button.callback("✏️ Edit Channel", "adm_set_chan"), Markup.button.callback("✏️ Edit Group", "adm_set_grp")],
    [Markup.button.callback("✏️ Edit USDT Address", "adm_set_usdt"), Markup.button.callback("✏️ Edit Binance Pay ID", "adm_set_binpay")],
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

bot.action("adm_set_usdt", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.adminAction = { type: "set_usdt_addr" };
  await ctx.reply("Enter new BEP20/Polygon USDT Address:");
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

// Handle admin text inputs
async function handleAdminTextInput(ctx, text) {
  const action = ctx.session.adminAction;
  ctx.session.adminAction = null;

  switch (action.type) {
    case "set_price": {
      const price = parseFloat(text);
      if (isNaN(price)) return ctx.reply("❌ Invalid price number.");
      updateProduct(action.productId, { price });
      return ctx.reply(`✅ Updated price of ${action.productId} to ${money(price)}`);
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
    case "set_usdt_addr": {
      setSetting("bep20_usdt_address", text);
      setSetting("polygon_usdt_address", text);
      return ctx.reply(`✅ USDT Address updated to:\n${text}`);
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
    return gemini.name;
  }

  const others = products.filter(p => p.id !== "gemini_18m");
  if (others.length > 0) {
    return others[Math.floor(Math.random() * others.length)].name;
  }
  return gemini ? gemini.name : "Gemini Links 18M";
}

function pickBroadcastQuantity() {
  const rand = Math.random();
  if (rand < 0.60) return 1;
  if (rand < 0.80) return 2;
  if (rand < 0.92) return 5;
  if (rand < 0.98) return 10;
  return 20;
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendGroupPurchaseNotice(productName, quantity, maskedId = null) {
  const settings = getAllSettings();
  const groupId = settings.group_id;
  if (!groupId) return;

  const id = maskedId || generateUniqueMaskedId();
  const timeStr = formatTimeRandomCountry();

  const msg = `<blockquote>✨ <b>NEW VERIFIED PURCHASE</b> ✨
━━━━━━━━━━━━━━━━━━
👤 <b>Buyer ID:</b> <code>${id}</code>
🛍️ <b>Product:</b> <b>${escapeHtml(productName)}</b>
🔢 <b>Quantity:</b> <b>${quantity}x License</b>
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
      const prodName = pickBroadcastProduct();
      const qty = pickBroadcastQuantity();
      await sendGroupPurchaseNotice(prodName, qty);
    }
    scheduleNextPurchaseBroadcast();
  }, delayMs);
}

// =====================================================
// SERVER & WEBHOOK / POLLING INITIALIZATION
// =====================================================
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;

let server;
let isShuttingDown = false;

if (WEBHOOK_URL) {
  const cleanUrl = WEBHOOK_URL.replace(/\/+$/, "");
  const secretPath = `/webhook/${bot.secretPathComponent ? bot.secretPathComponent() : "telegraf"}`;
  app.use(bot.webhookCallback(secretPath));

  server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
    if (!isBroadcasterStarted) {
      isBroadcasterStarted = true;
      scheduleNextPurchaseBroadcast();
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

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================
const stopApp = (signal) => {
  console.log(`Stopping bot and server on ${signal}...`);
  isShuttingDown = true;
  if (server) server.close();
  bot.stop(signal);
};

process.once("SIGINT", () => stopApp("SIGINT"));
process.once("SIGTERM", () => stopApp("SIGTERM"));