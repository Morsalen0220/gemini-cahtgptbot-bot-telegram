# Telegram Product Bot — Node.js 24

No native database module is used, so there is no `better-sqlite3` / Python / node-gyp requirement.

## Install

1. Copy `.env.example` to `.env`.
2. Set `BOT_TOKEN`.
3. Set the numeric Telegram ID in `ADMIN_TELEGRAM_ID`.
4. Run:

npm install
npm start

## Admin

Send `/admin` from the configured admin Telegram account.

You can update:
- Product name
- Product details
- Product image
- 1 KG package name/details/price
- 500 GM package name/details/price
- Budget Friendly package name/details/price
- Bank name/account name/account number/branch
- USDT network/address
- BTC address
- View submitted orders
- Approve/reject payments

Orders and settings are stored in `data/bot-data.json`.

Payment verification is manual: the customer submits "I Have Paid", then the admin approves or rejects it.
