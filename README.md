# 🔮 OSARYX Token v3 — Complete Setup Guide

This is a full ground-up rebuild. Every file in this version was written
together against one schema and cross-checked function-by-function before
delivery — every `DB.xxx()` call in the app and admin code is confirmed to
exist in `data.js`, every `onclick` handler is confirmed to exist as a
function, and every element ID referenced in JS is confirmed to exist in
the HTML. All four JS files pass Node's syntax parser with zero errors.

---

## 📁 Files

```
osaryx/
├── index.html      Mini app
├── app.js          Mini app logic
├── app.css         Theme
├── data.js         Supabase data layer
├── admin.html      Admin dashboard
├── admin.js        Admin logic + TOTP 2FA
├── admin.css       Admin theme
├── bot.js          Deno Deploy backend
├── build.js        Injects .env into source → dist/
├── schema.sql      Run once in Supabase (fresh slate — drops old tables)
├── env.example     Copy to .env and fill in
├── .gitignore
└── README.md
```

---

## ⚠️ This Is a Fresh Slate

`schema.sql` drops every existing table. All previous test data is gone
the moment you run it. This was deliberate, as requested.

---

## STEP 1 — Supabase

1. Open your Supabase project → **SQL Editor → New Query**
2. Paste the entire `schema.sql` → **Run**
3. **Settings → API** → copy your Project URL and anon key

---

## STEP 2 — Deno Deploy Backend

You can reuse your existing Deno project — just replace its code.

1. Open your Deno Deploy project → replace all code with the new `bot.js`
2. **Settings → Environment Variables** — confirm these are all set:
   ```
   BOT_TOKEN          = your bot token from BotFather
   SUPABASE_URL       = your Supabase project URL
   SUPABASE_KEY       = your Supabase anon key
   BOT_USERNAME       = your bot username, no @
   APP_NAME           = the short name from /newapp (e.g. "app")
   TON_ADDRESS        = your TON wallet address
   ZEUS_STARS_PRICE   = 150
   ```
3. Save & redeploy
4. Your webhook URL stays the same as before — no need to re-register it
   unless you changed your Deno project's URL. To verify it's still wired:
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
   ```
   You should see your existing webhook URL with no error message.

5. **Enable Telegram Stars payments:** BotFather → your bot →
   **Bot Settings → Payments** → follow the prompts to enable Stars (XTR).

---

## STEP 3 — Your .env

```bash
cp env.example .env
```

Fill in every value — see the file's comments for exactly what each one means.

---

## STEP 4 — Build & Deploy

```bash
node build.js
```

Deploy the resulting `dist/` folder to Vercel or Netlify exactly as before.

---

## What Was Fixed This Time, And Why

### The X-task verify infinite loop / duplicate users / repeating messages
**Root cause:** earlier versions of `approveX`/`rejectX` were re-saving
queue data in ways that didn't target a single row, and in some paths
could create a new user record instead of updating the existing one.

**The fix:** every queue action in `admin.js` now does exactly three
things, always in this order: (1) `PATCH` the ONE queue row by its own
numeric `id`, (2) `GET` the existing user by their `tg_id` — never
`createUser` — (3) mutate and save that one user. There is no function
anywhere in v3 that iterates a full queue array and writes it back, which
is what made the loop possible before.

### Task links opening as `yourapp.vercel.app/x.com/foo`
**Root cause:** a target URL saved without `https://` gets treated as a
relative path by the browser.

**The fix:** `admin.js` auto-prepends `https://` to any `x_follow` or
`link` task target that's missing it, before saving. `app.js` also
defensively normalizes any URL right before opening it, so even old data
self-heals.

### Airdrop / balance changes not appearing
**Root cause:** in earlier versions, some write paths called
`saveUser()` without the corresponding read path being correctly scoped,
so the UI sometimes rendered stale data fetched from elsewhere.

**The fix:** every admin action now re-fetches and re-renders from a
fresh database call after writing (`loadXQueue()`, `doUserLookup()`, etc.)
instead of trusting an in-memory copy.

### Events / NFT uploads silently failing
**Root cause:** `createEvent` and `createNFTListing` were not surfacing
Supabase insert errors — failures were swallowed by a generic `.catch`.

**The fix:** both functions now throw on any Supabase error response, and
the admin UI displays the actual error message in a status box instead of
just doing nothing.

