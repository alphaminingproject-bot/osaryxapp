-- ============================================================
--  OSARYX Token — Supabase Schema v3 (COMPLETE FRESH REBUILD)
--  Run this entire script in Supabase SQL Editor.
--  This DROPS every existing table — true fresh slate.
-- ============================================================

-- ── CLEAN SLATE ────────────────────────────────────────────
drop table if exists users cascade;
drop table if exists referrals cascade;
drop table if exists vaults cascade;
drop table if exists global_stats cascade;
drop table if exists maintenance cascade;
drop table if exists tasks cascade;
drop table if exists events cascade;
drop table if exists x_queue cascade;
drop table if exists ref_queue cascade;
drop table if exists nft_listings cascade;
drop table if exists nft_requests cascade;
drop table if exists transactions cascade;
drop table if exists admin_messages cascade;
drop table if exists banned_users cascade;
drop table if exists epic_gods_requests cascade;
drop table if exists airdrop_log cascade;

-- ── USERS ──────────────────────────────────────────────────
create table users (
  tg_id                text primary key,
  name                 text not null default 'Acolyte',
  username             text not null default '',
  photo_url            text not null default '',
  balance              numeric not null default 0,
  last_mine            bigint not null default 0,
  mine_interval_hours  integer not null default 3,
  mine_multiplier      numeric not null default 1,
  storage_expires_at   bigint default null,
  storage_hours        integer default null,
  rune_expires_at      bigint default null,
  rune_type            text default null,
  zeus_active_until    bigint default null,
  zeus_started_at      bigint default null,
  zeus_settled_balance numeric not null default 0,
  referred_by          text default null,
  task_states          text not null default '{}',
  task_handles         text not null default '{}',
  is_banned            boolean not null default false,
  welcomed              boolean not null default false,   -- has the bot sent the one-time welcome msg
  last_seen            bigint not null default 0,
  created_at           bigint not null default (extract(epoch from now())::bigint * 1000)
);
create index idx_users_balance on users (balance desc);
create index idx_users_username on users (lower(username));
create index idx_users_referred_by on users (referred_by);

-- ── REFERRALS ──────────────────────────────────────────────
create table referrals (
  id            bigint generated always as identity primary key,
  referrer_id   text not null references users(tg_id) on delete cascade,
  referee_id    text not null references users(tg_id) on delete cascade,
  referee_name  text not null default '',
  ref_status    text not null default 'pending',
  earned_total  numeric not null default 0,
  created_at    bigint not null default (extract(epoch from now())::bigint * 1000),
  unique(referrer_id, referee_id)
);
create index idx_referrals_referrer on referrals (referrer_id);
create index idx_referrals_referee on referrals (referee_id);

-- ── VAULTS (staking) ───────────────────────────────────────
create table vaults (
  id            text primary key,
  tg_user_id    text not null references users(tg_id) on delete cascade,
  amount        numeric not null,
  yield_amount  numeric not null,
  staked_at     bigint not null,
  matures_at    bigint not null
);
create index idx_vaults_user on vaults (tg_user_id);

-- ── GLOBAL STATS ───────────────────────────────────────────
create table global_stats (
  id            integer primary key default 1,
  total_mined   numeric not null default 0
);
insert into global_stats (id, total_mined) values (1, 0);

-- ── MAINTENANCE MODE ───────────────────────────────────────
create table maintenance (
  id            integer primary key default 1,
  is_active     boolean not null default false,
  message       text not null default 'OSARYX is undergoing a sacred ritual. Please return shortly.',
  snapshot      text default null,
  activated_at  bigint default null
);
insert into maintenance (id, is_active) values (1, false);

-- ── TASKS ──────────────────────────────────────────────────
create table tasks (
  id           text primary key,
  name         text not null default '',
  description  text not null default '',
  reward       numeric not null default 0,
  task_type    text not null default 'link',  -- telegram_channel | telegram_group | x_follow | link | auto_ref | watch_ad
  icon         text not null default '🎯',
  target       text not null default '',
  x_follow     boolean not null default false,
  auto_ref     integer default null,
  click_cap    integer default null,
  click_count  integer not null default 0,
  sort_order   bigint not null default 0,
  created_at   bigint not null default (extract(epoch from now())::bigint * 1000)
);

-- ── EVENTS ─────────────────────────────────────────────────
create table events (
  id          text primary key,
  name        text not null default '',
  icon        text not null default '📣',
  description text not null default '',
  tasks       text not null default '[]',
  created_at  bigint not null default (extract(epoch from now())::bigint * 1000)
);

-- ── X QUEUE ────────────────────────────────────────────────
create table x_queue (
  id           bigint generated always as identity primary key,
  tg_user_id   text not null references users(tg_id) on delete cascade,
  user_name    text not null default '',
  task_id      text not null default '',
  task_name    text not null default '',
  reward       numeric not null default 0,
  x_handle     text not null default '',
  ts           bigint not null default (extract(epoch from now())::bigint * 1000),
  queue_status text not null default 'pending',  -- pending | verified | rejected
  notified     boolean not null default false
);
create index idx_xqueue_user on x_queue (tg_user_id);

-- ── REF QUEUE ──────────────────────────────────────────────
create table ref_queue (
  id            bigint generated always as identity primary key,
  referrer_id   text not null,
  referrer_name text not null default '',
  referee_id    text not null,
  referee_name  text not null default '',
  ts            bigint not null default (extract(epoch from now())::bigint * 1000),
  queue_status  text not null default 'pending'
);

