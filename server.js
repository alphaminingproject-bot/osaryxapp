/* ============================================================
   server.js — OSARYX Secure Admin Backend (Node.js)

   All secrets stay here. The browser never sees:
     ADMIN_PASSWORD, TOTP_SECRET, SUPABASE_SERVICE_KEY

   The mini app (index.html + app.js) uses the Supabase
   anon key directly — that key is intentionally public.

   The admin panel (admin.html + admin.js) talks only to
   this server for auth, and to Supabase via this server
   for any write that requires the service role key.

   Run:   node server.js
   Prod:  set PORT env var, run behind nginx/Railway/Render
   ============================================================ */

require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT          = process.env.PORT              || 3001;
const ADMIN_PW      = process.env.ADMIN_PASSWORD    || '';
const TOTP_SECRET   = process.env.TOTP_SECRET       || '';
const SB_URL        = process.env.SUPABASE_URL      || '';
const SB_ANON       = process.env.SUPABASE_ANON_KEY || '';
const SB_SVC        = process.env.SUPABASE_SERVICE_KEY || '';
const BOT_BACKEND   = process.env.BOT_BACKEND_URL   || '';

if (!ADMIN_PW)    console.warn('⚠  ADMIN_PASSWORD not set');
if (!TOTP_SECRET) console.warn('⚠  TOTP_SECRET not set');
if (!SB_SVC)      console.warn('⚠  SUPABASE_SERVICE_KEY not set — admin writes will fail');

/* ══════════════════════════════════════════════
   TOTP  (RFC 6238, SHA-1, 30s, 6 digits)
══════════════════════════════════════════════ */
function base32ToBytes(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) {
    val = (val << 5) | alpha.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const mac    = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[19] & 0x0f;
  const code   = (((mac[offset] & 0x7f) << 24) | (mac[offset+1] << 16) | (mac[offset+2] << 8) | mac[offset+3]) % 1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, token) {
  const key  = base32ToBytes(secret);
  const step = Math.floor(Date.now() / 1000 / 30);
  const tok  = String(token).replace(/\s/g, '').padStart(6, '0');
  return [step - 1, step, step + 1].some(t => hotp(key, t) === tok);
}

/* ══════════════════════════════════════════════
   SESSIONS  (in-memory, single admin)
   Token = 32 random bytes hex, 8-hour expiry
══════════════════════════════════════════════ */
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const t = sessions.get(token);
  if (!t) return false;
  if (Date.now() - t > 8 * 3600000) { sessions.delete(token); return false; }
  return true;
}

function getToken(req) {
  return (req.headers['authorization'] || '').replace('Bearer ', '').trim();
}

/* ══════════════════════════════════════════════
   SUPABASE HELPERS  (service role — admin writes)
══════════════════════════════════════════════ */
const SB_SVC_HDR = {
  'Content-Type':  'application/json',
  'apikey':        SB_SVC,
  'Authorization': 'Bearer ' + SB_SVC,
};
const SB_ANON_HDR = {
  'Content-Type':  'application/json',
  'apikey':        SB_ANON,
  'Authorization': 'Bearer ' + SB_ANON,
};

async function sbGet(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { headers: SB_SVC_HDR });
  return r.json();
}
async function sbPatch(table, query, body) {
  await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH', headers: { ...SB_SVC_HDR, Prefer: 'return=minimal' }, body: JSON.stringify(body)
  });
}
async function sbInsert(table, body) {
  await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...SB_SVC_HDR, Prefer: 'return=minimal' }, body: JSON.stringify(body)
  });
}
async function sbUpsert(table, body) {
  await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_SVC_HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body)
  });
}
async function sbDelete(table, query) {
  await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    method: 'DELETE', headers: { ...SB_SVC_HDR, Prefer: 'return=minimal' }
  });
}