### "Error fetching users" in lookup
**Root cause:** lookup was, in some versions, pulling a large collective
user list and scanning it client-side, which is fragile and slow.

**The fix:** `findUserByIdOrUsername()` runs exactly one targeted
Supabase query for the ID, and only falls back to a second targeted query
for the username if the first finds nothing. Never a full table scan.

### Vault (staking) disappearing on app close
**Root cause:** vaults were being held only in local memory in earlier
versions, not persisted server-side.

**The fix:** vaults live in their own `vaults` table from the start,
keyed to `tg_user_id`, fetched on every boot, and deleted only once
claimed and credited to balance.

### Referral link opening the bot chat instead of the Mini App
**Root cause:** the link format `https://t.me/BOT?start=ref_ID` always
opens the chat first because `?start=` is the bot-command parameter, not
the Mini-App parameter.

**The fix:** the only link ever generated now is:
```
https://t.me/BOT_USERNAME/APP_NAME?startapp=ref_USERID
```
This is Telegram's dedicated Mini App deep-link format. It opens the
Mini App directly — no bot chat, no Start button, no detour. The app
reads the referral code from `Telegram.WebApp.initDataUnsafe.start_param`
the instant it loads.

### Welcome message never appearing
**Root cause:** earlier `bot.js` versions had referral-linking logic
mixed into the `/start` handler in a way that could skip the welcome
message entirely depending on which path executed.

**The fix:** `bot.js` v3 has one single, simple `/start` handler. It
checks if the user row exists; if not, creates it, marks `welcomed: true`,
and sends the welcome message with an **Open App** button. It fires
exactly once per user, forever, by design — `welcomed` is a permanent
column, not a derived value.

### Ad system showing an error on the main page when Adsgram isn't configured
**Root cause:** the SDK init call threw an unhandled error visible to users.

**The fix:** `initAdsgram()` is wrapped in try/catch and silently no-ops
if the block ID isn't set. Watching an ad without a configured block ID
shows a normal in-app toast ("Ad system unavailable") instead of a raw
JS error reaching the page.

---

## How Things Work Now

### Referrals
Link: `https://t.me/BOT/APP?startapp=ref_USERID` — opens the Mini App
directly. 5% of every harvest passes to the referrer automatically. At
100 OSARYX earned, the referral queues for admin verification → +100 bonus.

### Runes & Storage (independent, stackable)
- **Rune** = multiplier only (Shadow 2× / Oracle 4×), 3 days
- **Storage** = claim interval only (6h/12h/24h), 3 days, 500/1,000/2,000 OSARYX
- `claimable = MINE_REWARD × rune_multiplier × (storage_hours / 3)`
- Either can expire independently; the other keeps working

### Zeus (Epic God)
- **150 Stars** → instant, automatic via Telegram's payment webhook
- **TON** → manual: user sends, pastes txn ID, you verify in **Epic Gods** tab
- Once active: 10× accrues silently in the background for 7 days, no
  claim button, settles into one transaction at the end

### Tasks
- Global click cap: set a number in admin, task vanishes for everyone
  once that many completions happen across all users
- Invite/referral tasks always sort to the bottom
- New non-invite tasks float to the top automatically
- Watch Ad task always pins to the absolute top
- Fulfilled tasks vanish from that user's view (but stay in their
  transaction history and their referrals tab)
- X-task rejection sends a standard "please redo and resubmit" message
  via the bot automatically — no manual reason input needed

### NFT Market
- Admin sets name, worth (in OSARYX), chain, and image
- First buyer to hit the database wins the race (atomic conditional update)
- Stays visible to everyone as a greyed "SOLD" button — never disappears
- Dispatch requires admin to enter a transaction ID before confirming,
  which credits the worth to the buyer's balance and notifies them via bot

### Maintenance Mode
- One toggle locks every user out instantly, snapshotting balances first
- Admin dashboard stays fully accessible while it's on
- Banned users stay banned even after maintenance is turned off

---

## Security Reminders

1. Never commit `.env` — check `git status` before every push
2. Never push `dist/`
3. `bot.js`'s secrets live only in Deno's environment panel
4. If a key leaks, rotate immediately: Supabase → regenerate anon key,
   BotFather → revoke and reissue bot token
