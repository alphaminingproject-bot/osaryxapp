/* ============================================================
   bot.js — OSARYX Telegram Bot Backend (Deno Deploy) v3

   Routes (all on the same deployment, routed by path):
     POST /webhook                — Telegram updates land here
     GET  /check-member           — channel membership check
     GET  /process-notifications  — flush queued admin_messages
     GET  /ton-config             — expose TON address to mini app
     POST /create-zeus-invoice    — create a Telegram Stars invoice

   ── SECRETS ──
   Set these in Deno Deploy → Settings → Environment Variables.
   NEVER hardcode them here.

   BOT_TOKEN          = your bot token from BotFather
   SUPABASE_URL       = your Supabase project URL
   SUPABASE_KEY       = your Supabase anon key
   BOT_USERNAME       = your bot's username, no @
   APP_NAME           = the short name you set in /newapp
   TON_ADDRESS        = your TON wallet address
   ZEUS_STARS_PRICE   = 150
   ============================================================ */

const BOT_TOKEN        = Deno.env.get("BOT_TOKEN");
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY     = Deno.env.get("SUPABASE_KEY");
const BOT_USERNAME     = Deno.env.get("BOT_USERNAME") || "";
const APP_NAME         = Deno.env.get("APP_NAME") || "app";
const TON_ADDRESS      = Deno.env.get("TON_ADDRESS") || "";
const ZEUS_STARS_PRICE = parseInt(Deno.env.get("ZEUS_STARS_PRICE") || "150", 10);

const SB_HDR = {
  "Content-Type":  "application/json",
  "apikey":        SUPABASE_KEY,
  "Authorization": "Bearer " + SUPABASE_KEY,
};

/* ── Telegram helpers ── */
async function tgSend(chatId, text, extra = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra })
    });
    const data = await res.json();
    if (!data.ok) console.error("tgSend error:", JSON.stringify(data));
    return data;
  } catch (e) {
    console.error("tgSend threw", e);
    return null;
  }
}

async function tgSendWithOpenAppButton(chatId, text) {
  return tgSend(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{
        text: "⚡ Open App",
        web_app: { url: `https://t.me/${BOT_USERNAME}/${APP_NAME}` }
      }]]
    }
  });
}

