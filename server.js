/* ============================================================
   server.js — OSARYX Admin API (Node.js / Express)
   Deploy on Render.com (free tier, Web Service, Node).

   All secrets come from environment variables.
   Never hardcode anything here.

   Environment variables to set in Render dashboard:
     SUPABASE_URL       = https://yourproject.supabase.co
     SUPABASE_KEY       = your SERVICE ROLE key
     ADMIN_PASSWORD     = your chosen admin password
     TOTP_SECRET        = base32 TOTP secret
     BOT_BACKEND_URL    = https://your-main-bot.deno.dev  (for pinging notifications)
     PORT               = (Render sets this automatically)

   How it connects to a new server after expiry:
     Just set the same env vars on the new Render service.
     The server reads from Supabase — no local state, no files.
     Everything lives in the database. Point admin-db.js at
     the new Render URL and it works immediately.
   ============================================================ */

const express     = require('express');
const crypto      = require('crypto');
const https       = require('https');
const http        = require('http');

const app  = express();
const PORT = process.env.PORT || 3001;

const SUPABASE_URL   = process.env.SUPABASE_URL   || '';
const BOT_BACKEND_URL = process.env.BOT_BACKEND_URL || '';  /* Deno bot URL — for pinging process-notifications */
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || '';  /* service role */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOTP_SECRET    = process.env.TOTP_SECRET    || '';

if (!SUPABASE_URL || !SUPABASE_KEY) console.error('⚠  SUPABASE_URL / SUPABASE_KEY not set');
if (!ADMIN_PASSWORD)                console.error('⚠  ADMIN_PASSWORD not set');
if (!TOTP_SECRET)                   console.error('⚠  TOTP_SECRET not set');

/* ── Session tokens (HMAC-signed, stateless) ──
   Tokens are signed with HMAC-SHA256 using ADMIN_PASSWORD as the key.
   No in-memory storage needed — valid on any Render instance/restart.
   Format: base64(expiry_ms) . base64(hmac)
── */
const SESSION_TTL = 24 * 3600 * 1000; /* 24 hours */

function genToken() {
  const expiry = Date.now() + SESSION_TTL;
  const payload = String(expiry);
  const sig = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function validateSession(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return false;
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return false;
    const payload  = Buffer.from(payloadB64, 'base64url').toString();
    const expected = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('base64url');
    if (sig !== expected) return false;
    const expiry = parseInt(payload, 10);
    return Date.now() < expiry;
  } catch (e) { return false; }
}

/* ── TOTP (RFC 6238, HMAC-SHA1, 30s step) ── */
function b32ToBuffer(s) {
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

function totpCode(key, step) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const h   = crypto.createHmac('sha1', key).update(buf).digest();
  const off  = h[19] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off+1] << 16 | h[off+2] << 8 | h[off+3]) % 1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, token) {
  const key  = b32ToBuffer(secret);
  const tok  = String(token).replace(/\s/g, '').padStart(6, '0');
  const step = Math.floor(Date.now() / 1000 / 30);
  return [step - 1, step, step + 1].some(t => totpCode(key, t) === tok);
}

/* ── Supabase helpers ── */
function sbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Prefer':        'return=representation'
  };
}

function sbFetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(SUPABASE_URL + '/rest/v1/' + path);
    const isHttps = url.protocol === 'https:';
    const mod     = isHttps ? https : http;
    const headers = Object.assign(sbHeaders(), options.headers || {});
    const body    = options.body ? Buffer.from(options.body) : null;
    if (body) headers['Content-Length'] = body.length;

    const req = mod.request({
      hostname: url.hostname,
      path:     url.pathname + (url.search || ''),
      method:   options.method || 'GET',
      headers
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }); }
        catch (e) { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function sbGet(table, query)       { return (await sbFetch(table + (query ? '?' + query : ''))).body || []; }
async function sbPost(table, body)       { return (await sbFetch(table, { method: 'POST', body: JSON.stringify(body) })).body; }
async function sbPatch(table, query, body) {
  return (await sbFetch(table + '?' + query, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body)
  })).body;
}
async function sbDelete(table, query)    { return (await sbFetch(table + '?' + query, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })).body; }
async function sbUpsert(table, body)     {
  return (await sbFetch(table, {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body)
  })).body;
}
async function sbCount(table, query) {
  const r = await sbFetch(table + '?' + query, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const range = (r.headers || {})['content-range'] || '';
  return parseInt(range.split('/')[1] || '0', 10) || 0;
}

function pingBot() {
  if (!BOT_BACKEND_URL) return;
  const http  = require('http');
  const https = require('https');
  const url   = new URL(BOT_BACKEND_URL + '/process-notifications');
  const mod   = url.protocol === 'https:' ? https : http;
  mod.get(url.href).on('error', e => console.error('pingBot failed:', e.message));
}

function genTxnId(uid, amount) {
  const amtCents = Math.round(amount * 100);
  return 'TXN' + String(uid) + Date.now() + (amtCents < 0 ? '9' : '0') + Math.abs(amtCents);
}

/* ── Middleware ── */
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const auth = (req, res, next) => {
  if (!validateSession(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

/* ════════════════════════════════════════════
   AUTH ROUTES
════════════════════════════════════════════ */
app.post('/admin-login', (req, res) => {
  const { password, totp } = req.body || {};
  if (!ADMIN_PASSWORD || !TOTP_SECRET) return res.json({ ok: false, error: 'Admin not configured on server' });
  if (password !== ADMIN_PASSWORD)     return res.json({ ok: false, error: 'Incorrect password' });
  if (!verifyTotp(TOTP_SECRET, totp))  return res.json({ ok: false, error: 'Invalid authenticator code' });
  const token = genToken();
  res.json({ ok: true, token });
});

app.get('/admin-verify', (req, res) => {
  res.json({ ok: validateSession(req) });
});

/* ════════════════════════════════════════════
   READ ROUTES  (all require valid session)
════════════════════════════════════════════ */
app.get('/admin-read', auth, async (req, res) => {
  const q      = req.query.q || '';
  const [path, qs] = q.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));

  try {
    let data;
    switch (path) {
      case 'users_leaderboard':
        data = await sbGet('users', `order=balance.desc&limit=${parseInt(params.limit||'100',10)}&is_banned=eq.false`);
        break;
      case 'users_admin':
        if (params.q) {
          const s = params.q.replace(/^@/, '');
          data = await sbGet('users', `or=(name.ilike.*${s}*,username.ilike.*${s}*,tg_id.eq.${s})&limit=100`);
        } else {
          data = await sbGet('users', 'order=last_seen.desc&limit=200');
        }
        break;
      case 'user_count':
        data = { count: await sbCount('users', 'select=tg_id') };
        break;
      case 'user_find': {
        const q2 = (params.q || '').replace(/^@/, '');
        let rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(q2)}`);
        if (!rows.length) rows = await sbGet('users', `username=ilike.${encodeURIComponent(q2)}`);
        data = rows[0] || null;
        break;
      }
      case 'referrals':
        data = await sbGet('referrals', `referrer_id=eq.${encodeURIComponent(params.uid)}&order=created_at.desc`);
        break;
      case 'transactions':
        data = await sbGet('transactions', `tg_user_id=eq.${encodeURIComponent(params.uid)}&order=ts.desc&limit=${params.limit||20}`);
        break;
      case 'vaults':
        data = await sbGet('vaults', `tg_user_id=eq.${encodeURIComponent(params.uid)}&order=staked_at.desc`);
        break;
      case 'txn_find':
        data = (await sbGet('transactions', `txn_id=eq.${encodeURIComponent(params.id)}`))[0] || null;
        break;
      case 'global_stats':
        data = (await sbGet('global_stats', 'id=eq.1'))[0] || { total_mined: 0 };
        break;
      case 'maintenance':
        data = (await sbGet('maintenance', 'id=eq.1'))[0] || { is_active: false, message: '' };
        break;
      case 'tasks':
        data = await sbGet('tasks', 'order=sort_order.asc');
        break;
      case 'events':
        data = await sbGet('events', 'order=created_at.desc');
        break;
      case 'ref_queue':
        data = await sbGet('ref_queue', 'order=ts.desc&limit=200');
        break;
      case 'x_queue':
        data = await sbGet('x_queue', 'order=ts.desc&limit=200');
        break;
      case 'nft_listings':
        data = await sbGet('nft_listings', 'order=created_at.desc');
        break;
      case 'nft_requests':
        data = await sbGet('nft_requests', 'order=ts.desc&limit=200');
        break;
      case 'osaryx_nfts':
        data = await sbGet('osaryx_nfts', 'order=created_at.desc');
        break;
      case 'osaryx_nft_requests':
        data = await sbGet('osaryx_nft_requests', 'order=ts.desc&limit=200');
        break;
      case 'epic_gods_requests':
        data = await sbGet('epic_gods_requests', 'order=ts.desc&limit=200');
        break;
      case 'task_click_log':
        data = await sbGet('task_click_log', `task_id=eq.${encodeURIComponent(params.task_id)}&order=ts.desc&limit=500`);
        break;
      default:
        return res.status(400).json({ error: 'Unknown query: ' + path });
    }
    res.json({ data });
  } catch (e) {
    console.error('admin-read error:', path, e.message);
    res.status(500).json({ error: e.message || 'Read failed' });
  }
});

/* ════════════════════════════════════════════
   ACTION ROUTE  (all writes)
════════════════════════════════════════════ */
app.post('/admin-action', auth, async (req, res) => {
  const { action, ...params } = req.body || {};
  try {
    const result = await handleAction(action, params);
    res.json(result);
  } catch (e) {
    console.error('admin-action error:', action, e.message);
    res.status(500).json({ error: e.message || 'Action failed' });
  }
});

async function handleAction(action, p) {
  switch (action) {

    case 'adjust_balance': {
      const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.uid)}`);
      if (!rows.length) throw new Error('User not found');
      const u      = rows[0];
      const newBal = Math.max(0, parseFloat(u.balance) + parseFloat(p.amount));
      const label  = p.amount >= 0 ? 'Balance credit by admin' : 'Balance deduction by admin';
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { balance: newBal });
      await sbPost('transactions', { txn_id: genTxnId(p.uid, p.amount), tg_user_id: String(p.uid), user_name: u.name||'', type: 'admin_adjust', description: label, amount: parseFloat(p.amount), balance_after: newBal, ts: Date.now() });
      return { ok: true };
    }

    case 'cancel_vault': {
      const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.uid)}`);
      if (!rows.length) throw new Error('User not found');
      const u      = rows[0];
      const newBal = parseFloat(u.balance) + parseFloat(p.amount);
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { balance: newBal });
      await sbDelete('vaults', `id=eq.${encodeURIComponent(p.vault_id)}`);
      await sbPost('transactions', { txn_id: genTxnId(p.uid, p.amount), tg_user_id: String(p.uid), user_name: u.name||'', type: 'unstake', description: 'Admin cancelled vault — principal refunded', amount: parseFloat(p.amount), balance_after: newBal, ts: Date.now() });
      return { ok: true };
    }

    case 'fill_vault': {
      const rows   = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.uid)}`);
      if (!rows.length) throw new Error('User not found');
      const u      = rows[0];
      const payout = parseFloat(p.amount) + parseFloat(p.yield_amt);
      const newBal = parseFloat(u.balance) + payout;
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { balance: newBal });
      await sbDelete('vaults', `id=eq.${encodeURIComponent(p.vault_id)}`);
      await sbPost('transactions', { txn_id: genTxnId(p.uid, payout), tg_user_id: String(p.uid), user_name: u.name||'', type: 'unstake', description: 'Admin force-filled vault — principal + yield paid', amount: payout, balance_after: newBal, ts: Date.now() });
      return { ok: true };
    }

    case 'ban_user':
      await sbPatch('users',        `tg_id=eq.${encodeURIComponent(p.uid)}`, { is_banned: true });
      await sbPost('banned_users',  { tg_id: String(p.uid), reason: p.reason||'', banned_at: Date.now() });
      return { ok: true };

    case 'unban_user':
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { is_banned: false });
      return { ok: true };

    case 'send_message':
      await sbPost('admin_messages', { tg_user_id: String(p.uid), message: p.message, sent: false, ts: Date.now() });
      pingBot();
      return { ok: true };

    case 'approve_ref': {
      await sbPatch('referrals', `referrer_id=eq.${encodeURIComponent(p.referrer_id)}&referee_id=eq.${encodeURIComponent(p.referee_id)}`, { ref_status: 'verified' });
      await sbPatch('ref_queue', `id=eq.${p.queue_id}`, { queue_status: 'verified' });
      const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.referrer_id)}`);
      if (rows.length) {
        const ref    = rows[0];
        const newBal = parseFloat(ref.balance) + 100;
        await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.referrer_id)}`, { balance: newBal });
        await sbPost('transactions', { txn_id: genTxnId(p.referrer_id, 100), tg_user_id: String(p.referrer_id), user_name: ref.name||'', type: 'ref_bonus', description: 'Referral verified bonus', amount: 100, balance_after: newBal, ts: Date.now() });
      }
      /* Settle auto-ref tasks without blocking the response */
      settleAutoRefTasks(String(p.referrer_id)).catch(e => console.error('settleAutoRefTasks:', e.message));
      return { ok: true };
    }

    case 'reject_ref':
      await sbPatch('ref_queue', `id=eq.${p.queue_id}`, { queue_status: 'rejected' });
      return { ok: true };

    case 'approve_x': {
      await sbPatch('x_queue', `id=eq.${p.queue_row_id}`, { queue_status: 'verified', notified: false });
      const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.uid)}`);
      if (rows.length) {
        const u          = rows[0];
        const completed  = JSON.parse(u.completed_tasks || '{}');
        const taskStates = JSON.parse(u.task_states || '{}');
        const isEventTask = String(p.task_id).startsWith('ev_');
        /* Mark the task completed in DB — app.js realtime will detect
           this and call markEventTaskDone which checks if ALL event tasks
           are done before crediting the full event reward */
        completed[p.task_id]  = true;
        /* Clear pending/verify state so button updates */
        delete taskStates[p.task_id];
        if (isEventTask) {
          /* Event subtask — do NOT credit reward here.
             The reward is paid by markEventTaskDone only when
             every event task is complete. */
          await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, {
            task_states: JSON.stringify(taskStates),
            completed_tasks: JSON.stringify(completed)
          });
        } else if (p.reward > 0) {
          /* Regular task — credit reward directly */
          taskStates[p.task_id] = 'done';
          const newBal = parseFloat(u.balance) + parseFloat(p.reward);
          await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { balance: newBal, task_states: JSON.stringify(taskStates), completed_tasks: JSON.stringify(completed) });
          await sbPost('transactions', { txn_id: genTxnId(p.uid, p.reward), tg_user_id: String(p.uid), user_name: u.name||'', type: 'task', description: 'X task verified: ' + p.task_id, amount: parseFloat(p.reward), balance_after: newBal, ts: Date.now() });
        }
      }
      return { ok: true };
    }

    case 'reject_x': {
      await sbPatch('x_queue', `id=eq.${p.queue_row_id}`, { queue_status: 'rejected', notified: false });
      const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.uid)}`);
      if (rows.length) {
        const u          = rows[0];
        const taskStates = JSON.parse(u.task_states || '{}');
        taskStates[p.task_id] = 'rejected';
        await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { task_states: JSON.stringify(taskStates) });
      }
      await sbPost('admin_messages', { tg_user_id: String(p.uid), message: '❌ Your quest submission was not verified. Tap the task icon to complete it again, then resubmit.', sent: false, ts: Date.now() });
      pingBot();
      return { ok: true };
    }

    case 'dispatch_nft': {
      const r = await sbFetch(`nft_requests?req_id=eq.${encodeURIComponent(p.req_id)}&req_status=eq.pending`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ req_status: 'sent', txn_id: p.txn_id, notified: false })
      });
      if (!Array.isArray(r.body) || !r.body.length) throw new Error('Already dispatched or not found');
      await sbPatch('nft_listings', `id=eq.${encodeURIComponent(p.nft_id)}`, { dispatch_status: 'sent' });
      const req = r.body[0];
      await sbPost('admin_messages', { tg_user_id: req.tg_user_id, message: `✅ Your relic has been dispatched!\n\nNFT: ${req.nft_name||p.nft_id}\nTransaction ID: ${p.txn_id}`, sent: false, ts: Date.now() });
      pingBot();
      return { ok: true };
    }

    case 'dispatch_osaryx_nft': {
      const r = await sbFetch(`osaryx_nft_requests?req_id=eq.${encodeURIComponent(p.req_id)}&req_status=eq.pending`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ req_status: 'sent', txn_id: p.txn_id, notified: false })
      });
      if (!Array.isArray(r.body) || !r.body.length) throw new Error('Already dispatched or not found');
      await sbPatch('osaryx_nfts', `id=eq.${encodeURIComponent(p.nft_id)}`, { dispatch_status: 'sent' });
      const req = r.body[0];
      await sbPost('admin_messages', { tg_user_id: req.tg_user_id, message: `✅ Your OSARYX NFT has been dispatched!\n\nSent: ${p.nft_name||req.nft_name||p.nft_id}\nTransaction ID: ${p.txn_id}`, sent: false, ts: Date.now() });
      pingBot();
      return { ok: true };
    }

    case 'approve_epic_gods':
      await sbPatch('epic_gods_requests', `id=eq.${p.req_id}`, { req_status: 'verified', verified_at: Date.now() });
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { zeus_active_until: Date.now()+7*86400000, zeus_started_at: Date.now(), zeus_settled_balance: 0 });
      await sbPost('admin_messages', { tg_user_id: String(p.uid), message: '⚡ Zeus, God of Lightning, has answered your call! 10× mining speed is now active for 7 days.', sent: false, ts: Date.now() });
      pingBot();
      return { ok: true };

    case 'reject_epic_gods':
      await sbPatch('epic_gods_requests', `id=eq.${p.req_id}`, { req_status: 'rejected' });
      return { ok: true };

    case 'add_task':
      await sbPost('tasks', { id: p.task.id, name: p.task.name, description: p.task.desc||'', reward: p.task.reward, task_type: p.task.type, icon: p.task.icon||'🎯', target: p.task.target||'', x_follow: p.task.xFollow||false, auto_ref: p.task.autoRef||null, click_cap: p.task.clickCap||null, click_count: 0, sort_order: p.task.sortOrder||0 });
      return { ok: true };

    case 'delete_task':
      await sbDelete('tasks', `id=eq.${encodeURIComponent(p.task_id)}`);
      return { ok: true };

    case 'create_event':
      await sbPost('events', { id: p.event.id, name: p.event.name, icon: p.event.icon||'📣', description: p.event.desc||'', tasks: JSON.stringify(p.event.tasks||[]), reward: p.event.reward||0, expires_at: p.event.expiresAt||null, created_at: Date.now() });
      return { ok: true };

    case 'delete_event':
      await sbDelete('events', `id=eq.${encodeURIComponent(p.event_id)}`);
      return { ok: true };

    case 'create_nft_listing':
      await sbPost('nft_listings', { id: p.nft.id, name: p.nft.name, img: p.nft.img, chain: p.nft.chain||'', worth: p.nft.worth||0, sold: false, created_at: Date.now() });
      return { ok: true };

    case 'delete_nft_listing':
      await sbDelete('nft_listings', `id=eq.${encodeURIComponent(p.nft_id)}`);
      return { ok: true };

    case 'create_osaryx_nft':
      await sbPost('osaryx_nfts', { id: p.nft.id, name: p.nft.name, img: p.nft.img, chain: p.nft.chain||'', worth: p.nft.worth||0, sold: false, created_at: Date.now() });
      return { ok: true };

    case 'delete_osaryx_nft':
      await sbDelete('osaryx_nfts', `id=eq.${encodeURIComponent(p.nft_id)}`);
      return { ok: true };

    case 'airdrop': {
      const rows = await sbGet('users', `tg_id=eq.${encodeURIComponent(p.uid)}`);
      if (!rows.length) throw new Error('User not found: ' + p.uid);
      const u      = rows[0];
      const newBal = parseFloat(u.balance) + parseFloat(p.amount);
      await sbPatch('users', `tg_id=eq.${encodeURIComponent(p.uid)}`, { balance: newBal });
      await sbPost('transactions', { txn_id: genTxnId(p.uid, p.amount), tg_user_id: String(p.uid), user_name: u.name||'', type: 'airdrop', description: p.note||'Admin airdrop', amount: parseFloat(p.amount), balance_after: newBal, ts: Date.now() });
      return { ok: true };
    }

    case 'set_maintenance':
      await sbUpsert('maintenance', { id: 1, is_active: p.active, message: p.message||'' });
      return { ok: true };

    default:
      throw new Error('Unknown action: ' + action);
  }
}

