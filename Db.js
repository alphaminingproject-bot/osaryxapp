/* ============================================================
   db.js — OSARYX Admin Dashboard: read-only Supabase layer
   ============================================================
   Loaded AFTER the supabase-js UMD bundle and BEFORE admin.js.

   Defines a global `DB` object. All methods here are READS ONLY,
   done directly from the browser using the Supabase ANON key.
   Writes still go through bot.js's /admin-action endpoint using
   the service-role key server-side — nothing here should ever
   call .insert / .update / .delete / .upsert.

   Matches schema: OSARYX Supabase Schema v4 (Final Launch Build)
   ============================================================ */

const SUPABASE_URL      = 'https://pnvzcdipmazdhkjpaasf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Cim6Q3kudqrXUHCaGCg4nA_mW8a1sgb';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* Unwraps {data,error} from a supabase-js query, throws on error
   so callers' .catch(...) in admin.js keeps working as written. */
async function q(builder) {
  const { data, error } = await builder;
  if (error) { console.error('DB query error:', error); throw new Error(error.message); }
  return data || [];
}

async function qSingle(builder) {
  const { data, error } = await builder;
  if (error && error.code !== 'PGRST116') { console.error('DB query error:', error); throw new Error(error.message); }
  return data || null;
}

/* ── mapping: snake_case DB rows → camelCase shapes admin.js expects ── */

function mapUser(u) {
  if (!u) return null;
  return {
    id: u.tg_id,
    name: u.name,
    username: u.username,
    balance: parseFloat(u.balance || 0),
    lastSeen: Number(u.last_seen || 0),
    createdAt: Number(u.created_at || 0),
    isBanned: !!u.is_banned,
    runeType: u.rune_type || null,
    runeExpiresAt: u.rune_expires_at ? Number(u.rune_expires_at) : null,
    storageHours: u.storage_hours || null,
    storageExpiresAt: u.storage_expires_at ? Number(u.storage_expires_at) : null,
    zeusActiveUntil: u.zeus_active_until ? Number(u.zeus_active_until) : null,
  };
}

