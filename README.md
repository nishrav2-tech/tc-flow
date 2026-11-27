# TC Flow dashboard

Transaction coordination for Utopian Capital: every land deal from **New Contract** to **Deal Closed**, on one page. Same setup as Subdivide Finder and Hiring Flow: hosted on GitHub Pages, data in the Utopian CRM Supabase project (`yahosblylysopbxgztvg`).

- **Pipeline board:** one column per stage of the GHL "Contract --> Close" pipeline, named as in GHL. Each card shows the closing date, the 4-part title bar, and one line each for Title, Seller and DD & Broker, each with a red, yellow or green dot.
- **Deal view:** click a card for three panels, in order of priority:
  1. **Title:** where it stands, who it is waiting on, when title last replied, the title timeline and anything blocking it.
  2. **Seller contact:** last contact and what was discussed, anything owed either way, days since contact against the 10-day target, recent calls and texts.
  3. **Due diligence and broker:** what DD has found and still needs, and every broker we asked with their pricing opinion, who we picked and whether the listing agreement is signed (`tc_brokers`).
  The GHL stage checklist and activity log are folded underneath.
- **Needs attention:** one line per deal that is not on track.

## How deals get in

Nothing to do by hand. When a GHL opportunity enters the Contract --> Close pipeline, the GHL webhook writes to `ghl_events`, and a database trigger creates the TC deal and its checklist within about 10 minutes. Stage moves in GHL move the card. When the property is added to the CRM (Properties tab or the Daily KPI fetcher), it links to the deal automatically.

## The agent

The scheduled task **TC Flow: daily deal check** runs weekdays at 7:17 AM Central. It reads the GHL board and each contact (Due Diligence Phase II and III fields, Closing & Marketing files, tasks, conversations) and Jay's Gmail, ticks steps it can prove, writes what is missing, adds action items, drafts follow-ups (never sends), and pushes Jay a short summary. Its instructions are in `AGENT_PLAYBOOK.md`. It never edits GHL, never sends email, and never ticks wire verification, settlement review, funding source or the due diligence decision.

## Files

| File | What it does |
|---|---|
| `docs/index.html`, `docs/app.js` | The dashboard |
| `docs/config.js` | Supabase URL and public key (safe to publish; only emails in `tc_members` can see data) |
| `supabase/migrations/20261123000000_tc_flow.sql` | The `tc_` tables, checklist template, GHL trigger and security. Already applied |
| `AGENT_PLAYBOOK.md` | The daily agent's instructions |

## Publish

1. On github.com (account `nishrav2-tech`): **New repository**, name `tc-flow`, Public, leave every "Add ..." box unchecked, **Create repository**.
2. Save `tc-flow.bundle` to Downloads and run in Terminal:
   ```bash
   cd ~/Downloads && rm -rf tc-flow && git clone tc-flow.bundle tc-flow && cd tc-flow && git remote set-url origin https://github.com/nishrav2-tech/tc-flow.git && git push -u origin main
   ```
3. In the repo: **Settings, Pages**, Source **Deploy from a branch**, Branch **main**, folder **/docs**, **Save**. Live in about a minute at **https://nishrav2-tech.github.io/tc-flow/**

## CRM button

`crm-tc-flow-button.patch` adds a **TC Flow** button to the CRM's Properties page:
```bash
cd /tmp && rm -rf tcf && git clone https://github.com/nishrav2-tech/task_managerv1.2.git tcf && cd tcf && git am ~/Downloads/crm-tc-flow-button.patch && git push
```

## Access

Only emails in `tc_members` can see anything. Jay's two emails are added. To add Pramod or anyone else, run in the Supabase SQL editor:

```sql
insert into tc_members (email) values ('pramod@utopiancapitalinvest.com');
```

## Changing the checklist

Steps live in `tc_steps` (stage, title, who, due rule, GHL field). Edit a row to change it for every deal; set `active = false` to hide a step. New steps reach existing deals only if you also insert `tc_items` rows for them.
