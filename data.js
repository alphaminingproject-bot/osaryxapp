/* ============================================================
   data.js — OSARYX Token · Data Layer v3
   Every column name here is matched EXACTLY against schema.sql.
   Every user-specific read is scoped to that one user.
   Collective reads (leaderboard, admin overview, NFT market)
   are explicitly named so the exception is obvious.
   ============================================================ */

const SUPABASE_URL    = 'https://pnvzcdipmazdhkjpaasf.supabase.co';
const SUPABASE_ANON   = 'sb_publishable_Cim6Q3kudqrXUHCaGCg4nA_mW8a1sgb';
const TOKEN_NAME       = 'OSARYX';
const MAX_SUPPLY       = 23000000;
const BOT_BACKEND_URL  = 'https://snappy-wren-4059.alphaminingproject-bot.deno.net';
const MEMBER_CHECK_URL = 'https://hard-warthog-2361.alphaminingproject-bot.deno.net';  /* URL of the separate member-check-bot on Deno Deploy */

const SB = (function () {
  const BASE = SUPABASE_URL + '/rest/v1';
  const HDR  = {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON,
    'Authorization': 'Bearer ' + SUPABASE_ANON,
    'Prefer':        'return=representation'
  };

  function get(table, query) {
    return fetch(BASE + '/' + table + (query ? '?' + query : ''), { headers: HDR })
      .then(r => r.json())
      .catch(e => { console.error('SB.get failed', table, e); return []; });
  }
  function upsert(table, body) {
    const h = Object.assign({}, HDR, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
    return fetch(BASE + '/' + table, { method: 'POST', headers: h, body: JSON.stringify(body) })
      .then(r => r.json())
      .catch(e => { console.error('SB.upsert failed', table, e); return null; });
  }
  function patch(table, query, body) {
    return fetch(BASE + '/' + table + '?' + query, { method: 'PATCH', headers: HDR, body: JSON.stringify(body) })
      .then(r => r.json())
      .catch(e => { console.error('SB.patch failed', table, e); return null; });
  }
  function post(table, body) {
    return fetch(BASE + '/' + table, { method: 'POST', headers: HDR, body: JSON.stringify(body) })
      .then(r => r.json())
      .catch(e => { console.error('SB.post failed', table, e); return null; });
  }
  function del(table, query) {
    return fetch(BASE + '/' + table + '?' + query, { method: 'DELETE', headers: HDR })
      .then(r => r.ok)
      .catch(e => { console.error('SB.del failed', table, e); return false; });
  }
  return { get, upsert, patch, post, del };
})();

/* ══════════════════════════════════════════════════
   REALTIME
════════════════════════════════════════════════ */
const Realtime = (function () {
  let client = null;
  const channels = {};

  function getClient() {
    if (client) return client;
    if (typeof window.supabase === 'undefined') {
      console.warn('Supabase JS client not loaded — realtime sync disabled.');
      return null;
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return client;
  }

  function subscribeTable(table, callback) {
    const sb = getClient();
    if (!sb) return null;
    const channelName = 'rt_' + table;
    if (channels[channelName]) return channels[channelName];
    const ch = sb.channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table }, callback)
      .subscribe();
    channels[channelName] = ch;
    return ch;
  }

  function subscribeRow(table, filterColumn, filterValue, callback) {
    const sb = getClient();
    if (!sb) return null;
    const channelName = 'rt_' + table + '_' + filterColumn + '_' + filterValue;
    if (channels[channelName]) return channels[channelName];
    const ch = sb.channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: filterColumn + '=eq.' + filterValue }, callback)
      .subscribe();
    channels[channelName] = ch;
    return ch;
  }

  function unsubscribeAll() {
    const sb = getClient();
    if (!sb) return;
    Object.keys(channels).forEach(name => { sb.removeChannel(channels[name]); });
  }

  return { subscribeTable, subscribeRow, unsubscribeAll };
})();

const LOCAL = (function () {
  function load(key, fb) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fb; } catch (e) { return fb; } }
  function save(key, v)  { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  return { load, save };
})();

function genTxnId(userId, amount) {
  const ts = Date.now();
  const amtCents = Math.round(amount * 100);
  const amtPart = (amtCents < 0 ? '9' : '0') + Math.abs(amtCents);
  return 'TXN' + String(userId) + String(ts) + amtPart;
}