/* ── Settle auto-ref tasks ── */
async function settleAutoRefTasks(uid) {
  const [uRows, refs, tasks] = await Promise.all([
    sbGet('users',    `tg_id=eq.${encodeURIComponent(uid)}`),
    sbGet('referrals', `referrer_id=eq.${encodeURIComponent(uid)}&ref_status=eq.verified`),
    sbGet('tasks',    'task_type=eq.auto_ref')
  ]);
  if (!uRows.length) return;
  const u        = uRows[0];
  const verified = refs.length;
  let   bal      = parseFloat(u.balance);
  const completed = JSON.parse(u.completed_tasks || '{}');
  let   changed   = false;
  for (const task of tasks) {
    if (!task.auto_ref || completed[task.id]) continue;
    if (verified >= task.auto_ref) {
      completed[task.id] = true;
      bal += parseFloat(task.reward);
      await sbPost('transactions', { txn_id: genTxnId(uid, task.reward), tg_user_id: String(uid), user_name: u.name||'', type: 'task', description: 'Invocation task: ' + task.name, amount: parseFloat(task.reward), balance_after: bal, ts: Date.now() });
      changed = true;
    }
  }
  if (changed) await sbPatch('users', `tg_id=eq.${encodeURIComponent(uid)}`, { balance: bal, completed_tasks: JSON.stringify(completed) });
}

/* ── Health check ── */
app.get('/', (req, res) => res.json({ status: 'OSARYX Admin API running', ts: Date.now() }));

app.listen(PORT, () => console.log(`✅  OSARYX Admin API listening on port ${PORT}`));