const DB = {

  /* ASSUMPTION: adjust to your real tokenomics cap */
  MAX_SUPPLY: 1_000_000_000,

  /* ── Overview / leaderboard ── */
  async getAllUsersForLeaderboard(limit = 50) {
    const rows = await q(sb.from('users').select('*').order('balance', { ascending: false }).limit(limit));
    return rows.map(mapUser);
  },

  async getUserCount() {
    const { count, error } = await sb.from('users').select('*', { count: 'exact', head: true });
    if (error) { console.error('getUserCount error', error); return 0; }
    return count || 0;
  },

  async getGlobalStats() {
    const row = await qSingle(sb.from('global_stats').select('*').eq('id', 1).single());
    return { totalMined: parseFloat((row && row.total_mined) || 0) };
  },

  /* ── User search / lookup ── */
  async getAllUsersForAdmin(query) {
    let builder = sb.from('users').select('*');
    if (query && query.trim()) {
      const term = query.trim().replace(/^@/, '');
      builder = builder.or(`name.ilike.%${term}%,username.ilike.%${term}%,tg_id.eq.${term}`);
    }
    const rows = await q(builder.order('balance', { ascending: false }).limit(500));
    return rows.map(mapUser);
  },

  async findUserByIdOrUsername(raw) {
    const term = raw.trim();
    let row;
    if (term.startsWith('@')) {
      row = await qSingle(sb.from('users').select('*').ilike('username', term.slice(1)).single());
    } else if (/^\d+$/.test(term)) {
      row = await qSingle(sb.from('users').select('*').eq('tg_id', term).single());
    } else {
      row = await qSingle(sb.from('users').select('*').ilike('username', term).single());
    }
    return mapUser(row);
  },

  async findTransaction(raw) {
    const row = await qSingle(sb.from('transactions').select('*').eq('txn_id', raw.trim()).single());
    if (!row) return null;
    return {
      txn_id: row.txn_id, type: row.type, description: row.description,
      tg_user_id: row.tg_user_id, amount: parseFloat(row.amount || 0),
      balance_after: parseFloat(row.balance_after || 0), ts: Number(row.ts || 0),
    };
  },

  async getReferralsFor(uid) {
    const rows = await q(sb.from('referrals').select('*').eq('referrer_id', uid));
    return rows.map(r => ({
      status: r.ref_status, refereeId: r.referee_id, refereeName: r.referee_name,
      earnedTotal: parseFloat(r.earned_total || 0),
    }));
  },

  async getTransactionsFor(uid, limit = 20) {
    const rows = await q(sb.from('transactions').select('*').eq('tg_user_id', String(uid)).order('ts', { ascending: false }).limit(limit));
    return rows.map(h => ({
      ts: Number(h.ts || 0), type: h.type, description: h.description,
      amount: parseFloat(h.amount || 0), balance_after: parseFloat(h.balance_after || 0),
      txn_id: h.txn_id,
    }));
  },

  async getVaultsFor(uid) {
    const rows = await q(sb.from('vaults').select('*').eq('tg_user_id', uid));
    return rows.map(v => ({
      id: v.id, amount: parseFloat(v.amount || 0),
      yield: parseFloat(v.yield_amount || 0), maturesAt: Number(v.matures_at || 0),
    }));
  },

  /* ── Moderation queues ── */
  async getRefQueue() {
    const rows = await q(sb.from('ref_queue').select('*'));
    return rows.map(r => ({
      id: r.id, referrerId: r.referrer_id, refereeId: r.referee_id,
      referrerName: r.referrer_name, refereeName: r.referee_name,
      ts: Number(r.ts || 0), status: r.queue_status,
    }));
  },

  async getXQueue() {
    const rows = await q(sb.from('x_queue').select('*'));
    return rows.map(r => ({
      id: r.id, userId: r.tg_user_id, userName: r.user_name,
      taskId: r.task_id, taskName: r.task_name, handle: r.x_handle,
      ts: Number(r.ts || 0), status: r.queue_status, reward: parseFloat(r.reward || 0),
    }));
  },

  async getNFTRequests() {
    const rows = await q(sb.from('nft_requests').select('*'));
    return rows.map(r => ({
      reqId: r.req_id, nftId: r.nft_id, nftName: r.nft_name, nftImg: r.nft_img,
      userId: r.tg_user_id, userName: r.user_name, chain: r.chain, address: r.wallet_addr,
      worth: parseFloat(r.worth || 0), ts: Number(r.ts || 0), status: r.req_status, txnId: r.txn_id,
    }));
  },

  async getOsaryxNFTRequests() {
    const rows = await q(sb.from('osaryx_nft_requests').select('*'));
    return rows.map(r => ({
      reqId: r.req_id, nftId: r.nft_id, nftName: r.nft_name, nftImg: r.nft_img,
      userId: r.tg_user_id, userName: r.user_name, chain: r.chain, address: r.wallet_addr,
      worth: parseFloat(r.worth || 0), ts: Number(r.ts || 0), status: r.req_status, txnId: r.txn_id,
    }));
  },

  async getEpicGodsRequests() {
    const rows = await q(sb.from('epic_gods_requests').select('*'));
    return rows.map(r => ({
      id: r.id, userId: r.tg_user_id, userName: r.user_name, username: r.username,
      payMethod: r.pay_method, txnRef: r.txn_ref, ts: Number(r.ts || 0), status: r.req_status,
    }));
  },

  /* ── Content management ── */
  async getAllTasksForAdmin() {
    const rows = await q(sb.from('tasks').select('*').order('sort_order', { ascending: true }));
    return rows.map(t => ({
      id: t.id, name: t.name, type: t.task_type, target: t.target, icon: t.icon,
      clickCap: t.click_cap, clickCount: t.click_count || 0, reward: parseFloat(t.reward || 0),
    }));
  },

  async getTaskClickLog(taskId) {
    const rows = await q(sb.from('task_click_log').select('*').eq('task_id', taskId).order('ts', { ascending: false }));
    return rows.map(c => ({ userName: c.user_name, userId: c.tg_user_id, ts: Number(c.ts || 0) }));
  },

  async getEvents() {
    const rows = await q(sb.from('events').select('*').order('created_at', { ascending: false }));
    return rows.map(ev => ({
      id: ev.id, name: ev.name, icon: ev.icon, desc: ev.description,
      reward: parseFloat(ev.reward || 0), expiresAt: ev.expires_at ? Number(ev.expires_at) : null,
      tasks: typeof ev.tasks === 'string' ? JSON.parse(ev.tasks || '[]') : (ev.tasks || []),
    }));
  },

  async getNFTListings() {
    const rows = await q(sb.from('nft_listings').select('*').order('created_at', { ascending: false }));
    return rows.map(n => ({ id: n.id, name: n.name, img: n.img, chain: n.chain, worth: parseFloat(n.worth || 0), sold: !!n.sold }));
  },

  async getOsaryxNFTs() {
    const rows = await q(sb.from('osaryx_nfts').select('*').order('created_at', { ascending: false }));
    return rows.map(n => ({ id: n.id, name: n.name, img: n.img, chain: n.chain, worth: parseFloat(n.worth || 0), sold: !!n.sold }));
  },

  async getMaintenanceStatus() {
    const row = await qSingle(sb.from('maintenance').select('*').eq('id', 1).single());
    return { isActive: !!(row && row.is_active), message: (row && row.message) || '' };
  },

  /* ── Backup export ── */
  async exportAll() {
    const tables = [
      'users', 'transactions', 'ref_queue', 'referrals', 'x_queue', 'tasks',
      'events', 'nft_listings', 'nft_requests', 'osaryx_nfts', 'osaryx_nft_requests',
      'epic_gods_requests', 'vaults', 'maintenance', 'banned_users', 'global_stats',
      'task_click_log', 'admin_messages',
    ];
    const out = {};
    for (const t of tables) {
      try { out[t] = await q(sb.from(t).select('*')); }
      catch (e) { out[t] = { error: String(e.message || e) }; }
    }
    out.exported_at = new Date().toISOString();
    return out;
  },
};

window.DB = DB;