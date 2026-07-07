/* ============================================================
   admin-db.js — Admin read layer
   All reads go through the Deno backend with the session token.
   No Supabase keys in the browser.
   Injected placeholder: https://snappy-wren-4059.alphaminingproject-bot.deno.net
   ============================================================ */

const ADMIN_DB_URL = 'https://osaryx-admin-api.onrender.com';

const DB = (function () {

  let _token = null;
  function setToken(t) { _token = t; }

  async function query(path) {
    const r = await fetch(ADMIN_DB_URL + '/admin-read?q=' + encodeURIComponent(path), {
      headers: { 'Authorization': 'Bearer ' + _token }
    });
    if (r.status === 401) throw new Error('Session expired');
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.data;
  }

  function normaliseUser(u) {
    if (!u) return null;
    return {
      id: String(u.tg_id), name: u.name||'Acolyte', username: u.username||'',
      photoUrl: u.photo_url||'', balance: parseFloat(u.balance||0),
      lastMine: parseInt(u.last_mine||0,10), mineIntervalHours: parseFloat(u.mine_interval_hours||3),
      mineMultiplier: parseFloat(u.mine_multiplier||1),
      storageExpiresAt: u.storage_expires_at||null, storageHours: u.storage_hours||null,
      runeExpiresAt: u.rune_expires_at||null, runeType: u.rune_type||null,
      zeusActiveUntil: u.zeus_active_until||null, zeusStartedAt: u.zeus_started_at||null,
      referredBy: u.referred_by||null,
      taskStates: typeof u.task_states==='string' ? JSON.parse(u.task_states||'{}') : (u.task_states||{}),
      completedTasks: typeof u.completed_tasks==='string' ? JSON.parse(u.completed_tasks||'{}') : (u.completed_tasks||{}),
      isBanned: !!u.is_banned, welcomed: !!u.welcomed,
      lastSeen: parseInt(u.last_seen||0,10), createdAt: parseInt(u.created_at||Date.now(),10)
    };
  }

  const MAX_SUPPLY = 23000000;

  function getAllUsersForLeaderboard(limit) { return query('users_leaderboard?limit='+(limit||100)).then(r=>r.map(normaliseUser)).catch(()=>[]); }
  function getAllUsersForAdmin(search)      { return query('users_admin'+(search?'?q='+encodeURIComponent(search):'')).then(r=>r.map(normaliseUser)).catch(()=>[]); }
  function getUserCount()                  { return query('user_count').then(r=>r.count||0).catch(()=>0); }
  function findUserByIdOrUsername(q)       { return query('user_find?q='+encodeURIComponent(q)).then(r=>normaliseUser(r)).catch(()=>null); }
  function getReferralsFor(uid)            { return query('referrals?uid='+encodeURIComponent(uid)).then(r=>r.map(x=>({id:x.id,refereeId:x.referee_id,refereeName:x.referee_name,status:x.ref_status,earnedTotal:parseFloat(x.earned_total||0),createdAt:x.created_at}))).catch(()=>[]); }
  function getTransactionsFor(uid, limit)  { return query('transactions?uid='+encodeURIComponent(uid)+'&limit='+(limit||20)).catch(()=>[]); }
  function getVaultsFor(uid)               { return query('vaults?uid='+encodeURIComponent(uid)).then(r=>r.map(v=>({id:v.id,amount:parseFloat(v.amount),yield:parseFloat(v.yield_amount),stakedAt:v.staked_at,maturesAt:v.matures_at}))).catch(()=>[]); }
  function findTransaction(txnId)          { return query('txn_find?id='+encodeURIComponent(txnId)).catch(()=>null); }
  function getGlobalStats()                { return query('global_stats').then(r=>({totalMined:parseFloat(r.total_mined||0)})).catch(()=>({totalMined:0})); }
  function getMaintenanceStatus()          { return query('maintenance').then(r=>({isActive:r.is_active,message:r.message||''})).catch(()=>({isActive:false,message:''})); }
  function normTask(r) {
    return { id: r.id, name: r.name, desc: r.description||'', reward: r.reward, type: r.task_type, icon: r.icon||'🎯', target: r.target||'', xFollow: r.x_follow||false, autoRef: r.auto_ref||null, sortOrder: r.sort_order||0, clickCap: r.click_cap||null, clickCount: r.click_count||0 };
  }
  function getTasks()             { return query('tasks').then(r=>r.map(normTask)).catch(()=>[]); }
  function getAllTasksForAdmin()   { return query('tasks').then(r=>r.map(normTask)).catch(()=>[]); }
  function getEvents() {
    return query('events').then(r => r.map(ev => ({
      id: ev.id, name: ev.name, icon: ev.icon||'📣', desc: ev.description||'',
      reward: parseFloat(ev.reward||0), expiresAt: ev.expires_at||null, createdAt: ev.created_at,
      tasks: typeof ev.tasks === 'string' ? JSON.parse(ev.tasks||'[]') : (ev.tasks||[])
    }))).catch(()=>[]);
  }
  function getRefQueue()                   { return query('ref_queue').then(r=>r.map(x=>({id:x.id,referrerId:x.referrer_id,referrerName:x.referrer_name,refereeId:x.referee_id,refereeName:x.referee_name,ts:x.ts,status:x.queue_status}))).catch(()=>[]); }
  function getXQueue()                     { return query('x_queue').then(r=>r.map(x=>({id:x.id,userId:x.tg_user_id,userName:x.user_name,taskId:x.task_id,taskName:x.task_name,reward:x.reward,handle:x.x_handle,ts:x.ts,status:x.queue_status}))).catch(()=>[]); }
  function getNFTListings()                { return query('nft_listings').then(r=>r.map(x=>({id:x.id,name:x.name,img:x.img,chain:x.chain,worth:parseFloat(x.worth||0),sold:x.sold,soldTo:x.sold_to,dispatchStatus:x.dispatch_status}))).catch(()=>[]); }
  function getNFTRequests()                { return query('nft_requests').then(r=>r.map(x=>({reqId:x.req_id,userId:x.tg_user_id,userName:x.user_name,nftId:x.nft_id,nftName:x.nft_name,nftImg:x.nft_img,chain:x.chain,address:x.wallet_addr,worth:parseFloat(x.worth||0),ts:x.ts,status:x.req_status,txnId:x.txn_id}))).catch(()=>[]); }
  function getOsaryxNFTs()                 { return query('osaryx_nfts').then(r=>r.map(x=>({id:x.id,name:x.name,img:x.img,chain:x.chain,worth:parseFloat(x.worth||0),sold:x.sold,dispatchStatus:x.dispatch_status}))).catch(()=>[]); }
  function getOsaryxNFTRequests()          { return query('osaryx_nft_requests').then(r=>r.map(x=>({reqId:x.req_id,userId:x.tg_user_id,userName:x.user_name,nftId:x.nft_id,nftName:x.nft_name,nftImg:x.nft_img,chain:x.chain,address:x.wallet_addr,worth:parseFloat(x.worth||0),ts:x.ts,status:x.req_status,txnId:x.txn_id}))).catch(()=>[]); }
  function getEpicGodsRequests()           { return query('epic_gods_requests').then(r=>r.map(x=>({id:x.id,userId:x.tg_user_id,userName:x.user_name,username:x.username,godName:x.god_name,payMethod:x.pay_method,txnRef:x.txn_ref,status:x.req_status,ts:x.ts}))).catch(()=>[]); }
  function getTaskClickLog(taskId)         { return query('task_click_log?task_id='+encodeURIComponent(taskId)).then(r=>r.map(x=>({userId:x.tg_user_id,userName:x.user_name,ts:x.ts}))).catch(()=>[]); }

  function exportAll() {
    return Promise.all([getAllUsersForAdmin(), getGlobalStats(), getAllTasksForAdmin(), getEvents(), getXQueue(), getRefQueue(), getNFTListings(), getNFTRequests()])
      .then(([users,gs,tasks,events,xq,rq,nfts,nftreqs]) => ({
        exportedAt: new Date().toISOString(), users, globalStats:gs, tasks, events, xQueue:xq, refQueue:rq, nftListings:nfts, nftRequests:nftreqs
      }));
  }

  return {
    setToken, MAX_SUPPLY,
    getAllUsersForLeaderboard, getAllUsersForAdmin, getUserCount,
    findUserByIdOrUsername, getReferralsFor, getTransactionsFor,
    getVaultsFor, findTransaction, getGlobalStats, getMaintenanceStatus,
    getTasks, getAllTasksForAdmin, getEvents, getRefQueue, getXQueue,
    getNFTListings, getNFTRequests, getOsaryxNFTs, getOsaryxNFTRequests,
    getEpicGodsRequests, getTaskClickLog, exportAll
  };
})();
