-- TC Flow: transaction coordination dashboard tables (tc_ prefix).
-- Creates its own tables, plus two read-only hooks:
--   * an AFTER INSERT trigger on ghl_events that creates/updates a TC deal when an
--     opportunity is in the GHL "Contract --> Close" pipeline (never blocks the insert)
--   * an AFTER INSERT/UPDATE trigger on properties that links a TC deal to its CRM property
-- Nothing in ghl_events or properties is ever modified.

-- ---------- members & security helper ----------
create table if not exists public.tc_members (
  email text primary key,
  added_at timestamptz not null default now()
);
create or replace function public.tc_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tc_members
                 where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.tc_is_member() from public;
grant execute on function public.tc_is_member() to authenticated;

-- ---------- GHL stage map (Contract --> Close pipeline) ----------
create table if not exists public.tc_settings (
  id text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.tc_settings (id, doc) values
 ('pipeline', '{"pipelineId":"iUibfflR9UO3AaOJuVnl","name":"Contract --> Close","ghlLocation":"wYwhCQq7nLroxnCnZq2N"}')
on conflict (id) do nothing;

create table if not exists public.tc_stage_map (
  stage_id text primary key,
  key text not null,           -- new_contract | title_emd | dd2 | funding | dd3 | closed
  label text not null
);
insert into public.tc_stage_map (stage_id, key, label) values
 ('bfed27d0-4f3b-45a9-9add-07f95f09c3c8','new_contract','New Contract'),
 ('eb5420cb-274a-4ff8-9208-017ac77f506b','title_emd','Title & EMD Confirmed'),
 ('930f0623-bf08-474d-afbe-acb99849f54b','dd2','DD Phase II Completed'),
 ('99ca24af-07a8-4421-aae6-de91e410c789','funding','Funding Confirmed'),
 ('fb08637a-2b23-43c7-bd96-85557ab50411','dd3','DD Phase III Completed'),
 ('30687a3b-2cfb-4a5d-a8f5-745510446923','closed','Deal Closed'),
 ('a29dae0a-9df0-43f5-b253-215decbd9b52','closed','Deal Closed'),
 ('ec26acf1-7d29-41bc-a087-31fa52407195','closed','Deal Closed')
on conflict (stage_id) do update set key = excluded.key, label = excluded.label;

-- ---------- checklist template ----------
-- stage: the GHL stage this step belongs to. who: agent | team | jay.
-- agent_can_check: the daily agent may tick it when it finds proof.
-- ghl_field: the GHL contact field (folder: field) the agent reads to verify it.
-- due_anchor / due_offset: due date = anchor date + offset days (anchor: stage | contract | emd | close | dd_end).
create table if not exists public.tc_steps (
  id text primary key,
  stage text not null,
  sort int not null,
  title text not null,
  detail text,
  who text not null default 'agent',
  agent_can_check boolean not null default true,
  ghl_field text,
  due_anchor text,
  due_offset int,
  optional boolean not null default false,
  critical boolean not null default false,
  active boolean not null default true
);

insert into public.tc_steps (id, stage, sort, title, detail, who, agent_can_check, ghl_field, due_anchor, due_offset, optional, critical) values
-- New Contract
('contract_uploaded','new_contract',10,'Signed purchase agreement in GHL','Fully executed contract (all pages, initials, addenda) uploaded.','agent',true,'Due Diligence Phase II: Purchase Agreements','contract',1,false,true),
('key_fields','new_contract',20,'Price, EMD deadline and closing deadline entered','Purchase Price, EMD Deadline and Closing Deadline filled in.','agent',true,'Due Diligence Phase II: Purchase Price, EMD Deadline, Closing Deadline','contract',1,false,true),
('property_id','new_contract',30,'Property ID set and property in the CRM','Property ID (State-County-Lastname-Acres) set in GHL and the property exists in the Utopian CRM.','agent',true,'Due Diligence Phase II: Property ID','contract',2,false,false),
('deadline_tasks','new_contract',40,'EMD and closing deadline tasks created in GHL','GHL tasks for the EMD deadline and closing deadline exist with the right dates.','agent',true,'Contact Tasks','contract',2,false,false),
('funding_source','new_contract',50,'Funding source and title entity set','Who funds it (Robert, other lender, our cash, transactional) and which entity takes title.','jay',false,null,'contract',3,false,true),
('seller_welcome','new_contract',60,'Seller told the next steps','Welcome call or text: who we are, what happens next, timeline, what we need from them.','team',true,'Conversations','contract',1,false,false),
-- Title & EMD Confirmed
('title_company','title_emd',10,'Title company or closing attorney chosen','Closer name, email and phone saved.','agent',true,'Due Diligence Phase II: Title Company + Contacts','contract',2,false,true),
('title_opened','title_emd',20,'Title opened with the contract package','Contract, APN, vesting entity and target close date sent; receipt confirmed.','agent',true,'Gmail','contract',3,false,true),
('emd_sent','title_emd',30,'EMD sent','EMD delivered before the EMD deadline.','agent',true,'Due Diligence Phase II: EMD Deadline','emd',0,false,true),
('emd_received','title_emd',40,'EMD receipt confirmed by title','Written confirmation from the closer that EMD posted.','agent',true,'Gmail','emd',2,false,true),
('seller_docs_requested','title_emd',50,'Seller documents requested','ID, W-9, payoff info and any ownership papers (heirs, LLC, trust, divorce).','agent',true,'Conversations / Gmail','contract',3,false,false),
-- DD Phase II
('title_commitment','dd2',10,'Title commitment and search received','Commitment uploaded; vesting, legal description and Schedule B requirements reviewed.','agent',true,'Due Diligence Phase II: Title Commitment & Search','stage',10,false,true),
('deed_survey','dd2',20,'Deed and survey on file','Current deed and any existing survey uploaded.','agent',true,'Due Diligence Phase II: Deed and Survey','stage',7,false,false),
('defects_cures','dd2',30,'Title defects and cures noted','Liens, heirs, back taxes and how each gets cleared.','agent',true,'Due Diligence Phase II: Immediate Defects and Cures','stage',12,false,true),
('contractor_quotes','dd2',40,'Contractor quotes (3 minimum)','Clearing, driveway, survey or other work quotes uploaded.','agent',true,'Due Diligence Phase II: Contractor Quotes (3 Min)','stage',14,true,false),
('jurisdiction','dd2',50,'Jurisdiction level confirmed','City, county or ETJ rules that apply.','agent',true,'Due Diligence Phase II: Jurisdiction Level','stage',7,false,false),
('zoning','dd2',60,'Zoning and deed restrictions checked','Zoning, minimum lot size, covenants and restrictions.','agent',true,'Due Diligence Phase II: Zoning and Deed Restrictions','stage',7,false,false),
('electric','dd2',70,'Electricity provider and extension needs','Provider and what it takes to bring power.','agent',true,'Due Diligence Phase II: Electricity Provider and Extension Requirements','stage',7,false,false),
('sewer','dd2',80,'Sewer or septic status','Public sewer or septic and perc needs.','agent',true,'Due Diligence Phase II: Sewer Status','stage',7,false,false),
('water','dd2',90,'Water source','Public water, well or none.','agent',true,'Due Diligence Phase II: Water','stage',7,false,false),
('seller_docs_received','dd2',100,'Seller documents received','Everything requested from the seller is in.','agent',true,'Gmail / GHL files','stage',10,false,false),
('dd_decision','dd2',110,'Go, renegotiate or cancel decided','Decision made before the due diligence period ends.','jay',false,null,'dd_end',-2,false,true),
-- Funding Confirmed
('funder_approved','funding',10,'Funder approved the deal','Robert or the other funding source signed off.','agent',true,'Gmail','stage',3,false,true),
('funds_scheduled','funding',20,'Funding amount and date confirmed','Amount and wire date agreed with the funder.','agent',true,'Gmail','close',-5,false,true),
('buyer_contract','funding',30,'Buyer contract and buyer EMD (if reselling)','Only for double closes or pre-sold deals. Buyer contract date locks the capital split.','agent',true,'Gmail','stage',7,true,false),
-- DD Phase III
('new_survey','dd3',10,'New survey (if needed)','New survey uploaded when the deal needs one.','agent',true,'Due Diligence Phase III: New Survey','close',-10,true,false),
('new_perc','dd3',20,'New perc test (if needed)','Perc or soil test uploaded when the deal needs one.','agent',true,'Due Diligence Phase III: New Perc Test','close',-10,true,false),
('title_cleared','dd3',30,'Title requirements cleared','Every Schedule B item satisfied; curative work done.','agent',true,'Gmail','close',-5,false,true),
('clear_to_close','dd3',40,'Clear to close from title','Closer confirms the file is ready.','agent',true,'Gmail','close',-3,false,true),
('signing_scheduled','dd3',50,'Signing scheduled for every party','In office, mobile notary, remote online notary or mail-away, per party.','agent',true,'Gmail / Calendar','close',-5,false,true),
('settlement_reviewed','dd3',60,'Settlement statement reviewed','Checked line by line against the contract and funding.','jay',false,null,'close',-2,false,true),
('wire_verified','dd3',70,'Wire instructions verified by phone','Called the closer at a number from their website. Never from email alone. A person must tick this.','team',false,null,'close',-3,false,true),
('funds_sent','dd3',80,'Funds wired and received by the closer','Receipt confirmed by the closer.','agent',true,'Gmail','close',-1,false,true),
-- Deal Closed
('funds_disbursed','closed',10,'Closed and funds disbursed','Seller paid, funder paid out.','agent',true,'Gmail','close',1,false,true),
('final_settlement','closed',20,'Final settlement statement saved','Uploaded to GHL and the Drive deal folder.','agent',true,'Closing & Marketing: Final Settlement Statement','close',7,false,false),
('recorded_deed','closed',30,'Recorded deed saved','Recorded copy uploaded.','agent',true,'Closing & Marketing: Recorded Deed','close',21,false,false),
('title_policy','closed',40,'Owner''s title policy saved','Final policy uploaded.','agent',true,'Closing & Marketing: Title Policy','close',45,false,false),
('crm_updated','closed',50,'CRM and accounting updated','CRM buy price (land only), closing date and the 2026 Project Accounting sheet.','team',true,'Utopian CRM','close',7,false,false),
('seller_thanks','closed',60,'Seller thank-you and referral ask','Thank the seller; ask for a review or referral.','team',true,'Conversations','close',3,false,false)
on conflict (id) do update set stage=excluded.stage, sort=excluded.sort, title=excluded.title, detail=excluded.detail, who=excluded.who,
  agent_can_check=excluded.agent_can_check, ghl_field=excluded.ghl_field, due_anchor=excluded.due_anchor, due_offset=excluded.due_offset,
  optional=excluded.optional, critical=excluded.critical;

-- ---------- deals ----------
create table if not exists public.tc_deals (
  id uuid primary key default gen_random_uuid(),
  ghl_opportunity_id text unique,
  ghl_contact_id text,
  property_id uuid references public.properties(id) on delete set null,
  name text,
  seller_name text, seller_email text, seller_phone text,
  ghl_stage text not null default 'new_contract',
  ghl_stage_id text,
  ghl_status text default 'open',
  stage_dates jsonb not null default '{}'::jsonb,     -- {stage_key: 'YYYY-MM-DD'} when it entered each stage
  status text not null default 'active',               -- active | closed | dead | archived
  contract_date date,
  emd_deadline date,
  close_date date,
  dd_end date,
  purchase_price numeric,
  funding_source text,
  vesting_entity text,
  closing_agent text,
  closing_agent_contact text,
  structure text,                                       -- direct | assignment | double_close
  buyer_contract_date date,
  last_seller_contact timestamptz,
  agent_summary text,
  agent_checked_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tc_deals_contact on public.tc_deals(ghl_contact_id);

-- one row per checklist step per deal
create table if not exists public.tc_items (
  id bigint generated always as identity primary key,
  deal_id uuid not null references public.tc_deals(id) on delete cascade,
  step_id text not null references public.tc_steps(id),
  status text not null default 'open',     -- open | waiting | done | na
  done_at timestamptz,
  done_by text,                            -- 'agent' or the person's email
  evidence text,                           -- what proved it (one line)
  evidence_url text,                       -- link to the email, file or GHL record
  agent_note text,                         -- what is missing / who we are waiting on
  waiting_on text,                         -- title | seller | funder | buyer | us
  last_checked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (deal_id, step_id)
);

-- extra action items the agent finds (overdue GHL tasks, emails needing a reply, title issues)
create table if not exists public.tc_actions (
  id bigint generated always as identity primary key,
  deal_id uuid not null references public.tc_deals(id) on delete cascade,
  key text not null,                       -- stable key so the agent updates instead of duplicating
  title text not null,
  detail text,
  owner text,                              -- jay | team | title | seller | funder | buyer
  since date not null default (now() at time zone 'America/Chicago')::date,
  due_date date,
  source text,                             -- 'GHL task' | 'GHL field' | 'Gmail' | 'Agent'
  source_url text,
  status text not null default 'open',     -- open | done
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (deal_id, key)
);

-- activity log
create table if not exists public.tc_events (
  id bigint generated always as identity primary key,
  deal_id uuid references public.tc_deals(id) on delete cascade,
  at timestamptz not null default now(),
  actor text,                              -- 'agent', 'system', or an email
  kind text,                               -- created | stage | check | uncheck | note | run | flag
  text text,
  url text
);
create index if not exists tc_events_deal_at on public.tc_events(deal_id, at desc);

-- ---------- touch + item seeding ----------
create or replace function public.tc_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['tc_deals','tc_items','tc_actions','tc_settings'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.tc_touch()', t, t);
  end loop;
end $$;

create or replace function public.tc_seed_items() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.tc_items (deal_id, step_id)
  select new.id, s.id from public.tc_steps s where s.active
  on conflict (deal_id, step_id) do nothing;
  insert into public.tc_events (deal_id, actor, kind, text)
  values (new.id, 'system', 'created', 'Deal added to TC Flow from GHL (' || coalesce(new.ghl_stage,'') || ')');
  return new;
end $$;
drop trigger if exists tc_deals_seed on public.tc_deals;
create trigger tc_deals_seed after insert on public.tc_deals for each row execute function public.tc_seed_items();

-- ---------- GHL -> TC deal sync ----------
create or replace function public.tc_upsert_from_event(e public.ghl_events) returns void
language plpgsql security definer set search_path = public as $$
declare
  pipe text := (select doc->>'pipelineId' from public.tc_settings where id = 'pipeline');
  st text; k text; st_status text; cid text; d public.tc_deals; prop uuid; day date;
begin
  if e.opportunity_id is null or coalesce(e.pipeline_id, e.raw->>'pipelineId') is distinct from pipe then return; end if;
  if e.event_type not like 'Opportunity%' then return; end if;
  st := coalesce(e.raw->>'pipelineStageId', e.stage_id);
  select key into k from public.tc_stage_map where stage_id = st;
  st_status := coalesce(e.raw->>'status', 'open');
  cid := coalesce(e.contact_id, e.raw->>'contactId');
  day := (coalesce(e.occurred_at, e.received_at) at time zone 'America/Chicago')::date;
  select * into d from public.tc_deals where ghl_opportunity_id = e.opportunity_id;

  if d.id is null then
    -- only open deals that are not already closed start a TC file
    if st_status <> 'open' or k = 'closed' then return; end if;
    select id into prop from public.properties
      where deleted_at is null and ghl_url like '%/' || cid order by created_at desc limit 1;
    insert into public.tc_deals (ghl_opportunity_id, ghl_contact_id, property_id, name, seller_name, seller_email, seller_phone,
                                 ghl_stage, ghl_stage_id, ghl_status, stage_dates, contract_date)
    values (e.opportunity_id, cid, prop, e.raw->>'name', e.raw#>>'{contact,name}', e.raw#>>'{contact,email}', e.raw#>>'{contact,phone}',
            coalesce(k, 'new_contract'), st, st_status, jsonb_build_object(coalesce(k,'new_contract'), day), day);
    return;
  end if;

  update public.tc_deals set
    name = coalesce(e.raw->>'name', name),
    seller_name = coalesce(e.raw#>>'{contact,name}', seller_name),
    seller_email = coalesce(e.raw#>>'{contact,email}', seller_email),
    seller_phone = coalesce(e.raw#>>'{contact,phone}', seller_phone),
    ghl_stage = coalesce(k, ghl_stage),
    ghl_stage_id = st,
    ghl_status = st_status,
    stage_dates = case when k is not null and not (stage_dates ? k) then stage_dates || jsonb_build_object(k, day) else stage_dates end,
    status = case when st_status in ('lost','abandoned') then 'dead'
                  when status = 'dead' and st_status = 'open' then 'active'
                  else status end
  where id = d.id;
  if k is not null and k is distinct from d.ghl_stage then
    insert into public.tc_events (deal_id, actor, kind, text)
    values (d.id, 'system', 'stage', 'GHL stage moved to ' || (select label from public.tc_stage_map where stage_id = st));
  end if;
end $$;

create or replace function public.tc_on_ghl_event() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.tc_upsert_from_event(new);
  exception when others then
    raise warning 'tc_on_ghl_event skipped: %', sqlerrm;   -- never block GHL ingestion
  end;
  return new;
end $$;
drop trigger if exists tc_ghl_events_sync on public.ghl_events;
create trigger tc_ghl_events_sync after insert on public.ghl_events for each row execute function public.tc_on_ghl_event();

-- link a TC deal to its CRM property when the property is added or its GHL link is set
create or replace function public.tc_on_property() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.ghl_url is not null and new.deleted_at is null then
      update public.tc_deals set property_id = new.id
       where property_id is null and ghl_contact_id is not null and new.ghl_url like '%/' || ghl_contact_id;
    end if;
  exception when others then
    raise warning 'tc_on_property skipped: %', sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists tc_properties_link on public.properties;
create trigger tc_properties_link after insert or update of ghl_url, deleted_at on public.properties
  for each row execute function public.tc_on_property();

-- seller contact activity from GHL messages (members only)
create or replace function public.tc_contact_activity()
returns table (contact_id text, last_out timestamptz, last_in timestamptz, last_any timestamptz)
language sql stable security definer set search_path = public as $$
  select g.contact_id,
         max(g.occurred_at) filter (where g.event_type = 'OutboundMessage'),
         max(g.occurred_at) filter (where g.event_type = 'InboundMessage'),
         max(g.occurred_at)
  from public.ghl_events g
  where public.tc_is_member()
    and g.event_type in ('OutboundMessage','InboundMessage')
    and g.contact_id in (select ghl_contact_id from public.tc_deals where status in ('active','closed'))
  group by g.contact_id;
$$;
revoke all on function public.tc_contact_activity() from public, anon;
grant execute on function public.tc_contact_activity() to authenticated;


-- ---------- one row per open/closed item with due date and days open (used by the agent) ----------
create or replace view public.tc_item_status with (security_invoker = true) as
select i.id as item_id, d.id as deal_id, d.name as deal, d.ghl_stage as deal_stage, s.stage as step_stage, s.sort,
       s.id as step_id, s.title, s.who, s.agent_can_check, s.ghl_field, s.optional, s.critical,
       i.status, i.done_at, i.done_by, i.evidence, i.agent_note, i.waiting_on, i.last_checked_at,
       (d.stage_dates->>s.stage)::date as stage_entered,
       case s.due_anchor
         when 'stage'    then (d.stage_dates->>s.stage)::date + s.due_offset
         when 'contract' then d.contract_date + s.due_offset
         when 'emd'      then coalesce(d.emd_deadline, d.contract_date + 5) + s.due_offset
         when 'close'    then coalesce(d.close_date, p.closing_date) + s.due_offset
         when 'dd_end'   then coalesce(d.dd_end, coalesce(d.close_date, p.closing_date) - 21) + s.due_offset
       end as due_date,
       ((now() at time zone 'America/Chicago')::date - (d.stage_dates->>s.stage)::date) as days_open
from public.tc_items i
join public.tc_deals d on d.id = i.deal_id
join public.tc_steps s on s.id = i.step_id
left join public.properties p on p.id = d.property_id;

-- ---------- row level security ----------
alter table public.tc_members   enable row level security;
alter table public.tc_settings  enable row level security;
alter table public.tc_stage_map enable row level security;
alter table public.tc_steps     enable row level security;
alter table public.tc_deals     enable row level security;
alter table public.tc_items     enable row level security;
alter table public.tc_actions   enable row level security;
alter table public.tc_events    enable row level security;

drop policy if exists "tc members read" on public.tc_members;
create policy "tc members read" on public.tc_members for select to authenticated using (public.tc_is_member());
do $$ declare t text; begin
  foreach t in array array['tc_settings','tc_stage_map','tc_steps','tc_deals','tc_items','tc_actions','tc_events'] loop
    execute format('drop policy if exists "tc members only" on public.%I', t);
    execute format('create policy "tc members only" on public.%I for all to authenticated using (public.tc_is_member()) with check (public.tc_is_member())', t);
  end loop;
end $$;

insert into public.tc_members (email) values ('jay@utopiancapitalinvest.com'), ('jayrav70@gmail.com')
on conflict do nothing;

do $$ begin
  begin alter publication supabase_realtime add table public.tc_deals;   exception when others then null; end;
  begin alter publication supabase_realtime add table public.tc_items;   exception when others then null; end;
  begin alter publication supabase_realtime add table public.tc_actions; exception when others then null; end;
  begin alter publication supabase_realtime add table public.tc_events;  exception when others then null; end;
end $$;

-- ---------- lock down internal functions (only triggers and the service role call these) ----------
revoke execute on function public.tc_upsert_from_event(public.ghl_events) from public, anon, authenticated;
revoke execute on function public.tc_on_ghl_event() from public, anon, authenticated;
revoke execute on function public.tc_on_property() from public, anon, authenticated;
revoke execute on function public.tc_seed_items() from public, anon, authenticated;
revoke execute on function public.tc_is_member() from public, anon;
grant execute on function public.tc_is_member() to authenticated;
