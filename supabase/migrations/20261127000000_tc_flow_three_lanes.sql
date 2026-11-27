-- TC Flow v3: every deal shows three things, in this order:
--   1. Title          2. Seller contact          3. Due diligence and broker
-- The agent writes one short status line, a color and "waiting on" for each.
-- Additive only: no columns or rows are removed.

-- 1. TITLE
alter table public.tc_deals add column if not exists title_status text;        -- 1 to 3 plain sentences: where title stands right now
alter table public.tc_deals add column if not exists title_waiting_on text;    -- us | title | seller | funder | null
alter table public.tc_deals add column if not exists title_last_reply timestamptz; -- last email or Qualia message FROM title
alter table public.tc_deals add column if not exists title_last_ours timestamptz;  -- last email we (Jay or Pramod) sent title
alter table public.tc_deals add column if not exists title_flag text;          -- green | yellow | red

-- 2. SELLER
alter table public.tc_deals add column if not exists seller_status text;       -- what was last discussed and where things stand with the seller
alter table public.tc_deals add column if not exists seller_open text;         -- anything owed either way ("Seller owes: signed extension. We owe: call back on closing date.")
alter table public.tc_deals add column if not exists seller_flag text;

-- 3. DUE DILIGENCE AND BROKER
alter table public.tc_deals add column if not exists dd_status text;           -- what DD has found and what we still need to find
alter table public.tc_deals add column if not exists broker_status text;       -- where we are with brokers: opinions in, who we picked, listing agreement
alter table public.tc_deals add column if not exists dd_flag text;

-- brokers we talk to on a deal. Usually 2 or 3 give a pricing opinion, then we pick one and sign a listing agreement.
create table if not exists public.tc_brokers (
  id bigint generated always as identity primary key,
  deal_id uuid not null references public.tc_deals(id) on delete cascade,
  name text not null,
  company text,
  email text,
  phone text,
  status text not null default 'contacted',   -- contacted | opinion | chosen | signed | passed
  opinion_low numeric,                         -- pricing opinion (a single number goes in both low and high)
  opinion_high numeric,
  opinion_text text,                           -- e.g. "2 lots at $45k to $50k each"
  opinion_date date,
  opinion_url text,                            -- Gmail link
  listing_signed_date date,
  last_contact timestamptz,
  notes text,
  logged_by text default 'agent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists tc_brokers_dedupe on public.tc_brokers(deal_id, lower(coalesce(email, name)));
drop trigger if exists tc_brokers_touch on public.tc_brokers;
create trigger tc_brokers_touch before update on public.tc_brokers for each row execute function public.tc_touch();
alter table public.tc_brokers enable row level security;
drop policy if exists "tc members only" on public.tc_brokers;
create policy "tc members only" on public.tc_brokers for all to authenticated using (public.tc_is_member()) with check (public.tc_is_member());
do $$ begin begin alter publication supabase_realtime add table public.tc_brokers; exception when others then null; end; end $$;

-- who last edited each section (a person's email, or 'agent'). The agent keeps a person's edit
-- until it finds evidence newer than the edit.
alter table public.tc_deals add column if not exists title_edited_by text, add column if not exists title_edited_at timestamptz,
  add column if not exists seller_edited_by text, add column if not exists seller_edited_at timestamptz,
  add column if not exists dd_edited_by text, add column if not exists dd_edited_at timestamptz,
  add column if not exists dates_edited_by text, add column if not exists dates_edited_at timestamptz;
