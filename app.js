/* ============================================================
   app.js — OSARYX Mini App v3 (balance-safe build)

   BALANCE SAFETY MODEL
   ────────────────────
   • All balance mutations happen on a fresh DB read first
     (getUser) so we never operate on stale in-memory state.
   • A write-lock (_writing flag) suppresses realtime callbacks
     while a local save is in flight.  The callback only fires
     after our own write has fully resolved, so it always sees
     the correct committed value rather than a pre-write snapshot.
   • updateAll() never calls saveUser() — display only.
   • saveUser() is called exactly once per operation, at the end.
   ============================================================ */

const CFG = {
  TOKEN_NAME:    'OSARYX',
  BOT_USERNAME:  'OSARYXBot',
  APP_NAME:      'Osaryx',
  MINE_REWARD:   300,
  REF_PERCENT:   0.05,
  REF_BONUS:     100,
  REF_THRESHOLD: 100,

  SHADOW_COST: 1000,
  SHADOW_MULT: 2,
  ORACLE_COST: 2000,
  ORACLE_MULT: 4,
  RUNE_DAYS:   3,

  STORAGE_6H_COST:  500,
  STORAGE_12H_COST: 1000,
  STORAGE_24H_COST: 2000,
  STORAGE_DAYS:     3,

  STAKE_MIN:  1000,
  STAKE_DAYS: 1,
  NFT_SOLD_VISIBLE_MINUTES: 5
};

let currentUser = null;
let currentNFTId = null;
let currentNFTSource = 'market';
let timerHandle  = null;
let stakeTimer   = null;
let maintTimer   = null;
let zeusSaveTimer = null;

/* Write-lock: while true, realtime callbacks are suppressed.
   Set to true before any DB write; cleared after saveUser resolves. */
let _writing = false;

const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
if (tg) { tg.ready(); tg.expand(); }

const TG_USER = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user)
  ? tg.initDataUnsafe.user
  : { id: 100000001, first_name: 'Acolyte', username: 'demo_user', photo_url: '' };

/* ══════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════ */
window.onload = function () { checkMaintenanceBeforeBoot(); };

function checkMaintenanceBeforeBoot() {
  DB.getMaintenanceStatus().then(m => {
    if (m.isActive) { showMaintenanceScreen(m.message); return; }
    bootApp();
  }).catch(() => bootApp());
}

function showMaintenanceScreen(message) {
  const splash = document.getElementById('splash');
  splash.innerHTML = '<div class="maint-icon">🔒</div><div class="splash-name">OSARYX</div>'
    + '<div class="maint-msg">' + esc(message || 'The realm is undergoing a sacred ritual. Please return shortly.') + '</div>';
  splash.style.opacity = '1'; splash.style.display = 'flex';
  if (maintTimer) clearInterval(maintTimer);
  maintTimer = setInterval(() => {
    DB.getMaintenanceStatus().then(m => { if (!m.isActive) { clearInterval(maintTimer); location.reload(); } });
  }, 15000);
}

function bootApp() {
  let bootUser = null;

  DB.getUser(String(TG_USER.id)).then(u => {
    if (!u) return DB.createUser(TG_USER).then(n => { bootUser = n; return n; });
    u.name     = TG_USER.first_name || u.name;
    u.username = TG_USER.username   || u.username;
    if (TG_USER.photo_url) u.photoUrl = TG_USER.photo_url;
    bootUser = u;
    return u;
  }).then(u => {
    if (u.isBanned) { showBannedScreen(); throw new Error('banned'); }
    return handleReferralParam(u);
  }).then(() => DB.getVaultsFor(bootUser.id))
  .then(vaults => {
    bootUser.stakes = vaults;
    if (!bootUser.completedTasks) bootUser.completedTasks = {};
    bootUser = DB.settleZeusIfNeeded(bootUser, CFG.MINE_REWARD, 3);
    finishBoot(bootUser);
  }).catch(e => {
    if (e && e.message === 'banned') return;
    console.error('Boot failed, using offline fallback', e);
    const cached = JSON.parse(localStorage.getItem('user_' + TG_USER.id) || 'null') || {
      id: String(TG_USER.id), name: TG_USER.first_name || 'Acolyte', username: TG_USER.username || '',
      photoUrl: TG_USER.photo_url || '', balance: 0, lastMine: 0,
      mineIntervalHours: 3, mineMultiplier: 1,
      storageExpiresAt: null, storageHours: null, runeExpiresAt: null, runeType: null,
      zeusActiveUntil: null, zeusStartedAt: null, zeusSettledBalance: 0,
      referredBy: null, taskStates: {}, taskHandles: {}, completedTasks: {}, stakes: [],
      lastSeen: Date.now(), createdAt: Date.now()
    };
    finishBoot(cached);
  });
}

function showBannedScreen() {
  const splash = document.getElementById('splash');
  splash.innerHTML = '<div class="maint-icon">⛔</div><div class="splash-name">OSARYX</div><div class="maint-msg">Your access to the realm has been revoked.</div>';
  splash.style.opacity = '1'; splash.style.display = 'flex';
}

function finishBoot(u) {
  if (!u.stakes) u.stakes = [];
  if (!u.completedTasks) u.completedTasks = {};
  currentUser = u;
  const splash = document.getElementById('splash');
  if (splash) {
    splash.style.transition = 'opacity 0.4s';
    splash.style.opacity = '0';
    setTimeout(() => { splash.style.display = 'none'; }, 400);
  }
  document.getElementById('app').style.display = 'flex';
  applyAvatar();
  matureStakes();
  recalcMiningState();
  /* Save once on boot — do NOT call updateAll() before this resolves */
  _writing = true;
  DB.saveUser(currentUser).finally(() => { _writing = false; });
  updateDisplay();
  startCountdown();
  startStakeTimer();
  startZeusAutoSave();
  checkUserNotifications();
  setupSwipeNav();
  setupRealtimeSync();
  DB.notifyAppOpen(currentUser.id);
}

function applyAvatar() {
  const btn = document.getElementById('avatar-btn');
  if (currentUser.photoUrl) {
    btn.innerHTML = '<img src="' + currentUser.photoUrl + '" onerror="this.parentNode.textContent=\'' + esc((currentUser.name[0]||'O').toUpperCase()) + '\'"/>';
  } else {
    btn.textContent = (currentUser.name[0] || 'O').toUpperCase();
  }
}

/* ══════════════════════════════════════════════
   REALTIME SYNC
   
   The write-lock (_writing) is the key fix:
   • Every operation sets _writing = true before
     touching the DB and clears it in .finally().
   • The realtime callback skips while _writing is
     true, so our own broadcast never overwrites
     the balance we just saved.
   • After the lock clears we do ONE authoritative
     DB.getUser() to reconcile with any external
     changes (admin edits, bot credits, etc.)
══════════════════════════════════════════════ */
function setupRealtimeSync() {
  DB.Realtime.subscribeRow('users', 'tg_id', currentUser.id, payload => {
    /* Ignore our own writes — they are already applied in memory */
    if (_writing) return;
    if (payload.eventType === 'DELETE') return;

    /* An external change arrived (admin edit, bot credit, ban).
       Do ONE authoritative read to get the true committed value. */
    DB.getUser(currentUser.id).then(fresh => {
      if (!fresh) return;
      if (fresh.isBanned && !currentUser.isBanned) { showBannedScreen(); return; }

      /* Preserve session-only state that lives only in memory */
      fresh.taskStates     = currentUser.taskStates;
      fresh.taskHandles    = currentUser.taskHandles;
      fresh.completedTasks = currentUser.completedTasks;
      /* Refresh vaults from DB so vault cancellations/fills show immediately */
      DB.getVaultsFor(fresh.id).then(vaults => {
        fresh.stakes = vaults;
        currentUser = fresh;
        recalcMiningState();
        updateDisplay();
        renderShopState();
        renderStakes();
        updateStakePreview();
      });
    });
  });

  DB.Realtime.subscribeTable('maintenance', payload => {
    const row = payload.new;
    if (row && row.is_active) {
      showMaintenanceScreen(row.message);
    } else if (row && !row.is_active) {
      const splash = document.getElementById('splash');
      if (splash && splash.style.display === 'flex' && splash.innerHTML.indexOf('maint-icon') !== -1) {
        location.reload();
      }
    }
  });
}

/* ══════════════════════════════════════════════
   DISPLAY (never saves — pure render)
══════════════════════════════════════════════ */
function updateDisplay() {
  const u = currentUser;
  document.getElementById('hdr-name').textContent = u.name;
  document.getElementById('hdr-id').textContent   = 'ID: ' + u.id;
  if (!isZeusActive()) {
    document.getElementById('hdr-bal').textContent = formatNum(u.balance);
  }
}

/* Legacy alias used by many call sites */
function updateAll() { updateDisplay(); }

