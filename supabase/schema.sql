-- Voltra push alerts. Run once in the Supabase SQL Editor for a new project.
-- Only the Vercel functions touch these tables (with the service role key), so RLS is on with no policies:
-- the public anon key can't read or write anything.

-- One row per device that turned alerts on, with its own alert price and alert state
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  threshold numeric not null default 20,          -- alert when the live price goes above this (cents)
  alert_active boolean not null default false,    -- currently above threshold (high alert sent, no all-clear yet)
  below_count integer not null default 0,         -- intervals back under threshold, for the all-clear
  zero_active boolean not null default false,     -- currently at/below 0¢ (zero alert sent for this dip)
  zero_count integer not null default 0,          -- intervals back above 0¢, to re-arm the zero alert
  last_test_at timestamptz,                       -- rate limit for the "Send test" button
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

-- Single row (id = 1): the last 5-minute interval processed, so each price is handled exactly once
create table if not exists public.alert_state (
  id smallint primary key default 1 check (id = 1),
  last_interval_ms bigint not null default 0,
  last_price numeric,
  updated_at timestamptz not null default now()
);

alter table public.alert_state enable row level security;

insert into public.alert_state (id) values (1) on conflict (id) do nothing;