/* ══════════════════════════════════════════════
   PUBLIC CONFIG  (no secrets — safe to send to browser)
══════════════════════════════════════════════ */
const PUBLIC_CONFIG = {
  TOKEN_NAME:               process.env.TOKEN_NAME              || 'OSARYX',
  MAX_SUPPLY:               process.env.MAX_SUPPLY              || '100000000',
  MINE_REWARD:              process.env.MINE_REWARD             || '100',
  REF_PERCENT:              process.env.REF_PERCENT             || '0.05',
  REF_BONUS:                process.env.REF_BONUS               || '100',
  REF_THRESHOLD:            process.env.REF_THRESHOLD           || '300',
  SHADOW_RUNE_COST:         process.env.SHADOW_RUNE_COST        || '1000',
  ORACLE_CORE_COST:         process.env.ORACLE_CORE_COST        || '2000',
  STAKE_DURATION_DAYS:      process.env.STAKE_DURATION_DAYS     || '7',
  NFT_SOLD_VISIBLE_MINUTES: process.env.NFT_SOLD_VISIBLE_MINUTES|| '10',
  BOT_USERNAME:             process.env.BOT_USERNAME            || '',
  APP_NAME:                 process.env.APP_NAME                || '',
  BOT_BACKEND_URL:          BOT_BACKEND,
  SUPABASE_URL:             SB_URL,
  SUPABASE_ANON_KEY:        SB_ANON,
};

/* ══════════════════════════════════════════════
   HTTP HELPERS
══════════════════════════════════════════════ */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 100000) req.destroy(); });
    req.on('end',  () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

/* ══════════════════════════════════════════════
   STATIC FILES  (served from /public)
══════════════════════════════════════════════ */
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html':'text/html', '.js':'application/javascript',
  '.css':'text/css',   '.json':'application/json',
  '.png':'image/png',  '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': mime });
    res.end(data);
  });
}