async function tgGetChatMember(chatId, userId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${chatId}&user_id=${userId}`);
    const data = await res.json();
    const status = data?.result?.status;
    return ["member", "administrator", "creator"].includes(status);
  } catch (e) {
    console.error("getChatMember failed", e);
    return false;
  }
}

async function tgCreateStarsInvoice(title, description, payload, amountStars) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, payload, currency: "XTR", prices: [{ label: title, amount: amountStars }] })
    });
    const data = await res.json();
    if (!data.ok) { console.error("createInvoiceLink error:", JSON.stringify(data)); return null; }
    return data.result;
  } catch (e) {
    console.error("createInvoiceLink threw", e);
    return null;
  }
}

async function tgAnswerPreCheckout(queryId, ok, errorMessage) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pre_checkout_query_id: queryId, ok, error_message: errorMessage || undefined })
  });
}

/* ── Supabase helpers ── */
async function sbSelect(table, query) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: SB_HDR });
    return await res.json();
  } catch (e) { console.error("sbSelect failed", table, e); return []; }
}
async function sbPatch(table, query, body) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method: "PATCH", headers: { ...SB_HDR, Prefer: "return=minimal" }, body: JSON.stringify(body) });
  } catch (e) { console.error("sbPatch failed", table, e); }
}
async function sbInsert(table, body) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: { ...SB_HDR, Prefer: "return=minimal" }, body: JSON.stringify(body) });
  } catch (e) { console.error("sbInsert failed", table, e); }
}
async function sbUpsert(table, body) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: { ...SB_HDR, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body) });
  } catch (e) { console.error("sbUpsert failed", table, e); }
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  /* ════════════════════════════════════════
     GET /check-member
  ════════════════════════════════════════ */
  if (url.pathname === "/check-member" && req.method === "GET") {
    const userId = url.searchParams.get("user_id");
    const chatId = url.searchParams.get("chat_id");
    if (!userId || !chatId) {
      return new Response(JSON.stringify({ is_member: false, error: "missing params" }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const isMember = await tgGetChatMember(chatId, userId);
    return new Response(JSON.stringify({ is_member: isMember }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  /* ════════════════════════════════════════
     GET /process-notifications — flush admin_messages queue
  ════════════════════════════════════════ */
  if (url.pathname === "/process-notifications" && req.method === "GET") {
    const queued = await sbSelect("admin_messages", "sent=eq.false&order=ts.asc&limit=50");
    let processed = 0;
    if (Array.isArray(queued)) {
      for (const msg of queued) {
        await tgSendWithOpenAppButton(msg.tg_user_id, msg.message);
        await sbPatch("admin_messages", `id=eq.${msg.id}`, { sent: true });
        processed++;
      }
    }
    return new Response(JSON.stringify({ processed }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  /* ════════════════════════════════════════
     GET /ton-config
  ════════════════════════════════════════ */
  if (url.pathname === "/ton-config" && req.method === "GET") {
    return new Response(JSON.stringify({ address: TON_ADDRESS }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  /* ════════════════════════════════════════
     POST /create-zeus-invoice
  ════════════════════════════════════════ */
  if (url.pathname === "/create-zeus-invoice" && req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
    const userId = String(body.user_id || "");
    if (!userId) return new Response(JSON.stringify({ error: "missing user_id" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

    const payload = `zeus_${userId}_${Date.now()}`;
    const invoiceUrl = await tgCreateStarsInvoice("Zeus, God of Lightning", "10x mining speed for 7 days — accrues automatically, no claiming.", payload, ZEUS_STARS_PRICE);
    if (!invoiceUrl) return new Response(JSON.stringify({ error: "invoice creation failed" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ invoice_url: invoiceUrl, payload }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  /* ════════════════════════════════════════
     POST /webhook — Telegram updates
  ════════════════════════════════════════ */
  if (url.pathname === "/webhook" && req.method === "POST") {
    let update;
    try { update = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }

    /* ── Telegram Stars: pre-checkout ── */
    if (update.pre_checkout_query) {
      await tgAnswerPreCheckout(update.pre_checkout_query.id, true);
      return new Response("OK");
    }

    /* ── Telegram Stars: payment succeeded ── */
    if (update.message?.successful_payment) {
      const sp = update.message.successful_payment;
      const tgId = String(update.message.from.id);
      const name = update.message.from.first_name || "Acolyte";
      const username = update.message.from.username || "";
      const chargeId = sp.telegram_payment_charge_id;

      await sbInsert("epic_gods_requests", { tg_user_id: tgId, user_name: name, username, god_name: "zeus", pay_method: "stars", txn_ref: chargeId, req_status: "verified", ts: Date.now(), verified_at: Date.now() });
      await sbPatch("users", `tg_id=eq.${tgId}`, { zeus_active_until: Date.now() + 7*86400000, zeus_started_at: Date.now() });

      await tgSendWithOpenAppButton(
        update.message.chat.id,
        `⚡ <b>Zeus has answered your call, ${name}!</b>\n\nThe God of Lightning empowers your harvest at <b>10×</b> speed for the next 7 days. Your essence accrues continuously — no further action needed.`
      );
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg || !msg.text) return new Response("OK");

    const chatId   = msg.chat.id;
    const tgId     = String(msg.from.id);
    const name     = msg.from.first_name || "Acolyte";
    const username = msg.from.username   || "";
    const text     = msg.text.trim();

    /* ── /start — welcome message fires ONLY the first time ── */
    if (text === "/start" || text.startsWith("/start ")) {
      const existing = await sbSelect("users", `tg_id=eq.${tgId}&select=tg_id,welcomed`);
      const userRow = Array.isArray(existing) && existing.length ? existing[0] : null;

      if (!userRow) {
        /* Brand new user — create shell row, send welcome */
        await sbUpsert("users", {
          tg_id: tgId, name, username, balance: 0, last_mine: 0,
          mine_interval_hours: 3, mine_multiplier: 1, welcomed: true,
          last_seen: Date.now(), created_at: Date.now()
        });
        await tgSendWithOpenAppButton(
          chatId,
          `🔮 <b>Welcome to OSARYX, ${name}!</b>\n\n` +
          `<i>The Mystic Token of the Ether awaits.</i>\n\n` +
          `✦ Harvest OSARYX from the ether\n` +
          `✦ Bind Runes to amplify your yield\n` +
          `✦ Consecrate OSARYX to the Eternal Vault\n` +
          `✦ Invoke souls and earn from their harvests\n\n` +
          `Tap below to enter the realm.`
        );
      } else if (!userRow.welcomed) {
        /* Existing row but somehow never welcomed (e.g. created via referral before their own /start) */
        await sbPatch("users", `tg_id=eq.${tgId}`, { welcomed: true });
        await tgSendWithOpenAppButton(
          chatId,
          `🔮 <b>Welcome to OSARYX, ${name}!</b>\n\nThe ether stirs. Tap below to begin your harvest.`
        );
      } else {
        /* Returning user */
        await tgSendWithOpenAppButton(chatId, `✦ <b>Welcome back, ${name}!</b>\n\nYour essence awaits.`);
      }
      return new Response("OK");
    }

    /* ── any other message ── */
    await tgSendWithOpenAppButton(chatId, `✦ <i>The oracle speaks only through the realm, ${name}.</i>`);
    return new Response("OK");
  }

  return new Response("OSARYX bot backend is running.", { headers: CORS });
});
