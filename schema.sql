create table if not exists accounts (
  id uuid primary key,
  created_at timestamptz default now(),
  kick_user_id text unique not null,
  username text not null
);

create table if not exists kick_tokens (
  id uuid primary key,
  account_id uuid references accounts(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null
);

create index if not exists kick_tokens_account_idx on kick_tokens(account_id);

create table if not exists channels (
  id uuid primary key,
  created_at timestamptz default now(),
  channel_slug text unique not null,
  channel_id text
);

create table if not exists subscriptions (
  id uuid primary key,
  account_id uuid references accounts(id) on delete cascade,
  channel_id uuid references channels(id) on delete cascade,
  role text,
  unique(account_id, channel_id)
);