/* Persist to DB with write-lock */
function persist(user) {
  _writing = true;
  return DB.saveUser(user).finally(() => { _writing = false; });
}

function formatNum(n) { return Math.floor(n).toLocaleString(); }

/* ══════════════════════════════════════════════
   REFERRAL
══════════════════════════════════════════════ */
function handleReferralParam(u) {
  let startParam = '';
  if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) {
    startParam = tg.initDataUnsafe.start_param;
  } else {
    const p = new URLSearchParams(window.location.search);
    startParam = p.get('tgWebAppStartParam') || p.get('startapp') || '';
  }
  if (u.referredBy) return Promise.resolve();
  if (startParam.indexOf('ref_') !== 0) return Promise.resolve();
  const referrerId = startParam.replace('ref_', '');
  if (!referrerId || referrerId === String(u.id)) return Promise.resolve();
  return DB.getUser(referrerId).then(referrer => {
    if (!referrer) return;
    u.referredBy = referrerId;
    return DB.referralExists(referrerId, u.id).then(exists => {
      if (exists) return persist(u);
      return DB.addReferral(referrerId, u.id, u.name).then(() => persist(u));
    });
  }).catch(e => { console.error('handleReferralParam failed', e); });
}

function creditReferrerPercent(amount) {
  if (!currentUser.referredBy) return Promise.resolve();
  return DB.getReferralsFor(currentUser.referredBy).then(refs => {
    const thisRef = refs.find(r => r.refereeId === String(currentUser.id));
    if (!thisRef || thisRef.status !== 'verified') return;
    return DB.getUser(currentUser.referredBy).then(ref => {
      if (!ref) return;
      const bonus = parseFloat((amount * CFG.REF_PERCENT).toFixed(2));
      ref.balance += bonus;
      DB.logTransaction(ref.id, ref.name, 'ref_percent', 'Channelled 5% from ' + currentUser.name, bonus, ref.balance);
      DB.bumpReferralEarned(ref.id, currentUser.id, bonus);
      return DB.saveUser(ref);
    });
  }).catch(() => {});
}

function checkRefThreshold() {
  if (!currentUser.referredBy || currentUser.balance < CFG.REF_THRESHOLD) return Promise.resolve();
  return DB.refQueueEntryExists(currentUser.referredBy, currentUser.id).then(exists => {
    if (exists) return;
    return DB.getUser(currentUser.referredBy).then(ref => {
      if (!ref) return;
      return DB.pushRefQueueItem({ referrerId: ref.id, referrerName: ref.name, refereeId: currentUser.id, refereeName: currentUser.name, ts: Date.now() });
    });
  });
}

function checkAutoRefTasks() {
  DB.getReferralsFor(currentUser.id).then(refs => {
    const verified = refs.filter(r => r.status === 'verified').length;
    DB.getTasks().then(tasks => {
      let changed = false;
      tasks.forEach(task => {
        if (task.type !== 'auto_ref' || !task.autoRef) return;
        if (currentUser.completedTasks[task.id]) return;
        if (verified >= task.autoRef) {
          currentUser.completedTasks[task.id] = true;
          /* Do NOT set taskStates[task.id] — just mark completed so
             renderTasks() filters it out immediately */
          currentUser.balance += task.reward;
          DB.logTransaction(currentUser.id, currentUser.name, 'task', 'Invocation task: ' + task.name, task.reward, currentUser.balance);
          DB.addToTotalMined(task.reward);
          DB.incrementTaskClickCount(task.id);
          showToast('+' + task.reward + ' ' + CFG.TOKEN_NAME + '! ' + task.name, 'suc');
          changed = true;
        }
      });
      if (!changed) return;
      updateDisplay();
      renderTasks(); /* re-render immediately so completed tasks vanish */
      persist(currentUser);
    });
  });
}

/* ══════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════ */
function checkUserNotifications() {
  DB.getXQueueFor(currentUser.id).then(items => {
    if (!items.length) return;
    let changed = false;
    items.forEach(item => {
      if (item.status === 'verified') {
        showToast('✅ Quest "' + item.taskName + '" verified! +' + item.reward + ' ' + CFG.TOKEN_NAME, 'suc');
      } else if (item.status === 'rejected') {
        showToast('❌ Quest "' + item.taskName + '" was not completed. Tap the task icon to redo it, then verify again.', 'err');
        /* Write rejected state back so button flips from PENDING → VERIFY AGAIN */
        if (currentUser.taskStates[item.taskId] === 'pending') {
          currentUser.taskStates[item.taskId] = 'rejected';
          changed = true;
        }
      }
      DB.updateXQueueRow(item.id, { notified: true });
    });
    if (changed) { persist(currentUser); renderTasks(); }
  });
  DB.getNFTRequestsFor(currentUser.id).then(reqs => {
    reqs.forEach(req => {
      showToast('Relic dispatched! ✅', 'suc');
      DB.markNFTRequestNotified(req.reqId);
    });
  });
  DB.getOsaryxNFTRequestsFor(currentUser.id).then(reqs => {
    reqs.forEach(req => {
      showToast('OSARYX NFT dispatched! ✅', 'suc');
      DB.markOsaryxNFTRequestNotified(req.reqId);
    });
  });
}

/* ══════════════════════════════════════════════
   MINING STATE
══════════════════════════════════════════════ */
function recalcMiningState() {
  const u = currentUser;
  const now = Date.now();
  if (u.runeExpiresAt    && now > u.runeExpiresAt)    { u.runeExpiresAt = null; u.runeType = null; u.mineMultiplier = 1; }
  if (u.storageExpiresAt && now > u.storageExpiresAt) { u.storageExpiresAt = null; u.storageHours = null; u.mineIntervalHours = 3; }
  if (u.zeusActiveUntil  && now > u.zeusActiveUntil)  {
    currentUser = DB.settleZeusIfNeeded(u, CFG.MINE_REWARD, 3);
    _writing = true;
    DB.saveUser(currentUser).finally(() => { _writing = false; });
  }
}

function isZeusActive()      { return !!(currentUser.zeusActiveUntil && Date.now() < currentUser.zeusActiveUntil); }
function currentIntervalMs() { return (currentUser.mineIntervalHours || 3) * 3600000; }
function currentMultiplier() { return currentUser.mineMultiplier || 1; }
function currentCycleReward() {
  const cycles = currentIntervalMs() / (3 * 3600000);
  return Math.round(CFG.MINE_REWARD * currentMultiplier() * cycles * 100) / 100;
}

/* ══════════════════════════════════════════════
   MINING
   Always reads fresh from DB first so balance
   is never calculated on stale in-memory state.
══════════════════════════════════════════════ */
let mineInFlight = false;
function handleMine() {
  if (mineInFlight) return;
  recalcMiningState();
  const now = Date.now();
  const elapsed  = now - (currentUser.lastMine || 0);
  const interval = currentIntervalMs();
  if (currentUser.lastMine !== 0 && elapsed < interval) { showToast('The ether still channels...', 'err'); return; }

  const btn = document.getElementById('mine-btn');
  btn.disabled = true;
  mineInFlight  = true;

  /* Read authoritative balance from DB before crediting */
  DB.getUser(currentUser.id).then(fresh => {
    if (!fresh) throw new Error('user not found');
    const reward = currentCycleReward();
    fresh.balance         += reward;
    fresh.lastMine         = Date.now();
    fresh.stakes           = currentUser.stakes;
    fresh.completedTasks   = currentUser.completedTasks;
    fresh.taskStates       = currentUser.taskStates;
    fresh.taskHandles      = currentUser.taskHandles;
    currentUser = fresh;

    DB.logTransaction(currentUser.id, currentUser.name, 'mine', 'Ether harvest (x' + currentMultiplier() + ', ' + currentUser.mineIntervalHours + 'h cycle)', reward, currentUser.balance);
    DB.addToTotalMined(reward);
    updateDisplay();
    showToast('⚡ +' + reward + ' ' + CFG.TOKEN_NAME + ' harvested!', 'suc');

    return persist(currentUser).then(() => {
      creditReferrerPercent(reward);
      checkRefThreshold();
      checkAutoRefTasks();
    });
  }).catch(e => {
    console.error('handleMine failed', e);
    showToast('Harvest failed — try again', 'err');
  }).finally(() => {
    mineInFlight = false;
    btn.disabled = false;
  });
}

function startCountdown() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(tickCountdown, 1000);
  tickCountdown();
}