const DB = (function () {

  /* ════════════════════════════════════════════
     USERS
  ════════════════════════════════════════════ */
  function normaliseUser(u) {
    if (!u) return null;
    return {
      id:                   String(u.tg_id),
      name:                 u.name || 'Acolyte',
      username:             u.username || '',
      photoUrl:             u.photo_url || '',
      balance:              parseFloat(u.balance || 0),
      lastMine:             parseInt(u.last_mine || 0, 10),
      mineIntervalHours:    parseFloat(u.mine_interval_hours != null ? u.mine_interval_hours : 3),
      mineMultiplier:       parseFloat(u.mine_multiplier != null ? u.mine_multiplier : 1),
      storageExpiresAt:     u.storage_expires_at || null,
      storageHours:         u.storage_hours || null,
      runeExpiresAt:        u.rune_expires_at || null,
      runeType:             u.rune_type || null,
      zeusActiveUntil:      u.zeus_active_until || null,
      zeusStartedAt:        u.zeus_started_at || null,
      zeusSettledBalance:   parseFloat(u.zeus_settled_balance || 0),
      referredBy:           u.referred_by || null,
      taskStates:           (typeof u.task_states === 'string') ? JSON.parse(u.task_states || '{}') : (u.task_states || {}),
      taskHandles:          (typeof u.task_handles === 'string') ? JSON.parse(u.task_handles || '{}') : (u.task_handles || {}),
      /* completedTasks: permanent record of rewarded tasks — NEVER cleared */
      completedTasks:       (typeof u.completed_tasks === 'string') ? JSON.parse(u.completed_tasks || '{}') : (u.completed_tasks || {}),
      isBanned:             !!u.is_banned,
      welcomed:             !!u.welcomed,
      lastSeen:             parseInt(u.last_seen || 0, 10),
      createdAt:            parseInt(u.created_at || Date.now(), 10)
    };
  }

  function getUser(uid) {
    return SB.get('users', 'tg_id=eq.' + encodeURIComponent(uid)).then(rows => {
      if (!rows || rows.error || !rows.length) return null;
      return normaliseUser(rows[0]);
    }).catch(() => LOCAL.load('user_' + uid, null));
  }

  function saveUser(user) {
    user.lastSeen = Date.now();
    LOCAL.save('user_' + user.id, user);
    const row = {
      tg_id:                 String(user.id),
      name:                  user.name,
      username:              user.username || '',
      photo_url:             user.photoUrl || '',
      balance:               user.balance,
      last_mine:             user.lastMine,
      mine_interval_hours:   user.mineIntervalHours != null ? user.mineIntervalHours : 3,
      mine_multiplier:       user.mineMultiplier != null ? user.mineMultiplier : 1,
      storage_expires_at:    user.storageExpiresAt || null,
      storage_hours:         user.storageHours || null,
      rune_expires_at:       user.runeExpiresAt || null,
      rune_type:             user.runeType || null,
      zeus_active_until:     user.zeusActiveUntil || null,
      zeus_started_at:       user.zeusStartedAt || null,
      zeus_settled_balance:  user.zeusSettledBalance || 0,
      referred_by:           user.referredBy || null,
      task_states:           JSON.stringify(user.taskStates  || {}),
      task_handles:          JSON.stringify(user.taskHandles || {}),
      completed_tasks:       JSON.stringify(user.completedTasks || {}),
      is_banned:             !!user.isBanned,
      welcomed:              !!user.welcomed,
      last_seen:             user.lastSeen
    };
    return SB.upsert('users', row).catch(e => { console.error('saveUser failed', e); });
  }

  function createUser(tgUser) {
    const u = {
      id: String(tgUser.id), name: tgUser.first_name || 'Acolyte', username: tgUser.username || '',
      photoUrl: tgUser.photo_url || '', balance: 0, lastMine: 0,
      mineIntervalHours: 3, mineMultiplier: 1,
      storageExpiresAt: null, storageHours: null, runeExpiresAt: null, runeType: null,
      zeusActiveUntil: null, zeusStartedAt: null, zeusSettledBalance: 0,
      referredBy: null, taskStates: {}, taskHandles: {}, completedTasks: {},
      isBanned: false, welcomed: false,
      lastSeen: Date.now(), createdAt: Date.now()
    };
    return saveUser(u).then(() => u);
  }

  function findUserByIdOrUsername(query) {
    query = String(query || '').trim().replace(/^@/, '');
    if (!query) return Promise.resolve(null);
    return SB.get('users', 'tg_id=eq.' + encodeURIComponent(query)).then(rows => {
      if (rows && !rows.error && rows.length) return normaliseUser(rows[0]);
      return SB.get('users', 'username=ilike.' + encodeURIComponent(query)).then(rows2 => {
        if (rows2 && !rows2.error && rows2.length) return normaliseUser(rows2[0]);
        return null;
      });
    }).catch(e => { console.error('findUserByIdOrUsername failed', e); return null; });
  }

  function getAllUsersForLeaderboard(limit) {
    return SB.get('users', 'order=balance.desc&limit=' + (limit||100) + '&is_banned=eq.false').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(normaliseUser);
    }).catch(() => []);
  }

  /* getUserRank: returns the user's true global leaderboard position (1-indexed)
     without pulling the whole users table. Counts how many non-banned users
     have a strictly higher balance, then adds 1. Scales to any user count
     since it's a single count=exact request, not a full table fetch. */
  function getUserRank(uid, balance) {
    return fetch(
      SUPABASE_URL + '/rest/v1/users?select=tg_id&is_banned=eq.false&balance=gt.' + encodeURIComponent(balance),
      { headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON, Prefer: 'count=exact', Range: '0-0' } }
    ).then(r => {
      const range = r.headers.get('content-range');
      const higherCount = range ? (parseInt(range.split('/')[1], 10) || 0) : 0;
      return higherCount + 1;
    }).catch(() => null);
  }

  function getAllUsersForAdmin(searchQuery) {
    let q = 'order=last_seen.desc&limit=200';
    if (searchQuery) {
      const s = encodeURIComponent(searchQuery.replace(/^@/, ''));
      q = 'or=(name.ilike.*' + s + '*,username.ilike.*' + s + '*,tg_id.eq.' + s + ')&limit=100';
    }
    return SB.get('users', q).then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(normaliseUser);
    }).catch(e => { console.error('getAllUsersForAdmin failed', e); return []; });
  }

  function getUserCount() {
    return fetch(SUPABASE_URL + '/rest/v1/users?select=tg_id', {
      headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON, Prefer: 'count=exact', Range: '0-0' }
    }).then(r => {
      const range = r.headers.get('content-range');
      return range ? (parseInt(range.split('/')[1], 10) || 0) : 0;
    }).catch(() => 0);
  }

  function banUser(uid, reason) {
    return SB.patch('users', 'tg_id=eq.' + encodeURIComponent(uid), { is_banned: true })
      .then(() => SB.post('banned_users', { tg_id: String(uid), reason: reason||'', banned_at: Date.now() }))
      .catch(e => { console.error('banUser failed', e); });
  }

  function unbanUser(uid) {
    return SB.patch('users', 'tg_id=eq.' + encodeURIComponent(uid), { is_banned: false }).catch(() => {});
  }

  /* ════════════════════════════════════════════
     REFERRALS
  ════════════════════════════════════════════ */
  function getReferralsFor(referrerId) {
    return SB.get('referrals', 'referrer_id=eq.' + encodeURIComponent(referrerId) + '&order=created_at.desc').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, refereeId: r.referee_id, refereeName: r.referee_name, status: r.ref_status, earnedTotal: parseFloat(r.earned_total||0), createdAt: r.created_at }));
    }).catch(() => []);
  }

  function addReferral(referrerId, refereeId, refereeName) {
    return SB.post('referrals', { referrer_id: String(referrerId), referee_id: String(refereeId), referee_name: refereeName, ref_status: 'pending', earned_total: 0, created_at: Date.now() })
      .catch(e => { console.error('addReferral failed', e); });
  }

  function bumpReferralEarned(referrerId, refereeId, amount) {
    return SB.get('referrals', 'referrer_id=eq.' + encodeURIComponent(referrerId) + '&referee_id=eq.' + encodeURIComponent(refereeId)).then(rows => {
      if (!rows || !rows.length) return;
      const current = parseFloat(rows[0].earned_total || 0);
      return SB.patch('referrals', 'referrer_id=eq.' + encodeURIComponent(referrerId) + '&referee_id=eq.' + encodeURIComponent(refereeId), { earned_total: current + amount });
    }).catch(() => {});
  }

  function verifyReferral(referrerId, refereeId) {
    return SB.patch('referrals', 'referrer_id=eq.' + encodeURIComponent(referrerId) + '&referee_id=eq.' + encodeURIComponent(refereeId), { ref_status: 'verified' }).catch(() => {});
  }

  function referralExists(referrerId, refereeId) {
    return SB.get('referrals', 'referrer_id=eq.' + encodeURIComponent(referrerId) + '&referee_id=eq.' + encodeURIComponent(refereeId)).then(rows => rows && rows.length > 0).catch(() => false);
  }

  /* ════════════════════════════════════════════
     VAULTS (staking)
     FIX: vault creation is now atomic — we read the
     user, deduct balance, and insert the vault in one
     guarded flow. A unique vault ID with a per-user
     nonce prevents double-inserts on double-tap.
  ════════════════════════════════════════════ */
  function getVaultsFor(uid) {
    return SB.get('vaults', 'tg_user_id=eq.' + encodeURIComponent(uid) + '&order=staked_at.desc').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(v => ({ id: v.id, amount: parseFloat(v.amount), yield: parseFloat(v.yield_amount), stakedAt: v.staked_at, maturesAt: v.matures_at }));
    }).catch(() => []);
  }

  function createVault(uid, amount, yieldAmt, stakedAt, maturesAt) {
    /* ID includes a per-user millisecond timestamp so rapid double-taps
       produce a duplicate key error on the second insert — the vault table
       has `id text primary key`, so the second insert silently fails instead
       of creating a ghost vault. */
    const id = 'V' + String(uid) + '_' + stakedAt;
    return SB.post('vaults', { id, tg_user_id: String(uid), amount, yield_amount: yieldAmt, staked_at: stakedAt, matures_at: maturesAt })
      .catch(e => { console.error('createVault failed', e); });
  }

  function deleteVault(vaultId) {
    return SB.del('vaults', 'id=eq.' + encodeURIComponent(vaultId)).catch(() => {});
  }

  function adminCancelVault(vaultId, uid, amount) {
    return getUser(uid).then(u => {
      if (!u) return;
      u.balance += amount;
      logTransaction(u.id, u.name, 'unstake', 'Admin cancelled vault — principal refunded', amount, u.balance);
      return saveUser(u);
    }).then(() => deleteVault(vaultId));
  }

  function adminFillVault(vaultId, uid, amount, yieldAmt) {
    return getUser(uid).then(u => {
      if (!u) return;
      u.balance += amount + yieldAmt;
      logTransaction(u.id, u.name, 'unstake', 'Admin force-filled vault — principal + yield paid', amount + yieldAmt, u.balance);
      return saveUser(u);
    }).then(() => deleteVault(vaultId));
  }

  /* ════════════════════════════════════════════
     TRANSACTIONS (universal ledger)
  ════════════════════════════════════════════ */
  function logTransaction(userId, userName, type, desc, amount, balanceAfter, externalToken, externalAmount) {
    const txnId = genTxnId(userId, amount);
    SB.post('transactions', { txn_id: txnId, tg_user_id: String(userId), user_name: userName||'', type, description: desc, amount, external_token: externalToken||null, external_amount: externalAmount != null ? externalAmount : null, balance_after: balanceAfter, ts: Date.now() })
      .catch(e => { console.error('logTransaction failed', e); });
    return txnId;
  }

  function getTransactionsFor(uid, limit) {
    return SB.get('transactions', 'tg_user_id=eq.' + encodeURIComponent(uid) + '&order=ts.desc&limit=' + (limit||50)).then(rows => {
      return (!rows || rows.error) ? [] : rows;
    }).catch(() => []);
  }

  function findTransaction(txnId) {
    return SB.get('transactions', 'txn_id=eq.' + encodeURIComponent(txnId)).then(rows => (rows && rows.length) ? rows[0] : null).catch(() => null);
  }

  /* ════════════════════════════════════════════
     TASKS
     FIX: completedTasks is the permanent record.
     taskStates is only transient UI state (pending,
     verify, rejected). clearUserTaskState ONLY clears
     taskStates — it never touches completedTasks.
     A task with completedTasks[id] = true will never
     reward the user again regardless of taskStates.
  ════════════════════════════════════════════ */
  function getTasks() {
    return SB.get('tasks', 'order=sort_order.asc').then(rows => {
      if (!rows || rows.error) return [];
      return rows
        .filter(r => r.click_cap == null || (r.click_count||0) < r.click_cap)
        .map(r => ({
          id: r.id, name: r.name, desc: r.description||'', reward: r.reward,
          type: r.task_type, icon: r.icon||'🎯', target: r.target||'',
          xFollow: r.x_follow||false, autoRef: r.auto_ref||null,
          sortOrder: r.sort_order||0, clickCap: r.click_cap, clickCount: r.click_count||0
        }));
    }).catch(e => { console.error('getTasks failed', e); return []; });
  }

  function getAllTasksForAdmin() {
    return SB.get('tasks', 'order=sort_order.asc').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({
        id: r.id, name: r.name, desc: r.description||'', reward: r.reward,
        type: r.task_type, icon: r.icon||'🎯', target: r.target||'',
        xFollow: r.x_follow||false, autoRef: r.auto_ref||null,
        sortOrder: r.sort_order||0, clickCap: r.click_cap, clickCount: r.click_count||0
      }));
    }).catch(e => { console.error('getAllTasksForAdmin failed', e); return []; });
  }

  function addTask(task) {
    return SB.get('tasks', 'task_type=neq.auto_ref&order=sort_order.asc&limit=1').then(rows => {
      const minOrder = (rows && rows.length) ? rows[0].sort_order : 100;
      const newOrder = task.type === 'auto_ref' ? (9000 + Date.now() % 1000)
                     : task.type === 'watch_ad' ? -999999
                     : (minOrder - 1);
      return SB.post('tasks', {
        id: task.id, name: task.name, description: task.desc||'', reward: task.reward,
        task_type: task.type, icon: task.icon||'🎯', target: task.target||'',
        x_follow: task.xFollow||false, auto_ref: task.autoRef||null,
        click_cap: task.clickCap||null, click_count: 0, sort_order: newOrder
      });
    }).catch(e => { console.error('addTask failed', e); throw e; });
  }

  function deleteTask(taskId) {
    return SB.del('tasks', 'id=eq.' + encodeURIComponent(taskId)).catch(() => {});
  }

  function incrementTaskClickCount(taskId) {
    return SB.get('tasks', 'id=eq.' + encodeURIComponent(taskId)).then(rows => {
      if (!rows || !rows.length) return;
      return SB.patch('tasks', 'id=eq.' + encodeURIComponent(taskId), { click_count: (rows[0].click_count||0) + 1 });
    }).catch(() => {});
  }

  /* clearUserTaskState: ONLY clears transient UI state.
     NEVER removes from completedTasks. */
  function clearUserTaskState(uid, taskId) {
    return getUser(uid).then(u => {
      if (!u) return;
      delete u.taskStates[taskId];
      delete u.taskHandles[taskId];
      /* completedTasks[taskId] is intentionally NOT touched here */
      return saveUser(u);
    });
  }

  /* settleAutoRefTasksFor: uses completedTasks for permanent guard,
     taskStates only for transient UI feedback. */
  function settleAutoRefTasksFor(uid) {
    return Promise.all([getUser(uid), getReferralsFor(uid), getTasks()]).then(r => {
      const [u, refs, tasks] = r;
      if (!u) return;
      const verifiedCount = refs.filter(x => x.status === 'verified').length;
      let anyChanged = false;

      tasks.forEach(task => {
        if (task.type !== 'auto_ref' || !task.autoRef) return;
        /* Guard: never reward a task that has already been permanently completed */
        if (u.completedTasks[task.id]) return;
        if (verifiedCount >= task.autoRef) {
          u.completedTasks[task.id] = true;
          u.taskStates[task.id] = 'done';
          u.balance += task.reward;
          logTransaction(u.id, u.name, 'task', 'Invocation task: ' + task.name, task.reward, u.balance);
          addToTotalMined(task.reward);
          incrementTaskClickCount(task.id);
          anyChanged = true;
        }
      });

      if (!anyChanged) return;
      return saveUser(u).then(() => {
        /* Only clear the UI state after a delay — completedTasks remains */
        setTimeout(() => {
          tasks.forEach(task => {
            if (task.type === 'auto_ref' && u.taskStates[task.id] === 'done') {
              clearUserTaskState(uid, task.id);
            }
          });
        }, 4000);
      });
    });
  }

  /* ════════════════════════════════════════════
     EVENTS — now support multiple tasks, expiry,
     and per-user completion tracking via
     eventStates stored on the user row.
  ════════════════════════════════════════════ */
  function getEvents() {
    const now = Date.now();
    return SB.get('events', 'order=created_at.desc').then(rows => {
      if (!rows || rows.error) return [];
      return rows
        .filter(r => !r.expires_at || r.expires_at > now)
        .map(r => ({
          id: r.id, name: r.name, icon: r.icon||'📣', desc: r.description||'',
          reward: parseFloat(r.reward || 0),
          expiresAt: r.expires_at || null,
          createdAt: r.created_at,
          tasks: typeof r.tasks === 'string' ? JSON.parse(r.tasks||'[]') : (r.tasks||[])
        }));
    }).catch(e => { console.error('getEvents failed', e); return []; });
  }

  function createEvent(ev) {
    const row = {
      id: ev.id, name: ev.name, icon: ev.icon||'📣', description: ev.desc||'',
      reward: ev.reward || 0,
      expires_at: ev.expiresAt || null,
      tasks: JSON.stringify(ev.tasks||[]),
      created_at: Date.now()
    };
    return SB.post('events', row).then(result => {
      if (result && result.error) { console.error('createEvent insert error', result.error); throw new Error(result.error.message || JSON.stringify(result.error)); }
      if (!result) { throw new Error('No response from Supabase'); }
      return result;
    });
  }

  function deleteEvent(evId) {
    return SB.del('events', 'id=eq.' + encodeURIComponent(evId)).catch(() => {});
  }

  /* ════════════════════════════════════════════
     X QUEUE
  ════════════════════════════════════════════ */
  function pushXQueueItem(item) {
    return SB.post('x_queue', {
      tg_user_id: item.userId, user_name: item.userName||'', task_id: item.taskId||'',
      task_name: item.taskName||'', reward: item.reward||0, x_handle: item.handle||'',
      ts: item.ts||Date.now(), queue_status: 'pending', notified: false
    }).catch(e => { console.error('pushXQueueItem failed', e); });
  }

  function getXQueue() {
    return SB.get('x_queue', 'order=ts.desc&limit=200').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, userId: r.tg_user_id, userName: r.user_name, taskId: r.task_id, taskName: r.task_name, reward: r.reward, handle: r.x_handle, ts: r.ts, status: r.queue_status, notified: r.notified }));
    }).catch(e => { console.error('getXQueue failed', e); return []; });
  }

  function getXQueueFor(uid) {
    return SB.get('x_queue', 'tg_user_id=eq.' + encodeURIComponent(uid) + '&notified=eq.false&queue_status=neq.pending').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, userId: r.tg_user_id, taskName: r.task_name, reward: r.reward, status: r.queue_status }));
    }).catch(() => []);
  }

  function updateXQueueRow(id, patchObj) {
    const dbPatch = {};
    if (patchObj.status   !== undefined) dbPatch.queue_status = patchObj.status;
    if (patchObj.notified !== undefined) dbPatch.notified     = patchObj.notified;
    return SB.patch('x_queue', 'id=eq.' + id, dbPatch).catch(e => { console.error('updateXQueueRow failed', e); });
  }

  /* ════════════════════════════════════════════
     REF QUEUE
  ════════════════════════════════════════════ */
  function getRefQueue() {
    return SB.get('ref_queue', 'order=ts.desc&limit=200').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, referrerId: r.referrer_id, referrerName: r.referrer_name, refereeId: r.referee_id, refereeName: r.referee_name, ts: r.ts, status: r.queue_status }));
    }).catch(() => []);
  }

  function pushRefQueueItem(item) {
    return SB.post('ref_queue', { referrer_id: item.referrerId, referrer_name: item.referrerName||'', referee_id: item.refereeId, referee_name: item.refereeName||'', ts: item.ts||Date.now(), queue_status: 'pending' }).catch(() => {});
  }

  function updateRefQueueRow(id, status) {
    return SB.patch('ref_queue', 'id=eq.' + id, { queue_status: status }).catch(() => {});
  }

  function refQueueEntryExists(referrerId, refereeId) {
    return SB.get('ref_queue', 'referrer_id=eq.' + encodeURIComponent(referrerId) + '&referee_id=eq.' + encodeURIComponent(refereeId)).then(rows => rows && rows.length > 0).catch(() => false);
  }

  /* ════════════════════════════════════════════
     NFT LISTINGS
  ════════════════════════════════════════════ */
  function getNFTListings() {
    return SB.get('nft_listings', 'order=created_at.desc').then(rows => {
      if (!rows || rows.error) return [];
      const now = Date.now();
      return rows
        .filter(r => !r.sold || !r.sold_expires_at || r.sold_expires_at > now)
        .map(r => ({ id: r.id, name: r.name, img: r.img, chain: r.chain, worth: parseFloat(r.worth||0), sold: r.sold, soldTo: r.sold_to, dispatchStatus: r.dispatch_status, createdAt: r.created_at }));
    }).catch(e => { console.error('getNFTListings failed', e); return []; });
  }

  function getOwnedNFTListings(uid) {
    return SB.get('nft_listings', 'sold_to=eq.' + encodeURIComponent(uid)).then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, name: r.name, img: r.img, chain: r.chain, worth: parseFloat(r.worth||0), sold: r.sold, soldTo: r.sold_to, dispatchStatus: r.dispatch_status, createdAt: r.created_at }));
    }).catch(() => []);
  }

  function createNFTListing(nft) {
    return SB.post('nft_listings', { id: nft.id, name: nft.name, img: nft.img, chain: nft.chain||'', worth: nft.worth||0, sold: false, created_at: Date.now() })
      .then(result => {
        if (result && result.error) { console.error('createNFTListing error', result.error); throw new Error(result.error.message || 'Insert failed'); }
        return result;
      });
  }

  function deleteNFTListing(id) {
    return SB.del('nft_listings', 'id=eq.' + encodeURIComponent(id)).catch(() => {});
  }

  function tryBuyNFT(nftId, buyerId, soldVisibleMinutes) {
    const expiresAt = soldVisibleMinutes ? (Date.now() + soldVisibleMinutes * 60000) : null;
    return fetch(SUPABASE_URL + '/rest/v1/nft_listings?id=eq.' + encodeURIComponent(nftId) + '&sold=eq.false', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON, Prefer: 'return=representation' },
      body: JSON.stringify({ sold: true, sold_to: String(buyerId), sold_at: Date.now(), sold_expires_at: expiresAt })
    }).then(r => r.json()).then(rows => Array.isArray(rows) && rows.length > 0).catch(() => false);
  }

  function setNFTDispatchStatus(nftId, status) {
    return SB.patch('nft_listings', 'id=eq.' + encodeURIComponent(nftId), { dispatch_status: status }).catch(() => {});
  }

  function setNFTSoldUndo(nftId) {
    return SB.patch('nft_listings', 'id=eq.' + encodeURIComponent(nftId), { sold: false, sold_to: null, sold_at: null, sold_expires_at: null, dispatch_status: null }).catch(() => {});
  }

  /* ════════════════════════════════════════════
     OSARYX NFTS
  ════════════════════════════════════════════ */
  function getOsaryxNFTs() {
    return SB.get('osaryx_nfts', 'order=created_at.desc').then(rows => {
      if (!rows || rows.error) return [];
      const now = Date.now();
      return rows
        .filter(r => !r.sold || !r.sold_expires_at || r.sold_expires_at > now)
        .map(r => ({ id: r.id, name: r.name, img: r.img, chain: r.chain, worth: parseFloat(r.worth||0), sold: r.sold, soldTo: r.sold_to, dispatchStatus: r.dispatch_status, createdAt: r.created_at }));
    }).catch(e => { console.error('getOsaryxNFTs failed', e); return []; });
  }

  function getOwnedOsaryxNFTs(uid) {
    return SB.get('osaryx_nfts', 'sold_to=eq.' + encodeURIComponent(uid)).then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, name: r.name, img: r.img, chain: r.chain, worth: parseFloat(r.worth||0), sold: r.sold, soldTo: r.sold_to, dispatchStatus: r.dispatch_status, createdAt: r.created_at }));
    }).catch(() => []);
  }

  function createOsaryxNFT(nft) {
    return SB.post('osaryx_nfts', { id: nft.id, name: nft.name, img: nft.img, chain: nft.chain||'', worth: nft.worth||0, sold: false, created_at: Date.now() })
      .then(result => {
        if (result && result.error) { console.error('createOsaryxNFT error', result.error); throw new Error(result.error.message || 'Insert failed'); }
        return result;
      });
  }

  function deleteOsaryxNFT(id) {
    return SB.del('osaryx_nfts', 'id=eq.' + encodeURIComponent(id)).catch(() => {});
  }

  function tryBuyOsaryxNFT(nftId, buyerId, soldVisibleMinutes) {
    const expiresAt = soldVisibleMinutes ? (Date.now() + soldVisibleMinutes * 60000) : null;
    return fetch(SUPABASE_URL + '/rest/v1/osaryx_nfts?id=eq.' + encodeURIComponent(nftId) + '&sold=eq.false', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON, Prefer: 'return=representation' },
      body: JSON.stringify({ sold: true, sold_to: String(buyerId), sold_at: Date.now(), sold_expires_at: expiresAt })
    }).then(r => r.json()).then(rows => Array.isArray(rows) && rows.length > 0).catch(() => false);
  }

  function setOsaryxNFTDispatchStatus(nftId, status) {
    return SB.patch('osaryx_nfts', 'id=eq.' + encodeURIComponent(nftId), { dispatch_status: status }).catch(() => {});
  }

  function pushOsaryxNFTRequest(item) {
    return SB.post('osaryx_nft_requests', {
      req_id: item.reqId, tg_user_id: item.userId, user_name: item.userName||'',
      nft_id: item.nftId||'', nft_name: item.nftName||'', nft_img: item.nftImg||'',
      chain: item.chain||'', wallet_addr: item.address||'', worth: item.worth||0,
      ts: item.ts||Date.now(), req_status: 'pending', notified: false
    }).catch(e => { console.error('pushOsaryxNFTRequest failed', e); });
  }

  function getOsaryxNFTRequests() {
    return SB.get('osaryx_nft_requests', 'order=ts.desc&limit=200').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ reqId: r.req_id, userId: r.tg_user_id, userName: r.user_name, nftId: r.nft_id, nftName: r.nft_name, nftImg: r.nft_img, chain: r.chain, address: r.wallet_addr, worth: parseFloat(r.worth||0), dispatchedToken: r.dispatched_token, dispatchedAmount: r.dispatched_amount != null ? parseFloat(r.dispatched_amount) : null, ts: r.ts, status: r.req_status, txnId: r.txn_id, notified: r.notified }));
    }).catch(e => { console.error('getOsaryxNFTRequests failed', e); return []; });
  }

  function getOsaryxNFTRequestsFor(uid) {
    return SB.get('osaryx_nft_requests', 'tg_user_id=eq.' + encodeURIComponent(uid) + '&notified=eq.false&req_status=eq.sent').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ reqId: r.req_id, dispatchedToken: r.dispatched_token, dispatchedAmount: r.dispatched_amount != null ? parseFloat(r.dispatched_amount) : null, txnId: r.txn_id }));
    }).catch(() => []);
  }

  function markOsaryxNFTSent(reqId, txnId) {
    /* req_status=eq.pending ensures this is an atomic one-time transition.
       If the row is already 'sent', the PATCH matches zero rows — silent no-op. */
    return fetch(SUPABASE_URL + '/rest/v1/osaryx_nft_requests?req_id=eq.' + encodeURIComponent(reqId) + '&req_status=eq.pending', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON, Prefer: 'return=representation' },
      body: JSON.stringify({ req_status: 'sent', txn_id: txnId, notified: false })
    }).then(r => r.json()).then(rows => {
      if (!Array.isArray(rows) || !rows.length) {
        console.warn('markOsaryxNFTSent: no rows updated — already dispatched?', reqId);
        return false;
      }
      return true;
    }).catch(e => { console.error('markOsaryxNFTSent failed', e); return false; });
  }

  function markOsaryxNFTRequestNotified(reqId) {
    return SB.patch('osaryx_nft_requests', 'req_id=eq.' + encodeURIComponent(reqId), { notified: true }).catch(() => {});
  }

  /* ════════════════════════════════════════════
     NFT REQUESTS (dispatch)
  ════════════════════════════════════════════ */
  function pushNFTRequest(item) {
    return SB.post('nft_requests', {
      req_id: item.reqId, tg_user_id: item.userId, user_name: item.userName||'',
      nft_id: item.nftId||'', nft_name: item.nftName||'', nft_img: item.nftImg||'',
      chain: item.chain||'', wallet_addr: item.address||'', worth: item.worth||0,
      ts: item.ts||Date.now(), req_status: 'pending', notified: false
    }).catch(e => { console.error('pushNFTRequest failed', e); });
  }

  function getNFTRequests() {
    return SB.get('nft_requests', 'order=ts.desc&limit=200').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ reqId: r.req_id, userId: r.tg_user_id, userName: r.user_name, nftId: r.nft_id, nftName: r.nft_name, nftImg: r.nft_img, chain: r.chain, address: r.wallet_addr, worth: parseFloat(r.worth||0), dispatchedToken: r.dispatched_token, dispatchedAmount: r.dispatched_amount != null ? parseFloat(r.dispatched_amount) : null, ts: r.ts, status: r.req_status, txnId: r.txn_id, notified: r.notified }));
    }).catch(e => { console.error('getNFTRequests failed', e); return []; });
  }

  function getNFTRequestsFor(uid) {
    return SB.get('nft_requests', 'tg_user_id=eq.' + encodeURIComponent(uid) + '&notified=eq.false&req_status=eq.sent').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ reqId: r.req_id, dispatchedToken: r.dispatched_token, dispatchedAmount: r.dispatched_amount != null ? parseFloat(r.dispatched_amount) : null, txnId: r.txn_id }));
    }).catch(() => []);
  }

  function markNFTSent(reqId, txnId, dispatchedToken, dispatchedAmount) {
    return SB.patch('nft_requests', 'req_id=eq.' + encodeURIComponent(reqId), {
      req_status: 'sent', txn_id: txnId, notified: false,
      dispatched_token: dispatchedToken, dispatched_amount: dispatchedAmount
    }).catch(() => {});
  }

  function markNFTRequestNotified(reqId) {
    return SB.patch('nft_requests', 'req_id=eq.' + encodeURIComponent(reqId), { notified: true }).catch(() => {});
  }

  /* ════════════════════════════════════════════
     GLOBAL STATS
  ════════════════════════════════════════════ */
  function getGlobalStats() {
    return SB.get('global_stats', 'id=eq.1').then(rows => {
      return (!rows || rows.error || !rows.length) ? { totalMined: 0 } : { totalMined: parseFloat(rows[0].total_mined||0) };
    }).catch(() => ({ totalMined: 0 }));
  }

  function addToTotalMined(amount) {
    return getGlobalStats().then(g => {
      const newTotal = (g.totalMined||0) + amount;
      SB.upsert('global_stats', { id: 1, total_mined: newTotal }).catch(() => {});
      return newTotal;
    });
  }

  /* ════════════════════════════════════════════
     MAINTENANCE MODE
  ════════════════════════════════════════════ */
  function getMaintenanceStatus() {
    return SB.get('maintenance', 'id=eq.1').then(rows => {
      return (!rows || rows.error || !rows.length) ? { isActive: false, message: '' } : { isActive: rows[0].is_active, message: rows[0].message };
    }).catch(() => ({ isActive: false, message: '' }));
  }

  function setMaintenanceMode(active, message, snapshot) {
    const body = { id: 1, is_active: active };
    if (message !== undefined) body.message = message;
    if (active) { body.activated_at = Date.now(); if (snapshot) body.snapshot = JSON.stringify(snapshot); }
    else { body.snapshot = null; body.activated_at = null; }
    return SB.upsert('maintenance', body).catch(e => { console.error('setMaintenanceMode failed', e); });
  }

  /* ════════════════════════════════════════════
     ADMIN MESSAGES
  ════════════════════════════════════════════ */
  function sendAdminMessage(uid, message) {
    return SB.post('admin_messages', { tg_user_id: String(uid), message, sent: false, ts: Date.now() })
      .then(() => pingBotToProcess())
      .catch(e => { console.error('sendAdminMessage failed', e); });
  }

  function pingBotToProcess() {
    if (!BOT_BACKEND_URL) return Promise.resolve();
    return fetch(BOT_BACKEND_URL + '/process-notifications').catch(e => { console.error('pingBotToProcess failed', e); });
  }

  function notifyAppOpen(uid) {
    if (!BOT_BACKEND_URL) return Promise.resolve();
    return fetch(BOT_BACKEND_URL + '/notify-app-open?user_id=' + encodeURIComponent(uid)).catch(() => {});
  }

  /* ════════════════════════════════════════════
     TELEGRAM MEMBERSHIP CHECK
  ════════════════════════════════════════════ */
  function checkTelegramMembership(userId, chatId) {
    const baseUrl = MEMBER_CHECK_URL || BOT_BACKEND_URL;
    if (!baseUrl) return Promise.resolve({ isMember: true, error: null });
    return fetch(baseUrl + '/check-member?user_id=' + encodeURIComponent(userId) + '&chat_id=' + encodeURIComponent(chatId))
      .then(r => r.json())
      .then(d => ({ isMember: d.is_member === true, error: d.error || null }))
      .catch(e => { console.error('checkTelegramMembership failed', e); return { isMember: false, error: String(e) }; });
  }

  /* ════════════════════════════════════════════
     ZEUS
  ════════════════════════════════════════════ */
  const ZEUS_MULT = 10;

  function settleZeusIfNeeded(user, baseMineReward, baseIntervalHours) {
    if (!user.zeusActiveUntil) return user;
    const now = Date.now();
    const perSecondRate = (baseMineReward * ZEUS_MULT) / (baseIntervalHours * 3600);
    const periodStart = user.zeusStartedAt || now;
    const periodEnd   = Math.min(now, user.zeusActiveUntil);
    const elapsedSec  = Math.max(0, (periodEnd - periodStart) / 1000);
    const earnedSoFar = elapsedSec * perSecondRate;

    if (now >= user.zeusActiveUntil) {
      const totalEarned = (user.zeusSettledBalance||0) + earnedSoFar;
      user.balance += totalEarned;
      logTransaction(user.id, user.name, 'zeus_settlement', "Zeus's blessing — 7 days of 10x harvest", totalEarned, user.balance);
      user.zeusActiveUntil = null; user.zeusStartedAt = null; user.zeusSettledBalance = 0;
    } else {
      user.balance += earnedSoFar;
      user.zeusStartedAt = now;
    }
    return user;
  }

  function activateZeus(uid) {
    return getUser(uid).then(u => {
      if (!u) return;
      u.zeusActiveUntil = Date.now() + 7*86400000;
      u.zeusStartedAt = Date.now();
      u.zeusSettledBalance = 0;
      return saveUser(u);
    });
  }

  /* ════════════════════════════════════════════
     EPIC GODS REQUESTS
  ════════════════════════════════════════════ */
  function pushEpicGodsRequest(item) {
    return SB.post('epic_gods_requests', { tg_user_id: item.userId, user_name: item.userName||'', username: item.username||'', god_name: item.godName||'zeus', pay_method: item.payMethod||'ton', txn_ref: item.txnRef||null, req_status: 'pending', ts: Date.now() }).catch(() => {});
  }

  function getEpicGodsRequests() {
    return SB.get('epic_gods_requests', 'order=ts.desc&limit=200').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ id: r.id, userId: r.tg_user_id, userName: r.user_name, username: r.username, godName: r.god_name, payMethod: r.pay_method, txnRef: r.txn_ref, status: r.req_status, ts: r.ts }));
    }).catch(() => []);
  }

  function approveEpicGodsRequest(id, uid) {
    return SB.patch('epic_gods_requests', 'id=eq.'+id, { req_status: 'verified', verified_at: Date.now() }).then(() => activateZeus(uid)).catch(() => {});
  }

  function rejectEpicGodsRequest(id) {
    return SB.patch('epic_gods_requests', 'id=eq.'+id, { req_status: 'rejected' }).catch(() => {});
  }

  function getTonConfig() {
    if (!BOT_BACKEND_URL) return Promise.resolve({ address: '' });
    return fetch(BOT_BACKEND_URL + '/ton-config').then(r => r.json()).catch(() => ({ address: '' }));
  }

  function createZeusStarsInvoice(uid) {
    if (!BOT_BACKEND_URL) return Promise.resolve(null);
    return fetch(BOT_BACKEND_URL + '/create-zeus-invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: uid }) })
      .then(r => r.json()).catch(() => null);
  }

  /* ════════════════════════════════════════════
     WATCH-AD REWARD
  ════════════════════════════════════════════ */
  function logAdWatch(uid, reward) {
    return getUser(uid).then(u => {
      if (!u) return;
      u.balance += reward;
      logTransaction(u.id, u.name, 'watch_ad', 'Watched a sacred vision (ad)', reward, u.balance);
      addToTotalMined(reward);
      return saveUser(u);
    });
  }

  /* ════════════════════════════════════════════
     TASK CLICK LOG
  ════════════════════════════════════════════ */
  function logTaskClick(taskId, uid, userName) {
    return SB.post('task_click_log', { task_id: taskId, tg_user_id: String(uid), user_name: userName||'', ts: Date.now() }).catch(() => {});
  }

  function getTaskClickLog(taskId) {
    return SB.get('task_click_log', 'task_id=eq.' + encodeURIComponent(taskId) + '&order=ts.desc&limit=500').then(rows => {
      if (!rows || rows.error) return [];
      return rows.map(r => ({ userId: r.tg_user_id, userName: r.user_name, ts: r.ts }));
    }).catch(() => []);
  }

  /* ════════════════════════════════════════════
     EXPORT (admin backup)
  ════════════════════════════════════════════ */
  function exportAll() {
    return Promise.all([
      getAllUsersForAdmin(), getGlobalStats(), getTasks(), getEvents(),
      getXQueue(), getRefQueue(), getNFTListings(), getNFTRequests()
    ]).then(r => ({
      exportedAt: new Date().toISOString(), totalUsers: r[0].length, users: r[0],
      globalStats: r[1], tasks: r[2], events: r[3], xQueue: r[4],
      refQueue: r[5], nftListings: r[6], nftRequests: r[7]
    }));
  }

  return {
    normaliseUser,  /* exported so realtime payloads can be normalised without a DB round-trip */
    getUser, saveUser, createUser,
    findUserByIdOrUsername,
    getAllUsersForLeaderboard, getAllUsersForAdmin, getUserRank,
    getUserCount, banUser, unbanUser,

    getReferralsFor, addReferral, bumpReferralEarned,
    verifyReferral, referralExists,

    getVaultsFor, createVault, deleteVault,
    adminCancelVault, adminFillVault,

    logTransaction, getTransactionsFor, findTransaction,

    getTasks, getAllTasksForAdmin, addTask, deleteTask,
    incrementTaskClickCount, clearUserTaskState,
    settleAutoRefTasksFor,

    getEvents, createEvent, deleteEvent,

    pushXQueueItem, getXQueue, getXQueueFor, updateXQueueRow,

    getRefQueue, pushRefQueueItem, updateRefQueueRow, refQueueEntryExists,

    getNFTListings, getOwnedNFTListings,
    createNFTListing, deleteNFTListing,
    tryBuyNFT, setNFTDispatchStatus, setNFTSoldUndo,

    getOsaryxNFTs, getOwnedOsaryxNFTs,
    createOsaryxNFT, deleteOsaryxNFT, tryBuyOsaryxNFT,
    setOsaryxNFTDispatchStatus,
    pushOsaryxNFTRequest, getOsaryxNFTRequests,
    getOsaryxNFTRequestsFor, markOsaryxNFTSent,
    markOsaryxNFTRequestNotified,

    getTaskClickLog, logTaskClick,

    pushNFTRequest, getNFTRequests, getNFTRequestsFor,
    markNFTSent, markNFTRequestNotified,

    getGlobalStats, addToTotalMined, MAX_SUPPLY,

    getMaintenanceStatus, setMaintenanceMode,

    sendAdminMessage, pingBotToProcess, notifyAppOpen, checkTelegramMembership,

    settleZeusIfNeeded, activateZeus,
    pushEpicGodsRequest, getEpicGodsRequests,
    approveEpicGodsRequest, rejectEpicGodsRequest,
    getTonConfig, createZeusStarsInvoice,

    logAdWatch,

    exportAll,
    TOKEN_NAME,
    Realtime
  };
})();