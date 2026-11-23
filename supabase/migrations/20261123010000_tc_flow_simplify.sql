-- TC Flow v2: fewer steps, title timeline, seller contact log.

-- title timeline + title issue note on the deal
alter table public.tc_deals add column if not exists title_issue text;          -- what needs to happen to keep title moving (blank = none)
alter table public.tc_deals add column if not exists title_issue_stage text;    -- title_opened | emd_sent | title_commitment | signing_scheduled
alter table public.tc_deals add column if not exists title_issue_since date;

-- the real date something happened (title opened Nov 13), separate from when it was ticked
alter table public.tc_items add column if not exists event_date date;

-- seller contact log (agent or people add one row per call, text or email)
create table if not exists public.tc_contacts (
  id bigint generated always as identity primary key,
  deal_id uuid not null references public.tc_deals(id) on delete cascade,
  at timestamptz not null,
  channel text,            -- call | sms | email | voicemail
  direction text,          -- out | in
  summary text,
  source text,             -- 'GHL' | 'Gmail' | 'manual'
  logged_by text,          -- 'agent' or an email
  created_at timestamptz not null default now()
);
create index if not exists tc_contacts_deal_at on public.tc_contacts(deal_id, at desc);
create unique index if not exists tc_contacts_dedupe on public.tc_contacts(deal_id, at, coalesce(channel,''));
alter table public.tc_contacts enable row level security;
drop policy if exists "tc members only" on public.tc_contacts;
create policy "tc members only" on public.tc_contacts for all to authenticated using (public.tc_is_member()) with check (public.tc_is_member());
do $$ begin begin alter publication supabase_realtime add table public.tc_contacts; exception when others then null; end; end $$;

-- target: one seller contact every 10 days on average
insert into public.tc_settings (id, doc) values ('seller_contact', '{"targetDays":10}')
on conflict (id) do update set doc = excluded.doc;

-- ---------- slimmer checklist ----------
update public.tc_steps set active = false where id in (
  'deadline_tasks','funding_source','title_company','seller_docs_requested',
  'contractor_quotes','jurisdiction','electric','sewer','water','seller_docs_received','dd_decision',
  'funder_approved','buyer_contract','new_perc','title_cleared','settlement_reviewed',
  'funds_disbursed','seller_thanks');

insert into public.tc_steps (id, stage, sort, title, detail, who, agent_can_check, ghl_field, due_anchor, due_offset, optional, critical) values
('utilities','dd2',40,'Utilities checked (power, water, sewer or septic)','Electricity provider and extension needs, water source, sewer or septic.','agent',true,
 'Due Diligence Phase II: Electricity Provider and Extension Requirements, Water, Sewer Status','stage',7,false,false)
on conflict (id) do update set stage=excluded.stage, sort=excluded.sort, title=excluded.title, detail=excluded.detail, ghl_field=excluded.ghl_field, active=true;

update public.tc_steps set title='Signed purchase agreement in GHL', sort=10 where id='contract_uploaded';
update public.tc_steps set title='Price, EMD deadline and closing deadline entered', detail='Purchase Price field, plus the EMD Deadline and Closing Deadline fields or tasks.', sort=20 where id='key_fields';
update public.tc_steps set title='Property ID set and property in the CRM', sort=30 where id='property_id';
update public.tc_steps set title='Seller told the next steps', sort=40 where id='seller_welcome';
update public.tc_steps set title='Title opened', detail='Contract sent to the title company or closing attorney and the order confirmed.', sort=10 where id='title_opened';
update public.tc_steps set title='EMD submitted', detail='EMD sent before the EMD deadline.', sort=20 where id='emd_sent';
update public.tc_steps set title='EMD receipt confirmed by title', sort=30 where id='emd_received';
update public.tc_steps set title='Title commitment received', detail='Commitment and search uploaded to GHL.', sort=10 where id='title_commitment';
update public.tc_steps set title='Deed and survey on file', sort=20 where id='deed_survey';
update public.tc_steps set title='Zoning and deed restrictions checked', sort=30 where id='zoning';
update public.tc_steps set title='Title issues noted with a fix', detail='Liens, heirs, back taxes and how each gets cleared.', sort=50 where id='defects_cures';
update public.tc_steps set title='Funding confirmed for closing', detail='Funding amount and date confirmed with whoever is funding the deal.', sort=10 where id='funds_scheduled';
update public.tc_steps set title='New survey or perc test (if needed)', detail='Only when the deal needs one.', ghl_field='Due Diligence Phase III: New Survey, New Perc Test', sort=10 where id='new_survey';
update public.tc_steps set title='Clear to close from title', sort=20 where id='clear_to_close';
update public.tc_steps set title='Closing scheduled', detail='Closing date set with title and signing arranged for every party.', sort=30 where id='signing_scheduled';
update public.tc_steps set title='Wire instructions verified by phone', sort=40 where id='wire_verified';
update public.tc_steps set title='Funds wired and received by title', sort=50 where id='funds_sent';
update public.tc_steps set title='Final settlement statement saved', sort=10 where id='final_settlement';
update public.tc_steps set title='Recorded deed saved', sort=20 where id='recorded_deed';
update public.tc_steps set title='Owner''s title policy saved', sort=30 where id='title_policy';
update public.tc_steps set title='CRM and accounting updated', sort=40 where id='crm_updated';

-- add the new step to existing deals
insert into public.tc_items (deal_id, step_id)
select d.id, 'utilities' from public.tc_deals d on conflict (deal_id, step_id) do nothing;

-- new deals only get active steps (already true in tc_seed_items); view shows only active steps
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
       ((now() at time zone 'America/Chicago')::date - (d.stage_dates->>s.stage)::date) as days_open,
       i.event_date
from public.tc_items i
join public.tc_deals d on d.id = i.deal_id
join public.tc_steps s on s.id = i.step_id and s.active
left join public.properties p on p.id = d.property_id;

-- days with a GHL message to or from the seller since the contract (members only)
create or replace function public.tc_contact_days()
returns table (deal_id uuid, day date, n_out int, n_in int)
language sql stable security definer set search_path = public as $$
  select d.id,
         (g.occurred_at at time zone 'America/Chicago')::date,
         count(*) filter (where g.event_type = 'OutboundMessage')::int,
         count(*) filter (where g.event_type = 'InboundMessage')::int
  from public.tc_deals d
  join public.ghl_events g on g.contact_id = d.ghl_contact_id
  where public.tc_is_member()
    and d.status in ('active','closed')
    and g.event_type in ('OutboundMessage','InboundMessage')
    and g.occurred_at >= coalesce(d.contract_date, now() - interval '120 days')
  group by 1, 2;
$$;
revoke all on function public.tc_contact_days() from public, anon;
grant execute on function public.tc_contact_days() to authenticated;