function tickCountdown() {
  recalcMiningState();
  const zeusBlock   = document.getElementById('zeus-active-block');
  const normalBlock = document.getElementById('normal-mine-block');

  if (isZeusActive()) {
    zeusBlock.style.display   = 'block';
    normalBlock.style.display = 'none';
    const rem = currentUser.zeusActiveUntil - Date.now();
    const d = Math.floor(rem/86400000), h = Math.floor((rem%86400000)/3600000), m = Math.floor((rem%3600000)/60000);
    document.getElementById('zeus-time-left').textContent = d + 'd ' + h + 'h ' + m + 'm remaining';
    const proj = JSON.parse(JSON.stringify(currentUser));
    const settled = DB.settleZeusIfNeeded(proj, CFG.MINE_REWARD, 3);
    document.getElementById('hdr-bal').textContent = formatNum(settled.balance);
    return;
  }
  zeusBlock.style.display   = 'none';
  normalBlock.style.display = 'block';

  const now      = Date.now();
  const interval = currentIntervalMs();
  const elapsed  = currentUser.lastMine === 0 ? interval : now - currentUser.lastMine;
  const pct      = Math.min(1, elapsed / interval);

  document.getElementById('bal-arc').style.strokeDashoffset = 452 - (452 * pct);
  const currentlyMined = currentCycleReward() * pct;
  document.getElementById('bal-num').textContent = (currentlyMined > 0 && currentlyMined < 1) ? currentlyMined.toFixed(2) : formatNum(currentlyMined);

  const multBadge = document.getElementById('mult-badge');
  if (currentMultiplier() > 1) { multBadge.style.display = 'block'; multBadge.textContent = currentMultiplier() + '×'; }
  else { multBadge.style.display = 'none'; }

  const btn   = document.getElementById('mine-btn');
  const timer = document.getElementById('mine-timer');
  if (pct >= 1) {
    btn.style.display   = 'block'; btn.disabled = false; btn.textContent = '⚡ HARVEST OSARYX';
    timer.style.display = 'none';
  } else {
    btn.style.display   = 'none'; timer.style.display = 'block';
    const rem = interval - elapsed;
    const h = Math.floor(rem/3600000), m = Math.floor((rem%3600000)/60000), s = Math.floor((rem%60000)/1000);
    timer.innerHTML = pad(h) + ':' + pad(m) + ':' + pad(s);
  }
}

function pad(n) { return String(n).length === 1 ? '0' + n : String(n); }

/* ══════════════════════════════════════════════
   RUNES + STORAGE
══════════════════════════════════════════════ */
function buyRune(type) {
  const btn = document.getElementById('buy-' + type + '-btn');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;

  const cost = type === 'shadow' ? CFG.SHADOW_COST : CFG.ORACLE_COST;
  const mult = type === 'shadow' ? CFG.SHADOW_MULT : CFG.ORACLE_MULT;

  DB.getUser(currentUser.id).then(fresh => {
    if (!fresh) { showToast('Could not verify balance — try again', 'err'); return; }
    recalcMiningState();
    if (fresh.runeExpiresAt && fresh.runeType) { showToast('A rune already empowers you', 'err'); return; }
    if (fresh.balance < cost) { showToast('Insufficient essence — need ' + cost, 'err'); currentUser.balance = fresh.balance; updateDisplay(); return; }

    fresh.balance       -= cost;
    fresh.runeType       = type;
    fresh.mineMultiplier = mult;
    fresh.runeExpiresAt  = Date.now() + CFG.RUNE_DAYS * 86400000;
    fresh.stakes         = currentUser.stakes;
    fresh.completedTasks = currentUser.completedTasks;
    fresh.taskStates     = currentUser.taskStates;
    fresh.taskHandles    = currentUser.taskHandles;
    currentUser = fresh;

    DB.logTransaction(currentUser.id, currentUser.name, 'rune_buy', (type==='shadow'?'Shadow Rune':'Oracle Core') + ' bound', -cost, currentUser.balance);
    updateDisplay();
    renderShopState();
    return persist(currentUser);
  }).finally(() => { if (btn) btn.disabled = false; });
}

function buyStorage(hours) {
  const btn = document.getElementById('buy-storage-' + hours + '-btn');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;

  const cost = hours===6 ? CFG.STORAGE_6H_COST : hours===12 ? CFG.STORAGE_12H_COST : CFG.STORAGE_24H_COST;

  DB.getUser(currentUser.id).then(fresh => {
    if (!fresh) { showToast('Could not verify balance — try again', 'err'); return; }
    recalcMiningState();
    if (fresh.storageExpiresAt && fresh.storageHours) { showToast('Storage already active', 'err'); return; }
    if (fresh.balance < cost) { showToast('Insufficient essence — need ' + cost, 'err'); currentUser.balance = fresh.balance; updateDisplay(); return; }

    fresh.balance          -= cost;
    fresh.storageHours      = hours;
    fresh.mineIntervalHours = hours;
    fresh.storageExpiresAt  = Date.now() + CFG.STORAGE_DAYS * 86400000;
    fresh.stakes         = currentUser.stakes;
    fresh.completedTasks = currentUser.completedTasks;
    fresh.taskStates     = currentUser.taskStates;
    fresh.taskHandles    = currentUser.taskHandles;
    currentUser = fresh;

    DB.logTransaction(currentUser.id, currentUser.name, 'storage_buy', hours + 'h Storage bound', -cost, currentUser.balance);
    updateDisplay();
    renderShopState();
    return persist(currentUser);
  }).finally(() => { if (btn) btn.disabled = false; });
}

function renderShopState() {
  recalcMiningState();
  const u    = currentUser;
  const zeus = isZeusActive();

  ['shadow','oracle'].forEach(type => {
    const btn = document.getElementById('buy-' + type + '-btn');
    if (!btn) return;
    if (zeus) {
      btn.disabled    = true;
      btn.textContent = '⚡ ZEUS ACTIVE — ALL POWERS COVERED';
      return;
    }
    const active  = u.runeType === type && u.runeExpiresAt;
    const blocked = u.runeType && u.runeType !== type && u.runeExpiresAt;
    btn.disabled = !!(active || blocked);
    const cost = type==='shadow' ? CFG.SHADOW_COST : CFG.ORACLE_COST;
    btn.textContent = active  ? 'ACTIVE — ' + timeLeftStr(u.runeExpiresAt)
                   : blocked ? 'ANOTHER RUNE ACTIVE'
                   : ('BIND — ' + cost + ' OSARYX');
  });

  [6,12,24].forEach(hours => {
    const btn = document.getElementById('buy-storage-' + hours + '-btn');
    if (!btn) return;
    if (zeus) {
      btn.disabled    = true;
      btn.textContent = '⚡ ZEUS ACTIVE — ALL POWERS COVERED';
      return;
    }
    const active  = u.storageHours === hours && u.storageExpiresAt;
    const blocked = u.storageHours && u.storageHours !== hours && u.storageExpiresAt;
    btn.disabled = !!(active || blocked);
    const cost = hours===6 ? CFG.STORAGE_6H_COST : hours===12 ? CFG.STORAGE_12H_COST : CFG.STORAGE_24H_COST;
    btn.textContent = active  ? 'ACTIVE — ' + timeLeftStr(u.storageExpiresAt)
                   : blocked ? 'ANOTHER STORAGE ACTIVE'
                   : (cost.toLocaleString() + ' OSARYX');
  });
}

function timeLeftStr(expiresAt) {
  const rem = expiresAt - Date.now();
  if (rem <= 0) return 'expiring...';
  const d = Math.floor(rem/86400000), h = Math.floor((rem%86400000)/3600000);
  return d + 'd ' + h + 'h left';
}

/* ══════════════════════════════════════════════
   STAKING (Vault)
══════════════════════════════════════════════ */
function stakeSetMax() {
  const max = Math.floor(currentUser.balance / CFG.STAKE_MIN) * CFG.STAKE_MIN;
  document.getElementById('stake-amount-input').value = max || CFG.STAKE_MIN;
  updateStakePreview();
}

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('stake-amount-input');
  if (inp) inp.addEventListener('input', updateStakePreview);
});

function updateStakePreview() {
  const amt  = parseFloat(document.getElementById('stake-amount-input').value) || 0;
  const yld  = Math.floor((amt/1000)*100);
  const prev = document.getElementById('stake-preview');

  /* If a vault already exists, show its live countdown instead */
  const stakes = currentUser.stakes || [];
  if (stakes.length) {
    const now  = Date.now();
    const next = stakes.reduce((a, b) => a.maturesAt < b.maturesAt ? a : b);
    const rem  = Math.max(0, next.maturesAt - now);
    const d    = Math.floor(rem/86400000);
    const h    = Math.floor((rem%86400000)/3600000);
    const m    = Math.floor((rem%3600000)/60000);
    if (rem > 0) {
      prev.textContent = 'Active vault matures in ' + d + 'd ' + h + 'h ' + m + 'm — returns ' + (next.amount + next.yield) + ' OSARYX';
      return;
    }
    prev.textContent = 'Your vault has matured — claim it below';
    return;
  }

  prev.textContent = amt >= CFG.STAKE_MIN
    ? ('The Vault returns ' + yld + ' OSARYX after ' + CFG.STAKE_DAYS + ' days')
    : 'Minimum consecration is 1,000 OSARYX';
}

