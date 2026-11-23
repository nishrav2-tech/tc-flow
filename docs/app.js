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
  const S = { deals: [], items: [], steps: [], actions: [], events: [], contacts: [], ghlDays: [], props: {}, open: null };

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

  function health(d) {
    if (d.status !== "active") return { c: "grey", why: [] };
    const t = today(), red = [], yellow = [];
    if (d.title_issue) red.push(`Title: ${d.title_issue}`);
    const cd = closeDate(d);
    if (cd && cd < t) red.push(`Closing date passed ${plural(diff(cd, t), "day")} ago`);
    else if (cd && diff(t, cd) <= 5) { const cs = item(d, "signing_scheduled"); if (!cs || isOpen(cs)) red.push(`Closes in ${plural(diff(t, cd), "day")}, closing not scheduled`); }
    const sc = sellerContact(d);
    if (sc.since != null && sc.since > CONTACT_TARGET) yellow.push(`No seller contact in ${sc.since} days`);
    const over = currentItems(d).filter((i) => isOpen(i) && !i.step.optional && dueDate(d, i.step) && dueDate(d, i.step) < t);
    if (over.length) yellow.push(`${over.length} ${STAGE_LABEL[d.ghl_stage]} step${over.length > 1 ? "s" : ""} past due`);
    for (const a of S.actions.filter((x) => x.deal_id === d.id && x.status === "open")) yellow.push(a.title);
    return { c: red.length ? "red" : yellow.length ? "yellow" : "green", why: red.concat(yellow) };
  }

  // ---------- data ----------
  async function loadAll() {
    if (DEMO) {
      const j = await (await fetch("demo-data.json")).json();
      Object.assign(S, { deals: j.deals, items: j.items, steps: j.steps, actions: j.actions || [], events: j.events || [], contacts: j.contacts || [], ghlDays: j.ghlDays || [] });
      S.props = Object.fromEntries((j.properties || []).map((p) => [p.id, p]));
    } else {
      const [d, i, s, a, e, c] = await Promise.all([
        sb.from("tc_deals").select("*"), sb.from("tc_items").select("*"), sb.from("tc_steps").select("*"),
        sb.from("tc_actions").select("*"), sb.from("tc_events").select("*").order("at", { ascending: false }).limit(300),
        sb.from("tc_contacts").select("*").order("at", { ascending: false }),
      ]);
      for (const x of [d, i, s, a, e]) if (x.error) throw x.error;
      Object.assign(S, { deals: d.data, items: i.data, steps: s.data, actions: a.data, events: e.data, contacts: c.error ? [] : c.data });
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
    $("#kpis").innerHTML = [
      ["Deals under contract", active.length, `${active.filter((d) => health(d).c === "red").length} need attention`, false],
      ["Closing in 14 days", closing.length, closing.length ? "next: " + fmt(closing.map(closeDate).sort()[0]) : "none scheduled", false],
      ["Title issues", issues, "waiting on a fix", issues > 0],
      ["Sellers due for a call", quiet, `target: every ${CONTACT_TARGET} days`, quiet > 0],
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
    const p = prop(d), h = health(d), t = today(), cd = closeDate(d), sc = sellerContact(d);
    return `<a class="dcard" href="#/deal/${d.id}" title="${esc(h.why.join("\n"))}">
      <div class="t"><i class="dot ${h.c}"></i><span>${esc(d.name || d.seller_name)}</span></div>
      <div class="s">${esc([p.county && p.county + " Co", p.state, p.acres && p.acres + " ac"].filter(Boolean).join(", "))}</div>
      <div class="line">${cd ? `Closing <b>${fmt(cd)}</b> ${diff(t, cd) < 0 ? `<span class="over">(${-diff(t, cd)}d late)</span>` : `(${diff(t, cd)}d)`}` : "No closing date"}</div>
      <div class="line">Seller: <span class="${sc.ok ? "" : "soon"}">${sc.last ? `${sc.since}d ago` : "no contact logged"}</span></div>
      <div class="mini">Title ${titleBar(d)}</div>
      ${d.title_issue ? `<div class="line over" style="font-weight:500">${esc(d.title_issue.length > 70 ? d.title_issue.slice(0, 70) + "..." : d.title_issue)}</div>` : ""}
    </a>`;
  }

  // ---------- deal drawer ----------
  function openDeal(id) {
    const d = S.deals.find((x) => x.id === id); if (!d) return;
    S.open = id;
    const p = prop(d), t = today(), cd = closeDate(d), h = health(d), sc = sellerContact(d);
    const ghl = d.ghl_contact_id ? `https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${d.ghl_contact_id}` : "";
    const sd = stageDate(d, d.ghl_stage);
    const facts = [
      ["Stage", STAGE_LABEL[d.ghl_stage] + (sd ? ` (${diff(sd, t)}d)` : "")],
      ["Contract date", fmt(d.contract_date) || "not set"],
      ["EMD deadline", fmt(d.emd_deadline) || "not set"],
      ["Closing date", cd ? `${fmt(cd)} (${diff(t, cd) < 0 ? -diff(t, cd) + "d late" : diff(t, cd) + "d"})` : "not set"],
      ["Price", money(d.purchase_price || p.buy_price) || "not set"],
      ["Title company", d.closing_agent || "not set"],
    ];

    // title timeline
    const tlNodes = TITLE_STEPS.map(([sid, label], idx) => {
      const it = item(d, sid), done = it && it.status === "done", bad = d.title_issue && d.title_issue_stage === sid;
      const prevDone = idx === 0 || (item(d, TITLE_STEPS[idx - 1][0]) || {}).status === "done";
      const cls = bad ? "issue" : done ? "done" : prevDone ? "now" : "";
      const sub = done ? fmt(itemDate(it)) : bad ? "needs attention" : prevDone ? "next" : "";
      return `<div class="node ${cls}"><div class="ball"></div><div class="lbl">${label}</div><div class="dt">${sub}</div></div>`;
    }).join("");
    const issue = d.title_issue ? `<div class="tlnote"><b>To keep title moving:</b> ${esc(d.title_issue)}${d.title_issue_since ? ` <span style="opacity:.8">(since ${fmt(d.title_issue_since)}, ${plural(diff(toDay(d.title_issue_since), t), "day")})</span>` : ""}</div>` : "";

    // seller contact
    const recent = S.contacts.filter((c) => c.deal_id === d.id && (!d.contract_date || tsDay(c.at) >= toDay(d.contract_date))).slice(0, 5);
    const contactHtml = `<div class="contact">
        <div><div class="big ${sc.ok ? "" : "soon"}">${sc.since != null ? sc.since + "d" : "-"}</div><div class="meta" style="font-size:12px;color:var(--ink-3)">${sc.last ? "since last contact" : "no contact since contract"}</div></div>
        <div><div class="big">${sc.avg != null ? sc.avg + "d" : "-"}</div><div class="meta" style="font-size:12px;color:var(--ink-3)">average gap (target ${CONTACT_TARGET}d)</div></div>
        <div><div class="big">${sc.count}</div><div class="meta" style="font-size:12px;color:var(--ink-3)">contacts since contract</div></div>
        <span class="pill ${sc.ok ? "p-ok" : "p-warn"}">${sc.ok ? "On track" : "Reach out"}</span></div>
      ${recent.length ? `<div class="list" style="margin-top:8px">${recent.map((c) => `<div class="item" style="font-size:13px"><time style="min-width:70px;color:var(--ink-3)">${fmt(c.at)}</time><div class="who">${esc([c.channel, c.direction === "in" ? "from seller" : c.direction === "out" ? "to seller" : ""].filter(Boolean).join(" "))}${c.summary ? ": " + esc(c.summary) : ""}</div></div>`).join("")}</div>` : ""}`;

    // checklist: current stage only; earlier stages folded away
    const cur = currentItems(d);
    const earlierOpen = dealItems(d).filter((i) => STAGE_IDX[i.step.stage] < STAGE_IDX[d.ghl_stage] && isOpen(i));
    const evs = S.events.filter((e) => e.deal_id === d.id).slice(0, 25);

    $("#drawer").innerHTML = `
      <button class="btn sm x" id="closeDrawer">Close</button>
      <h3><i class="dot ${h.c}" style="margin-right:8px;vertical-align:middle"></i>${esc(d.name || d.seller_name)}</h3>
      <p class="sub">${esc([p.county && p.county + " County", p.state, p.acres && p.acres + " acres"].filter(Boolean).join(", "))}${ghl ? ` · <a href="${ghl}" target="_blank" rel="noopener">Open in GHL</a>` : ""}</p>
      <div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
      ${d.agent_summary ? `<div class="summary">${esc(d.agent_summary)}</div>` : ""}
      <section><h2>Title</h2><div class="tl">${tlNodes}</div>${issue}</section>
      <section><h2>Seller contact</h2>${contactHtml}</section>
      <section><h2>${esc(STAGE_LABEL[d.ghl_stage])} checklist</h2><div id="ckList">${cur.map((it) => itemRow(d, it)).join("") || `<div class="empty">No steps for this stage.</div>`}</div>
        ${earlierOpen.length ? `<details><summary>${plural(earlierOpen.length, "earlier step")} not ticked (the deal moved on in GHL)</summary><div id="ckOld">${earlierOpen.map((it) => itemRow(d, it, true)).join("")}</div></details>` : ""}</section>
      <details><summary>Activity</summary><div class="list log">${evs.map((e) => `<div class="item"><time>${fmtTime(e.at)}</time><div class="who">${esc(e.text)}</div></div>`).join("") || `<div class="empty">No activity yet.</div>`}</div></details>`;
    $("#scrim").classList.remove("hidden"); $("#drawer").classList.remove("hidden");
    $("#closeDrawer").onclick = closeDrawer;
    $("#drawer").onchange = (ev) => { const cb = ev.target.closest("input[data-item]"); if (cb) toggleItem(cb); };
    $("#drawer").onclick = (ev) => { const b = ev.target.closest("button[data-na]"); if (b) setNa(b); };
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
    for (const tb of ["tc_deals", "tc_items", "tc_actions", "tc_events", "tc_contacts"]) ch.on("postgres_changes", { event: "*", schema: "public", table: tb }, reload);
    ch.subscribe();
  }
  start();
})();
