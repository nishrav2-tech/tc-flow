/* TC Flow dashboard. A viewing tool: the TC agent checks GHL and Gmail each morning and fills it in.
   People can tick checklist boxes too. Data: tc_ tables in Supabase, plus CRM properties. */
(function () {
  const CFG = window.TC_CONFIG || {};
  const TZ = CFG.TIMEZONE || "America/Chicago";
  const LOC = CFG.GHL_LOCATION || "wYwhCQq7nLroxnCnZq2N";
  const DEMO = new URLSearchParams(location.search).has("demo");
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

  // GHL "Contract --> Close" stages, named exactly as in GHL
  const STAGES = [
    ["new_contract", "New Contract"], ["title_emd", "Title & EMD Confirmed"], ["dd2", "DD Phase II Completed"],
    ["funding", "Funding Confirmed"], ["dd3", "DD Phase III Completed"], ["closed", "Deal Closed"],
  ];
  const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
  const STAGE_LABEL = Object.fromEntries(STAGES);
  // title process timeline, each point is a checklist step
  const TITLE_STEPS = [["title_opened", "Title opened"], ["emd_sent", "EMD submitted"], ["title_commitment", "Title commitment received"], ["signing_scheduled", "Closing scheduled"]];
  const CONTACT_TARGET = 10; // one seller contact every 10 days on average

  let sb = null, user = null;
  const S = { deals: [], items: [], steps: [], actions: [], events: [], contacts: [], brokers: [], ghlDays: [], props: {}, open: null };
  // due diligence items shown in the DD & Broker panel, whatever the GHL stage
  const DD_STEPS = [["deed_survey", "Deed and survey"], ["zoning", "Zoning and deed restrictions"], ["utilities", "Utilities (power, water, sewer or septic)"], ["new_survey", "New survey or perc test (if needed)"]];
  const BROKER_STATUS = { contacted: ["Asked", "p-mute"], opinion: ["Opinion in", "p-info"], chosen: ["Picked", "p-warn"], signed: ["Listing signed", "p-ok"], passed: ["Passed", "p-mute"] };
  const WAITING = { us: "us", title: "title", seller: "the seller", funder: "the funder" };
  const RANK = { grey: 0, green: 1, yellow: 2, red: 3 };
  const worst = (...cs) => cs.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "grey");

  // ---------- dates ----------
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const toDay = (d) => (d ? String(d).slice(0, 10) : null);
  const tsDay = (ts) => (ts ? new Date(ts).toLocaleDateString("en-CA", { timeZone: TZ }) : null);
  const diff = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5); // b - a, in days
  const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const fmt = (d) => { if (!d) return ""; const x = new Date(String(d).length === 10 ? d + "T12:00:00Z" : d); return isNaN(x) ? esc(d) : x.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }); };
  const fmtTime = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
  const money = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
  const plural = (n, w) => `${n} ${w}${Math.abs(n) === 1 ? "" : "s"}`;
  const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.remove("hidden"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 2600); };

  // ---------- derived ----------
  const prop = (d) => S.props[d.property_id] || {};
  const closeDate = (d) => toDay(d.close_date) || toDay(prop(d).closing_date);
  const stepById = (id) => S.steps.find((s) => s.id === id);
  const stageDate = (d, k) => toDay((d.stage_dates || {})[k]);
  const isOpen = (it) => it.status === "open" || it.status === "waiting";
  const dealItems = (d) => S.items.filter((i) => i.deal_id === d.id)
    .map((i) => Object.assign({}, i, { step: stepById(i.step_id) })).filter((i) => i.step && i.step.active !== false)
    .sort((a, b) => STAGE_IDX[a.step.stage] - STAGE_IDX[b.step.stage] || a.step.sort - b.step.sort);
  const item = (d, stepId) => S.items.find((i) => i.deal_id === d.id && i.step_id === stepId);
  const itemDate = (it) => (it && it.status === "done" ? toDay(it.event_date) || tsDay(it.done_at) : null);
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
  // only the current stage's steps matter; earlier ones are history once GHL moves on
  const currentItems = (d) => dealItems(d).filter((i) => i.step.stage === d.ghl_stage);

  function sellerContact(d) {
    const days = new Set();
    for (const c of S.contacts) if (c.deal_id === d.id) days.add(tsDay(c.at));
    for (const g of S.ghlDays) if (g.deal_id === d.id && g.n_out > 0) days.add(toDay(g.day));
    const start = toDay(d.contract_date), t = today();
    const list = [...days].filter((x) => x && (!start || x >= start)).sort();
    const last = list[list.length - 1] || null;
    const span = start ? Math.max(diff(start, t), 1) : null;
    const avg = span ? Math.round(span / Math.max(list.length, 1)) : null;
    const since = last ? diff(last, t) : span;
    return { count: list.length, last, since, avg, span, ok: since != null && since <= CONTACT_TARGET && (avg == null || avg <= CONTACT_TARGET) };
  }

  // ---------- the three lanes: title, seller, due diligence + broker ----------
  const sinceTxt = (ts) => { if (!ts) return null; const n = diff(tsDay(ts), today()); return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n}d ago`; };
  function titleLane(d) {
    let c = d.title_flag || (d.title_issue ? "red" : "green");
    if (d.title_issue && RANK[c] < RANK.yellow) c = "yellow";
    const who = WAITING[d.title_waiting_on] || null;
    const short = (who ? `On ${who}` : "Moving") + (d.title_last_reply ? `, title replied ${sinceTxt(d.title_last_reply)}` : ", no reply yet");
    return { c, who, short };
  }
  function sellerLane(d) {
    const sc = sellerContact(d);
    let c = sc.since == null ? "grey" : sc.since > CONTACT_TARGET ? "red" : sc.since > 7 ? "yellow" : "green";
    if (d.seller_open && RANK[c] < RANK.yellow) c = "yellow";
    if (d.seller_flag && d.seller_edited_by && d.seller_edited_by !== "agent") c = d.seller_flag;
    const short = sc.last ? `Last contact ${sc.since === 0 ? "today" : sc.since + "d ago"}` : "No contact logged";
    return { c, sc, short };
  }
  const dealBrokers = (d) => S.brokers.filter((b) => b.deal_id === d.id);
  function ddLane(d) {
    const bs = dealBrokers(d);
    const signed = bs.find((b) => b.status === "signed"), chosen = bs.find((b) => b.status === "chosen");
    const opinions = bs.filter((b) => b.opinion_low || b.opinion_high || b.opinion_text).length;
    const broker = signed ? `Listed with ${signed.name}` : chosen ? `Broker: ${chosen.name}` : opinions ? `${plural(opinions, "broker opinion")} in` : bs.length ? `Asked ${plural(bs.length, "broker")}` : "No broker yet";
    const dd = DD_STEPS.map(([id]) => item(d, id)).filter((it) => it && it.status !== "na");
    const done = dd.filter((it) => it.status === "done").length;
    const c = d.dd_flag || (bs.length || done ? "yellow" : "grey");
    return { c, bs, broker, done, total: dd.length, short: `DD ${done}/${dd.length} · ${broker}` };
  }
  const priceRange = (b) => (b.opinion_low && b.opinion_high && Number(b.opinion_low) !== Number(b.opinion_high) ? `${money(b.opinion_low)} to ${money(b.opinion_high)}` : money(b.opinion_low || b.opinion_high));

  function health(d) {
    if (d.status !== "active") return { c: "grey", why: [] };
    const t = today(), red = [], yellow = [];
    const tl = titleLane(d), sl = sellerLane(d), dl = ddLane(d);
    if (tl.c === "red") red.push(`Title: ${d.title_issue || d.title_status || tl.short}`); else if (tl.c === "yellow") yellow.push(`Title: ${d.title_issue || tl.short}`);
    if (d.seller_open) yellow.push(`Seller: ${d.seller_open}`);
    if (dl.c === "red") red.push(`DD: ${d.dd_status || dl.short}`);
    const cd = closeDate(d);
    if (cd && cd < t) red.push(`Closing date passed ${plural(diff(cd, t), "day")} ago`);
    else if (cd && diff(t, cd) <= 5) { const cs = item(d, "signing_scheduled"); if (!cs || isOpen(cs)) red.push(`Closes in ${plural(diff(t, cd), "day")}, closing not scheduled`); }
    const sc = sellerContact(d);
    if (sc.since != null && sc.since > CONTACT_TARGET) red.push(`No seller contact in ${sc.since} days`);
    const over = currentItems(d).filter((i) => isOpen(i) && !i.step.optional && dueDate(d, i.step) && dueDate(d, i.step) < t);
    if (over.length) yellow.push(`${over.length} ${STAGE_LABEL[d.ghl_stage]} step${over.length > 1 ? "s" : ""} past due`);
    for (const a of S.actions.filter((x) => x.deal_id === d.id && x.status === "open")) yellow.push(a.title);
    return { c: red.length ? "red" : yellow.length ? "yellow" : "green", why: red.concat(yellow) };
  }

  // ---------- data ----------
  async function loadAll() {
    if (DEMO) {
      const j = await (await fetch("demo-data.json")).json();
      Object.assign(S, { deals: j.deals, items: j.items, steps: j.steps, actions: j.actions || [], events: j.events || [], contacts: j.contacts || [], brokers: j.brokers || [], ghlDays: j.ghlDays || [] });
      S.props = Object.fromEntries((j.properties || []).map((p) => [p.id, p]));
    } else {
      const [d, i, s, a, e, c, b] = await Promise.all([
        sb.from("tc_deals").select("*"), sb.from("tc_items").select("*"), sb.from("tc_steps").select("*"),
        sb.from("tc_actions").select("*"), sb.from("tc_events").select("*").order("at", { ascending: false }).limit(300),
        sb.from("tc_contacts").select("*").order("at", { ascending: false }),
        sb.from("tc_brokers").select("*").order("created_at"),
      ]);
      for (const x of [d, i, s, a, e]) if (x.error) throw x.error;
      Object.assign(S, { deals: d.data, items: i.data, steps: s.data, actions: a.data, events: e.data, contacts: c.error ? [] : c.data, brokers: b.error ? [] : b.data });
      const ids = S.deals.map((x) => x.property_id).filter(Boolean);
      if (ids.length) {
        const p = await sb.from("properties").select("id,property_id,county,state,acres,buy_price,closing_date,status").in("id", ids);
        if (!p.error) S.props = Object.fromEntries(p.data.map((x) => [x.id, x]));
      }
      const g = await sb.rpc("tc_contact_days");
      S.ghlDays = g.error ? [] : g.data || [];
    }
    render();
    const m = location.hash.match(/^#\/deal\/([\w-]+)/);
    if (m) openDeal(m[1]);
  }

  // ---------- main page ----------
  function render() {
    const t = today(), active = S.deals.filter((d) => d.status === "active");
    const closing = active.filter((d) => closeDate(d) && diff(t, closeDate(d)) >= 0 && diff(t, closeDate(d)) <= 14);
    const issues = active.filter((d) => d.title_issue).length;
    const quiet = active.filter((d) => !sellerContact(d).ok).length;
    const titleUs = active.filter((d) => d.title_waiting_on === "us" || d.title_issue).length;
    const ddBroker = active.filter((d) => ddLane(d).bs.some((b) => b.status === "signed" || b.status === "chosen")).length;
    $("#kpis").innerHTML = [
      ["Title waiting on us", titleUs, `${issues} with a blocker`, titleUs > 0],
      ["Sellers due for a call", quiet, `target: every ${CONTACT_TARGET} days`, quiet > 0],
      ["Broker picked", `${ddBroker}/${active.length}`, "listing signed or broker chosen", false],
      ["Closing in 14 days", closing.length, closing.length ? "next: " + fmt(closing.map(closeDate).sort()[0]) : "none scheduled", false],
    ].map(([l, v, h, attn]) => `<div class="card kpi${attn ? " attn" : ""}"><div class="label">${l}</div><div class="val">${v}</div><div class="hint">${esc(h)}</div></div>`).join("");

    const runs = S.events.filter((e) => e.kind === "run");
    $("#agentInfo").textContent = runs[0] ? `Agent last checked ${fmtTime(runs[0].at)}.` : "The agent checks every weekday morning.";
    $("#ghlBtn").href = `https://app.gohighlevel.com/v2/location/${LOC}/opportunities`;

    const show = $("#fStatus").value, list = S.deals.filter((d) => d.status === show);
    $("#board").innerHTML = STAGES.map(([k, label]) => {
      const ds = list.filter((d) => d.ghl_stage === k).sort((a, b) => ((closeDate(a) || "9") < (closeDate(b) || "9") ? -1 : 1));
      return `<div class="col"><h3>${label}<span>${ds.length}</span></h3>${ds.map(cardHtml).join("") || `<div class="empty" style="padding:6px 4px;font-size:12.5px">None</div>`}</div>`;
    }).join("");

    const att = active.map((d) => ({ d, h: health(d) })).filter((x) => x.h.c !== "green")
      .sort((a, b) => (a.h.c === b.h.c ? 0 : a.h.c === "red" ? -1 : 1));
    $("#attention").innerHTML = att.length ? att.map(({ d, h }) => `<div class="item click" data-deal="${d.id}"><i class="dot ${h.c}" style="margin-top:5px"></i>
      <div class="who"><b>${esc(d.name)}</b> <span class="meta">${esc(STAGE_LABEL[d.ghl_stage])}</span><div class="meta" style="color:var(--ink-2)">${h.why.slice(0, 3).map(esc).join(" · ")}</div></div></div>`).join("")
      : `<div class="empty">Everything is on track.</div>`;
  }

  function titleBar(d) {
    return TITLE_STEPS.map(([id]) => { const it = item(d, id); const bad = d.title_issue && d.title_issue_stage === id; return `<i class="${bad ? "bad" : it && it.status === "done" ? "on" : ""}"></i>`; }).join("");
  }

  function cardHtml(d) {
    const p = prop(d), h = health(d), t = today(), cd = closeDate(d);
    const tl = titleLane(d), sl = sellerLane(d), dl = ddLane(d);
    const lane = (c, label, text) => `<div class="lane-mini"><i class="dot ${c}"></i><b>${label}</b><span>${esc(text)}</span></div>`;
    return `<a class="dcard" href="#/deal/${d.id}" title="${esc(h.why.join("\n"))}">
      <div class="t"><i class="dot ${h.c}"></i><span>${esc(d.name || d.seller_name)}</span></div>
      <div class="s">${esc([p.county && p.county + " Co", p.state, p.acres && p.acres + " ac"].filter(Boolean).join(", "))}</div>
      <div class="line">${cd ? `Closing <b>${fmt(cd)}</b> ${diff(t, cd) < 0 ? `<span class="over">(${-diff(t, cd)}d late)</span>` : `(${diff(t, cd)}d)`}` : "No closing date"}</div>
      <div class="mini">Title ${titleBar(d)}</div>
      ${lane(tl.c, "Title", tl.short)}
      ${lane(sl.c, "Seller", sl.short)}
      ${lane(dl.c, "DD", dl.broker)}
    </a>`;
  }

  // ---------- deal drawer: three panels ----------
  function openDeal(id) {
    const d = S.deals.find((x) => x.id === id); if (!d) return;
    S.open = id;
    const p = prop(d), t = today(), cd = closeDate(d), h = health(d);
    const tl = titleLane(d), sl = sellerLane(d), dl = ddLane(d), sc = sl.sc;
    const ghl = d.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${d.ghl_contact_id}` : "";
    const sd = stageDate(d, d.ghl_stage);
    const facts = [
      ["GHL stage", STAGE_LABEL[d.ghl_stage] + (sd ? ` (${diff(sd, t)}d)` : "")],
      ["Contract", fmt(d.contract_date) || "not set"],
      ["EMD deadline", fmt(d.emd_deadline) || "not set"],
      ["Closing", cd ? `${fmt(cd)} (${diff(t, cd) < 0 ? -diff(t, cd) + "d late" : diff(t, cd) + "d"})` : "not set"],
      ["Price", money(d.purchase_price || p.buy_price) || "not set"],
    ];
    const panel = (kind, c, title, right, body, edited) => `<section class="panel" data-host="${kind}"><div class="phead"><i class="dot ${c}"></i><h2>${title}</h2><div class="grow"></div>${right || ""}<button class="btn sm" data-edit="${kind}">Edit</button></div><div class="pbody">${body}${edited || ""}</div></section>`;
    const para = (txt, empty) => (txt ? `<p class="pstatus">${esc(txt)}</p>` : `<p class="pstatus muted">${esc(empty)}</p>`);

    // 1. TITLE
    const tlNodes = TITLE_STEPS.map(([sid, label], idx) => {
      const it = item(d, sid), done = it && it.status === "done", bad = d.title_issue && d.title_issue_stage === sid;
      const prevDone = idx === 0 || (item(d, TITLE_STEPS[idx - 1][0]) || {}).status === "done";
      const cls = bad ? "issue" : done ? "done" : prevDone ? "now" : "";
      const sub = done ? fmt(itemDate(it)) : bad ? "blocked" : prevDone ? "next" : "";
      return `<div class="node ${cls}"><div class="ball"></div><div class="lbl">${label}</div><div class="dt">${sub}</div></div>`;
    }).join("");
    const titleStats = [
      ["Title last replied", d.title_last_reply ? `${fmt(d.title_last_reply)} (${sinceTxt(d.title_last_reply)})` : "no reply yet"],
      ["Title company", d.closing_agent || "not chosen"],
    ];
    const titleBody = `${para(d.title_status, "No title update yet.")}
      <div class="stats">${titleStats.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
      <div class="tl">${tlNodes}</div>
      ${d.title_issue ? `<div class="tlnote"><b>Blocking title:</b> ${esc(d.title_issue)}${d.title_issue_since ? ` <span style="opacity:.8">(since ${fmt(d.title_issue_since)}, ${plural(diff(toDay(d.title_issue_since), t), "day")})</span>` : ""}</div>` : ""}
      ${d.closing_agent_contact ? `<div class="meta2">Contact: ${esc(d.closing_agent_contact)}</div>` : ""}`;

    // 2. SELLER
    const recent = S.contacts.filter((c) => c.deal_id === d.id && (!d.contract_date || tsDay(c.at) >= toDay(d.contract_date))).slice(0, 6);
    const sellerStats = [
      ["Since last contact", sc.since != null ? `${sc.since} days` : "-"],
      ["Average gap", sc.avg != null ? `${sc.avg} days (target ${CONTACT_TARGET})` : "-"],
      ["Contacts since contract", String(sc.count)],
      ["Seller", [d.seller_name, d.seller_phone].filter(Boolean).join(" · ") || "-"],
    ];
    const sellerBody = `${para(d.seller_status, sc.last ? "" : "No contact logged since the contract.")}
      ${d.seller_open ? `<div class="open-note">${esc(d.seller_open)}</div>` : ""}
      <div class="stats">${sellerStats.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
      <div data-host="contact"><div class="pbody"><button class="btn sm" data-edit="contact">+ Log a call or text</button></div></div>
      ${recent.length ? `<div class="list small">${recent.map((c) => `<div class="item"><time>${fmt(c.at)}</time><div class="who">${esc([c.channel, c.direction === "in" ? "from seller" : c.direction === "out" ? "to seller" : ""].filter(Boolean).join(" "))}${c.summary ? ": " + esc(c.summary) : ""}</div></div>`).join("")}</div>` : ""}`;

    // 3. DUE DILIGENCE + BROKER
    const ddRows = DD_STEPS.map(([sid, label]) => {
      const it = item(d, sid); if (!it) return "";
      const st = it.status === "done" ? `<span class="pill p-ok">Found</span>` : it.status === "na" ? `<span class="pill p-mute">Not needed</span>` : `<span class="pill p-warn">Still needed</span>`;
      const detail = it.status === "done" ? it.evidence : it.agent_note;
      return `<div class="ddrow"><div class="who"><b>${label}</b>${detail ? `<div class="meta">${esc(detail)}</div>` : ""}</div>${st}</div>`;
    }).join("");
    const brokerRows = dl.bs.map((b) => {
      return `<div data-host="broker-${b.id}"><div class="pbody">${brokerRowHtml(b)}</div></div>`; }).join("");
    function brokerRowHtml(b) {
      const [lbl, cls] = BROKER_STATUS[b.status] || [b.status, "p-mute"];
      const op = priceRange(b);
      return `<div class="brow"><div class="who"><b>${esc(b.name)}</b>${b.company ? ` <span class="meta">${esc(b.company)}</span>` : ""}
          <div class="meta">${op ? `Opinion <b>${esc(op)}</b>${b.opinion_date ? ` (${fmt(b.opinion_date)})` : ""}` : "No pricing opinion yet"}${b.opinion_text ? ` · ${esc(b.opinion_text)}` : ""}${safeUrl(b.opinion_url) ? ` <a href="${esc(safeUrl(b.opinion_url))}" target="_blank" rel="noopener">email</a>` : ""}</div>
          ${b.listing_signed_date ? `<div class="meta">Listing agreement signed ${fmt(b.listing_signed_date)}</div>` : ""}
          ${b.notes ? `<div class="meta">${esc(b.notes)}</div>` : ""}${b.logged_by && b.logged_by !== "agent" ? `<div class="edited">Edited by ${esc(b.logged_by)}</div>` : ""}</div>
        <div class="bright"><span class="pill ${cls}">${lbl}</span><button class="btn sm" data-edit="broker" data-id="${b.id}">Edit</button></div></div>`;
    }
    const ddBody = `<h4>Due diligence</h4>${para(d.dd_status, "No due diligence notes yet.")}<div class="ddlist">${ddRows}</div>
      <h4>Broker</h4>${para(d.broker_status, "No broker contacted yet.")}${brokerRows ? `<div class="ddlist">${brokerRows}</div>` : ""}<div data-host="newbroker"><div class="pbody"><button class="btn sm" data-edit="broker">+ Add a broker</button></div></div>`;

    // GHL stage checklist, folded away
    const cur = currentItems(d);
    const evs = S.events.filter((e) => e.deal_id === d.id).slice(0, 25);

    $("#drawer").innerHTML = `
      <button class="btn sm x" id="closeDrawer">Close</button>
      <h3><i class="dot ${h.c}" style="margin-right:8px;vertical-align:middle"></i>${esc(d.name || d.seller_name)}</h3>
      <p class="sub">${esc([p.property_id, p.county && p.county + " County", p.state, p.acres && p.acres + " acres"].filter(Boolean).join(", "))}${ghl ? ` · <a href="${ghl}" target="_blank" rel="noopener">Open in GHL</a>` : ""}</p>
      <div data-host="dates"><div class="pbody"><div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div><div class="factsbar">${editedLine(d.dates_edited_by, d.dates_edited_at)}<div class="grow"></div><button class="btn sm" data-edit="dates">Edit dates and title company</button></div></div></div>
      ${d.agent_summary ? `<div class="summary">${esc(d.agent_summary)}</div>` : ""}
      ${panel("title", tl.c, "1. Title", tl.who ? `<span class="pill ${tl.c === "red" ? "p-bad" : tl.c === "yellow" ? "p-warn" : "p-ok"}">Waiting on ${esc(tl.who)}</span>` : "", titleBody, editedLine(d.title_edited_by, d.title_edited_at))}
      ${panel("seller", sl.c, "2. Seller contact", `<span class="pill ${sl.c === "green" ? "p-ok" : sl.c === "yellow" ? "p-warn" : "p-bad"}">${sc.since != null ? (sc.since <= CONTACT_TARGET ? "On track" : "Reach out") : "No contact"}</span>`, sellerBody, editedLine(d.seller_edited_by, d.seller_edited_at))}
      ${panel("dd", dl.c, "3. Due diligence and broker", `<span class="pill p-mute">${esc(dl.broker)}</span>`, ddBody, editedLine(d.dd_edited_by, d.dd_edited_at))}
      <details><summary>GHL stage checklist: ${esc(STAGE_LABEL[d.ghl_stage])} (${cur.filter((i) => i.status === "done").length} of ${cur.length} done)</summary><div id="ckList">${cur.map((it) => itemRow(d, it)).join("") || `<div class="empty">No steps for this stage.</div>`}</div></details>
      <details><summary>Activity</summary><div class="list log">${evs.map((e) => `<div class="item"><time>${fmtTime(e.at)}</time><div class="who">${esc(e.text)}</div></div>`).join("") || `<div class="empty">No activity yet.</div>`}</div></details>`;
    $("#scrim").classList.remove("hidden"); $("#drawer").classList.remove("hidden");
    $("#closeDrawer").onclick = closeDrawer;
    $("#drawer").onchange = (ev) => { const cb = ev.target.closest("input[data-item]"); if (cb) toggleItem(cb); };
    $("#drawer").onclick = (ev) => {
      const b = ev.target.closest("button"); if (!b || b.id === "closeDrawer") return;
      if (b.dataset.na) setNa(b);
      else if (b.dataset.edit) { ev.stopPropagation(); showEdit(b); }
      else if (b.dataset.save) saveEdit(b);
      else if (b.hasAttribute("data-cancel")) openDeal(S.open);
    };
    if (location.hash !== `#/deal/${id}`) history.replaceState(null, "", `#/deal/${id}`);
  }

  function itemRow(d, it, old) {
    const t = today(), due = dueDate(d, it.step);
    let st = "";
    if (it.status === "done") st = `<span class="pill ${it.done_by === "agent" ? "p-agent" : "p-ok"}">${fmt(itemDate(it))}</span>`;
    else if (it.status === "na") st = `<span class="pill p-mute">Not needed</span>`;
    else if (!old && due) { const over = due < t ? diff(due, t) : 0; st = `<span class="${over ? "over" : diff(t, due) <= 2 ? "soon" : ""}">${over ? `${over}d late` : `due ${fmt(due)}`}</span>`; }
    return `<div class="ck${it.status === "done" ? " done" : ""}">
      <input type="checkbox" data-item="${it.id}" ${it.status === "done" ? "checked" : ""} ${it.status === "na" ? "disabled" : ""} aria-label="${esc(it.step.title)}">
      <div class="body"><div class="ti">${esc(it.step.title)}</div>
        ${it.status !== "done" && it.agent_note ? `<div class="note">${esc(it.agent_note)}</div>` : ""}
        ${it.status === "done" && it.evidence ? `<div class="sub2">${esc(it.evidence)}${safeUrl(it.evidence_url) ? ` <a href="${esc(safeUrl(it.evidence_url))}" target="_blank" rel="noopener">proof</a>` : ""}</div>` : ""}
        ${it.step.optional && it.status !== "done" ? `<button class="btn sm" data-na="${it.id}" style="margin-top:4px">${it.status === "na" ? "Needed after all" : "Not needed"}</button>` : ""}
      </div><div class="st">${st}</div></div>`;
  }

  async function saveItem(it, patch, text) {
    if (DEMO) { Object.assign(it, patch); render(); openDeal(S.open); toast("Saved (demo)"); return; }
    const { error } = await sb.from("tc_items").update(patch).eq("id", it.id);
    if (error) { toast("Could not save: " + error.message); return; }
    await sb.from("tc_events").insert({ deal_id: it.deal_id, actor: user.email, kind: patch.status === "done" ? "check" : "uncheck", text });
    Object.assign(it, patch); render(); openDeal(S.open); toast("Saved");
  }
  function toggleItem(cb) {
    const it = S.items.find((i) => String(i.id) === cb.dataset.item); if (!it) return;
    const st = stepById(it.step_id) || {};
    if (cb.checked) saveItem(it, { status: "done", done_at: new Date().toISOString(), event_date: today(), done_by: user ? user.email : "demo" }, `Checked: ${st.title}`);
    else {
      if (it.done_by === "agent" && !confirm("The agent ticked this with proof. Untick it anyway?")) { cb.checked = true; return; }
      saveItem(it, { status: "open", done_at: null, event_date: null, done_by: null, evidence: null, evidence_url: null }, `Unchecked: ${st.title}`);
    }
  }
  function setNa(b) {
    const it = S.items.find((i) => String(i.id) === b.dataset.na); if (!it) return;
    const st = stepById(it.step_id) || {};
    saveItem(it, { status: it.status === "na" ? "open" : "na" }, `${it.status === "na" ? "Needed" : "Not needed"}: ${st.title}`);
  }
  // ---------- editing: people can change anything the agent wrote ----------
  const me = () => (user ? user.email : "demo");
  const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${esc(v)}"${String(cur == null ? "" : cur) === v ? " selected" : ""}>${esc(l)}</option>`).join("");
  const FLAGS = [["", "Automatic"], ["green", "Green: on track"], ["yellow", "Yellow: watch"], ["red", "Red: needs attention"], ["grey", "Grey: not started"]];
  const fText = (k, label, v, rows) => `<div class="fld"><label>${label}</label><textarea name="${k}" rows="${rows || 3}">${esc(v || "")}</textarea></div>`;
  const fInput = (k, label, v, type) => `<div class="fld"><label>${label}</label><input name="${k}" type="${type || "text"}" value="${esc(v == null ? "" : v)}"></div>`;
  const fSelect = (k, label, pairs, v) => `<div class="fld"><label>${label}</label><select name="${k}">${opt(pairs, v)}</select></div>`;
  const formBtns = (kind, extra) => `<div class="fbtns"><button class="btn primary sm" data-save="${kind}"${extra || ""}>Save</button><button class="btn sm" data-cancel>Cancel</button></div>`;
  const editedLine = (by, at) => (by && at ? `<div class="edited">Edited by ${esc(by === "agent" ? "the agent" : by)} on ${fmt(at)}</div>` : "");

  function editForm(d, kind) {
    if (kind === "dates") return `<div class="eform grid2">${fInput("contract_date", "Contract date", toDay(d.contract_date), "date")}${fInput("emd_deadline", "EMD deadline", toDay(d.emd_deadline), "date")}
      ${fInput("close_date", "Closing date", toDay(d.close_date), "date")}${fInput("purchase_price", "Purchase price ($)", d.purchase_price, "number")}
      ${fInput("closing_agent", "Title company or closing attorney", d.closing_agent)}${fInput("closing_agent_contact", "Title contact (email, phone)", d.closing_agent_contact)}</div>${formBtns("dates")}`;
    if (kind === "title") return `<div class="eform">${fText("title_status", "Where title stands", d.title_status, 4)}
      <div class="grid2">${fSelect("title_waiting_on", "Waiting on", [["", "Nobody"], ["us", "Us"], ["title", "Title"], ["seller", "Seller"], ["funder", "Funder"]], d.title_waiting_on)}
      ${fSelect("title_flag", "Color", FLAGS, d.title_flag)}${fInput("title_last_reply", "Title last replied", toDay(d.title_last_reply), "date")}
      ${fSelect("title_issue_stage", "Blocker is on step", [["", "None"]].concat(TITLE_STEPS), d.title_issue_stage)}</div>
      ${fText("title_issue", "What is blocking title (leave blank if nothing)", d.title_issue, 2)}</div>${formBtns("title")}`;
    if (kind === "seller") return `<div class="eform">${fText("seller_status", "Last contact and what was discussed", d.seller_status, 3)}
      ${fText("seller_open", "Anything owed either way (blank if nothing)", d.seller_open, 2)}${fSelect("seller_flag", "Color", FLAGS, d.seller_flag)}</div>${formBtns("seller")}`;
    if (kind === "dd") {
      const rows = DD_STEPS.map(([sid, label]) => { const it = item(d, sid); if (!it) return "";
        return `<div class="ddedit" data-item-id="${it.id}"><b>${label}</b><div class="grid2"><select name="st_${it.id}">${opt([["open", "Still needed"], ["done", "Found"], ["na", "Not needed"]], it.status === "waiting" ? "open" : it.status)}</select>
          <input name="ev_${it.id}" placeholder="What we found or what is missing" value="${esc((it.status === "done" ? it.evidence : it.agent_note) || "")}"></div></div>`; }).join("");
      return `<div class="eform">${fText("dd_status", "Due diligence: what we found and still need", d.dd_status, 4)}${rows}
        ${fText("broker_status", "Broker: opinions, who we picked, listing agreement", d.broker_status, 3)}${fSelect("dd_flag", "Color", FLAGS, d.dd_flag)}</div>${formBtns("dd")}`;
    }
    if (kind === "contact") return `<div class="eform grid2">${fInput("at", "When", new Date().toISOString().slice(0, 16), "datetime-local")}
      ${fSelect("channel", "How", [["call", "Call"], ["sms", "Text"], ["email", "Email"], ["voicemail", "Voicemail"]], "call")}
      ${fSelect("direction", "Direction", [["out", "We reached out"], ["in", "Seller reached us"]], "out")}${fInput("summary", "What was said", "")}</div>${formBtns("contact")}`;
    return "";
  }
  function brokerForm(b) {
    b = b || {};
    return `<div class="eform"><div class="grid2">${fInput("name", "Name", b.name)}${fInput("company", "Company", b.company)}${fInput("email", "Email", b.email)}${fInput("phone", "Phone", b.phone)}
      ${fSelect("status", "Status", Object.entries(BROKER_STATUS).map(([k, v]) => [k, v[0]]), b.status || "contacted")}${fInput("opinion_date", "Opinion date", toDay(b.opinion_date), "date")}
      ${fInput("opinion_low", "Opinion low ($)", b.opinion_low, "number")}${fInput("opinion_high", "Opinion high ($)", b.opinion_high, "number")}
      ${fInput("listing_signed_date", "Listing agreement signed", toDay(b.listing_signed_date), "date")}${fInput("opinion_url", "Link to their email", b.opinion_url)}</div>
      ${fInput("opinion_text", "Opinion in words (e.g. $40K to $45K per lot)", b.opinion_text)}${fText("notes", "Notes", b.notes, 2)}</div>${formBtns("broker", b.id ? ` data-id="${b.id}"` : "")}`;
  }
  function showEdit(btn) {
    const kind = btn.dataset.edit, d = S.deals.find((x) => x.id === S.open); if (!d) return;
    const host = btn.closest("[data-host]") || $("#drawer").querySelector(`[data-host="${kind}"]`);
    const box = host.querySelector(".pbody") || host;
    if (kind === "broker") { const b = S.brokers.find((x) => String(x.id) === btn.dataset.id); box.innerHTML = brokerForm(b); }
    else box.innerHTML = editForm(d, kind);
  }
  const val = (form, k) => { const el = form.querySelector(`[name="${k}"]`); if (!el) return undefined; const v = el.value.trim(); return v === "" ? null : v; };
  async function write(table, op, patch, match) {
    if (DEMO) return { error: null };
    let q = sb.from(table);
    q = op === "insert" ? q.insert(patch) : q.update(patch).eq(match[0], match[1]);
    return await q;
  }
  async function logEvent(dealId, text) { if (!DEMO) await sb.from("tc_events").insert({ deal_id: dealId, actor: me(), kind: "note", text }); }
  async function saveEdit(btn) {
    const kind = btn.dataset.save, d = S.deals.find((x) => x.id === S.open); if (!d) return;
    const form = btn.closest(".pbody") || btn.closest("[data-host]");
    const now = new Date().toISOString();
    const dealPatch = (keys, section) => { const p = {}; for (const k of keys) p[k] = val(form, k); if (section) { p[section + "_edited_by"] = me(); p[section + "_edited_at"] = now; } return p; };
    let res, patch;
    if (kind === "dates") {
      patch = dealPatch(["contract_date", "emd_deadline", "close_date", "purchase_price", "closing_agent", "closing_agent_contact"], "dates");
      res = await write("tc_deals", "update", patch, ["id", d.id]); if (!res.error) { Object.assign(d, patch); await logEvent(d.id, "Edited key dates and title company"); }
    } else if (kind === "title") {
      patch = dealPatch(["title_status", "title_waiting_on", "title_flag", "title_issue", "title_issue_stage"], "title");
      const lr = val(form, "title_last_reply"); patch.title_last_reply = lr ? lr + "T17:00:00Z" : null;
      if (!patch.title_issue) { patch.title_issue_stage = null; patch.title_issue_since = null; } else if (!d.title_issue) patch.title_issue_since = today();
      res = await write("tc_deals", "update", patch, ["id", d.id]); if (!res.error) { Object.assign(d, patch); await logEvent(d.id, "Edited the Title section"); }
    } else if (kind === "seller") {
      patch = dealPatch(["seller_status", "seller_open", "seller_flag"], "seller");
      res = await write("tc_deals", "update", patch, ["id", d.id]); if (!res.error) { Object.assign(d, patch); await logEvent(d.id, "Edited the Seller section"); }
    } else if (kind === "contact") {
      const at = val(form, "at"); if (!at) { toast("Pick a date"); return; }
      const row = { deal_id: d.id, at: new Date(at).toISOString(), channel: val(form, "channel"), direction: val(form, "direction"), summary: val(form, "summary"), source: "manual", logged_by: me() };
      res = await write("tc_contacts", "insert", row); if (!res.error) { S.contacts.unshift(row); await logEvent(d.id, `Logged a seller ${row.channel}`); }
    } else if (kind === "dd") {
      patch = dealPatch(["dd_status", "broker_status", "dd_flag"], "dd");
      res = await write("tc_deals", "update", patch, ["id", d.id]);
      if (!res.error) {
        Object.assign(d, patch);
        for (const [sid] of DD_STEPS) {
          const it = item(d, sid); if (!it) continue;
          const st = val(form, "st_" + it.id) || "open", note = val(form, "ev_" + it.id);
          const cur = it.status === "done" ? it.evidence : it.agent_note;
          if (st === (it.status === "waiting" ? "open" : it.status) && (note || null) === (cur || null)) continue;
          const ip = st === "done" ? { status: "done", evidence: note, done_by: me(), done_at: it.status === "done" ? it.done_at : now, event_date: it.event_date || today() }
            : { status: st, agent_note: note, done_by: null, done_at: null, event_date: null, evidence: null };
          const r = await write("tc_items", "update", ip, ["id", it.id]); if (!r.error) Object.assign(it, ip); else res = r;
        }
        await logEvent(d.id, "Edited the Due diligence and broker section");
      }
    } else if (kind === "broker") {
      const keys = ["name", "company", "email", "phone", "status", "opinion_low", "opinion_high", "opinion_text", "opinion_date", "opinion_url", "listing_signed_date", "notes"];
      patch = {}; for (const k of keys) patch[k] = val(form, k);
      if (!patch.name) { toast("Add the broker's name"); return; }
      patch.status = patch.status || "contacted"; patch.logged_by = me();
      const id = btn.dataset.id;
      if (id) { res = await write("tc_brokers", "update", patch, ["id", id]); if (!res.error) Object.assign(S.brokers.find((x) => String(x.id) === id), patch); }
      else {
        const row = Object.assign({ deal_id: d.id }, patch);
        if (DEMO) { row.id = Date.now(); S.brokers.push(row); res = { error: null }; }
        else { res = await sb.from("tc_brokers").insert(row).select().single(); if (!res.error) S.brokers.push(res.data); }
      }
      if (!res.error) await logEvent(d.id, `${id ? "Edited" : "Added"} broker ${patch.name}`);
    }
    if (res && res.error) { toast("Could not save: " + res.error.message); return; }
    render(); openDeal(d.id); toast(DEMO ? "Saved (demo)" : "Saved");
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
    for (const tb of ["tc_deals", "tc_items", "tc_actions", "tc_events", "tc_contacts", "tc_brokers"]) ch.on("postgres_changes", { event: "*", schema: "public", table: tb }, reload);
    ch.subscribe();
  }
  start();
})();