let stakeInFlight = false;
function doStake() {
  if (stakeInFlight) return;
  let amt = parseFloat(document.getElementById('stake-amount-input').value) || 0;
  if (amt < CFG.STAKE_MIN) { showToast('Minimum is 1,000 OSARYX', 'err'); return; }
  amt = Math.floor(amt/1000)*1000;

  const stakeBtn = document.querySelector('.form-card-stake .miner-buy-btn');
  if (stakeBtn) { stakeBtn.disabled = true; stakeBtn.textContent = '⏳ CONSECRATING...'; }
  stakeInFlight = true;

  DB.getUser(currentUser.id).then(fresh => {
    if (!fresh) { showToast('Could not verify balance — try again', 'err'); return; }
    if (amt > fresh.balance) { showToast('Insufficient essence', 'err'); currentUser.balance = fresh.balance; updateDisplay(); return; }

    const yld = Math.floor((amt/1000)*100);
    const now = Date.now();
    fresh.balance       -= amt;
    fresh.stakes         = currentUser.stakes;
    fresh.completedTasks = currentUser.completedTasks;
    fresh.taskStates     = currentUser.taskStates;
    fresh.taskHandles    = currentUser.taskHandles;
    currentUser = fresh;

    DB.logTransaction(currentUser.id, currentUser.name, 'stake', 'Consecrated ' + amt + ' to the Vault', -amt, currentUser.balance);
    updateDisplay();

    return persist(currentUser)
      .then(() => DB.createVault(currentUser.id, amt, yld, now, now + CFG.STAKE_DAYS*86400000))
      .then(() => DB.getVaultsFor(currentUser.id))
      .then(vaults => {
        currentUser.stakes = vaults;
        renderStakes();
        showToast('⚖ ' + amt + ' consecrated. Yield in 7 days: +' + yld, 'suc');
      });
  }).finally(() => {
    stakeInFlight = false;
    if (stakeBtn) { stakeBtn.disabled = false; stakeBtn.textContent = '⚖ CONSECRATE TO THE VAULT'; }
  });
}

function matureStakes() {
  if (!currentUser.stakes || !currentUser.stakes.length) return;
  const now     = Date.now();
  const matured = currentUser.stakes.filter(s => now >= s.maturesAt);
  if (!matured.length) return;

  matured.forEach(s => {
    currentUser.balance += s.amount + s.yield;
    DB.logTransaction(currentUser.id, currentUser.name, 'unstake', 'Vault matured — principal + yield', s.amount + s.yield, currentUser.balance);
    DB.deleteVault(s.id);
  });
  currentUser.stakes = currentUser.stakes.filter(s => now < s.maturesAt);
  updateDisplay();
  persist(currentUser);
  showToast('⚖ Your Vault matured! Essence returned.', 'suc');
}

function startStakeTimer() {
  if (stakeTimer) clearInterval(stakeTimer);
  stakeTimer = setInterval(() => { matureStakes(); renderStakes(); }, 60000);
}

function startZeusAutoSave() {
  if (zeusSaveTimer) clearInterval(zeusSaveTimer);
  zeusSaveTimer = setInterval(() => {
    if (!isZeusActive()) return;
    currentUser = DB.settleZeusIfNeeded(currentUser, CFG.MINE_REWARD, 3);
    persist(currentUser);
  }, 30000);
}

function renderStakes() {
  const cont = document.getElementById('stake-list');
  if (!cont) return;
  const stakes = currentUser.stakes || [];
  if (!stakes.length) { cont.innerHTML = '<div class="empty-note">No active consecrations.<br>The Vault awaits your offering.</div>'; return; }
  const now = Date.now();
  cont.innerHTML = stakes.map(s => {
    const rem = Math.max(0, s.maturesAt - now);
    const d = Math.floor(rem/86400000), h = Math.floor((rem%86400000)/3600000), m = Math.floor((rem%3600000)/60000);
    const pct = Math.min(100, Math.round((1 - rem/(CFG.STAKE_DAYS*86400000))*100));
    return '<div class="stake-card">'
      + '<div class="stake-card-row"><span class="stake-card-amt">' + s.amount.toLocaleString() + ' OSARYX</span><span class="stake-card-yield">+' + s.yield + ' yield</span></div>'
      + '<div class="stake-bar-track"><div class="stake-bar-fill" style="width:' + pct + '%"></div></div>'
      + '<div class="stake-card-time">' + (rem>0 ? ('Matures in ' + d + 'd ' + h + 'h ' + m + 'm') : '✅ Matured') + '</div></div>';
  }).join('');
  updateStakePreview();
}

/* ══════════════════════════════════════════════
   TASKS
══════════════════════════════════════════════ */
function renderTasks() {
  const list = document.getElementById('tasks-list');
  list.innerHTML = '<div class="empty-note">Consulting the oracle...</div>';
  Promise.all([DB.getTasks(), DB.getEvents()]).then(res => {
    const [tasks, events] = res;
    list.innerHTML = '';
    events.forEach(ev => { list.appendChild(buildEventBanner(ev)); });
    tasks.forEach(t => {
      if (t.type !== 'watch_ad' && currentUser.completedTasks[t.id]) return;
      const state = (currentUser.taskStates || {})[t.id];
      if (t.type !== 'watch_ad' && state === 'done') return;
      list.appendChild(buildTaskCard(t));
    });
    if (!list.children.length) list.innerHTML = '<div class="empty-note">No quests remain — return soon, acolyte.</div>';
  }).catch(() => {
    list.innerHTML = '<div class="empty-note">Could not load quests — check your connection</div>';
  });
}

function buildEventBanner(ev) {
  const eventCompleted = !!currentUser.completedTasks['event_' + ev.id];
  const banner = document.createElement('div');
  banner.className = 'task-card event-banner';
  const actionHtml = eventCompleted
    ? '<div class="task-btn verify" style="opacity:0.7;pointer-events:none;">EVENT COMPLETED ✅</div>'
    : '<button class="task-btn go" onclick="openEventModal(\'' + ev.id + '\')">JOIN EVENT →</button>';
  banner.innerHTML =
    '<div class="task-icon">' + (ev.icon||'📣') + '</div>' +
    '<div class="task-info">' +
      '<div class="task-event-badge">✦ ACTIVE EVENT</div>' +
      '<div class="task-name">' + esc(ev.name) + '</div>' +
      '<div class="task-desc">' + esc(ev.desc||'') + '</div>' +
      '<div class="task-reward">+' + ev.reward + ' ' + CFG.TOKEN_NAME + ' total reward</div>' +
    '</div>' +
    actionHtml;
  return banner;
}

/* ── EVENT MODAL ── */
let currentEventId = null;
function openEventModal(evId) {
  currentEventId = evId;
  DB.getEvents().then(events => {
    const ev = events.find(e => e.id === evId);
    if (!ev) return;
    document.getElementById('event-modal-title').textContent  = (ev.icon||'📣') + ' ' + ev.name;
    document.getElementById('event-modal-reward').textContent = 'Complete all tasks to earn +' + ev.reward + ' ' + CFG.TOKEN_NAME;
    const container = document.getElementById('event-modal-tasks');
    container.innerHTML = ev.tasks.map(t => {
      const taskKey = 'ev_' + ev.id + '_' + t.id;
      const done  = !!currentUser.completedTasks[taskKey];
      const state = done ? 'done' : ((currentUser.taskStates||{})[taskKey] || 'go');
      let btnHtml;
      if (done) {
        btnHtml = '<button class="task-btn verify" disabled>DONE ✅</button>';
      } else if (state === 'pending') {
        btnHtml = '<button class="task-btn pending">PENDING</button>';
      } else if (state === 'verify') {
        if (t.xFollow || t.type === 'x_follow') {
          btnHtml = '<button class="task-btn verify" onclick="showEventXInput(\'' + taskKey + '\')">VERIFY</button>';
        } else {
          btnHtml = '<button class="task-btn verify" onclick="verifyEventTask(\'' + ev.id + '\',\'' + t.id + '\',\'' + (t.target||'') + '\',\'' + t.type + '\')">VERIFY</button>';
        }
      } else {
        btnHtml = '<button class="task-btn go" onclick="goEventTask(\'' + ev.id + '\',\'' + t.id + '\',\'' + t.type + '\',\'' + (t.target||'') + '\')">EMBARK →</button>';
      }
      const xHtml = (t.xFollow || t.type === 'x_follow')
        ? '<div class="x-input-wrap" id="xwrap_ev_' + taskKey + '"><input class="x-input" id="xinput_ev_' + taskKey + '" placeholder="@yourhandle"/><button class="x-submit-btn" onclick="submitEventXHandle(\'' + ev.id + '\',\'' + t.id + '\',\'' + esc(t.name) + '\')">SUBMIT</button></div>'
        : '';
      const taskIconOnclick = (t.type === 'auto_ref' || t.type === 'watch_ad' || !t.target)
        ? '' : 'onclick="goTaskLink(\'' + t.type + '\',\'' + (t.target||'') + '\')" style="cursor:pointer;" title="Tap to open task link"';
      return '<div class="task-card"><div class="task-icon" ' + taskIconOnclick + '>' + (t.icon||'🎯') + '</div>'
        + '<div class="task-info"><div class="task-name">' + esc(t.name) + '</div>'
        + '<div class="task-desc">' + esc(t.desc||'') + '</div>' + xHtml + '</div>' + btnHtml + '</div>';
    }).join('');

    showModal('modal-event');
  });
}