-- ── NFT LISTINGS ───────────────────────────────────────────
create table nft_listings (
  id              text primary key,
  name            text not null default '',
  img             text not null default '',
  chain           text not null default '',
  worth           numeric not null default 0,
  sold            boolean not null default false,
  sold_to         text default null,
  sold_at         bigint default null,
  dispatch_status text default null,    -- null | 'pending' | 'sent'
  created_at      bigint not null default (extract(epoch from now())::bigint * 1000)
);

-- ── NFT REQUESTS (dispatch) ────────────────────────────────
create table nft_requests (
  req_id      text primary key,
  tg_user_id  text not null references users(tg_id) on delete cascade,
  user_name   text not null default '',
  nft_id      text not null default '',
  nft_name    text not null default '',
  nft_img     text not null default '',
  chain       text not null default '',
  wallet_addr text not null default '',
  worth       numeric not null default 0,
  ts          bigint not null default (extract(epoch from now())::bigint * 1000),
  req_status  text not null default 'pending',  -- pending | sent
  txn_id      text default null,
  notified    boolean not null default false
);
create index idx_nftreq_user on nft_requests (tg_user_id);

-- ── TRANSACTIONS (universal ledger) ───────────────────────
create table transactions (
  txn_id        text primary key,
  tg_user_id    text not null,
  user_name     text not null default '',
  type          text not null default '',
  description   text not null default '',
  amount        numeric not null default 0,
  balance_after numeric not null default 0,
  ts            bigint not null default (extract(epoch from now())::bigint * 1000)
);
create index idx_txn_user on transactions (tg_user_id);
create index idx_txn_ts on transactions (ts desc);

-- ── ADMIN MESSAGES (direct DM queue, processed by bot.js) ─
create table admin_messages (
  id          bigint generated always as identity primary key,
  tg_user_id  text not null,
  message     text not null,
  sent        boolean not null default false,
  ts          bigint not null default (extract(epoch from now())::bigint * 1000)
);

-- ── BANNED USERS LOG ───────────────────────────────────────
create table banned_users (
  tg_id     text primary key,
  reason    text default '',
  banned_at bigint not null default (extract(epoch from now())::bigint * 1000)
);

-- ── EPIC GODS (Zeus) PURCHASE REQUESTS ─────────────────────
create table epic_gods_requests (
  id          bigint generated always as identity primary key,
  tg_user_id  text not null,
  user_name   text not null default '',
  username    text not null default '',
  god_name    text not null default 'zeus',
  pay_method  text not null default 'ton',   -- ton | stars
  txn_ref     text default null,
  req_status  text not null default 'pending',
  ts          bigint not null default (extract(epoch from now())::bigint * 1000),
  verified_at bigint default null
);
create index idx_epic_gods_user on epic_gods_requests (tg_user_id);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────
alter table users               enable row level security;
alter table referrals           enable row level security;
alter table vaults              enable row level security;
alter table global_stats        enable row level security;
alter table maintenance         enable row level security;
alter table tasks               enable row level security;
alter table events              enable row level security;
alter table x_queue             enable row level security;
alter table ref_queue           enable row level security;
alter table nft_listings        enable row level security;
alter table nft_requests        enable row level security;
alter table transactions        enable row level security;
alter table admin_messages      enable row level security;
alter table banned_users        enable row level security;
alter table epic_gods_requests  enable row level security;

do $$ declare t text; begin
  foreach t in array array[
    'users','referrals','vaults','global_stats','maintenance','tasks','events',
    'x_queue','ref_queue','nft_listings','nft_requests','transactions',
    'admin_messages','banned_users','epic_gods_requests'
  ] loop
    execute format('drop policy if exists allow_all on %I', t);
    execute format('create policy allow_all on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- ── REALTIME ───────────────────────────────────────────────
alter publication supabase_realtime add table users;
alter publication supabase_realtime add table referrals;
alter publication supabase_realtime add table vaults;
alter publication supabase_realtime add table x_queue;
alter publication supabase_realtime add table ref_queue;
alter publication supabase_realtime add table nft_requests;
alter publication supabase_realtime add table nft_listings;
alter publication supabase_realtime add table global_stats;
alter publication supabase_realtime add table maintenance;
alter publication supabase_realtime add table admin_messages;
alter publication supabase_realtime add table epic_gods_requests;

-- ── SEED DEFAULT TASKS ─────────────────────────────────────
insert into tasks (id, name, description, reward, task_type, icon, target, x_follow, auto_ref, sort_order) values
  ('t_ch1',   'Join OSARYX Channel', 'Join our official Telegram channel', 50,  'telegram_channel', '📢', '@OSARYXOfficial',          false, null, 100),
  ('t_x1',    'Follow on X',          'Follow @OSARYX on X',                25,  'x_follow',         '🐦', 'https://x.com/OSARYX',     true,  null, 200),
  ('t_ref1',   'Invoke 1 Soul',    'Refer 1 verified soul',     300,   'auto_ref', '🎯', '', false, 1,   9000),
  ('t_ref3',   'Invoke 3 Souls',   'Refer 3 verified souls',    500,   'auto_ref', '🎯', '', false, 3,   9001),
  ('t_ref10',  'Invoke 10 Souls',  'Refer 10 verified souls',   3000,  'auto_ref', '🏆', '', false, 10,  9002),
  ('t_ref50',  'Invoke 50 Souls',  'Refer 50 verified souls',   15000, 'auto_ref', '🏆', '', false, 50,  9003),
  ('t_ref100', 'Invoke 100 Souls', 'Refer 100 verified souls',  50000, 'auto_ref', '👑', '', false, 100, 9004);