/* ══════════════════════════════════════════════
   ADMIN ACTION HANDLER
   All writes use the service role key here.
   Browser never touches this key.
══════════════════════════════════════════════ */
async function handleAdminAction(body) {
  const { action } = body;

  if (action === 'adjust_balance') {
    const { uid, amount, label } = body;
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(uid)}&select=balance,name`);
    if (!rows || !rows.length) return { error: 'User not found' };
    const newBal = parseFloat(rows[0].balance || 0) + parseFloat(amount);
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { balance: newBal });
    await sbInsert('transactions', {
      txn_id: 'TXN' + uid + Date.now() + Math.abs(Math.round(parseFloat(amount) * 100)),
      tg_user_id: String(uid), user_name: rows[0].name || '',
      type: 'admin_adjust',
      description: label || (parseFloat(amount) >= 0 ? 'Balance credit by admin' : 'Balance deduction by admin'),
      amount: parseFloat(amount), balance_after: newBal, ts: Date.now()
    });
    return { ok: true, new_balance: newBal };
  }

  if (action === 'ban_user') {
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(body.uid)}`, { is_banned: true });
    await sbInsert('banned_users', { tg_id: String(body.uid), reason: body.reason || '', banned_at: Date.now() });
    return { ok: true };
  }

  if (action === 'unban_user') {
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(body.uid)}`, { is_banned: false });
    return { ok: true };
  }

  if (action === 'cancel_vault') {
    const { vault_id, uid, amount } = body;
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(uid)}&select=balance,name`);
    if (!rows || !rows.length) return { error: 'User not found' };
    const newBal = parseFloat(rows[0].balance || 0) + parseFloat(amount);
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { balance: newBal });
    await sbDelete('vaults', `id=eq.${encodeURIComponent(vault_id)}`);
    await sbInsert('transactions', { txn_id: 'TXN'+uid+Date.now()+'refund', tg_user_id: String(uid), user_name: rows[0].name||'', type: 'unstake', description: 'Admin cancelled vault — principal refunded', amount: parseFloat(amount), balance_after: newBal, ts: Date.now() });
    return { ok: true, new_balance: newBal };
  }

  if (action === 'fill_vault') {
    const { vault_id, uid, amount, yield_amt } = body;
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(uid)}&select=balance,name`);
    if (!rows || !rows.length) return { error: 'User not found' };
    const payout = parseFloat(amount) + parseFloat(yield_amt);
    const newBal = parseFloat(rows[0].balance || 0) + payout;
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { balance: newBal });
    await sbDelete('vaults', `id=eq.${encodeURIComponent(vault_id)}`);
    await sbInsert('transactions', { txn_id: 'TXN'+uid+Date.now()+'fill', tg_user_id: String(uid), user_name: rows[0].name||'', type: 'unstake', description: 'Admin force-filled vault — principal + yield', amount: payout, balance_after: newBal, ts: Date.now() });
    return { ok: true, new_balance: newBal };
  }

  if (action === 'send_message') {
    await sbInsert('admin_messages', { tg_user_id: String(body.uid), message: body.message, sent: false, ts: Date.now() });
    if (BOT_BACKEND) fetch(BOT_BACKEND + '/process-notifications').catch(() => {});
    return { ok: true };
  }

  if (action === 'approve_ref') {
    const { queue_id, referrer_id, referee_id } = body;
    await sbPatch('referrals', `referrer_id=eq.${encodeURIComponent(referrer_id)}&referee_id=eq.${encodeURIComponent(referee_id)}`, { ref_status: 'verified' });
    await sbPatch('ref_queue', `id=eq.${queue_id}`, { queue_status: 'verified' });
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(referrer_id)}&select=balance,name`);
    if (rows && rows.length) {
      const newBal = parseFloat(rows[0].balance || 0) + 100;
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(referrer_id)}`, { balance: newBal });
      await sbInsert('transactions', { txn_id: 'TXN'+referrer_id+Date.now()+'refbonus', tg_user_id: String(referrer_id), user_name: rows[0].name||'', type: 'ref_bonus', description: 'Referral verified bonus', amount: 100, balance_after: newBal, ts: Date.now() });
    }
    return { ok: true };
  }

  if (action === 'reject_ref') {
    await sbPatch('ref_queue', `id=eq.${body.queue_id}`, { queue_status: 'rejected' });
    return { ok: true };
  }

  if (action === 'approve_x') {
    const { queue_row_id, uid, task_id, reward } = body;
    await sbPatch('x_queue', `id=eq.${queue_row_id}`, { queue_status: 'verified', notified: false });
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(uid)}&select=balance,name,completed_tasks`);
    if (rows && rows.length) {
      const u = rows[0];
      const completed = typeof u.completed_tasks === 'string' ? JSON.parse(u.completed_tasks || '{}') : (u.completed_tasks || {});
      completed[task_id] = true;
      const newBal = parseFloat(u.balance || 0) + parseFloat(reward || 0);
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { balance: newBal, completed_tasks: JSON.stringify(completed) });
      await sbInsert('transactions', { txn_id: 'TXN'+uid+Date.now()+'xtask', tg_user_id: String(uid), user_name: u.name||'', type: 'task', description: 'Quest verified: '+task_id, amount: parseFloat(reward||0), balance_after: newBal, ts: Date.now() });
    }
    return { ok: true };
  }

  if (action === 'reject_x') {
    const { queue_row_id, uid, task_id } = body;
    await sbPatch('x_queue', `id=eq.${queue_row_id}`, { queue_status: 'rejected', notified: false });
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(uid)}&select=task_states`);
    if (rows && rows.length) {
      const states = typeof rows[0].task_states === 'string' ? JSON.parse(rows[0].task_states||'{}') : (rows[0].task_states||{});
      states[task_id] = 'rejected';
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { task_states: JSON.stringify(states) });
    }
    await sbInsert('admin_messages', { tg_user_id: String(uid), message: '❌ Your quest submission was not approved. Tap the task icon to redo it, then submit again.', sent: false, ts: Date.now() });
    if (BOT_BACKEND) fetch(BOT_BACKEND + '/process-notifications').catch(() => {});
    return { ok: true };
  }

  if (action === 'dispatch_nft') {
    const { req_id, nft_id, uid, txn_id: txnRef, nft_name: nftName } = body;
    const existing = await sbGet('nft_requests', `req_id=eq.${encodeURIComponent(req_id)}&req_status=eq.pending`);
    if (!existing || !existing.length) return { error: 'Already dispatched or not found' };
    await sbPatch('nft_requests', `req_id=eq.${encodeURIComponent(req_id)}&req_status=eq.pending`, { req_status: 'sent', txn_id: txnRef, notified: false });
    await sbPatch('nft_listings', `id=eq.${encodeURIComponent(nft_id)}`, { dispatch_status: 'sent' });
    await sbInsert('admin_messages', { tg_user_id: String(uid), message: `✅ Your NFT has been dispatched!\n\nSent: ${nftName || 'your relic'}\nTransaction ID: ${txnRef}`, sent: false, ts: Date.now() });
    if (BOT_BACKEND) fetch(BOT_BACKEND + '/process-notifications').catch(() => {});
    return { ok: true };
  }

  if (action === 'dispatch_osaryx_nft') {
    const { req_id, nft_id, uid, txn_id: txnRef, nft_name: nftName } = body;
    const existing = await sbGet('osaryx_nft_requests', `req_id=eq.${encodeURIComponent(req_id)}&req_status=eq.pending`);
    if (!existing || !existing.length) return { error: 'Already dispatched or not found' };
    await sbPatch('osaryx_nft_requests', `req_id=eq.${encodeURIComponent(req_id)}&req_status=eq.pending`, { req_status: 'sent', txn_id: txnRef, notified: false });
    await sbPatch('osaryx_nfts', `id=eq.${encodeURIComponent(nft_id)}`, { dispatch_status: 'sent' });
    await sbInsert('admin_messages', { tg_user_id: String(uid), message: `✅ Your OSARYX NFT has been dispatched!\n\nSent: ${nftName || 'your NFT'}\nTransaction ID: ${txnRef}`, sent: false, ts: Date.now() });
    if (BOT_BACKEND) fetch(BOT_BACKEND + '/process-notifications').catch(() => {});
    return { ok: true };
  }

  if (action === 'add_task') {
    const { task } = body;
    await sbInsert('tasks', { id: task.id, name: task.name, description: task.desc||'', reward: task.reward, task_type: task.type, icon: task.icon||'🎯', target: task.target||'', x_follow: task.xFollow||false, auto_ref: task.autoRef||null, click_cap: task.clickCap||null, click_count: 0, sort_order: task.sortOrder||0 });
    return { ok: true };
  }

  if (action === 'delete_task') {
    await sbDelete('tasks', `id=eq.${encodeURIComponent(body.task_id)}`);
    return { ok: true };
  }

  if (action === 'create_event') {
    const { event } = body;
    await sbInsert('events', { id: event.id, name: event.name, icon: event.icon||'📣', description: event.desc||'', tasks: JSON.stringify(event.tasks||[]), reward: event.reward||0, expires_at: event.expiresAt||null, created_at: Date.now() });
    return { ok: true };
  }

  if (action === 'delete_event') {
    await sbDelete('events', `id=eq.${encodeURIComponent(body.event_id)}`);
    return { ok: true };
  }

  if (action === 'create_nft_listing') {
    const { nft } = body;
    await sbInsert('nft_listings', { id: nft.id, name: nft.name, img: nft.img, chain: nft.chain||'', worth: nft.worth||0, sold: false, created_at: Date.now() });
    return { ok: true };
  }

  if (action === 'delete_nft_listing') {
    await sbDelete('nft_listings', `id=eq.${encodeURIComponent(body.nft_id)}`);
    return { ok: true };
  }

  if (action === 'create_osaryx_nft') {
    const { nft } = body;
    await sbInsert('osaryx_nfts', { id: nft.id, name: nft.name, img: nft.img, chain: nft.chain||'', worth: nft.worth||0, sold: false, created_at: Date.now() });
    return { ok: true };
  }

  if (action === 'delete_osaryx_nft') {
    await sbDelete('osaryx_nfts', `id=eq.${encodeURIComponent(body.nft_id)}`);
    return { ok: true };
  }

  if (action === 'approve_epic_gods') {
    const { req_id, uid } = body;
    await sbPatch('epic_gods_requests', `id=eq.${req_id}`, { req_status: 'verified', verified_at: Date.now() });
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { zeus_active_until: Date.now()+7*86400000, zeus_started_at: Date.now() });
    await sbInsert('admin_messages', { tg_user_id: String(uid), message: '⚡ Zeus has answered your call! 10× mining speed is now active for 7 days.', sent: false, ts: Date.now() });
    if (BOT_BACKEND) fetch(BOT_BACKEND + '/process-notifications').catch(() => {});
    return { ok: true };
  }

  if (action === 'reject_epic_gods') {
    await sbPatch('epic_gods_requests', `id=eq.${body.req_id}`, { req_status: 'rejected' });
    return { ok: true };
  }

  if (action === 'airdrop') {
    const { uid, amount, note } = body;
    const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(uid)}&select=balance,name`);
    if (!rows || !rows.length) return { error: 'User not found' };
    const newBal = parseFloat(rows[0].balance || 0) + parseFloat(amount);
    await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { balance: newBal });
    await sbInsert('transactions', { txn_id: 'TXN'+uid+Date.now()+'drop', tg_user_id: String(uid), user_name: rows[0].name||'', type: 'airdrop', description: note||'Admin airdrop', amount: parseFloat(amount), balance_after: newBal, ts: Date.now() });
    return { ok: true, new_balance: newBal };
  }

  if (action === 'set_maintenance') {
    const { active, message: msg } = body;
    const upd = { id: 1, is_active: active };
    if (msg !== undefined) upd.message = msg;
    if (active) upd.activated_at = Date.now(); else { upd.snapshot = null; upd.activated_at = null; }
    await sbUpsert('maintenance', upd);
    return { ok: true };
  }

  return { error: 'Unknown action: ' + action };
}