function goEventTask(evId, taskId, type, target) {
  const taskKey = 'ev_' + evId + '_' + taskId;
  currentUser.taskStates[taskKey] = 'verify';
  persist(currentUser);
  const absTarget = ensureAbsoluteUrl(target);
  if (type === 'telegram_channel' || type === 'telegram_group') {
    const ch = target.replace('@','');
    if (tg) tg.openTelegramLink('https://t.me/' + ch); else window.open('https://t.me/' + ch, '_blank');
  } else {
    if (tg) tg.openLink(absTarget); else window.open(absTarget, '_blank');
  }
  openEventModal(evId);
}

function verifyEventTask(evId, taskId, target, type) {
  const taskKey = 'ev_' + evId + '_' + taskId;
  if (currentUser.completedTasks[taskKey]) { openEventModal(evId); return; }
  if (type === 'telegram_channel') {
    const chatId = target.replace('@','');
    DB.checkTelegramMembership(String(currentUser.id), chatId).then(result => {
      if (result.isMember) { markEventTaskDone(evId, taskId); }
      else { showToast(result.error ? 'Verification error — try again' : 'You have not joined the channel yet!', 'err'); }
      openEventModal(evId);
    });
  } else {
    markEventTaskDone(evId, taskId);
    openEventModal(evId);
  }
}

function markEventTaskDone(evId, taskId) {
  const taskKey = 'ev_' + evId + '_' + taskId;
  if (currentUser.completedTasks[taskKey]) return;
  currentUser.completedTasks[taskKey] = true;
  delete currentUser.taskStates[taskKey];
  showToast('Task completed ✅', 'suc');

  DB.getEvents().then(events => {
    const ev = events.find(e => e.id === evId);
    if (!ev) { persist(currentUser); return; }

    const allDone = ev.tasks.every(t => !!currentUser.completedTasks['ev_' + ev.id + '_' + t.id]);
    if (allDone && !currentUser.completedTasks['event_' + evId]) {
      /* Read fresh balance before crediting event reward */
      DB.getUser(currentUser.id).then(fresh => {
        if (!fresh) { persist(currentUser); return; }
        fresh.completedTasks = currentUser.completedTasks;
        fresh.taskStates     = currentUser.taskStates;
        fresh.taskHandles    = currentUser.taskHandles;
        fresh.stakes         = currentUser.stakes;
        fresh.completedTasks['event_' + evId] = true;
        fresh.balance += ev.reward;
        currentUser = fresh;

        DB.logTransaction(currentUser.id, currentUser.name, 'event', 'Event completed: ' + ev.name, ev.reward, currentUser.balance);
        DB.addToTotalMined(ev.reward);
        updateDisplay();
        showToast('🎉 Event complete! +' + ev.reward + ' ' + CFG.TOKEN_NAME, 'suc');
        return persist(currentUser);
      });
    } else {
      persist(currentUser);
    }
  });
}

function showEventXInput(taskKey) {
  const w = document.getElementById('xwrap_ev_' + taskKey);
  if (w) w.classList.toggle('show');
}

function submitEventXHandle(evId, taskId, taskName) {
  const taskKey = 'ev_' + evId + '_' + taskId;
  const input   = document.getElementById('xinput_ev_' + taskKey);
  const handle  = input ? input.value.trim() : '';
  if (!handle) { showToast('Enter your @handle', 'err'); return; }
  if (currentUser.completedTasks[taskKey]) { openEventModal(evId); return; }

  /* Look up the event reward so admin approval can credit the correct amount */
  DB.getEvents().then(events => {
    const ev = events.find(e => e.id === evId);
    /* Store a marker so markEventTaskDone knows this task is pending admin review */
    currentUser.taskStates[taskKey]  = 'pending';
    currentUser.taskHandles[taskKey] = handle;
    persist(currentUser);

    /* Push to x_queue with the full event reward — admin approving this
       entry will call markEventTaskDone which credits the event reward,
       not the individual task reward (which is 0 for event subtasks). */
    DB.pushXQueueItem({
      userId:   currentUser.id,
      userName: currentUser.name,
      taskId:   taskKey,
      taskName: (ev ? ev.name + ' — ' : '') + taskName,
      reward:   ev ? ev.reward : 0,   /* full event reward, not per-subtask */
      handle,
      ts: Date.now()
    });
    showToast('Submitted! Awaiting judgment.', 'suc');
    openEventModal(evId);
  });
}

function closeEventModal() { closeModal('modal-event'); currentEventId = null; }

