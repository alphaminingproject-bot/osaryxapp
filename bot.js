/* ============================================================
   bot.js — OSARYX (Deno Deploy)

   Handles both the Telegram bot AND the admin API.
   All secrets live in Deno env vars — nothing hardcoded.

   Env vars to set in Deno Deploy → Settings → Environment Variables:
     BOT_TOKEN        = bot token from BotFather
     SUPABASE_URL     = your Supabase project URL
     SUPABASE_KEY     = Supabase SERVICE ROLE key  ← use service role for admin writes
     SUPABASE_ANON    = Supabase ANON key          ← for public bot reads
     BOT_USERNAME     = bot username without @
     APP_NAME         = mini app short name from BotFather
     ADMIN_PASSWORD   = your chosen admin password
     TOTP_SECRET      = base32 TOTP secret from Google Authenticator
     TON_ADDRESS      = your TON wallet address
     TON_PRICE        = e.g. 2
     ZEUS_STARS_PRICE = 150
   ============================================================ */

const BOT_TOKEN        = Deno.env.get("BOT_TOKEN");
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY     = Deno.env.get("SUPABASE_KEY");     /* service role — admin ops */
const SUPABASE_ANON    = Deno.env.get("SUPABASE_ANON") || Deno.env.get("SUPABASE_KEY");
const BOT_USERNAME     = Deno.env.get("BOT_USERNAME") || "";
const APP_NAME         = Deno.env.get("APP_NAME") || "app";
const ADMIN_PASSWORD   = Deno.env.get("ADMIN_PASSWORD") || "";
const TOTP_SECRET      = Deno.env.get("TOTP_SECRET") || "";
const TON_ADDRESS      = Deno.env.get("TON_ADDRESS") || "";
const TON_PRICE        = Deno.env.get("TON_PRICE") || "2";
const ZEUS_STARS_PRICE = parseInt(Deno.env.get("ZEUS_STARS_PRICE") || "150", 10);

/* ── Session store (in-memory, resets on cold start — acceptable for single-admin use) ── */
const SESSIONS = new Map(); /* token → expiry timestamp */
const SESSION_TTL_MS = 8 * 3600 * 1000; /* 8 hours */

function genToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
}

function validateSession(req) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return false;
  const exp = SESSIONS.get(token);
  if (!exp || Date.now() > exp) { SESSIONS.delete(token); return false; }
  return true;
}

/* ── TOTP (RFC 6238, SHA-1, 30s step) ── */
const TOTP = (() => {
  function b32ToBytes(s) {
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    s = s.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
    let bits = 0, val = 0;
    const out = [];
    for (const ch of s) {
      val = (val << 5) | alpha.indexOf(ch);
      bits += 5;
      if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
    }
    return new Uint8Array(out);
  }
  function intToBytes(n) {
    const a = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { a[i] = n & 0xff; n = Math.floor(n / 256); }
    return a;
  }
  async function verify(secret, token) {
    const key = await crypto.subtle.importKey(
      "raw", b32ToBytes(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const step = Math.floor(Date.now() / 1000 / 30);
    const tok  = String(token).replace(/\s/g, "").padStart(6, "0");
    for (const t of [step - 1, step, step + 1]) {
      const sig  = new Uint8Array(await crypto.subtle.sign("HMAC", key, intToBytes(t)));
      const off  = sig[19] & 0x0f;
      const code = (((sig[off]&0x7f)<<24)|(sig[off+1]<<16)|(sig[off+2]<<8)|sig[off+3]) % 1000000;
      if (String(code).padStart(6, "0") === tok) return true;
    }
    return false;
  }
  return { verify };
})();

/* ── Supabase helpers (service role for admin, anon for bot) ── */
function sbHdr(key) {
  return { "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key };
}

async function sbGet(table, query, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_KEY : SUPABASE_ANON;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHdr(key) });
    return await r.json();
  } catch (e) { console.error("sbGet failed", table, e); return []; }
}

