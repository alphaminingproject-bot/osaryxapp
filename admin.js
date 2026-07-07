/* ============================================================
   admin.js — OSARYX Admin Dashboard v4 (secure)
   No secrets in browser. All writes through bot backend.
   ============================================================ */

const ADMIN_API_URL   = 'https://osaryx-admin-api.onrender.com';
const POLL_INTERVAL   = 20000;

let sessionToken          = null;
let pollTimer             = null;
let pendingMessageUserId  = null;
let pendingNFTReqId       = null;
let pendingOsaryxNFTReqId = null;

async function adminAction(action, params = {}) {
  if (!sessionToken) { adminToast('Session expired — please log in again', 'err'); showLoginScreen(); throw new Error('No session'); }
  const res = await fetch(ADMIN_API_URL + '/admin-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionToken },
    body: JSON.stringify({ action, ...params })
  });
  if (res.status === 401) { adminToast('Session expired — please log in again', 'err'); showLoginScreen(); throw new Error('Unauthorized'); }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('dashboard').style.display = 'none';
  sessionToken = null;
  sessionStorage.removeItem('admin_token');
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function doLogin() {
  const pw   = document.getElementById('pw-input').value;
  const code = document.getElementById('totp-input').value.replace(/\s/g, '');
  const err  = document.getElementById('login-err');
  const btn  = document.querySelector('.login-btn');
  if (!pw || !code) { err.style.display = 'block'; err.textContent = 'Enter password and authenticator code'; return; }
  btn.disabled = true; btn.textContent = 'VERIFYING...';
  err.style.display = 'none';

  fetch(ADMIN_API_URL + '/admin-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw, totp: code })
  }).then(r => r.json()).then(data => {
    btn.disabled = false; btn.textContent = 'ACCESS DASHBOARD';
    if (!data.ok) { err.style.display = 'block'; err.textContent = data.error || 'Login failed'; return; }
    sessionToken = data.token;
    DB.setToken(sessionToken);
    sessionStorage.setItem('admin_token', sessionToken);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadOverview(); startPolling();
  }).catch(() => {
    btn.disabled = false; btn.textContent = 'ACCESS DASHBOARD';
    err.style.display = 'block'; err.textContent = 'Network error — check ADMIN_API_URL in .env';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  ['pw-input','totp-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
  const stored = sessionStorage.getItem('admin_token');
  if (!stored) return;
  fetch(ADMIN_API_URL + '/admin-verify', { headers: { 'Authorization': 'Bearer ' + stored } })
    .then(r => r.json()).then(data => {
      if (data.ok) {
        sessionToken = stored;
        DB.setToken(sessionToken);
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        loadOverview(); startPolling();
      } else { sessionStorage.removeItem('admin_token'); }
    }).catch(() => sessionStorage.removeItem('admin_token'));
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(updateBadgeDots, POLL_INTERVAL);
  updateBadgeDots();
}

function updateBadgeDots() {
  DB.getRefQueue().then(q => setDot('dot-ref', q.filter(i => i.status==='pending').length));
  DB.getXQueue().then(q => setDot('dot-x', q.filter(i => i.status==='pending').length));
  DB.getNFTRequests().then(q => setDot('dot-nft', q.filter(i => i.status==='pending').length));
  DB.getEpicGodsRequests().then(q => setDot('dot-zeus', q.filter(i => i.status==='pending').length));
  DB.getOsaryxNFTRequests().then(q => setDot('dot-osaryx-nft', q.filter(i => i.status==='pending').length));
}

function setDot(id, count) {
  const dot = document.getElementById(id);
  if (dot) dot.className = 'badge-dot' + (count > 0 ? ' show' : '');
}

function showSection(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('section-' + name).classList.add('active');
  if (el) el.classList.add('active');
  const loaders = {
    overview: loadOverview, users: loadUsers, 'verify-ref': loadRefQueue,
    'verify-x': loadXQueue, 'nft-requests': loadNFTRequests, 'epic-gods': loadEpicGods,
    tasks: loadTasksAdmin, events: loadEvents, 'nft-market': loadNFTListings,
    leaderboard: loadLeaderboard, maintenance: loadMaintenanceStatus,
    backup: () => {}, 'txn-search': () => {},
    'osaryx-nft-launch': loadOsaryxNFTListings, 'osaryx-nft-requests': loadOsaryxNFTRequests
  };
  if (loaders[name]) loaders[name]();
}

function loadOverview() {
  Promise.all([DB.getAllUsersForLeaderboard(50), DB.getGlobalStats(), DB.getUserCount()]).then(([users, gs, totalUsers]) => {
    const now = Date.now();
    const online = users.filter(u => now - u.lastSeen < 2*60*1000).length;
    document.getElementById('ov-users').textContent  = totalUsers;
    document.getElementById('ov-online').textContent = online;
    document.getElementById('ov-mined').textContent  = Math.floor(gs.totalMined||0).toLocaleString();
    document.getElementById('ov-supply').textContent = DB.MAX_SUPPLY.toLocaleString();
    document.getElementById('ov-left').textContent   = Math.max(0, DB.MAX_SUPPLY - (gs.totalMined||0)).toLocaleString();
    document.getElementById('ov-table').innerHTML = users.sort((a,b)=>b.lastSeen-a.lastSeen).slice(0,50).map(u => {
      const isOnline = now - u.lastSeen < 2*60*1000;
      const rune = u.runeType && u.runeExpiresAt > now ? '<span class="badge gold">'+u.runeType.toUpperCase()+'</span>' : '<span class="badge gray">NONE</span>';
      return '<tr><td><span class="dot-online" style="opacity:'+(isOnline?1:0.2)+'"></span>'+esc(u.name)+'</td>'
        +'<td style="color:var(--gray)">'+u.id+'</td><td style="color:var(--gold)">'+Math.floor(u.balance)+'</td>'
        +'<td>'+rune+'</td><td><span class="badge '+(isOnline?'green':'gray')+'">'+(isOnline?'ONLINE':'OFFLINE')+'</span></td>'
        +'<td style="color:var(--gray)">'+timeAgo(u.lastSeen)+'</td></tr>';
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--gray);padding:20px;">No users yet</td></tr>';
  }).catch(() => adminToast('Failed to load overview', 'err'));
}

function loadUsers() {
  const q = (document.getElementById('user-search-inline')||{}).value || '';
  DB.getAllUsersForAdmin(q).then(users => {
    document.getElementById('users-table').innerHTML = users.sort((a,b)=>b.balance-a.balance).map(u => {
      const rune = u.runeType ? '<span class="badge gold">'+u.runeType.toUpperCase()+'</span>' : '—';
      return '<tr><td>'+esc(u.name)+'</td><td style="color:var(--blue)">'+(u.username?'@'+esc(u.username):'—')+'</td>'
        +'<td style="color:var(--gray)">'+u.id+'</td><td style="color:var(--gold)">'+Math.floor(u.balance)+'</td>'
        +'<td>'+rune+'</td><td style="color:var(--gray)">'+timeAgo(u.lastSeen)+'</td>'
        +'<td><button class="btn ghost sm" onclick="openMessageModal(\''+u.id+'\')">✉ MSG</button></td></tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--gray);padding:20px;">No users found</td></tr>';
  });
}

function doUserLookup() {
  const raw = (document.getElementById('lookup-id-input').value || '').trim();
  const cont = document.getElementById('lookup-result');
  if (!raw) { cont.innerHTML = '<div style="color:var(--red);padding:10px;font-size:11px;">Enter an ID or username</div>'; return; }
  cont.innerHTML = '<div style="color:var(--gray);padding:10px;font-size:11px;">Searching...</div>';
  DB.findUserByIdOrUsername(raw).then(u => {
    if (!u) { cont.innerHTML = '<div style="color:var(--red);padding:10px;font-size:11px;">No user found</div>'; return; }
    renderUserDetail(u, cont);
  }).catch(() => { cont.innerHTML = '<div style="color:var(--red);padding:10px;font-size:11px;">Error fetching user</div>'; });
}

function doTxnLookup() {
  const raw = (document.getElementById('txn-lookup-input').value || '').trim();
  const cont = document.getElementById('txn-lookup-result');
  if (!raw) { cont.innerHTML = '<div style="color:var(--red);padding:10px;font-size:11px;">Enter a transaction ID</div>'; return; }
  cont.innerHTML = '<div style="color:var(--gray);padding:10px;font-size:11px;">Searching...</div>';
  DB.findTransaction(raw).then(txn => {
    if (!txn) { cont.innerHTML = '<div style="color:var(--red);padding:10px;font-size:11px;">Not found</div>'; return; }
    cont.innerHTML = '<div class="user-detail-card"><div class="ud-name">'+esc(txn.type)+'</div>'
      +'<div class="ud-id">TXN: '+esc(txn.txn_id)+'</div>'
      +'<div class="ud-grid">'
      +'<div class="ud-stat"><div class="ud-sv">'+esc(txn.tg_user_id)+'</div><div class="ud-sl">USER ID</div></div>'
      +'<div class="ud-stat"><div class="ud-sv" style="color:'+(txn.amount>=0?'var(--green)':'var(--red)')+'\">'+(txn.amount>=0?'+':'')+txn.amount+'</div><div class="ud-sl">AMOUNT</div></div>'
      +'<div class="ud-stat"><div class="ud-sv">'+Math.floor(txn.balance_after)+'</div><div class="ud-sl">BAL AFTER</div></div>'
      +'</div><div style="font-size:10px;color:var(--gray);margin-top:8px;">'+esc(txn.description)+' · '+new Date(txn.ts).toLocaleString()+'</div></div>';
  });
}

function renderUserDetail(u, cont) {
  Promise.all([DB.getReferralsFor(u.id), DB.getTransactionsFor(u.id, 20), DB.getVaultsFor(u.id)]).then(([refs, hist, vaults]) => {
    const verifiedRefs = refs.filter(x => x.status==='verified').length;
    const now = Date.now();
    const rune    = u.runeType && u.runeExpiresAt ? u.runeType.toUpperCase()+' · expires '+new Date(u.runeExpiresAt).toLocaleString() : 'None';
    const storage = u.storageHours ? u.storageHours+'h · expires '+new Date(u.storageExpiresAt).toLocaleString() : 'None';
    const zeus    = u.zeusActiveUntil ? 'ACTIVE until '+new Date(u.zeusActiveUntil).toLocaleString() : 'Not active';
    const histHtml = hist.map(h =>
      '<tr><td>'+new Date(h.ts).toLocaleString()+'</td><td style="color:var(--gold)">'+h.type+'</td>'
      +'<td>'+esc(h.description)+'</td><td style="color:'+(h.amount>=0?'var(--green)':'var(--red)')+'\">'+(h.amount>=0?'+':'')+h.amount+'</td>'
      +'<td>'+Math.floor(h.balance_after)+'</td><td style="font-size:8px;color:var(--gray);word-break:break-all;">'+h.txn_id+'</td></tr>'
    ).join('');
    const vaultsHtml = vaults.length ? vaults.map(v =>
      '<div style="display:flex;align-items:center;gap:8px;font-size:10px;color:var(--gray);padding:6px 0;border-bottom:1px solid var(--border);">'
      +'<span style="flex:1;">'+v.amount+' staked → +'+v.yield+' yield · matures '+new Date(v.maturesAt).toLocaleDateString()+'</span>'
      +'<button class="btn warning sm" onclick="withButtonGuard(this,()=>adminFillVaultNow(this,\''+v.id+'\',\''+u.id+'\','+v.amount+','+v.yield+'))">⚡ FILL</button>'
      +'<button class="btn danger sm" onclick="withButtonGuard(this,()=>adminCancelVaultNow(this,\''+v.id+'\',\''+u.id+'\','+v.amount+'))">✗ CANCEL</button></div>'
    ).join('') : '<div style="font-size:10px;color:var(--gray);">No active vaults</div>';

    cont.innerHTML = '<div class="user-detail-card">'
      +'<div class="ud-name">'+esc(u.name)+(u.username?' <span style="color:var(--blue);font-size:12px;">@'+esc(u.username)+'</span>':'')+'</div>'
      +'<div class="ud-id">TG ID: '+u.id+' · Joined: '+new Date(u.createdAt).toLocaleDateString()+(u.isBanned?' · <span style="color:var(--red)">BANNED</span>':'')+'</div>'
      +'<div class="ud-grid">'
      +'<div class="ud-stat"><div class="ud-sv">'+Math.floor(u.balance)+'</div><div class="ud-sl">BALANCE</div></div>'
      +'<div class="ud-stat"><div class="ud-sv">'+refs.length+'/'+verifiedRefs+'</div><div class="ud-sl">REFS/VERIFIED</div></div>'
      +'<div class="ud-stat"><div class="ud-sv">'+vaults.length+'</div><div class="ud-sl">VAULTS</div></div>'
      +'</div>'
      +'<div style="font-size:10px;color:var(--gray);margin-bottom:4px;">🔮 '+rune+'</div>'
      +'<div style="font-size:10px;color:var(--gray);margin-bottom:4px;">⏳ '+storage+'</div>'
      +'<div style="font-size:10px;color:var(--gray);margin-bottom:10px;">⚡ Zeus: '+zeus+'</div>'
      +'<div style="margin-bottom:14px;">'+vaultsHtml+'</div>'
      +'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">'
      +'<button class="btn success sm" onclick="adminAdjustBalance(\''+u.id+'\',1)">＋ Add</button>'
      +'<button class="btn danger sm" onclick="adminAdjustBalance(\''+u.id+'\',-1)">－ Deduct</button>'
      +'<button class="btn ghost sm" onclick="openMessageModal(\''+u.id+'\')">✉ MSG</button>'
      +(u.isBanned
        ? '<button class="btn success sm" onclick="withButtonGuard(this,()=>adminUnbanUser(\''+u.id+'\'))">✓ Unban</button>'
        : '<button class="btn danger sm" onclick="adminBanUser(\''+u.id+'\')">⛔ Ban</button>')
      +'</div>'
      +'<div class="tbl-card"><div class="tbl-head"><span class="tbl-title">TRANSACTION HISTORY (LAST 20)</span></div>'
      +'<div class="tbl-body"><table><thead><tr><th>DATE</th><th>TYPE</th><th>DESC</th><th>AMT</th><th>BAL</th><th>TXN ID</th></tr></thead>'
      +'<tbody>'+(histHtml||'<tr><td colspan="6" style="text-align:center;color:var(--gray);padding:14px;">No history</td></tr>')+'</tbody></table></div></div></div>';
  });
}

function adminAdjustBalance(uid, direction) {
  const amount = parseFloat(prompt('Amount to '+(direction>0?'ADD':'DEDUCT')+':') || 0);
  if (!amount || amount <= 0) return;
  adminAction('adjust_balance', { uid, amount: direction*amount })
    .then(() => { adminToast((direction>0?'Added ':'Deducted ')+amount, 'suc'); doUserLookup(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function adminCancelVaultNow(btn, vaultId, uid, amount) {
  if (!confirm('Cancel vault and refund '+amount+' OSARYX?')) return;
  return adminAction('cancel_vault', { vault_id: vaultId, uid, amount })
    .then(() => { adminToast('Vault cancelled', 'suc'); doUserLookup(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function adminFillVaultNow(btn, vaultId, uid, amount, yieldAmt) {
  if (!confirm('Force-mature this vault now?')) return;
  return adminAction('fill_vault', { vault_id: vaultId, uid, amount, yield_amt: yieldAmt })
    .then(() => { adminToast('Vault filled', 'suc'); doUserLookup(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function adminBanUser(uid) {
  if (!confirm('Ban this user?')) return;
  adminAction('ban_user', { uid, reason: 'Banned via admin panel' })
    .then(() => { adminToast('User banned', 'suc'); doUserLookup(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function adminUnbanUser(uid) {
  return adminAction('unban_user', { uid })
    .then(() => { adminToast('User unbanned', 'suc'); doUserLookup(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function openMessageModal(uid) {
  pendingMessageUserId = uid;
  document.getElementById('msg-user-text').value = '';
  document.getElementById('modal-message-user').classList.add('show');
}
function closeMessageModal() { document.getElementById('modal-message-user').classList.remove('show'); pendingMessageUserId = null; }
function confirmSendUserMessage() {
  const text = document.getElementById('msg-user-text').value.trim();
  if (!text || !pendingMessageUserId) { adminToast('Enter a message', 'err'); return; }
  const btn = document.querySelector('#modal-message-user .btn.primary');
  withButtonGuard(btn, () =>
    adminAction('send_message', { uid: pendingMessageUserId, message: text })
      .then(() => { adminToast('Message sent ✅', 'suc'); closeMessageModal(); })
      .catch(e => adminToast('Failed: '+e.message, 'err'))
  );
}

function loadRefQueue() {
  DB.getRefQueue().then(q => {
    q.sort((a,b) => b.ts - a.ts);
    document.getElementById('ref-queue-table').innerHTML = q.map(item => {
      const badge = item.status==='verified'?'green':item.status==='rejected'?'red':'gold';
      const actions = item.status === 'pending'
        ? '<button class="btn success sm" onclick="withButtonGuard(this,()=>approveRef('+item.id+',\''+item.referrerId+'\',\''+item.refereeId+'\'))">✓ VERIFY</button> '
          +'<button class="btn danger sm" onclick="withButtonGuard(this,()=>rejectRef('+item.id+'))">✗ REJECT</button>'
        : '<span class="badge '+badge+'">'+item.status.toUpperCase()+'</span>';
      return '<tr><td>'+esc(item.referrerName)+' <span style="color:var(--gray);font-size:9px;">('+item.referrerId+')</span></td>'
        +'<td>'+esc(item.refereeName)+' <span style="color:var(--gray);font-size:9px;">('+item.refereeId+')</span></td>'
        +'<td style="color:var(--gray)">'+new Date(item.ts).toLocaleString()+'</td>'
        +'<td><span class="badge '+badge+'">'+item.status.toUpperCase()+'</span></td>'
        +'<td>'+actions+'</td></tr>';
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--gray);padding:20px;">No referral submissions</td></tr>';
    updateBadgeDots();
  });
}

function approveRef(queueId, referrerId, refereeId) {
  return adminAction('approve_ref', { queue_id: queueId, referrer_id: referrerId, referee_id: refereeId })
    .then(() => { adminToast('Referral verified ✅', 'suc'); loadRefQueue(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function rejectRef(queueId) {
  return adminAction('reject_ref', { queue_id: queueId })
    .then(() => { adminToast('Rejected', 'err'); loadRefQueue(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function loadXQueue() {
  DB.getXQueue().then(q => {
    q.sort((a,b) => b.ts - a.ts);
    document.getElementById('x-queue-table').innerHTML = q.map(item => {
      const badge = item.status==='verified'?'green':item.status==='rejected'?'red':'gold';
      const actions = item.status === 'pending'
        ? '<button class="btn success sm" onclick="withButtonGuard(this,()=>approveX('+item.id+',\''+item.userId+'\',\''+item.taskId+'\','+(item.reward||0)+'))">✓ VERIFY</button> '
          +'<button class="btn danger sm" onclick="withButtonGuard(this,()=>rejectX('+item.id+',\''+item.userId+'\',\''+item.taskId+'\'))">✗ REJECT</button>'
        : '<span class="badge '+badge+'">'+item.status.toUpperCase()+'</span>';
      return '<tr><td>'+esc(item.userName||'')+' <span style="color:var(--gray);font-size:9px;">('+item.userId+')</span></td>'
        +'<td>'+esc(item.taskName||item.taskId)+'</td><td style="color:var(--blue)">'+esc(item.handle||'')+'</td>'
        +'<td style="color:var(--gray)">'+new Date(item.ts).toLocaleString()+'</td>'
        +'<td><span class="badge '+badge+'">'+item.status.toUpperCase()+'</span></td>'
        +'<td>'+actions+'</td></tr>';
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--gray);padding:20px;">No X task submissions</td></tr>';
    updateBadgeDots();
  });
}

function approveX(queueRowId, userId, taskId, reward) {
  return adminAction('approve_x', { queue_row_id: queueRowId, uid: userId, task_id: taskId, reward })
    .then(() => { adminToast('X task approved ✅', 'suc'); loadXQueue(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function rejectX(queueRowId, userId, taskId) {
  return adminAction('reject_x', { queue_row_id: queueRowId, uid: userId, task_id: taskId })
    .then(() => { adminToast('Rejected, user notified', 'err'); loadXQueue(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function loadNFTRequests() {
  DB.getNFTRequests().then(reqs => {
    reqs.sort((a,b) => b.ts - a.ts);
    document.getElementById('nft-req-table').innerHTML = reqs.map(req => {
      const badge = req.status==='sent'?'green':'gold';
      const actions = req.status === 'pending'
        ? '<button class="btn success sm" onclick="openNFTTxnModal(\''+req.reqId+'\',\''+req.nftId+'\',\''+req.userId+'\','+req.worth+',\''+esc(req.chain||'')+'\')">✓ CONFIRM SENT</button>'
        : '<span class="badge green">TXN: '+(req.txnId||'—')+'</span>';
      return '<tr><td>'+esc(req.userName||'')+' <span style="color:var(--gray);font-size:9px;">('+req.userId+')</span></td>'
        +'<td>'+(req.nftImg?'<img src="'+req.nftImg+'" style="width:30px;height:30px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;">':'')+esc(req.nftName||'')+'</td>'
        +'<td style="color:var(--blue)">'+esc(req.chain||'')+'</td>'
        +'<td style="color:var(--blue);font-size:10px;word-break:break-all;">'+esc(req.address||'')+'</td>'
        +'<td style="color:var(--gold)">'+req.worth+'</td>'
        +'<td style="color:var(--gray)">'+new Date(req.ts).toLocaleString()+'</td>'
        +'<td><span class="badge '+badge+'">'+req.status.toUpperCase()+'</span></td>'
        +'<td>'+actions+'</td></tr>';
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--gray);padding:20px;">No NFT dispatch requests</td></tr>';
    updateBadgeDots();
  });
}

function openNFTTxnModal(reqId, nftId, userId, worth, chain) {
  pendingNFTReqId = { reqId, nftId, userId, worth, chain };
  document.getElementById('nft-txn-input').value = '';
  document.getElementById('nft-dispatch-token').value = chain || '';
  document.getElementById('nft-dispatch-amount').value = '';
  document.getElementById('modal-nft-txn').classList.add('show');
}
function closeNFTTxnModal() { document.getElementById('modal-nft-txn').classList.remove('show'); pendingNFTReqId = null; }

let nftDispatchInFlight = false;
function confirmNFTDispatch() {
  if (nftDispatchInFlight) return;
  const txnId  = document.getElementById('nft-txn-input').value.trim();
  const token  = document.getElementById('nft-dispatch-token').value.trim();
  const amount = parseFloat(document.getElementById('nft-dispatch-amount').value);
  if (!txnId)  { adminToast('Enter a transaction ID', 'err'); return; }
  if (!token)  { adminToast('Enter the token/chain sent', 'err'); return; }
  if (!amount || amount <= 0) { adminToast('Enter the amount sent', 'err'); return; }
  if (!pendingNFTReqId) { adminToast('No request selected', 'err'); return; }
  const p = pendingNFTReqId;
  nftDispatchInFlight = true;
  const btn = document.querySelector('#modal-nft-txn .btn.success');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ CONFIRMING...'; }
  adminAction('dispatch_nft', { req_id: p.reqId, nft_id: p.nftId, uid: p.userId, txn_id: txnId })
    .then(() => { adminToast('Dispatch confirmed ✅', 'suc'); closeNFTTxnModal(); loadNFTRequests(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'))
    .finally(() => { nftDispatchInFlight = false; if (btn) { btn.disabled = false; btn.textContent = 'CONFIRM SENT'; } });
}

function loadEpicGods() {
  DB.getEpicGodsRequests().then(reqs => {
    reqs.sort((a,b) => b.ts - a.ts);
    document.getElementById('epic-gods-table').innerHTML = reqs.map(r => {
      const badge = r.status==='verified'?'green':r.status==='rejected'?'red':'gold';
      const actions = r.status === 'pending'
        ? '<button class="btn success sm" onclick="withButtonGuard(this,()=>approveEpicGods('+r.id+',\''+r.userId+'\'))">✓ ACTIVATE ZEUS</button> '
          +'<button class="btn danger sm" onclick="withButtonGuard(this,()=>rejectEpicGods('+r.id+'))">✗ REJECT</button>'
        : '<span class="badge '+badge+'">'+r.status.toUpperCase()+'</span>';
      return '<tr><td>'+esc(r.userName||'')+' <span style="color:var(--gray);font-size:9px;">('+r.userId+')</span></td>'
        +'<td style="color:var(--blue)">'+(r.username?'@'+esc(r.username):'—')+'</td>'
        +'<td><span class="badge '+(r.payMethod==='stars'?'gold':'blue')+'">'+r.payMethod.toUpperCase()+'</span></td>'
        +'<td style="font-size:9px;color:var(--gray);word-break:break-all;">'+esc(r.txnRef||'—')+'</td>'
        +'<td style="color:var(--gray)">'+new Date(r.ts).toLocaleString()+'</td>'
        +'<td><span class="badge '+badge+'">'+r.status.toUpperCase()+'</span></td>'
        +'<td>'+actions+'</td></tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--gray);padding:20px;">No Epic Gods requests</td></tr>';
    updateBadgeDots();
  });
}

function approveEpicGods(reqId, uid) {
  return adminAction('approve_epic_gods', { req_id: reqId, uid })
    .then(() => { adminToast('Zeus activated ✅', 'suc'); loadEpicGods(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function rejectEpicGods(reqId) {
  return adminAction('reject_epic_gods', { req_id: reqId })
    .then(() => { adminToast('Rejected', 'err'); loadEpicGods(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function loadTasksAdmin() {
  DB.getAllTasksForAdmin().then(tasks => {
    document.getElementById('tasks-count-badge').textContent = tasks.length + ' tasks';
    document.getElementById('tasks-admin-list').innerHTML = tasks.map(t => {
      const capped = t.clickCap != null;
      const capBadge = capped ? (t.clickCount >= t.clickCap ? 'red' : 'gold') : 'gray';
      const capText  = capped ? (t.clickCount+'/'+t.clickCap+' completed') : (t.clickCount+' completed');
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="openTaskDetailModal(\''+t.id+'\',\''+esc(t.name)+'\')">'
        +'<span style="font-size:18px;">'+(t.icon||'🎯')+'</span>'
        +'<div style="flex:1;"><div style="font-size:11px;color:var(--white);">'+esc(t.name)+'</div>'
        +'<div style="font-size:9px;color:var(--gray);margin-top:2px;">'+t.type+' · '+esc(t.target||'')+'</div>'
        +'<div style="margin-top:4px;"><span class="badge '+capBadge+'">'+capText+'</span></div></div>'
        +'<span style="color:var(--gold);font-size:11px;">+'+t.reward+'</span>'
        +'<button class="btn danger sm" onclick="event.stopPropagation();deleteTask(\''+t.id+'\')">✗ DEL</button></div>';
    }).join('') || '<div style="text-align:center;color:var(--gray);padding:20px;font-size:11px;">No tasks yet</div>';
  });
}

function openTaskDetailModal(taskId, taskName) {
  document.getElementById('task-detail-title').textContent = '✦ ' + taskName;
  document.getElementById('task-detail-sub').textContent = 'Loading...';
  document.getElementById('task-click-log-table').innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--gray);padding:14px;">Loading...</td></tr>';
  document.getElementById('modal-task-detail').classList.add('show');

  Promise.all([DB.getTaskClickLog(taskId), DB.getAllTasksForAdmin()]).then(([clicks, allTasks]) => {
    const task = allTasks.find(t => t.id === taskId);
    const clickCount = task ? (task.clickCount || 0) : 0;
    const clickCap   = task ? task.clickCap : null;
    const capLine    = clickCap != null
      ? clickCount + ' / ' + clickCap + ' successful completions'
      : clickCount + ' successful completions, no cap set';
    document.getElementById('task-detail-sub').innerHTML =
      '<b style="color:var(--gold)">' + clicks.length + '</b> raw EMBARK clicks &nbsp;·&nbsp; ' + capLine;
    document.getElementById('task-click-log-table').innerHTML = clicks.map(c =>
      '<tr><td>' + esc(c.userName||'') + '</td><td style="color:var(--gray)">' + esc(c.userId) + '</td><td style="color:var(--gray)">' + new Date(c.ts).toLocaleString() + '</td></tr>'
    ).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--gray);padding:14px;">No clicks recorded yet</td></tr>';
  }).catch(e => {
    console.error('openTaskDetailModal failed', e);
    document.getElementById('task-click-log-table').innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--red);padding:14px;">Error loading data</td></tr>';
  });
}
function closeTaskDetailModal() { document.getElementById('modal-task-detail').classList.remove('show'); }

function addTask() {
  const statusEl = document.getElementById('task-status');
  statusEl.className = 'totp-status';
  const name    = document.getElementById('t-name').value.trim();
  const reward  = parseInt(document.getElementById('t-reward').value, 10);
  const type    = document.getElementById('t-type').value;
  const icon    = document.getElementById('t-icon').value.trim() || '🎯';
  let target    = document.getElementById('t-target').value.trim();
  const desc    = document.getElementById('t-desc').value.trim();
  const capRaw  = document.getElementById('t-clickcap').value.trim();
  const clickCap = capRaw ? parseInt(capRaw, 10) : null;
  if (!name || !reward) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Name and reward are required.'; return; }
  if (type !== 'watch_ad' && !target) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Target is required.'; return; }
  if ((type === 'x_follow' || type === 'link') && target && !/^https?:\/\//i.test(target)) target = 'https://' + target;
  /* Sort order strategy:
     watch_ad  = -999999 (always first)
     new tasks = 1 to 99 (near top, above default channel/X tasks at 100+)
     auto_ref  = 9000+   (always last)
  */
  const minOrder = type === 'auto_ref'  ? (9000 + Date.now() % 1000)
                 : type === 'watch_ad'  ? -999999
                 : 1;
  adminAction('add_task', { task: { id: 't_'+Date.now(), name, desc, reward, type, icon, target, xFollow: type==='x_follow', clickCap, sortOrder: minOrder } })
    .then(() => { statusEl.className = 'totp-status ok'; statusEl.textContent = 'Task added ✅'; clearTaskForm(); loadTasksAdmin(); })
    .catch(e => { statusEl.className = 'totp-status err'; statusEl.textContent = 'Failed: '+e.message; });
}

function deleteTask(taskId) {
  if (!confirm('Delete this task?')) return;
  adminAction('delete_task', { task_id: taskId })
    .then(() => { adminToast('Task deleted', 'suc'); loadTasksAdmin(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function clearTaskForm() {
  ['t-name','t-reward','t-icon','t-target','t-desc','t-clickcap'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function loadEvents() {
  DB.getEvents().then(events => {
    document.getElementById('events-list').innerHTML = events.map(ev => {
      const tasks = (ev.tasks||[]).map(t => '<div style="font-size:10px;color:var(--gray);padding:4px 0;">'+(t.icon||'🎯')+' '+esc(t.name)+'</div>').join('');
      const expiry = ev.expiresAt ? new Date(ev.expiresAt).toLocaleString() : 'No expiry';
      return '<div class="tbl-card" style="margin-bottom:12px;"><div class="tbl-head"><span class="tbl-title">'+(ev.icon||'📣')+' '+esc(ev.name)+'</span>'
        +'<button class="btn danger sm" onclick="deleteEvent(\''+ev.id+'\')">✗ DELETE</button></div>'
        +'<div style="padding:14px;"><div style="font-size:10px;color:var(--gray);margin-bottom:4px;">'+esc(ev.desc||'')+'</div>'
        +'<div style="font-size:9px;color:var(--blue);margin-bottom:8px;">Reward: +'+ev.reward+' OSARYX · Expires: '+expiry+'</div>'+tasks+'</div></div>';
    }).join('') || '<div style="text-align:center;color:var(--gray);padding:20px;font-size:11px;">No events</div>';
  });
}

let eventTaskCount = 1;
function addEventTaskRow() {
  eventTaskCount++;
  const container = document.getElementById('ev-tasks-container');
  const row = document.createElement('div');
  row.className = 'form-grid'; row.id = 'ev-task-row-'+eventTaskCount;
  row.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px solid var(--border);';
  row.innerHTML = '<div class="form-group"><label class="form-label">TASK '+eventTaskCount+' NAME</label><input class="form-input" id="ev-t-name-'+eventTaskCount+'" placeholder="Task name"/></div>'
    +'<div class="form-group"><label class="form-label">TYPE</label><select class="form-select" id="ev-t-type-'+eventTaskCount+'"><option value="telegram_channel">Telegram Channel</option><option value="x_follow">X Follow</option><option value="link">Link</option></select></div>'
    +'<div class="form-group"><label class="form-label">ICON</label><input class="form-input" id="ev-t-icon-'+eventTaskCount+'" placeholder="🎁"/></div>'
    +'<div class="form-group"><label class="form-label">TARGET</label><input class="form-input" id="ev-t-target-'+eventTaskCount+'" placeholder="@channel or https://..."/></div>'
    +'<div class="form-group full" style="text-align:right;"><button class="btn danger sm" onclick="removeEventTaskRow('+eventTaskCount+')">✗ Remove</button></div>';
  container.appendChild(row);
}
function removeEventTaskRow(n) { const row = document.getElementById('ev-task-row-'+n); if (row) row.remove(); }

function createOsaryxEvent() {
  const statusEl = document.getElementById('event-status');
  statusEl.className = 'totp-status';
  const evName = document.getElementById('ev-name').value.trim();
  if (!evName) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Event name is required.'; return; }
  const evIcon    = document.getElementById('ev-icon').value.trim() || '📣';
  const evDesc    = document.getElementById('ev-desc').value.trim();
  const evReward  = parseInt(document.getElementById('ev-reward').value, 10) || 0;
  const evExpRaw  = document.getElementById('ev-expiry').value;
  const expiresAt = evExpRaw ? new Date(evExpRaw).getTime() : null;
  const tasks = [];
  const t1name = document.getElementById('ev-t-name').value.trim();
  const t1type = document.getElementById('ev-t-type').value;
  let t1target   = document.getElementById('ev-t-target').value.trim();
  const t1icon   = document.getElementById('ev-t-icon').value.trim() || '🎁';
  if (t1name) {
    if ((t1type==='x_follow'||t1type==='link') && t1target && !/^https?:\/\//i.test(t1target)) t1target = 'https://'+t1target;
    tasks.push({ id: 'evt_'+Date.now()+'_1', name: t1name, reward: 0, type: t1type, icon: t1icon, target: t1target, xFollow: t1type==='x_follow' });
  }
  for (let i = 2; i <= eventTaskCount; i++) {
    const nameEl = document.getElementById('ev-t-name-'+i);
    if (!nameEl || !document.getElementById('ev-task-row-'+i)) continue;
    const tname = nameEl.value.trim();
    const ttype = document.getElementById('ev-t-type-'+i).value;
    let ttarget  = document.getElementById('ev-t-target-'+i).value.trim();
    const ticon  = document.getElementById('ev-t-icon-'+i).value.trim() || '🎁';
    if (tname) {
      if ((ttype==='x_follow'||ttype==='link') && ttarget && !/^https?:\/\//i.test(ttarget)) ttarget = 'https://'+ttarget;
      tasks.push({ id: 'evt_'+Date.now()+'_'+i, name: tname, reward: 0, type: ttype, icon: ticon, target: ttarget, xFollow: ttype==='x_follow' });
    }
  }
  if (!tasks.length) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Add at least one task.'; return; }
  adminAction('create_event', { event: { id: 'ev_'+Date.now(), name: evName, icon: evIcon, desc: evDesc, reward: evReward, expiresAt, tasks } })
    .then(() => {
      statusEl.className = 'totp-status ok'; statusEl.textContent = 'Event created ✅';
      loadEvents();
      ['ev-name','ev-icon','ev-desc','ev-reward','ev-expiry','ev-t-name','ev-t-icon','ev-t-target'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      for (let i = 2; i <= eventTaskCount; i++) { const row = document.getElementById('ev-task-row-'+i); if (row) row.remove(); }
      eventTaskCount = 1;
    })
    .catch(e => { statusEl.className = 'totp-status err'; statusEl.textContent = 'Failed: '+e.message; });
}

function deleteEvent(evId) {
  if (!confirm('Delete this event?')) return;
  adminAction('delete_event', { event_id: evId })
    .then(() => { adminToast('Event deleted', 'suc'); loadEvents(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

let nftImgB64 = null;
function previewNFTImage() {
  const file = document.getElementById('nft-img-file').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { nftImgB64 = e.target.result; document.getElementById('nft-img-preview').innerHTML = '<img src="'+nftImgB64+'" style="width:100%;height:100%;object-fit:cover;"/>'; };
  reader.readAsDataURL(file);
}

function loadNFTListings() {
  DB.getNFTListings().then(list => {
    document.getElementById('nft-listings-list').innerHTML = list.map(nft => {
      const statusBadge = nft.sold ? '<span class="badge gray">SOLD</span>' : '<span class="badge green">AVAILABLE</span>';
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--border);">'
        +(nft.img?'<img src="'+nft.img+'" style="width:44px;height:44px;object-fit:cover;border-radius:6px;">':'<div style="width:44px;height:44px;background:var(--gray2);border-radius:6px;"></div>')
        +'<div style="flex:1;"><div style="font-size:11px;color:var(--white);">'+esc(nft.name)+'</div>'
        +'<div style="font-size:9px;color:var(--gold);">'+nft.worth+' OSARYX · '+esc(nft.chain)+'</div></div>'
        +statusBadge+'<button class="btn danger sm" onclick="deleteNFTListing(\''+nft.id+'\')">✗ DEL</button></div>';
    }).join('') || '<div style="text-align:center;color:var(--gray);padding:20px;font-size:11px;">No NFT listings yet</div>';
  });
}

function addNFTListing() {
  const statusEl = document.getElementById('nft-status');
  statusEl.className = 'totp-status';
  const name  = document.getElementById('nft-name').value.trim();
  const worth = parseInt(document.getElementById('nft-worth').value, 10);
  const chain = document.getElementById('nft-chain').value.trim();
  if (!name || !worth || !chain) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Name, worth, and chain are required.'; return; }
  if (!nftImgB64) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Select an image.'; return; }
  adminAction('create_nft_listing', { nft: { id: 'nft_'+Date.now(), name, img: nftImgB64, chain, worth } })
    .then(() => {
      statusEl.className = 'totp-status ok'; statusEl.textContent = 'NFT listed ✅';
      document.getElementById('nft-name').value=''; document.getElementById('nft-worth').value=''; document.getElementById('nft-chain').value='';
      document.getElementById('nft-img-preview').innerHTML = 'No image selected'; nftImgB64 = null;
      loadNFTListings();
    }).catch(e => { statusEl.className = 'totp-status err'; statusEl.textContent = 'Failed: '+e.message; });
}

function deleteNFTListing(id) {
  if (!confirm('Delete this NFT listing?')) return;
  adminAction('delete_nft_listing', { nft_id: id })
    .then(() => { adminToast('Deleted', 'suc'); loadNFTListings(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

let osaryxNftImgB64 = null;
function previewOsaryxNFTImage() {
  const file = document.getElementById('osaryx-nft-img-file').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { osaryxNftImgB64 = e.target.result; document.getElementById('osaryx-nft-img-preview').innerHTML = '<img src="'+osaryxNftImgB64+'" style="width:100%;height:100%;object-fit:cover;"/>'; };
  reader.readAsDataURL(file);
}

function loadOsaryxNFTListings() {
  DB.getOsaryxNFTs().then(list => {
    document.getElementById('osaryx-nft-listings-list').innerHTML = list.map(nft => {
      const statusBadge = nft.sold ? '<span class="badge gray">SOLD</span>' : '<span class="badge green">AVAILABLE</span>';
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--border);">'
        +(nft.img?'<img src="'+nft.img+'" style="width:44px;height:44px;object-fit:cover;border-radius:6px;">':'<div style="width:44px;height:44px;background:var(--gray2);border-radius:6px;"></div>')
        +'<div style="flex:1;"><div style="font-size:11px;color:var(--white);">'+esc(nft.name)+'</div>'
        +'<div style="font-size:9px;color:var(--gold);">'+nft.worth+' OSARYX · '+esc(nft.chain)+'</div></div>'
        +statusBadge+'<button class="btn danger sm" onclick="deleteOsaryxNFT(\''+nft.id+'\')">✗ DEL</button></div>';
    }).join('') || '<div style="text-align:center;color:var(--gray);padding:20px;font-size:11px;">No OSARYX NFTs yet</div>';
  });
}

function launchOsaryxNFT() {
  const statusEl = document.getElementById('osaryx-nft-status');
  statusEl.className = 'totp-status';
  const name  = document.getElementById('osaryx-nft-name').value.trim();
  const worth = parseInt(document.getElementById('osaryx-nft-worth').value, 10);
  const chain = document.getElementById('osaryx-nft-chain').value.trim();
  if (!name || !worth || !chain) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Name, worth, and chain are required.'; return; }
  if (!osaryxNftImgB64) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Select an image.'; return; }
  adminAction('create_osaryx_nft', { nft: { id: 'onft_'+Date.now(), name, img: osaryxNftImgB64, chain, worth } })
    .then(() => {
      statusEl.className = 'totp-status ok'; statusEl.textContent = 'OSARYX NFT launched ✅';
      document.getElementById('osaryx-nft-name').value=''; document.getElementById('osaryx-nft-worth').value=''; document.getElementById('osaryx-nft-chain').value='';
      document.getElementById('osaryx-nft-img-preview').innerHTML = 'No image selected'; osaryxNftImgB64 = null;
      loadOsaryxNFTListings();
    }).catch(e => { statusEl.className = 'totp-status err'; statusEl.textContent = 'Failed: '+e.message; });
}

function deleteOsaryxNFT(id) {
  if (!confirm('Delete this OSARYX NFT?')) return;
  adminAction('delete_osaryx_nft', { nft_id: id })
    .then(() => { adminToast('Deleted', 'suc'); loadOsaryxNFTListings(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'));
}

function loadOsaryxNFTRequests() {
  DB.getOsaryxNFTRequests().then(reqs => {
    reqs.sort((a,b) => b.ts - a.ts);
    document.getElementById('osaryx-nft-req-table').innerHTML = reqs.map(req => {
      const badge = req.status==='sent'?'green':'gold';
      const actions = req.status === 'pending'
        ? '<button class="btn success sm" onclick="openOsaryxNFTTxnModal(\''+req.reqId+'\',\''+req.nftId+'\',\''+req.userId+'\',\''+esc(req.nftName||'')+'\')">✓ CONFIRM SENT</button>'
        : '<span class="badge green">TXN: '+(req.txnId||'—')+'</span>';
      return '<tr><td>'+esc(req.userName||'')+' <span style="color:var(--gray);font-size:9px;">('+req.userId+')</span></td>'
        +'<td>'+(req.nftImg?'<img src="'+req.nftImg+'" style="width:30px;height:30px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;">':'')+esc(req.nftName||'')+'</td>'
        +'<td style="color:var(--blue)">'+esc(req.chain||'')+'</td>'
        +'<td style="color:var(--blue);font-size:10px;word-break:break-all;">'+esc(req.address||'')+'</td>'
        +'<td style="color:var(--gold)">'+req.worth+'</td>'
        +'<td style="color:var(--gray)">'+new Date(req.ts).toLocaleString()+'</td>'
        +'<td><span class="badge '+badge+'">'+req.status.toUpperCase()+'</span></td>'
        +'<td>'+actions+'</td></tr>';
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--gray);padding:20px;">No OSARYX NFT requests</td></tr>';
    updateBadgeDots();
  });
}

function openOsaryxNFTTxnModal(reqId, nftId, userId, nftName) {
  pendingOsaryxNFTReqId = { reqId, nftId, userId, nftName };
  document.getElementById('osaryx-nft-txn-input').value = '';
  document.getElementById('osaryx-nft-dispatch-label').textContent = 'NFT: ' + (nftName || nftId);
  document.getElementById('modal-osaryx-nft-txn').classList.add('show');
}
function closeOsaryxNFTTxnModal() { document.getElementById('modal-osaryx-nft-txn').classList.remove('show'); pendingOsaryxNFTReqId = null; }

let osaryxNftDispatchInFlight = false;
function confirmOsaryxNFTDispatch() {
  if (osaryxNftDispatchInFlight) return;
  const txnId = document.getElementById('osaryx-nft-txn-input').value.trim();
  if (!txnId) { adminToast('Enter a transaction ID', 'err'); return; }
  if (!pendingOsaryxNFTReqId) { adminToast('No request selected', 'err'); return; }
  const p = pendingOsaryxNFTReqId;
  osaryxNftDispatchInFlight = true;
  const btn = document.querySelector('#modal-osaryx-nft-txn .btn.success');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ CONFIRMING...'; }
  adminAction('dispatch_osaryx_nft', { req_id: p.reqId, nft_id: p.nftId, uid: p.userId, txn_id: txnId, nft_name: p.nftName })
    .then(() => { adminToast('Dispatch confirmed ✅', 'suc'); closeOsaryxNFTTxnModal(); loadOsaryxNFTRequests(); })
    .catch(e => adminToast('Failed: '+e.message, 'err'))
    .finally(() => { osaryxNftDispatchInFlight = false; if (btn) { btn.disabled = false; btn.textContent = 'CONFIRM SENT'; } });
}

function doAirdrop() {
  const statusEl = document.getElementById('airdrop-status');
  statusEl.className = 'totp-status';
  const uid    = document.getElementById('drop-id').value.trim();
  const amount = parseFloat(document.getElementById('drop-amount').value);
  const note   = document.getElementById('drop-note').value.trim() || 'Admin airdrop';
  if (!uid || !amount || amount <= 0) { statusEl.className = 'totp-status err'; statusEl.textContent = 'Enter a valid user ID and amount.'; return; }
  adminAction('airdrop', { uid, amount, note })
    .then(() => {
      statusEl.className = 'totp-status ok'; statusEl.textContent = 'Airdrop sent ✅';
      document.getElementById('drop-id').value=''; document.getElementById('drop-amount').value=''; document.getElementById('drop-note').value='';
    }).catch(e => { statusEl.className = 'totp-status err'; statusEl.textContent = 'Failed: '+e.message; });
}

function loadLeaderboard() {
  DB.getAllUsersForLeaderboard(100).then(users => {
    document.getElementById('lb-table').innerHTML = users.map((u,i) => {
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1);
      return '<tr><td style="color:var(--gold)">'+medal+'</td><td>'+esc(u.name)+'</td>'
        +'<td style="color:var(--blue)">'+(u.username?'@'+esc(u.username):'—')+'</td>'
        +'<td style="color:var(--gold);font-weight:bold;">'+Math.floor(u.balance).toLocaleString()+'</td></tr>';
    }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--gray);padding:20px;">No users yet</td></tr>';
  });
}

function loadMaintenanceStatus() {
  DB.getMaintenanceStatus().then(m => {
    document.getElementById('maint-status-text').textContent = m.isActive ? 'ON' : 'OFF';
    document.getElementById('maint-toggle').className = 'toggle' + (m.isActive ? ' on' : '');
    document.getElementById('maint-message').value = m.message || '';
  });
}

function toggleMaintenance() {
  DB.getMaintenanceStatus().then(m => {
    const turningOn = !m.isActive;
    if (turningOn && !confirm('This will lock ALL users out of the app. Continue?')) return;
    adminAction('set_maintenance', { active: turningOn, message: m.message })
      .then(() => { adminToast(turningOn ? 'Maintenance ON' : 'Maintenance OFF', 'suc'); loadMaintenanceStatus(); })
      .catch(e => adminToast('Failed: '+e.message, 'err'));
  });
}

function saveMaintMessage() {
  const msg = document.getElementById('maint-message').value.trim();
  DB.getMaintenanceStatus().then(m => {
    adminAction('set_maintenance', { active: m.isActive, message: msg })
      .then(() => adminToast('Message updated', 'suc'))
      .catch(e => adminToast('Failed: '+e.message, 'err'));
  });
}

function downloadBackup() {
  adminToast('Preparing backup...', '');
  DB.exportAll().then(data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'osaryx_backup_' + new Date().toISOString().slice(0,10) + '.json';
    a.click(); URL.revokeObjectURL(url);
    adminToast('Backup downloaded ✅', 'suc');
  }).catch(() => adminToast('Backup failed', 'err'));
}

function withButtonGuard(btn, actionFn) {
  if (!btn || btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '...';
  const result = actionFn();
  if (result && typeof result.then === 'function') {
    result.finally(() => { btn.disabled = false; btn.textContent = orig; });
  } else { btn.disabled = false; btn.textContent = orig; }
}

function esc(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function timeAgo(ts) {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d/60000)+'m ago';
  if (d < 86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}
let toastTimer = null;
function adminToast(msg, type) {
  const t = document.getElementById('admin-toast');
  t.textContent = msg; t.className = 'toast show' + (type?' '+type:'');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3000);
}