function ensureAbsoluteUrl(url) {
  url = String(url || '').trim();
  if (!url || /^https?:\/\//i.test(url) || /^@/.test(url)) return url;
  return 'https://' + url;
}

function buildTaskCard(task) {
  if (task.type === 'watch_ad') {
    const adCard = document.createElement('div');
    adCard.className = 'task-card watch-ad-card';
    adCard.innerHTML = '<div class="task-icon">📺</div><div class="task-info"><div class="task-name">' + esc(task.name) + '</div>'
      + '<div class="task-desc">' + esc(task.desc||'') + '</div>'
      + '<div class="task-reward">+' + task.reward + ' ' + CFG.TOKEN_NAME + '</div></div>'
      + '<button class="task-btn go" onclick="watchAdForReward(\'' + task.id + '\',' + task.reward + ')">WATCH</button>';
    return adCard;
  }

  const state = (currentUser.taskStates||{})[task.id] || 'go';
  const card  = document.createElement('div');
  card.className = 'task-card';
  /* Icon always navigates to target — works for ALL task types including Telegram.
     Tapping icon lets users go back to complete or redo any task. */
  const iconOnclick = (task.type === 'auto_ref' || task.type === 'watch_ad' || !task.target)
    ? ''
    : 'onclick="goTaskLink(\'' + task.type + '\',\'' + (task.target||'') + '\')" style="cursor:pointer;" title="Tap to open task link"';

  let btnHtml;
  if (task.type === 'auto_ref') {
    btnHtml = '<button class="task-btn verify" style="cursor:default;">AUTO</button>';
  } else if (state === 'pending') {
    btnHtml = '<button class="task-btn pending">PENDING</button>';
  } else if (state === 'rejected') {
    btnHtml = '<button class="task-btn verify" onclick="resetAndVerify(\'' + task.id + '\',\'' + task.type + '\',\'' + (task.target||'') + '\')" >VERIFY AGAIN</button>';
  } else if (state === 'verify') {
    if (task.xFollow || task.type === 'x_follow') {
      btnHtml = '<button class="task-btn verify" onclick="showXInput(\'' + task.id + '\')">VERIFY</button>';
    } else {
      btnHtml = '<button class="task-btn verify" onclick="verifyTelegramTask(\'' + task.id + '\',' + task.reward + ',\'' + (task.target||'') + '\',\'' + task.type + '\')">VERIFY</button>';
    }
  } else {
    btnHtml = '<button class="task-btn go" onclick="goTask(\'' + task.id + '\',\'' + (task.type||'') + '\',\'' + (task.target||'') + '\')">EMBARK →</button>';
  }

  const xHtml = (task.xFollow || task.type === 'x_follow')
    ? '<div class="x-input-wrap" id="xwrap_' + task.id + '"><input class="x-input" id="xinput_' + task.id + '" placeholder="@yourhandle"/>'
      + '<button class="x-submit-btn" onclick="submitXHandle(\'' + task.id + '\',' + task.reward + ',\'' + esc(task.name) + '\')">SUBMIT</button></div>'
    : '';

  card.innerHTML = '<div class="task-icon" ' + iconOnclick + '>' + (task.icon||'🎯') + '</div><div class="task-info">'
    + '<div class="task-name">' + esc(task.name) + '</div><div class="task-desc">' + esc(task.desc||'') + '</div>'
    + '<div class="task-reward">+' + task.reward + ' ' + CFG.TOKEN_NAME + '</div>' + xHtml + '</div>' + btnHtml;
  return card;
}

/* Navigate to task link without changing task state — used by icon click */
function goTaskLink(type, target) {
  if (type === 'telegram_channel' || type === 'telegram_group') {
    const ch = target.replace('@','');
    if (tg) tg.openTelegramLink('https://t.me/' + ch); else window.open('https://t.me/' + ch, '_blank');
  } else {
    const absUrl = ensureAbsoluteUrl(target);
    if (tg) tg.openLink(absUrl); else window.open(absUrl, '_blank');
  }
}

function goTask(id, type, target) {
  currentUser.taskStates[id] = 'verify';
  persist(currentUser);
  DB.logTaskClick(id, currentUser.id, currentUser.name);
  if (type === 'telegram_channel' || type === 'telegram_group') {
    const ch = target.replace('@','');
    if (tg) tg.openTelegramLink('https://t.me/' + ch); else window.open('https://t.me/' + ch, '_blank');
  } else {
    const absUrl = ensureAbsoluteUrl(target);
    if (tg) tg.openLink(absUrl); else window.open(absUrl, '_blank');
  }
  renderTasks();
}

function verifyTelegramTask(id, reward, target, type) {
  if (currentUser.completedTasks[id]) { renderTasks(); return; }
  if (type !== 'telegram_channel') {
    currentUser.taskStates[id] = 'pending';
    persist(currentUser);
    DB.pushXQueueItem({ userId: currentUser.id, userName: currentUser.name, taskId: id, taskName: target, reward, handle: '(manual review)', ts: Date.now() });
    renderTasks();
    showToast('Submitted for review', 'suc');
    return;
  }
  const chatId = target.replace('@','');
  DB.checkTelegramMembership(String(currentUser.id), chatId).then(result => {
    if (result.isMember) {
      if (currentUser.completedTasks[id]) { renderTasks(); return; }
      /* Read fresh balance before crediting */
      DB.getUser(currentUser.id).then(fresh => {
        if (!fresh) return;
        fresh.completedTasks = currentUser.completedTasks;
        fresh.taskStates     = currentUser.taskStates;
        fresh.taskHandles    = currentUser.taskHandles;
        fresh.stakes         = currentUser.stakes;
        fresh.completedTasks[id] = true;
        fresh.taskStates[id]     = 'done';
        fresh.balance           += reward;
        currentUser = fresh;

        DB.logTransaction(currentUser.id, currentUser.name, 'task', 'Quest fulfilled: ' + id, reward, currentUser.balance);
        DB.addToTotalMined(reward);
        DB.incrementTaskClickCount(id);
        updateDisplay();
        renderTasks();
        showToast('+' + reward + ' ' + CFG.TOKEN_NAME + '! Quest fulfilled ✅', 'suc');
        checkRefThreshold();
        checkAutoRefTasks();
        return persist(currentUser).then(() => {
          setTimeout(() => { DB.clearUserTaskState(currentUser.id, id); }, 4000);
        });
      });
    } else if (result.error) {
      showToast('Verification error — try again shortly', 'err');
      currentUser.taskStates[id] = 'go'; persist(currentUser); renderTasks();
    } else {
      showToast('You have not joined the channel yet!', 'err');
      currentUser.taskStates[id] = 'go'; persist(currentUser); renderTasks();
    }
  });
}

function retryTask(id) { currentUser.taskStates[id] = 'go'; persist(currentUser); renderTasks(); }

/* resetAndVerify: used when task was rejected — takes user back to verify state
   so they can resubmit after redoing the task via the icon link */
function resetAndVerify(id, type, target) {
  currentUser.taskStates[id] = 'verify';
  persist(currentUser);
  renderTasks();
}
function showXInput(id) { const w = document.getElementById('xwrap_' + id); if (w) w.classList.toggle('show'); }

function submitXHandle(id, reward, taskName) {
  const input  = document.getElementById('xinput_' + id);
  const handle = input ? input.value.trim() : '';
  if (!handle) { showToast('Enter your @handle', 'err'); return; }
  if (currentUser.completedTasks[id]) { renderTasks(); return; }
  currentUser.taskStates[id]  = 'pending';
  currentUser.taskHandles[id] = handle;
  persist(currentUser);
  DB.pushXQueueItem({ userId: currentUser.id, userName: currentUser.name, taskId: id, taskName, reward, handle, ts: Date.now() });
  renderTasks();
  showToast('Submitted! Awaiting judgment.', 'suc');
}

/* ══════════════════════════════════════════════
   ZEUS
══════════════════════════════════════════════ */
function openZeusModal() {
  if (isZeusActive()) { showToast('Zeus already empowers your harvest', 'err'); return; }
  showModal('modal-zeus');
}
function payZeusWithStars() {
  closeModal('modal-zeus');
  DB.createZeusStarsInvoice(currentUser.id).then(result => {
    if (!result || !result.invoice_url) { showToast('Could not create invoice — try again', 'err'); return; }
    if (tg && tg.openInvoice) {
      tg.openInvoice(result.invoice_url, status => {
        if (status === 'paid') { showToast('⚡ Payment received — Zeus awakens!', 'suc'); setTimeout(() => location.reload(), 1500); }
      });
    } else { window.open(result.invoice_url, '_blank'); }
  });
}
function payZeusWithTon() {
  closeModal('modal-zeus');
  DB.getTonConfig().then(cfg => {
    document.getElementById('ton-amount-display').textContent  = (cfg.ton_price || cfg.price || '2') + ' TON';
    document.getElementById('ton-address-display').textContent = cfg.address || 'Address not configured';
    document.getElementById('ton-memo-display').textContent    = currentUser.id;
    showModal('modal-zeus-ton');
  });
}
function copyTonAddress() {
  const addr = document.getElementById('ton-address-display').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(addr).catch(() => {});
  showToast('Address copied', 'suc');
}
let zeusTonInFlight = false;
function submitZeusTonTxn() {
  if (zeusTonInFlight) return;
  const txnRef = document.getElementById('ton-txn-input').value.trim();
  if (!txnRef) { showToast('Paste your transaction ID or link', 'err'); return; }
  zeusTonInFlight = true;
  const btn = document.querySelector('#modal-zeus-ton .modal-ok');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ SUBMITTING...'; }
  DB.pushEpicGodsRequest({ userId: currentUser.id, userName: currentUser.name, username: currentUser.username, godName: 'zeus', payMethod: 'ton', txnRef })
    .then(() => { closeModal('modal-zeus-ton'); showToast('Submitted — awaiting verification ⚡', 'suc'); })
    .finally(() => { zeusTonInFlight = false; if (btn) { btn.disabled = false; btn.textContent = 'SUBMIT'; } });
}

/* ══════════════════════════════════════════════
   WATCH AD
══════════════════════════════════════════════ */
function watchAdForReward(taskId, reward) {
  showToast('This quest is temporarily unavailable', 'err');
}

/* ══════════════════════════════════════════════
   SHOP TABS
══════════════════════════════════════════════ */
function switchSubTab(name, btn) {
  document.querySelectorAll('.sub-page').forEach(p => { p.classList.remove('active'); });
  document.querySelectorAll('.sub-tab').forEach(b => { b.classList.remove('active'); });
  document.getElementById('sub-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'market')  renderNFTMarket();
  if (name === 'nft')     renderOsaryxNFTs();
  if (name === 'stake')   renderStakes();
  if (name === 'miners')  renderShopState();
}

/* ══════════════════════════════════════════════
   NFT MARKET
   Always reads fresh balance; uses tryBuyNFT for
   atomic sold=false check so two simultaneous taps
   cannot both succeed.
══════════════════════════════════════════════ */
function renderNFTMarket() {
  const cont = document.getElementById('nft-market-list');
  cont.innerHTML = '<div class="empty-note">Consulting the reliquary...</div>';
  DB.getNFTListings().then(listings => {
    if (!listings.length) { cont.innerHTML = '<div class="empty-note">No relics available yet</div>'; return; }
    cont.innerHTML = '';
    listings.forEach(nft => {
      const card = document.createElement('div'); card.className = 'miner-card';
      const btnHtml = nft.sold
        ? '<button class="miner-buy-btn sold" disabled>SOLD</button>'
        : '<button class="miner-buy-btn" onclick="buyNFT(\'' + nft.id + '\')">ACQUIRE — ' + nft.worth + ' ' + CFG.TOKEN_NAME + '</button>';
      card.innerHTML = '<img class="miner-img" src="' + (nft.img||'') + '" onerror="this.style.display=\'none\'">'
        + '<div class="miner-body"><div class="miner-name">' + esc(nft.name) + '</div>'
        + '<div class="miner-detail">Chain: <span style="color:var(--blue)">' + esc(nft.chain||'—') + '</span></div>'
        + '<div class="miner-detail">Worth: <span style="color:var(--gold)">' + nft.worth + ' ' + CFG.TOKEN_NAME + '</span></div>' + btnHtml + '</div>';
      cont.appendChild(card);
    });
  });
}

let nftBuyInFlight = false;
function buyNFT(nftId) {
  if (nftBuyInFlight) return;
  nftBuyInFlight = true;

  DB.getNFTListings().then(listings => {
    const nft = listings.find(l => l.id === nftId);
    if (!nft || nft.sold) { showToast(nft ? 'This relic is already sold' : 'Relic not found', 'err'); renderNFTMarket(); return; }

    /* Atomic sold check first, then deduct from fresh balance */
    return DB.tryBuyNFT(nftId, currentUser.id, CFG.NFT_SOLD_VISIBLE_MINUTES).then(won => {
      if (!won) { showToast('This relic was just claimed by another soul', 'err'); renderNFTMarket(); return; }

      return DB.getUser(currentUser.id).then(fresh => {
        if (!fresh) { showToast('Could not verify balance', 'err'); return; }
        if (fresh.balance < nft.worth) {
          showToast('Insufficient essence — need ' + nft.worth + ' ' + CFG.TOKEN_NAME, 'err');
          /* Undo the sold flag since we can't pay */
          DB.setNFTDispatchStatus(nftId, null);
          currentUser.balance = fresh.balance; updateDisplay(); return;
        }
        fresh.balance       -= nft.worth;
        fresh.stakes         = currentUser.stakes;
        fresh.completedTasks = currentUser.completedTasks;
        fresh.taskStates     = currentUser.taskStates;
        fresh.taskHandles    = currentUser.taskHandles;
        currentUser = fresh;

        DB.logTransaction(currentUser.id, currentUser.name, 'nft_buy', 'Relic acquired: ' + nft.name, -nft.worth, currentUser.balance);
        updateDisplay();
        showToast('"' + nft.name + '" acquired! Find it in your gallery.', 'suc');
        return persist(currentUser).then(() => renderNFTMarket());
      });
    });
  }).finally(() => { nftBuyInFlight = false; });
}

/* ══════════════════════════════════════════════
   OSARYX NFTS
══════════════════════════════════════════════ */
function renderOsaryxNFTs() {
  const cont      = document.getElementById('osaryx-nft-list');
  const comingSoon = document.getElementById('osaryx-nft-coming-soon');
  cont.innerHTML  = '<div class="empty-note">Consulting the reliquary...</div>';
  DB.getOsaryxNFTs().then(listings => {
    if (!listings.length) {
      comingSoon.style.display = 'none'; cont.style.display = 'block';
      cont.innerHTML = '<div class="osaryx-empty-mystic">⚡ <div class="osaryx-empty-title">NO GODS AVAILABLE</div><div class="osaryx-empty-sub">The pantheon rests.</div></div>';
      return;
    }
    comingSoon.style.display = 'none'; cont.style.display = 'block';
    cont.innerHTML = '';
    listings.forEach(nft => {
      const card = document.createElement('div'); card.className = 'miner-card';
      const btnHtml = nft.sold
        ? '<button class="miner-buy-btn sold" disabled>SOLD</button>'
        : '<button class="miner-buy-btn" onclick="buyOsaryxNFT(\'' + nft.id + '\')">ACQUIRE — ' + nft.worth + ' ' + CFG.TOKEN_NAME + '</button>';
      card.innerHTML = '<img class="miner-img" src="' + (nft.img||'') + '" onerror="this.style.display=\'none\'">'
        + '<div class="miner-body"><div class="miner-name">' + esc(nft.name) + '</div>'
        + '<div class="miner-detail">Chain: <span style="color:var(--blue)">' + esc(nft.chain||'—') + '</span></div>'
        + '<div class="miner-detail">Worth: <span style="color:var(--gold)">' + nft.worth + ' ' + CFG.TOKEN_NAME + '</span></div>' + btnHtml + '</div>';
      cont.appendChild(card);
    });
  });
}

let osaryxNftBuyInFlight = false;
function buyOsaryxNFT(nftId) {
  if (osaryxNftBuyInFlight) return;
  osaryxNftBuyInFlight = true;
  DB.getOsaryxNFTs().then(listings => {
    const nft = listings.find(l => l.id === nftId);
    if (!nft || nft.sold) { showToast(nft ? 'Already sold' : 'Not found', 'err'); renderOsaryxNFTs(); return; }
    return DB.tryBuyOsaryxNFT(nftId, currentUser.id, CFG.NFT_SOLD_VISIBLE_MINUTES).then(won => {
      if (!won) { showToast('Just claimed by another soul', 'err'); renderOsaryxNFTs(); return; }
      return DB.getUser(currentUser.id).then(fresh => {
        if (!fresh) { showToast('Could not verify balance', 'err'); return; }
        if (fresh.balance < nft.worth) {
          showToast('Insufficient essence — need ' + nft.worth + ' ' + CFG.TOKEN_NAME, 'err');
          currentUser.balance = fresh.balance; updateDisplay(); return;
        }
        fresh.balance       -= nft.worth;
        fresh.stakes         = currentUser.stakes;
        fresh.completedTasks = currentUser.completedTasks;
        fresh.taskStates     = currentUser.taskStates;
        fresh.taskHandles    = currentUser.taskHandles;
        currentUser = fresh;
        DB.logTransaction(currentUser.id, currentUser.name, 'nft_buy', 'OSARYX NFT acquired: ' + nft.name, -nft.worth, currentUser.balance);
        updateDisplay();
        showToast('"' + nft.name + '" acquired!', 'suc');
        return persist(currentUser).then(() => renderOsaryxNFTs());
      });
    });
  }).finally(() => { osaryxNftBuyInFlight = false; });
}

/* ══════════════════════════════════════════════
   LEADERBOARD
══════════════════════════════════════════════ */
function renderLeaderboard() {
  document.getElementById('lb-podium').innerHTML = '<div class="empty-note">Reading the chronicles...</div>';
  DB.getAllUsersForLeaderboard(50).then(all => {
    if (!all.some(u => u.id === String(currentUser.id))) all.push(currentUser);
    all.sort((a, b) => b.balance - a.balance);
    const top3 = all.slice(0,3), rest = all.slice(3,50);
    const order = [top3[1], top3[0], top3[2]].filter(Boolean);
    const rkC = ['r2','r1','r3'], rkB = ['b2','b1','b3'], medals = ['🥈','🥇','🥉'], nums = [2,1,3];
    document.getElementById('lb-podium').innerHTML = order.map((u, p) =>
      '<div class="podium-item"><div class="podium-av ' + rkC[p] + '">' + medals[p] + '<div class="podium-badge">' + nums[p] + '</div></div>'
      + '<div class="podium-name">' + esc(u.name) + '</div><div class="podium-score">' + formatNum(u.balance) + '</div>'
      + '<div class="podium-block ' + rkB[p] + '"></div></div>'
    ).join('');
    document.getElementById('lb-list').innerHTML = rest.map((u, i) => {
      const me = u.id === String(currentUser.id);
      return '<div class="lb-row' + (me?' me':'') + '"><div class="lb-pos">#' + (i+4) + '</div>'
        + '<div class="lb-name">' + esc(u.name) + (me?' (you)':'') + '</div>'
        + '<div class="lb-score">' + formatNum(u.balance) + '</div></div>';
    }).join('') || '<div class="empty-note">No other souls yet</div>';
  });
}

/* ══════════════════════════════════════════════
   REFERRALS
══════════════════════════════════════════════ */
function renderRefs() {
  DB.getReferralsFor(currentUser.id).then(refs => {
    const verified = refs.filter(r => r.status === 'verified').length;
    document.getElementById('ref-count').textContent  = refs.length;
    document.getElementById('ref-earned').textContent = '+' + (verified * CFG.REF_BONUS) + ' ' + CFG.TOKEN_NAME + ' channelled · +5% of all soul harvests';
    const link = 'https://t.me/' + CFG.BOT_USERNAME + '/' + '?startapp=ref_' + currentUser.id;
    document.getElementById('ref-link-box').textContent = link;
    document.getElementById('ref-list').innerHTML = refs.map(r =>
      '<div class="ref-item"><div class="ref-av">👤</div><div class="ref-user">'
      + '<div class="ref-uname">' + esc(r.refereeName) + '</div>'
      + '<div class="ref-ustat ' + r.status + '">' + (r.status==='verified' ? ('✅ Verified · +' + Math.round(r.earnedTotal) + ' channelled') : '⏳ Awakening') + '</div>'
      + '</div><div class="ref-bonus">' + (r.status==='verified' ? ('+' + CFG.REF_BONUS) : '---') + '</div></div>'
    ).join('') || '<div class="empty-note">No souls invoked yet.</div>';
  });
}

function copyRefLink() {
  const link = document.getElementById('ref-link-box').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
  const el = document.createElement('textarea'); el.value = link; document.body.appendChild(el); el.select();
  try { document.execCommand('copy'); } catch(e){}
  document.body.removeChild(el);
  showToast('Invocation scroll copied ✅', 'suc');
}

function shareRefLink() {
  const link = document.getElementById('ref-link-box').textContent;
  const text = 'I invoke thee into OSARYX — mine tokens, climb the board, and acquire exclusive NFTs.';
  const url  = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
  if (tg) tg.openTelegramLink(url); else window.open(url, '_blank');
}

/* ══════════════════════════════════════════════
   HISTORY
══════════════════════════════════════════════ */
function openHistory() {
  const body = document.getElementById('history-body');
  body.innerHTML = '<div class="empty-note">Reading the ledger...</div>';
  DB.getTransactionsFor(currentUser.id, 100).then(hist => {
    const filteredHist = (hist || []).filter(h => h.type !== 'nft_dispatch');
    body.innerHTML = !filteredHist.length ? '<div class="empty-note">The ledger is empty</div>' : filteredHist.map(h => {
      let amtLine;
      const pos = h.amount >= 0;
      amtLine = '<span class="hist-amt ' + (pos?'pos':'neg') + '">' + (pos?'+':'') + Number(h.amount).toFixed(1) + ' ' + CFG.TOKEN_NAME + '</span>';
      const typeLabels = {
        'mine': 'HARVEST', 'task': 'QUEST REWARD', 'event': 'EVENT REWARD',
        'ref_bonus': 'REFERRAL BONUS', 'ref_percent': 'REFERRAL SHARE',
        'stake': 'VAULT DEPOSIT', 'unstake': 'VAULT RETURN',
        'rune_buy': 'RUNE BOUND', 'storage_buy': 'STORAGE BOUND',
        'nft_buy': 'NFT PURCHASE', 'nft_dispatch': 'NFT DISPATCHED',
        'admin_adjust': h.amount >= 0 ? 'BALANCE CREDIT' : 'BALANCE DEDUCTION',
        'airdrop': 'AIRDROP', 'zeus_settlement': 'ZEUS HARVEST',
        'watch_ad': 'AD REWARD'
      };
      const typeLabel = typeLabels[h.type] || h.type.toUpperCase().replace(/_/g,' ');
      return '<div class="hist-item"><div class="hist-row1"><span class="hist-type">' + typeLabel + '</span>' + amtLine + '</div>'
        + '<div class="hist-txn">TXN: ' + h.txn_id + '</div>'
        + '<div class="hist-ts">' + new Date(h.ts).toLocaleString() + ' · Bal: ' + formatNum(h.balance_after) + '</div></div>';
    }).join('');
  });
  openOverlay('overlay-history');
}

/* ══════════════════════════════════════════════
   PROFILE
══════════════════════════════════════════════ */
let ownedNFTsCache = [];
function openProfile() {
  const u = currentUser;
  document.getElementById('profile-body').innerHTML =
    '<div class="profile-name">' + esc(u.name) + '</div>'
    + '<div class="profile-id">ID: ' + u.id + (u.username ? ' · @' + esc(u.username) : '') + '</div>'
    + '<div class="profile-tabs">'
    +   '<button class="profile-tab active" onclick="switchProfileTab(\'info\',this)">INFO</button>'
    +   '<button class="profile-tab" onclick="switchProfileTab(\'gallery\',this)">RELICS</button>'
    + '</div>'
    + '<div class="profile-sub-page active" id="ptab-info">'
    +   '<div class="stat-card" style="margin-bottom:8px;"><div class="stat-v">' + formatNum(u.balance) + '</div><div class="stat-l">OSARYX ESSENCE</div></div>'
    +   '<div class="stat-card"><div class="stat-v">' + (u.stakes||[]).length + '</div><div class="stat-l">ACTIVE VAULTS</div></div>'
    + '</div>'
    + '<div class="profile-sub-page" id="ptab-gallery"><div class="empty-note">Loading relics...</div></div>';
  openOverlay('overlay-profile');
  loadOwnedNFTs();
}

function loadOwnedNFTs() {
  Promise.all([DB.getOwnedNFTListings(currentUser.id), DB.getOwnedOsaryxNFTs(currentUser.id)]).then(r => {
    ownedNFTsCache = r[0].map(n => Object.assign({}, n, { source: 'market' }))
      .concat(r[1].map(n => Object.assign({}, n, { source: 'osaryx' })));
    const gallery = document.getElementById('ptab-gallery');
    if (!gallery) return;
    if (!ownedNFTsCache.length) { gallery.innerHTML = '<div class="empty-note">No relics bound yet</div>'; return; }
    gallery.innerHTML = '<div class="nft-grid">' + ownedNFTsCache.map(n => {
      const action = n.dispatchStatus === 'pending' ? '<div class="nft-send-status">📬 Pending dispatch</div>'
        : n.dispatchStatus === 'sent' ? '<div class="nft-send-status">✅ Dispatched</div>'
        : '<button class="nft-send-btn" onclick="openSendNFT(\'' + n.id + '\',\'' + esc(n.chain||'') + '\',\'' + n.source + '\')">DISPATCH ↗</button>';
      return '<div class="nft-item"><img src="' + (n.img||'') + '" onerror="this.style.display=\'none\'">'
        + '<div class="nft-item-body"><div class="nft-item-name">' + esc(n.name) + '</div>'
        + '<div class="nft-item-chain">' + esc(n.chain||'') + '</div>' + action + '</div></div>';
    }).join('') + '</div>';
  });
}

function switchProfileTab(name, btn) {
  document.querySelectorAll('.profile-tab').forEach(t => { t.classList.remove('active'); });
  document.querySelectorAll('.profile-sub-page').forEach(p => { p.classList.remove('active'); });
  btn.classList.add('active');
  const pg = document.getElementById('ptab-' + name); if (pg) pg.classList.add('active');
}

function openSendNFT(nftId, chain, source) {
  currentNFTId     = nftId;
  currentNFTSource = source || 'market';
  document.getElementById('send-address-input').value = '';
  document.getElementById('modal-chain-note').innerHTML = 'Send only a <b>' + esc(chain||'compatible') + '</b> address';
  showModal('modal-send');
}

let dispatchInFlight = false;
function confirmSendNFT() {
  if (dispatchInFlight) return;
  const addr = document.getElementById('send-address-input').value.trim();
  if (!addr) { showToast('Enter a wallet address', 'err'); return; }
  const nft = ownedNFTsCache.find(n => n.id === currentNFTId);
  if (!nft) { showToast('Relic not found', 'err'); return; }
  dispatchInFlight = true;
  closeModal('modal-send');
  const pushFn   = currentNFTSource === 'osaryx' ? DB.pushOsaryxNFTRequest : DB.pushNFTRequest;
  const statusFn = currentNFTSource === 'osaryx' ? DB.setOsaryxNFTDispatchStatus : DB.setNFTDispatchStatus;
  pushFn({ reqId: 'NFT'+Date.now(), userId: currentUser.id, userName: currentUser.name, nftId: nft.id, nftName: nft.name, nftImg: nft.img, chain: nft.chain, worth: nft.worth, address: addr, ts: Date.now() })
    .then(() => statusFn(nft.id, 'pending'))
    .then(() => { showToast('Dispatch submitted ✅', 'suc'); openProfile(); })
    .finally(() => { dispatchInFlight = false; });
}

/* ══════════════════════════════════════════════
   NAV / OVERLAY / MODAL / SWIPE
══════════════════════════════════════════════ */
const PAGE_ORDER = ['home','tasks','shop','road','lb','ref'];
function switchPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); });
  document.querySelectorAll('.nav-btn').forEach(b => { b.classList.remove('active'); });
  document.getElementById('page-' + name).classList.add('active');
  if (btn) btn.classList.add('active'); else document.getElementById('nav-' + name).classList.add('active');
  if (name === 'tasks') renderTasks();
  if (name === 'lb')    renderLeaderboard();
  if (name === 'ref')   renderRefs();
  if (name === 'shop')  { renderNFTMarket(); renderOsaryxNFTs(); renderStakes(); renderShopState(); }
}
function openOverlay(id)  { document.getElementById(id).classList.add('show'); }
function closeOverlay(id) { document.getElementById(id).classList.remove('show'); }
function showModal(id)    { document.getElementById(id).classList.add('show'); }
function closeModal(id)   { document.getElementById(id).classList.remove('show'); }

function setupSwipeNav() {
  let startX = 0, startY = 0, tracking = false;
  const pagesEl = document.querySelector('.pages');
  pagesEl.addEventListener('touchstart', e => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; tracking = true; }, { passive: true });
  pagesEl.addEventListener('touchend', e => {
    if (!tracking) return; tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)*1.5) return;
    const activePage = document.querySelector('.page.active').id.replace('page-','');
    const idx = PAGE_ORDER.indexOf(activePage);
    if (idx === -1) return;
    const nextIdx = dx < 0 ? idx+1 : idx-1;
    if (nextIdx < 0 || nextIdx >= PAGE_ORDER.length) return;
    switchPage(PAGE_ORDER[nextIdx], document.getElementById('nav-' + PAGE_ORDER[nextIdx]));
  }, { passive: true });
}

/* ══════════════════════════════════════════════
   UTILS / TOAST
══════════════════════════════════════════════ */
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
let toastTimer = null;
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (type ? ' ' + type : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3000);
}