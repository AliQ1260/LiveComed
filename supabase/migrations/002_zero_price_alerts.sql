-- Adds the "at or below 0¢" alert. Run once in the Supabase SQL Editor if you already ran schema.sql
-- before this change. Safe to run more than once.

alter table public.push_subscriptions
  add column if not exists zero_active boolean not null default false,  -- currently at/below 0¢ (zero alert sent)
  add column if not exists zero_count integer not null default 0;       -- intervals back above 0¢, to re-arm