/* ══════════════════════════════════════════════
   HTTP SERVER
══════════════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.writeHead(204); res.end(); return;
  }

  /* ── POST /api/admin-login ── */
  if (urlObj.pathname === '/api/admin-login' && req.method === 'POST') {
    const body = await readBody(req);
    const pw   = String(body.password || '');
    const code = String(body.totp    || '');
    if (pw !== ADMIN_PW) {
      await new Promise(r => setTimeout(r, 500));
      return sendJson(res, 401, { ok: false, error: 'Incorrect password' });
    }
    if (!verifyTotp(TOTP_SECRET, code)) {
      await new Promise(r => setTimeout(r, 500));
      return sendJson(res, 401, { ok: false, error: 'Invalid authenticator code' });
    }
    const token = createSession();
    console.log('Admin login — session issued');
    return sendJson(res, 200, { ok: true, token });
  }

  /* ── GET /api/verify-session ── */
  if (urlObj.pathname === '/api/verify-session' && req.method === 'GET') {
    return sendJson(res, 200, { ok: isValidSession(getToken(req)) });
  }

  /* ── POST /api/admin-logout ── */
  if (urlObj.pathname === '/api/admin-logout' && req.method === 'POST') {
    sessions.delete(getToken(req));
    return sendJson(res, 200, { ok: true });
  }

  /* ── GET /api/config ── */
  if (urlObj.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, PUBLIC_CONFIG);
  }

  /* ── POST /api/admin-action ── */
  if (urlObj.pathname === '/api/admin-action' && req.method === 'POST') {
    if (!isValidSession(getToken(req))) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    const body = await readBody(req);
    try {
      const result = await handleAdminAction(body);
      return sendJson(res, 200, result);
    } catch (e) {
      console.error('admin-action failed:', body?.action, e.message);
      return sendJson(res, 500, { error: 'Server error' });
    }
  }

  /* ── Static files from /public ── */
  let filePath = path.join(PUBLIC_DIR, urlObj.pathname === '/' ? 'index.html' : urlObj.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.access(filePath, fs.constants.F_OK, err => {
    if (err) filePath = path.join(PUBLIC_DIR, 'index.html');
    serveFile(res, filePath);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅  OSARYX admin server running → http://localhost:${PORT}/admin.html`);
  console.log(`    Secrets: loaded from .env — never sent to browser\n`);
});