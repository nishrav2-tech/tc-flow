/* TC Flow dashboard. Reads the tc_ tables in Supabase (plus CRM properties for county, acres and close date).
   It is a viewing tool: the TC agent does the work each morning and ticks what it can prove.
   People can also tick boxes, mark optional steps N/A, and leave notes. */
(function () {
  const CFG = window.TC_CONFIG || {};
  const TZ = CFG.TIMEZONE || "America/Chicago";
  const LOC = CFG.GHL_LOCATION || "wYwhCQq7nLroxnCnZq2N";
  const DEMO = new URLSearchParams(location.search).has("demo");
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

  const STAGES = [
    ["new_contract", "New Contract"], ["title_emd", "Title & EMD Confirmed"], ["dd2", "DD Phase II"],
    ["funding", "Funding Confirmed"], ["dd3", "DD Phase III"], ["closed", "Deal Closed"],
  ];
  const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
  const STAGE_LABEL = Object.fromEntries(STAGES);
  const WHO = { agent: "Agent", team: "Team", jay: "Jay" };

  let sb = null, user = null;
  const S = { deals: [], items: [], steps: [], actions: [], events: [], props: {}, contact: {}, open: null };

  // ---------- dates ----------
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const toDay = (d) => (d ? String(d).slice(0, 10) : null);
  const tsDay = (ts) => (ts ? new Date(ts).toLocaleDateString("en-CA", { timeZone: TZ }) : null);
  const diff = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5); // b - a
  const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const fmt = (d) => { if (!d) return ""; const x = new Date(String(d).length === 10 ? d + "T12:00:00Z" : d); return isNaN(x) ? esc(d) : x.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }); };
  const fmtTime = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
  const money = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
  const plural = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? "" : "s"}`;
  const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 2600); };

  // ---------- derived values ----------
  const prop = (d) => S.props[d.property_id] || {};
  const closeDate = (d) => toDay(d.close_date) || toDay(prop(d).closing_date);
  const stepById = (id) => S.steps.find((s) => s.id === id) || {};
  const dealItems = (d) => S.items.filter((i) => i.deal_id === d.id).map((i) => Object.assign({}, i, { step: stepById(i.step_id) })).filter((i) => i.step.id && i.step.active !== false)
    .sort((a, b) => STAGE_IDX[a.step.stage] - STAGE_IDX[b.step.stage] || a.step.sort - b.step.sort);
  const stageDate = (d, k) => toDay((d.stage_dates || {})[k]);
  const reached = (d, k) => STAGE_IDX[k] <= (STAGE_IDX[d.ghl_stage] ?? 0);
  function dueDate(d, st) {
    const off = st.due_offset || 0, cd = closeDate(d);
    switch (st.due_anchor) {
      case "stage": return stageDate(d, st.stage) ? addDays(stageDate(d, st.stage), off) : null;
      case "contract": return d.contract_date ? addDays(toDay(d.contract_date), off) : null;
      case "emd": { const e = toDay(d.emd_deadline) || (d.contract_date ? addDays(toDay(d.contract_date), 5) : null); return e ? addDays(e, off) : null; }
      case "close": return cd ? addDays(cd, off) : null;
      case "dd_end": { const e = toDay(d.dd_end) || (cd ? addDays(cd, -21) : null); return e ? addDays(e, off) : null; }
      default: return null;
    }
  }
  // how long an open item has been waiting: since its stage started (or since contract for earlier stages)
  const openSince = (d, it) => stageDate(d, it.step.stage) || (reached(d, it.step.stage) ? toDay(d.contract_date) : null);
  const isOpen = (it) => it.status === "open" || it.status === "waiting";
  function lastSellerContact(d) {
    const a = S.contact[d.ghl_contact_id], vals = [d.last_seller_contact, a && a.last_out].filter(Boolean).sort();
    return vals.length ? tsDay(vals[vals.length - 1]) : null;
  }
  function health(d) {
    if (d.status !== "active") return { c: "grey", why: [] };
    const t = today(), why = [], warn = [];
    for (const it of dealItems(d)) {
      if (!isOpen(it) || !reached(d, it.step.stage)) continue;
      const due = dueDate(d, it.step);
      if (due && due < t) (it.step.critical ? why : warn).push(`${it.step.title} overdue ${plural(diff(due, t), "day")}`);
      else if (due && diff(t, due) <= 2) warn.push(`${it.step.title} due ${fmt(due)}`);
    }
    const cd = closeDate(d);
    if (cd) {
      const left = diff(t, cd);
      const ctc = dealItems(d).find((i) => i.step_id === "clear_to_close");
      if (left < 0) why.push(`Closing date passed ${plural(-left, "day")} ago`);
      else if (left <= 5 && ctc && isOpen(ctc)) why.push(`Closes in ${plural(left, "day")}, not clear to close`);
    }
    const lc = lastSellerContact(d);
    if (lc) { const q = diff(lc, t); if (q >= 7) why.push(`No seller contact in ${q} days`); else if (q >= 5) warn.push(`Seller last contacted ${q} days ago`); }
    if (!d.agent_checked_at || diff(tsDay(d.agent_checked_at), t) >= 2) warn.push("Agent has not checked this deal in 2+ days");
    return { c: why.length ? "red" : warn.length ? "yellow" : "green", why: why.concat(warn) };
  }
  function progress(d) {
    const its = dealItems(d).filter((i) => reached(d, i.step.stage) && i.status !== "na" && !(i.step.optional && isOpen(i)));
    const done = its.filter((i) => i.status === "done").length;
    return { done, total: its.length, pct: its.length ? Math.round((100 * done) / its.length) : 0 };
  }
  // open action items across deals: open steps in stages the deal has reached, plus agent-found actions
  function actionList(onlyDeal) {
    const t = today(), out = [];
    for (const d of S.deals.filter((x) => x.status === "active" && (!onlyDeal || x.id === onlyDeal.id))) {
      for (const it of dealItems(d)) {
        if (!isOpen(it) || !reached(d, it.step.stage) || it.step.optional) continue;
        const due = dueDate(d, it.step), since = openSince(d, it);
        const overdue = due && due < t ? diff(due, t) : 0;
        if (!overdue && !(due && diff(t, due) <= 3) && !(since && diff(since, t) >= 3)) continue; // keep the list to what matters
        out.push({ d, title: it.step.title, note: it.agent_note, who: it.waiting_on ? "Waiting on " + it.waiting_on : "Owner: " + (WHO[it.step.who] || it.step.who), since, due, overdue, critical: it.step.critical, kind: "step", itemId: it.id });
      }
      for (const a of S.actions.filter((x) => x.deal_id === d.id && x.status === "open")) {
        const due = toDay(a.due_date), overdue = due && due < t ? diff(due, t) : 0;
        out.push({ d, title: a.title, note: a.detail, who: a.owner ? "Waiting on " + a.owner : "", since: toDay(a.since), due, overdue, critical: true, kind: "action", url: a.source_url, source: a.source });
      }
    }
    return out.sort((a, b) => (b.overdue - a.overdue) || (b.critical - a.critical) || ((a.since || "9") < (b.since || "9") ? -1 : 1));
  }

  // ---------- data ----------
  async function loadAll() {
    if (DEMO) {
      const j = await (await fetch("demo-data.json")).json();
      Object.assign(S, { deals: j.deals, items: j.items, steps: j.steps, actions: j.actions, events: j.events });
      S.props = Object.fromEntries((j.properties || []).map((p) => [p.id, p]));
      S.contact = Object.fromEntries((j.contact || []).map((c) => [c.contact_id, c]));
    } else {
      const [d, i, s, a, e] = await Promise.all([
        sb.from("tc_deals").select("*"), sb.from("tc_items").select("*"), sb.from("tc_steps").select("*"),
        sb.from("tc_actions").select("*"), sb.from("tc_events").select("*").order("at", { ascending: false }).limit(400),
      ]);
      for (const x of [d, i, s, a, e]) if (x.error) throw x.error;
      Object.assign(S, { deals: d.data, items: i.data, steps: s.data, actions: a.data, events: e.data });
      const ids = S.deals.map((x) => x.property_id).filter(Boolean);
      if (ids.length) {
        const p = await sb.from("properties").select("id,property_id,county,state,acres,buy_price,sell_price,closing_date,status,ghl_url,double_close").in("id", ids);
        if (!p.error) S.props = Object.fromEntries(p.data.map((x) => [x.id, x]));
      }
      const c = await sb.rpc("tc_contact_activity");
      if (!c.error) S.contact = Object.fromEntries((c.data || []).map((x) => [x.contact_id, x]));
    }
    render();
    const m = location.hash.match(/^#\/deal\/([\w-]+)/);
    if (m) openDeal(m[1]);
  }

  // ---------- render ----------
  function render() {
    const t = today(), active = S.deals.filter((d) => d.status === "active");
    const acts = actionList();
    const closingSoon = active.filter((d) => closeDate(d) && diff(t, closeDate(d)) <= 14).sort((a, b) => (closeDate(a) < closeDate(b) ? -1 : 1));
    const overdue = acts.filter((a) => a.overdue > 0).length;
    const quiet = active.filter((d) => { const l = lastSellerContact(d); return l && diff(l, t) >= 7; }).length;
    const reds = active.filter((d) => health(d).c === "red").length;
    const ages = active.filter((d) => d.contract_date).map((d) => diff(toDay(d.contract_date), t));
    const avg = ages.length ? Math.round(ages.reduce((x, y) => x + y, 0) / ages.length) : 0;
    $("#kpis").innerHTML = [
      ["Active deals", active.length, `${reds} need attention`, reds > 0],
      ["Overdue items", overdue, "past their due date", overdue > 0],
      ["Action items", acts.length, "open across all deals", false],
      ["Closing in 14 days", closingSoon.length, closingSoon[0] ? `next: ${fmt(closeDate(closingSoon[0]))}` : "none scheduled", false],
      ["Sellers quiet 7+ days", quiet, "no GHL message out", quiet > 0],
      ["Avg days under contract", avg, "active deals", false],
    ].map(([l, v, h, attn]) => `<div class="card kpi${attn ? " attn" : ""}"><div class="label">${l}</div><div class="val">${v}</div><div class="hint">${esc(h)}</div></div>`).join("");

    $("#actCount").textContent = acts.length ? `· ${acts.length} open` : "";
    const groups = [];
    for (const x of acts) { let g = groups.find((y) => y.d.id === x.d.id); if (!g) groups.push(g = { d: x.d, rows: [] }); g.rows.push(x); }
    $("#actions").innerHTML = groups.length ? groups.map((g) => {
      const h = health(g.d), over = g.rows.filter((r) => r.overdue).length;
      return `<div class="card dealacts"><h3 data-deal="${g.d.id}"><i class="dot ${h.c}"></i>${esc(g.d.name)}<span class="sub" style="font:400 12.5px var(--sans)">${esc(STAGE_LABEL[g.d.ghl_stage])} · ${g.rows.length} open${over ? `, <span class="over">${over} overdue</span>` : ""}</span></h3>
        <div class="list">${g.rows.slice(0, 4).map(actionRow).join("")}</div>
        ${g.rows.length > 4 ? `<span class="more" data-deal="${g.d.id}">+ ${g.rows.length - 4} more on the checklist</span>` : ""}</div>`;
    }).join("") : `<div class="card empty">Nothing waiting. Every reached step is done or not due yet.</div>`;
    $("#closing").innerHTML = closingSoon.length ? closingSoon.map((d) => {
      const left = diff(t, closeDate(d)), h = health(d);
      return `<div class="item click" data-deal="${d.id}"><i class="dot ${h.c}" style="margin-top:5px"></i><div class="who"><b>${esc(d.name)}</b><div class="meta">${esc(STAGE_LABEL[d.ghl_stage])} · ${progress(d).pct}% done</div></div>
        <div class="right"><div class="days ${left < 0 ? "bad" : left <= 5 ? "warn" : ""}">${left < 0 ? -left : left}<small>${left < 0 ? "days late" : "days left"}</small></div></div></div>`;
    }).join("") : `<div class="empty">No closings in the next 14 days.</div>`;

    const runs = S.events.filter((e) => e.kind === "run");
    $("#agentInfo").innerHTML = runs[0] ? `Last run ${fmtTime(runs[0].at)}: ${esc(runs[0].text)}` : "The agent has not run yet. It runs every weekday morning.";
    $("#ghlBtn").href = `https://app.gohighlevel.com/v2/location/${LOC}/opportunities`;

    const show = $("#fStatus").value;
    const list = S.deals.filter((d) => d.status === show);
    $("#board").innerHTML = STAGES.map(([k, label]) => {
      const ds = list.filter((d) => d.ghl_stage === k).sort((a, b) => (closeDate(a) || "9") < (closeDate(b) || "9") ? -1 : 1);
      return `<div class="col"><h3>${label}<span>${ds.length}</span></h3>${ds.map(cardHtml).join("") || `<div class="empty" style="padding:6px 4px;font-size:12.5px">None</div>`}</div>`;
    }).join("");
  }

  function actionRow(a) {
    const t = today(), open = a.since ? diff(a.since, t) : null;
    const dueTxt = a.due ? (a.overdue ? `<span class="over">${plural(a.overdue, "day")} overdue</span>` : `due ${fmt(a.due)}`) : "no due date";
    return `<div class="item click" data-deal="${a.d.id}">
      <div class="who"><b>${esc(a.title)}</b><div class="meta">${esc(a.who || "")}</div>
      ${a.note ? `<div class="meta" style="color:var(--ink-2)">${esc(a.note)}</div>` : ""}<div class="meta">${dueTxt}${a.source ? ` · ${esc(a.source)}` : ""}</div></div>
      <div class="right"><div class="days ${a.overdue ? "bad" : open >= 7 ? "warn" : ""}">${open == null ? "–" : open}<small>days open</small></div></div></div>`;
  }

  function cardHtml(d) {
    const p = prop(d), h = health(d), pr = progress(d), t = today(), cd = closeDate(d);
    const next = actionList(d)[0];
    const lc = lastSellerContact(d);
    const inStage = stageDate(d, d.ghl_stage) ? diff(stageDate(d, d.ghl_stage), t) : null;
    return `<a class="dcard" href="#/deal/${d.id}" title="${esc(h.why.join("\n"))}">
      <div class="t"><i class="dot ${h.c}"></i><span>${esc(d.name || d.seller_name)}</span></div>
      <div class="s">${esc([p.county && p.county + " Co", p.state, p.acres && p.acres + " ac"].filter(Boolean).join(", ") || (d.property_id ? "" : "Not in CRM yet"))}</div>
      <div class="line">${cd ? `Close <b>${fmt(cd)}</b> (${diff(t, cd) < 0 ? `<span class="over">${-diff(t, cd)}d late</span>` : diff(t, cd) + "d"})` : "No close date"}${inStage != null ? ` · ${inStage}d in stage` : ""}</div>
      ${next ? `<div class="line">Next: ${esc(next.title)}${next.overdue ? ` <span class="over">(${next.overdue}d over)</span>` : ""}</div>` : ""}
      <div class="line" style="color:var(--ink-3)">Seller contact: ${lc ? `${diff(lc, t)}d ago` : "none logged"}</div>
      <div class="prog"><i style="width:${pr.pct}%"></i></div><div class="s" style="margin-top:3px">${pr.done} of ${pr.total} steps done</div></a>`;
  }

  // ---------- deal drawer ----------
  function openDeal(id) {
    const d = S.deals.find((x) => x.id === id); if (!d) return;
    S.open = id;
    const p = prop(d), t = today(), h = health(d), cd = closeDate(d), its = dealItems(d);
    const ghl = d.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${d.ghl_contact_id}` : "";
    const facts = [
      ["Stage", STAGE_LABEL[d.ghl_stage] + (stageDate(d, d.ghl_stage) ? ` (${diff(stageDate(d, d.ghl_stage), t)}d)` : "")],
      ["Contract date", fmt(d.contract_date)], ["EMD deadline", fmt(d.emd_deadline)], ["Closing date", fmt(cd)],
      ["Purchase price", money(d.purchase_price || p.buy_price)], ["Funding", d.funding_source], ["Title entity", d.vesting_entity],
      ["Title / attorney", d.closing_agent], ["Structure", d.structure || (p.double_close ? "Double close" : "")],
      ["Property ID", p.property_id], ["Seller", d.seller_name], ["Seller contact", lastSellerContact(d) ? `${diff(lastSellerContact(d), t)} days ago` : "none logged"],
    ].filter((f) => f[1]);
    const byStage = STAGES.map(([k, label]) => {
      const rows = its.filter((i) => i.step.stage === k); if (!rows.length) return "";
      const sd = stageDate(d, k), fut = !reached(d, k);
      return `<div class="stagehead${fut ? " future" : ""}">${label}<span>${fut ? "not reached" : sd ? `entered ${fmt(sd)} · ${diff(sd, t)} days` : "reached"}</span></div>` + rows.map((it) => itemRow(d, it, fut)).join("");
    }).join("");
    const acts = S.actions.filter((a) => a.deal_id === d.id && a.status === "open");
    const evs = S.events.filter((e) => e.deal_id === d.id).slice(0, 30);
    $("#drawer").innerHTML = `
      <button class="btn sm x" id="closeDrawer">Close</button>
      <h3><i class="dot ${h.c}" style="margin-right:8px;vertical-align:middle"></i>${esc(d.name || d.seller_name)}</h3>
      <p class="sub">${esc([p.county && p.county + " County", p.state, p.acres && p.acres + " acres"].filter(Boolean).join(", "))}
        ${ghl ? ` · <a href="${ghl}" target="_blank" rel="noopener">Open in GHL</a>` : ""}${d.status !== "active" ? ` · <span class="pill p-mute">${esc(d.status)}</span>` : ""}</p>
      ${h.why.length ? `<div class="banner" style="background:${h.c === "red" ? "var(--danger-soft)" : "var(--gold-soft)"};color:${h.c === "red" ? "var(--danger)" : "var(--gold-ink)"};border-radius:var(--r-md);padding:9px 12px;margin-top:10px;font-size:13px">${h.why.map(esc).join("<br>")}</div>` : ""}
      ${d.agent_summary ? `<div class="summary"><b>Agent:</b> ${esc(d.agent_summary)}${d.agent_checked_at ? ` <span style="opacity:.75">(${fmtTime(d.agent_checked_at)})</span>` : ""}</div>` : ""}
      <div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
      ${acts.length ? `<section><h2>Open action items</h2><div class="list">${acts.map((a) => `<div class="item"><div class="who"><b>${esc(a.title)}</b><div class="meta">${esc(a.detail || "")}</div><div class="meta">${a.owner ? "Waiting on " + esc(a.owner) + " · " : ""}since ${fmt(a.since)}${a.due_date ? " · due " + fmt(a.due_date) : ""}${safeUrl(a.source_url) ? ` · <a href="${esc(safeUrl(a.source_url))}" target="_blank" rel="noopener">${esc(a.source || "source")}</a>` : ""}</div></div><div class="right"><div class="days">${diff(toDay(a.since), t)}<small>days open</small></div></div></div>`).join("")}</div></section>` : ""}
      <section><h2>Checklist</h2><div id="ckList">${byStage}</div></section>
      ${d.notes ? `<section><h2>Notes</h2><p style="white-space:pre-wrap;margin:0">${esc(d.notes)}</p></section>` : ""}
      <section class="log"><h2>Activity</h2><div class="list">${evs.map((e) => `<div class="item"><time>${fmtTime(e.at)}</time><div class="who">${esc(e.text)}${safeUrl(e.url) ? ` <a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">link</a>` : ""}<div class="meta">${esc(e.actor || "")}</div></div></div>`).join("") || `<div class="empty">No activity yet.</div>`}</div></section>`;
    $("#scrim").classList.remove("hidden"); $("#drawer").classList.remove("hidden");
    $("#closeDrawer").onclick = closeDrawer;
    $("#ckList").onchange = (ev) => { const cb = ev.target.closest("input[data-item]"); if (cb) toggleItem(cb); };
    $("#ckList").onclick = (ev) => { const b = ev.target.closest("button[data-na]"); if (b) setNa(b); };
    if (location.hash !== `#/deal/${id}`) history.replaceState(null, "", `#/deal/${id}`);
  }
  function itemRow(d, it, fut) {
    const t = today(), due = dueDate(d, it.step), since = openSince(d, it);
    let st = "";
    if (it.status === "done") st = `<span class="pill ${it.done_by === "agent" ? "p-agent" : "p-ok"}">${it.done_by === "agent" ? "Agent" : "Done"} ${fmt(it.done_at)}</span>`;
    else if (it.status === "na") st = `<span class="pill p-mute">N/A</span>`;
    else if (!fut) {
      const over = due && due < t ? diff(due, t) : 0;
      st = `${since ? `<div>open ${plural(diff(since, t), "day")}</div>` : ""}${due ? `<div class="${over ? "over" : diff(t, due) <= 2 ? "soon" : ""}">${over ? `${over}d overdue` : `due ${fmt(due)}`}</div>` : ""}`;
    } else if (due) st = `<div style="color:var(--ink-3)">due ${fmt(due)}</div>`;
    const lock = it.step.id === "wire_verified" ? " (a person must tick this)" : "";
    return `<div class="ck${it.status === "done" ? " done" : ""}${fut ? " future" : ""}">
      <input type="checkbox" data-item="${it.id}" ${it.status === "done" ? "checked" : ""} ${it.status === "na" ? "disabled" : ""} aria-label="${esc(it.step.title)}">
      <div class="body"><div class="ti">${esc(it.step.title)}<span class="chip">${esc(WHO[it.step.who] || it.step.who)}</span>${it.step.critical ? `<span class="chip" style="background:var(--danger-soft);color:var(--danger)">key</span>` : ""}${it.step.optional ? `<span class="chip">if needed</span>` : ""}</div>
        <div class="sub2">${esc(it.step.detail || "")}${it.step.ghl_field ? ` · <i>${esc(it.step.ghl_field)}</i>` : ""}${esc(lock)}</div>
        ${it.agent_note && it.status !== "done" ? `<div class="note">${it.waiting_on ? `<b>Waiting on ${esc(it.waiting_on)}:</b> ` : ""}${esc(it.agent_note)}</div>` : ""}
        ${it.status === "done" && (it.evidence || it.evidence_url) ? `<div class="note">${esc(it.evidence || "")} ${safeUrl(it.evidence_url) ? `<a href="${esc(safeUrl(it.evidence_url))}" target="_blank" rel="noopener">proof</a>` : ""}</div>` : ""}
        ${it.step.optional && it.status !== "done" ? `<button class="btn sm" data-na="${it.id}" style="margin-top:4px">${it.status === "na" ? "Needed after all" : "Not needed"}</button>` : ""}
      </div><div class="st">${st}</div></div>`;
  }

  async function saveItem(it, patch, text) {
    const who = user ? user.email : "demo";
    if (DEMO) { Object.assign(it, patch); render(); openDeal(S.open); toast("Saved (demo, not stored)"); return; }
    const { error } = await sb.from("tc_items").update(patch).eq("id", it.id);
    if (error) { toast("Could not save: " + error.message); return; }
    await sb.from("tc_events").insert({ deal_id: it.deal_id, actor: who, kind: patch.status === "done" ? "check" : "uncheck", text });
    Object.assign(it, patch); render(); openDeal(S.open); toast("Saved");
  }
  function toggleItem(cb) {
    const it = S.items.find((i) => String(i.id) === cb.dataset.item); if (!it) return;
    const st = stepById(it.step_id);
    if (cb.checked) {
      saveItem(it, { status: "done", done_at: new Date().toISOString(), done_by: user ? user.email : "demo", last_checked_at: new Date().toISOString() }, `Checked: ${st.title}`);
    } else {
      if (it.done_by === "agent" && !confirm("The agent ticked this with proof. Untick it anyway?")) { cb.checked = true; return; }
      saveItem(it, { status: "open", done_at: null, done_by: null, evidence: null, evidence_url: null }, `Unchecked: ${st.title}`);
    }
  }
  function setNa(b) {
    const it = S.items.find((i) => String(i.id) === b.dataset.na); if (!it) return;
    const st = stepById(it.step_id);
    saveItem(it, { status: it.status === "na" ? "open" : "na" }, `${it.status === "na" ? "Needed" : "Not needed"}: ${st.title}`);
  }
  function closeDrawer() { S.open = null; $("#scrim").classList.add("hidden"); $("#drawer").classList.add("hidden"); history.replaceState(null, "", "#/"); }

  // ---------- events + auth ----------
  function bind() {
    document.addEventListener("click", (ev) => { const r = ev.target.closest("[data-deal]"); if (r) openDeal(r.dataset.deal); });
    $("#scrim").onclick = closeDrawer;
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    window.addEventListener("hashchange", () => { const m = location.hash.match(/^#\/deal\/([\w-]+)/); if (m) openDeal(m[1]); else if (S.open) closeDrawer(); });
    $("#fStatus").onchange = render;
    $("#signOut").onclick = async () => { if (sb) await sb.auth.signOut(); location.reload(); };
  }
  async function start() {
    bind();
    if (DEMO) { $("#app").classList.remove("hidden"); $("#signOut").classList.add("hidden"); await loadAll(); return; }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const { data } = await sb.auth.getSession();
    if (data.session) return enter(data.session);
    $("#login").classList.remove("hidden");
    sb.auth.onAuthStateChange((_e, session) => { if (session && !user) enter(session); });
    $("#loginForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const email = $("#lEmail").value.trim(), pass = $("#lPass").value;
      $("#loginMsg").textContent = "";
      const res = pass ? await sb.auth.signInWithPassword({ email, password: pass })
        : await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } });
      if (res.error) $("#loginMsg").textContent = res.error.message;
      else if (!pass) $("#loginMsg").textContent = "Check your email for the sign-in link.";
    };
  }
  async function enter(session) {
    user = session.user;
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
    try { await loadAll(); } catch (e) { $("#sub").textContent = "Could not load data: " + (e.message || String(e)) + ". Is your email in tc_members?"; return; }
    let tm; const reload = () => { clearTimeout(tm); tm = setTimeout(() => loadAll().catch(() => {}), 800); };
    const ch = sb.channel("tc");
    for (const tb of ["tc_deals", "tc_items", "tc_actions", "tc_events"]) ch.on("postgres_changes", { event: "*", schema: "public", table: tb }, reload);
    ch.subscribe();
  }
  start();
})();