async function sbPost(table, body, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_KEY : SUPABASE_ANON;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sbHdr(key), Prefer: "return=representation" },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) { console.error("sbPost failed", table, e); return null; }
}

async function sbPatch(table, query, body, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_KEY : SUPABASE_ANON;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: "PATCH",
      headers: { ...sbHdr(key), Prefer: "return=minimal" },
      body: JSON.stringify(body)
    });
  } catch (e) { console.error("sbPatch failed", table, e); }
}

async function sbDelete(table, query, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_KEY : SUPABASE_ANON;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      method: "DELETE", headers: { ...sbHdr(key), Prefer: "return=minimal" }
    });
  } catch (e) { console.error("sbDelete failed", table, e); }
}

async function sbUpsert(table, body, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_KEY : SUPABASE_ANON;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sbHdr(key), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body)
    });
  } catch (e) { console.error("sbUpsert failed", table, e); }
}

function genTxnId(uid, amount) {
  const amtCents = Math.round(amount * 100);
  return "TXN" + String(uid) + Date.now() + (amtCents < 0 ? "9" : "0") + Math.abs(amtCents);
}

/* ── Telegram helpers ── */
async function tgSend(chatId, text, extra = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra })
    });
    const d = await r.json();
    if (!d.ok) console.error("tgSend FAILED for", chatId, "-", JSON.stringify(d));
    return d;
  } catch (e) { console.error("tgSend threw", e); return null; }
}

async function tgSendWithOpenAppButton(chatId, text) {
  return tgSend(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "⚡ Open App", url: `https://t.me/${BOT_USERNAME}/?startapp` }]]
    }
  });
}

