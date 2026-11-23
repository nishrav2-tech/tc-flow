# TC Flow dashboard

Transaction coordination for Utopian Capital: every land deal from **New Contract** to **Deal Closed**, on one page. Same setup as Subdivide Finder and Hiring Flow: hosted on GitHub Pages, data in the Utopian CRM Supabase project (`yahosblylysopbxgztvg`).

- **Pipeline board:** one column per stage of the GHL "Contract --> Close" pipeline, named as in GHL. Each card shows the closing date, days since the seller was last contacted, a 4-part title bar and any title issue. The dot is red (needs attention), yellow (watch) or green (on track).
- **Needs attention:** one line per deal that is not on track.
- **Deal view:** click a card for the summary (stage, contract date, EMD deadline, closing date, price, title company), the title timeline (title opened, EMD submitted, title commitment received, closing scheduled) with the agent's note on anything blocking title, seller contact against the 10-day target, and the checklist for the current GHL stage only.

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