async function tgGetChatMember(chatId, userId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${chatId}&user_id=${userId}`);
    const d = await r.json();
    if (!d.ok) return { isMember: false, error: d.description || "unknown" };
    return { isMember: ["member","administrator","creator"].includes(d.result?.status), error: null };
  } catch (e) { return { isMember: false, error: String(e) }; }
}

async function tgCreateStarsInvoice(title, desc, payload, stars) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: desc, payload, currency: "XTR", prices: [{ label: title, amount: stars }] })
    });
    const d = await r.json();
    if (!d.ok) { console.error("createInvoiceLink error:", JSON.stringify(d)); return null; }
    return d.result;
  } catch (e) { console.error("createInvoiceLink threw", e); return null; }
}

async function tgAnswerPreCheckout(queryId) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pre_checkout_query_id: queryId, ok: true })
  });
}

function WELCOME_MESSAGE(name) {
  return `🔮 <b>Welcome to OSARYX, ${name}!</b>\n\n` +
    `OSARYX is a mining realm built inside Telegram. Tap in daily to harvest OSARYX tokens, complete quests to earn more, and climb the leaderboard.\n\n` +
    `Stake tokens in the Eternal Vault for steady yield, bind mystic runes to boost your mining rate, and browse exclusive NFTs tied to real value sent directly to your wallet.\n\n` +
    `Invite others and earn a share of everything they harvest, indefinitely.\n\n` +
    `Tap below to enter the realm.`;
}

/* ── CORS ── */
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function ok(data)          { return new Response(JSON.stringify(data),          { headers: { ...CORS, "Content-Type": "application/json" } }); }
function err(msg, status)  { return new Response(JSON.stringify({ error: msg }), { status: status||400, headers: { ...CORS, "Content-Type": "application/json" } }); }
function unauth()          { return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } }); }

/* ════════════════════════════════════════════
   ADMIN ACTION HANDLER
   All DB mutations for the admin go through here.
   The session token is validated before any action runs.
════════════════════════════════════════════ */
async function handleAdminAction(action, params) {
  const SR = true; /* use service role for all admin writes */

  switch (action) {

    case "adjust_balance": {
      const rows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, SR);
      if (!rows.length) throw new Error("User not found");
      const u = rows[0];
      const newBal = Math.max(0, parseFloat(u.balance) + parseFloat(params.amount));
      const label = params.amount >= 0 ? "Balance credit by admin" : "Balance deduction by admin";
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { balance: newBal }, SR);
      await sbPost("transactions", { txn_id: genTxnId(params.uid, params.amount), tg_user_id: String(params.uid), user_name: u.name||"", type: "admin_adjust", description: label, amount: parseFloat(params.amount), balance_after: newBal, ts: Date.now() }, SR);
      return { ok: true };
    }

    case "cancel_vault": {
      const uRows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, SR);
      if (!uRows.length) throw new Error("User not found");
      const u = uRows[0];
      const newBal = parseFloat(u.balance) + parseFloat(params.amount);
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { balance: newBal }, SR);
      await sbDelete("vaults", `id=eq.${encodeURIComponent(params.vault_id)}`, SR);
      await sbPost("transactions", { txn_id: genTxnId(params.uid, params.amount), tg_user_id: String(params.uid), user_name: u.name||"", type: "unstake", description: "Admin cancelled vault — principal refunded", amount: parseFloat(params.amount), balance_after: newBal, ts: Date.now() }, SR);
      return { ok: true };
    }

    case "fill_vault": {
      const uRows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, SR);
      if (!uRows.length) throw new Error("User not found");
      const u = uRows[0];
      const payout = parseFloat(params.amount) + parseFloat(params.yield_amt);
      const newBal = parseFloat(u.balance) + payout;
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { balance: newBal }, SR);
      await sbDelete("vaults", `id=eq.${encodeURIComponent(params.vault_id)}`, SR);
      await sbPost("transactions", { txn_id: genTxnId(params.uid, payout), tg_user_id: String(params.uid), user_name: u.name||"", type: "unstake", description: "Admin force-filled vault — principal + yield paid", amount: payout, balance_after: newBal, ts: Date.now() }, SR);
      return { ok: true };
    }

    case "ban_user": {
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { is_banned: true }, SR);
      await sbPost("banned_users", { tg_id: String(params.uid), reason: params.reason||"", banned_at: Date.now() }, SR);
      return { ok: true };
    }

    case "unban_user": {
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { is_banned: false }, SR);
      return { ok: true };
    }

    case "send_message": {
      await sbPost("admin_messages", { tg_user_id: String(params.uid), message: params.message, sent: false, ts: Date.now() }, SR);
      await tgSendWithOpenAppButton(params.uid, params.message);
      return { ok: true };
    }

    case "approve_ref": {
      await sbPatch("referrals", `referrer_id=eq.${encodeURIComponent(params.referrer_id)}&referee_id=eq.${encodeURIComponent(params.referee_id)}`, { ref_status: "verified" }, SR);
      await sbPatch("ref_queue", `id=eq.${params.queue_id}`, { queue_status: "verified" }, SR);
      /* Bonus to referrer */
      const refRows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.referrer_id)}`, SR);
      if (refRows.length) {
        const ref = refRows[0];
        const newBal = parseFloat(ref.balance) + 100;
        await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.referrer_id)}`, { balance: newBal }, SR);
        await sbPost("transactions", { txn_id: genTxnId(params.referrer_id, 100), tg_user_id: String(params.referrer_id), user_name: ref.name||"", type: "ref_bonus", description: "Referral verified bonus", amount: 100, balance_after: newBal, ts: Date.now() }, SR);
      }
      /* Settle auto-ref tasks async — don't await, respond immediately */
      settleAutoRefTasks(String(params.referrer_id), SR).catch(e => console.error('settleAutoRefTasks failed', e));
      return { ok: true };
    }

    case "reject_ref": {
      await sbPatch("ref_queue", `id=eq.${params.queue_id}`, { queue_status: "rejected" }, SR);
      return { ok: true };
    }

    case "approve_x": {
      await sbPatch("x_queue", `id=eq.${params.queue_row_id}`, { queue_status: "verified", notified: false }, SR);
      const uRows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, SR);
      if (uRows.length && params.reward > 0) {
        const u = uRows[0];
        const taskStates     = JSON.parse(u.task_states     || "{}");
        const completedTasks = JSON.parse(u.completed_tasks || "{}");
        completedTasks[params.task_id] = true;
        taskStates[params.task_id] = "done";
        const newBal = parseFloat(u.balance) + parseFloat(params.reward);
        await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, {
          balance: newBal,
          task_states: JSON.stringify(taskStates),
          completed_tasks: JSON.stringify(completedTasks)
        }, SR);
        await sbPost("transactions", { txn_id: genTxnId(params.uid, params.reward), tg_user_id: String(params.uid), user_name: u.name||"", type: "task", description: "X task verified: " + params.task_id, amount: parseFloat(params.reward), balance_after: newBal, ts: Date.now() }, SR);
      }
      return { ok: true };
    }

    case "reject_x": {
      await sbPatch("x_queue", `id=eq.${params.queue_row_id}`, { queue_status: "rejected", notified: false }, SR);
      const uRows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, SR);
      if (uRows.length) {
        const u = uRows[0];
        const taskStates = JSON.parse(u.task_states || "{}");
        taskStates[params.task_id] = "rejected";
        await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { task_states: JSON.stringify(taskStates) }, SR);
      }
      await sbPost("admin_messages", { tg_user_id: String(params.uid), message: "❌ Your quest submission was not verified. Tap the task icon to complete it again, then resubmit.", sent: false, ts: Date.now() }, SR);
      await tgSendWithOpenAppButton(params.uid, "❌ Your quest submission was not verified. Tap the task icon in the app to complete it again, then resubmit.");
      return { ok: true };
    }

    case "dispatch_nft": {
      /* Atomic: only patch if still pending */
      const r = await fetch(`${SUPABASE_URL}/rest/v1/nft_requests?req_id=eq.${encodeURIComponent(params.req_id)}&req_status=eq.pending`, {
        method: "PATCH",
        headers: { ...sbHdr(SUPABASE_KEY), Prefer: "return=representation" },
        body: JSON.stringify({ req_status: "sent", txn_id: params.txn_id, notified: false })
      });
      const patched = await r.json();
      if (!Array.isArray(patched) || !patched.length) throw new Error("Already dispatched or not found");
      await sbPatch("nft_listings", `id=eq.${encodeURIComponent(params.nft_id)}`, { dispatch_status: "sent" }, SR);
      const req = patched[0];
      await tgSendWithOpenAppButton(req.tg_user_id,
        `✅ Your relic has been dispatched!\n\nNFT: ${req.nft_name||params.nft_id}\nTransaction ID: ${params.txn_id}`);
      return { ok: true };
    }

    case "dispatch_osaryx_nft": {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/osaryx_nft_requests?req_id=eq.${encodeURIComponent(params.req_id)}&req_status=eq.pending`, {
        method: "PATCH",
        headers: { ...sbHdr(SUPABASE_KEY), Prefer: "return=representation" },
        body: JSON.stringify({ req_status: "sent", txn_id: params.txn_id, notified: false })
      });
      const patched = await r.json();
      if (!Array.isArray(patched) || !patched.length) throw new Error("Already dispatched or not found");
      await sbPatch("osaryx_nfts", `id=eq.${encodeURIComponent(params.nft_id)}`, { dispatch_status: "sent" }, SR);
      const req = patched[0];
      await tgSendWithOpenAppButton(req.tg_user_id,
        `✅ Your OSARYX NFT has been dispatched!\n\nSent: ${params.nft_name || req.nft_name || params.nft_id}\nTransaction ID: ${params.txn_id}`);
      return { ok: true };
    }

    case "approve_epic_gods": {
      await sbPatch("epic_gods_requests", `id=eq.${params.req_id}`, { req_status: "verified", verified_at: Date.now() }, SR);
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, {
        zeus_active_until: Date.now() + 7*86400000,
        zeus_started_at:   Date.now(),
        zeus_settled_balance: 0
      }, SR);
      await tgSendWithOpenAppButton(params.uid, "⚡ Zeus, God of Lightning, has answered your call! 10× mining speed is now active for 7 days.");
      return { ok: true };
    }

    case "reject_epic_gods": {
      await sbPatch("epic_gods_requests", `id=eq.${params.req_id}`, { req_status: "rejected" }, SR);
      return { ok: true };
    }

    case "add_task": {
      const t = params.task;
      await sbPost("tasks", {
        id: t.id, name: t.name, description: t.desc||"", reward: t.reward,
        task_type: t.type, icon: t.icon||"🎯", target: t.target||"",
        x_follow: t.xFollow||false, auto_ref: t.autoRef||null,
        click_cap: t.clickCap||null, click_count: 0, sort_order: t.sortOrder||0
      }, SR);
      return { ok: true };
    }

    case "delete_task": {
      await sbDelete("tasks", `id=eq.${encodeURIComponent(params.task_id)}`, SR);
      return { ok: true };
    }

    case "create_event": {
      const ev = params.event;
      await sbPost("events", {
        id: ev.id, name: ev.name, icon: ev.icon||"📣",
        description: ev.desc||"", tasks: JSON.stringify(ev.tasks||[]),
        reward: ev.reward||0, expires_at: ev.expiresAt||null, created_at: Date.now()
      }, SR);
      return { ok: true };
    }

    case "delete_event": {
      await sbDelete("events", `id=eq.${encodeURIComponent(params.event_id)}`, SR);
      return { ok: true };
    }

    case "create_nft_listing": {
      const n = params.nft;
      await sbPost("nft_listings", { id: n.id, name: n.name, img: n.img, chain: n.chain||"", worth: n.worth||0, sold: false, created_at: Date.now() }, SR);
      return { ok: true };
    }

    case "delete_nft_listing": {
      await sbDelete("nft_listings", `id=eq.${encodeURIComponent(params.nft_id)}`, SR);
      return { ok: true };
    }

    case "create_osaryx_nft": {
      const n = params.nft;
      await sbPost("osaryx_nfts", { id: n.id, name: n.name, img: n.img, chain: n.chain||"", worth: n.worth||0, sold: false, created_at: Date.now() }, SR);
      return { ok: true };
    }

    case "delete_osaryx_nft": {
      await sbDelete("osaryx_nfts", `id=eq.${encodeURIComponent(params.nft_id)}`, SR);
      return { ok: true };
    }

    case "airdrop": {
      const uRows = await sbGet("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, SR);
      if (!uRows.length) throw new Error("User not found: " + params.uid);
      const u = uRows[0];
      const newBal = parseFloat(u.balance) + parseFloat(params.amount);
      await sbPatch("users", `tg_id=eq.${encodeURIComponent(params.uid)}`, { balance: newBal }, SR);
      await sbPost("transactions", { txn_id: genTxnId(params.uid, params.amount), tg_user_id: String(params.uid), user_name: u.name||"", type: "airdrop", description: params.note||"Admin airdrop", amount: parseFloat(params.amount), balance_after: newBal, ts: Date.now() }, SR);
      return { ok: true };
    }

    case "set_maintenance": {
      await sbUpsert("maintenance", { id: 1, is_active: params.active, message: params.message||"" }, SR);
      return { ok: true };
    }

    default:
      throw new Error("Unknown action: " + action);
  }
}

/* ── Settle auto-ref tasks after a referral is verified ── */
async function settleAutoRefTasks(uid, sr) {
  const [uRows, refs, tasks] = await Promise.all([
    sbGet("users", `tg_id=eq.${encodeURIComponent(uid)}`, sr),
    sbGet("referrals", `referrer_id=eq.${encodeURIComponent(uid)}&ref_status=eq.verified`, sr),
    sbGet("tasks", `task_type=eq.auto_ref`, sr)
  ]);
  if (!uRows.length) return;
  const u = uRows[0];
  const verifiedCount = refs.length;
  let bal = parseFloat(u.balance);
  const completed = JSON.parse(u.completed_tasks || "{}");
  let changed = false;
  for (const task of tasks) {
    if (!task.auto_ref || completed[task.id]) continue;
    if (verifiedCount >= task.auto_ref) {
      completed[task.id] = true;
      bal += parseFloat(task.reward);
      await sbPost("transactions", { txn_id: genTxnId(uid, task.reward), tg_user_id: String(uid), user_name: u.name||"", type: "task", description: "Invocation task: " + task.name, amount: parseFloat(task.reward), balance_after: bal, ts: Date.now() }, sr);
      changed = true;
    }
  }
  if (changed) await sbPatch("users", `tg_id=eq.${encodeURIComponent(uid)}`, { balance: bal, completed_tasks: JSON.stringify(completed) }, sr);
}

/* ════════════════════════════════════════════
   MAIN SERVER
════════════════════════════════════════════ */
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  /* ── POST /admin-login ── */
  if (url.pathname === "/admin-login" && req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Bad request"); }
    if (!ADMIN_PASSWORD || !TOTP_SECRET) return err("Admin not configured", 500);
    if (body.password !== ADMIN_PASSWORD) return ok({ ok: false, error: "Incorrect password" });
    const valid = await TOTP.verify(TOTP_SECRET, body.totp);
    if (!valid) return ok({ ok: false, error: "Invalid authenticator code" });
    const token = genToken();
    SESSIONS.set(token, Date.now() + SESSION_TTL_MS);
    return ok({ ok: true, token });
  }

  /* ── GET /admin-verify ── */
  if (url.pathname === "/admin-verify" && req.method === "GET") {
    return ok({ ok: validateSession(req) });
  }

  /* ── GET /admin-read ── */
  if (url.pathname === "/admin-read" && req.method === "GET") {
    if (!validateSession(req)) return unauth();
    const q = url.searchParams.get("q") || "";
    const [path, qs] = q.split("?");
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    const SR = true;
    try {
      let data;
      switch (path) {
        case "users_leaderboard": {
          const limit = parseInt(params.limit||"100",10);
          data = await sbGet("users", `order=balance.desc&limit=${limit}&is_banned=eq.false`, SR);
          break;
        }
        case "users_admin": {
          if (params.q) {
            const s = encodeURIComponent(params.q.replace(/^@/,""));
            data = await sbGet("users", `or=(name.ilike.*${s}*,username.ilike.*${s}*,tg_id.eq.${s})&limit=100`, SR);
          } else {
            data = await sbGet("users", "order=last_seen.desc&limit=200", SR);
          }
          break;
        }
        case "user_count": {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/users?select=tg_id`, {
            headers: { ...sbHdr(SUPABASE_KEY), Prefer: "count=exact", Range: "0-0" }
          });
          const range = r.headers.get("content-range");
          data = { count: range ? (parseInt(range.split("/")[1],10)||0) : 0 };
          break;
        }
        case "user_find": {
          const q2 = (params.q||"").replace(/^@/,"");
          let rows = await sbGet("users", `tg_id=eq.${encodeURIComponent(q2)}`, SR);
          if (!rows.length) rows = await sbGet("users", `username=ilike.${encodeURIComponent(q2)}`, SR);
          data = rows[0] || null;
          break;
        }
        case "referrals":
          data = await sbGet("referrals", `referrer_id=eq.${encodeURIComponent(params.uid)}&order=created_at.desc`, SR);
          break;
        case "transactions":
          data = await sbGet("transactions", `tg_user_id=eq.${encodeURIComponent(params.uid)}&order=ts.desc&limit=${params.limit||20}`, SR);
          break;
        case "vaults":
          data = await sbGet("vaults", `tg_user_id=eq.${encodeURIComponent(params.uid)}&order=staked_at.desc`, SR);
          break;
        case "txn_find":
          data = (await sbGet("transactions", `txn_id=eq.${encodeURIComponent(params.id)}`, SR))[0] || null;
          break;
        case "global_stats":
          data = (await sbGet("global_stats", "id=eq.1", SR))[0] || { total_mined: 0 };
          break;
        case "maintenance":
          data = (await sbGet("maintenance", "id=eq.1", SR))[0] || { is_active: false, message: "" };
          break;
        case "tasks":
          data = await sbGet("tasks", "order=sort_order.asc", SR);
          break;
        case "events":
          data = await sbGet("events", "order=created_at.desc", SR);
          break;
        case "ref_queue":
          data = await sbGet("ref_queue", "order=ts.desc&limit=200", SR);
          break;
        case "x_queue":
          data = await sbGet("x_queue", "order=ts.desc&limit=200", SR);
          break;
        case "nft_listings":
          data = await sbGet("nft_listings", "order=created_at.desc", SR);
          break;
        case "nft_requests":
          data = await sbGet("nft_requests", "order=ts.desc&limit=200", SR);
          break;
        case "osaryx_nfts":
          data = await sbGet("osaryx_nfts", "order=created_at.desc", SR);
          break;
        case "osaryx_nft_requests":
          data = await sbGet("osaryx_nft_requests", "order=ts.desc&limit=200", SR);
          break;
        case "epic_gods_requests":
          data = await sbGet("epic_gods_requests", "order=ts.desc&limit=200", SR);
          break;
        case "task_click_log":
          data = await sbGet("task_click_log", `task_id=eq.${encodeURIComponent(params.task_id)}&order=ts.desc&limit=500`, SR);
          break;
        default:
          return err("Unknown query: " + path);
      }
      return ok({ data });
    } catch(e) {
      console.error("admin-read error:", path, e);
      return err(e.message||"Read failed", 500);
    }
  }

  /* ── POST /admin-action ── */
  if (url.pathname === "/admin-action" && req.method === "POST") {
    if (!validateSession(req)) return unauth();
    let body;
    try { body = await req.json(); } catch { return err("Bad request"); }
    try {
      const result = await handleAdminAction(body.action, body);
      return ok(result);
    } catch (e) {
      console.error("admin-action failed:", body?.action, e);
      return err(e.message || "Action failed", 500);
    }
  }

  /* ── GET /notify-app-open ── */
  if (url.pathname === "/notify-app-open" && req.method === "GET") {
    const userId = url.searchParams.get("user_id");
    if (!userId) return err("missing user_id");
    const rows = await sbGet("users", `tg_id=eq.${userId}&select=tg_id,name,welcomed`);
    const user = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (user && !user.welcomed) {
      await sbPatch("users", `tg_id=eq.${userId}`, { welcomed: true });
      await tgSendWithOpenAppButton(userId, WELCOME_MESSAGE(user.name || "Acolyte"));
    }
    return ok({ ok: true });
  }

  /* ── GET /check-member ── */
  if (url.pathname === "/check-member" && req.method === "GET") {
    const userId = url.searchParams.get("user_id");
    const chatId = url.searchParams.get("chat_id");
    if (!userId || !chatId) return err("missing params");
    const result = await tgGetChatMember(chatId, userId);
    return ok({ is_member: result.isMember, error: result.error });
  }

  /* ── GET /process-notifications ── */
  if (url.pathname === "/process-notifications" && req.method === "GET") {
    const queued = await sbGet("admin_messages", "sent=eq.false&order=ts.asc&limit=50");
    let processed = 0;
    if (Array.isArray(queued)) {
      for (const msg of queued) {
        await tgSendWithOpenAppButton(msg.tg_user_id, msg.message);
        await sbPatch("admin_messages", `id=eq.${msg.id}`, { sent: true });
        processed++;
      }
    }
    return ok({ processed });
  }

  /* ── GET /ton-config ── */
  if (url.pathname === "/ton-config" && req.method === "GET") {
    return ok({ address: TON_ADDRESS, ton_price: TON_PRICE, zeus_stars_price: ZEUS_STARS_PRICE, stars_price: ZEUS_STARS_PRICE });
  }

  /* ── POST /create-zeus-invoice ── */
  if (url.pathname === "/create-zeus-invoice" && req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Bad request"); }
    const userId = String(body.user_id || "");
    if (!userId) return err("missing user_id");
    const payload    = `zeus_${userId}_${Date.now()}`;
    const invoiceUrl = await tgCreateStarsInvoice("Zeus, God of Lightning", "10x mining speed for 7 days — accrues automatically, no claiming.", payload, ZEUS_STARS_PRICE);
    if (!invoiceUrl) return err("invoice creation failed", 500);
    return ok({ invoice_url: invoiceUrl, payload });
  }

  /* ── POST /webhook ── */
  if (url.pathname === "/webhook" && req.method === "POST") {
    let update;
    try { update = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
    console.log("Webhook:", JSON.stringify(update).slice(0, 300));

    if (update.pre_checkout_query) {
      await tgAnswerPreCheckout(update.pre_checkout_query.id);
      return new Response("OK");
    }

    if (update.message?.successful_payment) {
      const sp   = update.message.successful_payment;
      const tgId = String(update.message.from.id);
      const name = update.message.from.first_name || "Acolyte";
      await sbUpsert("epic_gods_requests", { tg_user_id: tgId, user_name: name, username: update.message.from.username||"", god_name: "zeus", pay_method: "stars", txn_ref: sp.telegram_payment_charge_id, req_status: "verified", ts: Date.now(), verified_at: Date.now() });
      await sbPatch("users", `tg_id=eq.${tgId}`, { zeus_active_until: Date.now()+7*86400000, zeus_started_at: Date.now() });
      await tgSendWithOpenAppButton(update.message.chat.id, `⚡ <b>Zeus has answered your call, ${name}!</b>\n\nThe God of Lightning empowers your harvest at <b>10×</b> speed for the next 7 days.`);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg || !msg.text) return new Response("OK");
    const chatId   = msg.chat.id;
    const tgId     = String(msg.from.id);
    const name     = msg.from.first_name || "Acolyte";
    const username = msg.from.username || "";
    const text     = msg.text.trim();

    if (text === "/start" || text.startsWith("/start ")) {
      const rows = await sbGet("users", `tg_id=eq.${tgId}&select=tg_id,welcomed`);
      const row  = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!row) {
        await sbUpsert("users", { tg_id: tgId, name, username, balance: 0, last_mine: 0, mine_interval_hours: 3, mine_multiplier: 1, welcomed: true, last_seen: Date.now(), created_at: Date.now() });
        await tgSendWithOpenAppButton(chatId, WELCOME_MESSAGE(name));
      } else if (!row.welcomed) {
        await sbPatch("users", `tg_id=eq.${tgId}`, { welcomed: true });
        await tgSendWithOpenAppButton(chatId, WELCOME_MESSAGE(name));
      } else {
        await tgSendWithOpenAppButton(chatId, `✦ <b>Welcome back, ${name}!</b>\n\nYour essence awaits.`);
      }
      return new Response("OK");
    }

    await tgSendWithOpenAppButton(chatId, `✦ <i>The oracle speaks only through the realm, ${name}.</i>`);
    return new Response("OK");
  }

  return new Response("OSARYX is running.", { headers: CORS });
});
