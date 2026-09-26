"use strict";

/* Steps 3 and 4 of the workspace: Buyers (seller story, buyer search) and Outreach (emails).
   The data is the company's campaign, saved on the server in output/campaigns/<Business ID>.json. */

const cmp = { bid: null, data: null, seller: null, jobs: {} };
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
// The campaign's sender, or the details used last time in another campaign
const effectiveSender = () => (Object.values(cmp.data.sender || {}).some(Boolean) ? cmp.data.sender : pref.get("sender", {}));
const JOB_PATHS = { brief: "brief", find: "find", add: "buyers", emails: "emails", followup: "followup" };
const STATUS_LABEL = { draft: "Draft", sent: "Sent", interested: "Interested", not_interested: "Not interested" };
const STATUS_BADGE = { draft: "", sent: "acc", interested: "good", not_interested: "bad" };
const FOLLOW_UP_DAYS = 7;

function followUpDue(e) {
  if (e.status !== "sent" || !e.sent_at || (e.follow_up && e.follow_up.status === "sent")) return false;
  return (Date.now() - new Date(e.sent_at).getTime()) / 86400000 >= FOLLOW_UP_DAYS;
}
// Selected buyers still without an address: a full look-up of each reads all its website pages.
const needContact = () => cmp.data.buyers.filter((b) => b.selected && !b.contact_email && !b.contact_checked);

async function reloadCampaign(bid) {
  try {
    const r = await api(`/api/campaigns/${bid}`);
    if (cmp.bid === bid) {
      await flushActiveField();
      cmp.data = r.campaign;
      cmp.seller = r.seller;
    }
  } catch { /* keep what is shown */ }
}

// Saves go out one at a time, in order, so a quick series of edits can't overwrite each other.
let editQueue = Promise.resolve();

function edit(changes) {
  const bid = cmp.bid;
  editQueue = editQueue.then(async () => {
    try {
      const r = await api(`/api/campaigns/${bid}/edit`, { method: "POST", body: JSON.stringify(changes) });
      if (cmp.bid === bid) cmp.data = r.campaign;
      setHtml("cmp-msg", "");
    } catch (e) {
      setHtml("cmp-msg", notice("error", "Your change was not saved", e.message));
    }
  });
  return editQueue;
}

const stepHead = (n, title, sub, actions) => html`<div class="step-head">
  ${n ? html`<span class="step-no" aria-hidden="true">${n}</span>` : ""}
  <div class="step-title-wrap"><h2>${title}</h2>${sub ? html`<div class="card-sub">${sub}</div>` : ""}</div>
  <div class="step-actions">${actions || ""}</div>
</div>`;
const working = (text, job, hint) => html`<div class="ai-progress" aria-live="polite">${ICON.spinner}<div><strong>${text}</strong>
  <div class="muted">${fmtElapsed(job.elapsed)}${hint ? ` · ${hint}` : ""}</div></div></div>`;
const failed = (job, title) => (job && job.status === "error" ? notice("error", title, job.error || "Unknown error.") : "");
const needsClaude = html`<p class="empty-note">Needs Claude: put the Anthropic API key in the .env file and restart the app.</p>`;

// ---------- step 3: buyers ----------

function renderBuyersTab() {
  return html`<div id="cmp-msg"></div>
    <section class="card cmp-step" id="cmp-brief">${renderBriefStep()}</section>
    <section class="card cmp-step">
      <div id="cmp-buyers-head">${renderBuyersHead()}</div>
      <div id="cmp-buyers-body">${renderBuyersBody()}</div>
    </section>`;
}

function renderBriefStep() {
  const b = cmp.data.brief;
  const job = cmp.jobs.brief;
  const running = job && job.status === "running";
  const button = state.ai.configured
    ? html`<button type="button" class="btn ${b ? "" : "primary"}" data-action="cmp-brief" ${running ? "disabled" : ""}>${b ? "Rewrite" : "Write seller story"}</button>` : "";
  const head = stepHead("A", "Seller story: background and potential",
    b ? `By ${b.model} · ${fmtDateTime(b.created_at)}` : "What buyers need to hear, and which buyers to look for", button);
  if (!state.ai.configured) return html`${head}${needsClaude}`;
  if (running) return html`${head}${working("Claude is writing the seller story and the buyer search plan…", job, "usually about a minute")}`;
  const err = failed(job, "The seller story failed");
  if (!b) {
    return html`${head}${err}<p class="empty-note">Claude reads the company's facts and writes its background, its potential for a buyer, what buyers will ask, and an anonymous teaser for the emails. It also suggests which kinds of companies could buy it and where to look.</p>`;
  }
  const facts = factMap(b.facts);
  const list = (items) => html`<ul>${(items || []).map((t) => html`<li>${cited(t, "brief", facts)}</li>`)}</ul>`;
  return html`${head}${err}
    <div class="brief-grid">
      <div><h3>Background</h3>${list(b.background)}</div>
      <div><h3>Potential for a buyer</h3>${list(b.potential)}</div>
      <div><h3>What buyers will ask</h3>${list(b.deal_notes)}</div>
    </div>
    <label class="field teaser-field">Anonymous teaser <span class="muted">(describes the company in the emails; edit freely)</span>
      <textarea id="cmp-teaser" rows="3">${cmp.data.teaser || ""}</textarea>
    </label>
    <div class="buyer-types">
      <h3>Buyers to look for</h3>
      <ul>${(b.buyer_types || []).map((t) => html`<li>${badge("acc", RELATION[t.relation] || t.relation)}
        <strong>${t.label}</strong><span class="muted"> · ${t.reason}</span>
        <span class="codes" title="Industry codes searched in the trade register">${(t.industry_codes || []).join(", ")}</span></li>`)}</ul>
      <p class="muted search-area">Search area: ${(b.search_areas || []).join(", ")}</p>
    </div>`;
}

function renderBuyersHead() {
  const c = cmp.data;
  const job = cmp.jobs.find;
  const running = job && job.status === "running";
  const n = c.buyers.length;
  const selected = c.buyers.filter((b) => b.selected).length;
  const research = cmp.jobs.research && cmp.jobs.research.status === "running";
  const missing = needContact().length;
  const button = state.ai.configured ? html`
    ${missing ? html`<button type="button" class="btn" data-action="cmp-contacts" ${research ? "disabled" : ""} title="Looks up each selected buyer in full, reading all its website pages, to find who to write to">Find contacts (${missing})</button>` : ""}
    <button type="button" class="btn ${n ? "" : "primary"}" data-action="cmp-find" ${running ? "disabled" : ""}>${n ? "Search again" : "Find buyers"}</button>` : "";
  return stepHead("B", "Potential buyers",
    n ? `${plural(n, "candidate", "candidates")} · ${selected} selected for emails` : "Companies that could want to buy it, checked against their accounts", button);
}

function renderBuyersBody() {
  const c = cmp.data;
  const job = cmp.jobs.find;
  if (job && job.status === "running") {
    return html`<div class="progress-inline">${renderSteps(job.log || [], true)}<div class="muted">${fmtElapsed(job.elapsed)} · usually 2–4 minutes; you can keep working meanwhile</div></div>`;
  }
  if (!state.ai.configured) return needsClaude;
  const note = job && job.status === "done" && job.items && job.items[0] && job.items[0].note;
  const research = cmp.jobs.research;
  const researching = research && research.status === "running"
    ? working(`Finding contacts: ${(research.items || []).filter((i) => !["queued", "running"].includes(i.status)).length} of ${(research.items || []).length || "…"} buyers looked up`, research, "each buyer's whole website is read")
    : failed(research, "Finding contacts failed");
  const top = html`${failed(job, "The buyer search failed")}${note ? notice("info", "Search finished", note) : ""}${researching}`;
  const add = cmp.jobs.add;
  const adding = add && add.status === "running";
  const addForm = c.brief ? html`
    <form id="add-buyer" class="add-buyer" autocomplete="off">
      <input id="add-buyer-q" type="text" placeholder="Add a buyer you know: name or Business ID" aria-label="Add a buyer by name or Business ID">
      <button type="submit" class="btn" ${adding ? "disabled" : ""}>Add</button>
    </form>
    ${adding ? html`<div class="muted add-progress">${ICON.spinner} ${((add.log || []).slice(-1)[0] || "Adding…").replace(/^→\s*/, "")}</div>` : ""}
    ${failed(add, "Could not add that buyer")}` : "";
  if (!c.buyers.length) {
    return html`${top}<p class="empty-note">The app searches the PRH trade register for the kinds of companies in the seller story, in and around this company's town. It checks their financial statements to see who could afford it and reads the best matches' websites, then Claude ranks them by fit. This takes 2–4 minutes.</p>${addForm}`;
  }
  const st = c.search;
  return html`${top}
    ${st ? html`<p class="muted search-stats">Searched ${(st.areas || []).join(", ")}: ${st.matching} active companies in the right industries, ${st.with_financials} with digital accounts; the best ${st.shortlisted} were scored by Claude.</p>` : ""}
    <ol class="buyer-list">${c.buyers.map(renderBuyer)}</ol>
    ${addForm}`;
}

const fitClass = (fit) => (fit >= 70 ? "high" : fit >= 50 ? "mid" : "low");

function finLine(b) {
  if (b.revenue == null && b.net_profit == null) return html`<span class="muted">No digital financial statements</span>`;
  return html`Revenue <strong>${eurCompact(b.revenue)}</strong>${b.revenue_growth_pct != null ? html` <span class="muted">(${signed(b.revenue_growth_pct)})</span>` : ""}
    · net profit ${eurCompact(b.net_profit)}${b.equity_ratio_pct != null ? html` · equity ratio ${pct(b.equity_ratio_pct)}` : ""}${b.fiscal_year_end ? html` <span class="muted">(${b.fiscal_year_end.slice(0, 4)})</span>` : ""}`;
}

function renderBuyer(b) {
  const meta = [
    b.municipality ? titleCase(b.municipality) : b.search_town ? `found searching ${b.search_town}` : null,
    b.industry ? `${b.industry} (${b.industry_code})` : null,
    b.company_age_years != null ? `${Math.floor(b.company_age_years)} years old` : null,
    b.in_employer_register ? "has employees" : "no employees registered",
  ].filter(Boolean).join(" · ");
  const src = b.sources || {};
  const saved = companyRow(b.business_id);
  return html`<li class="buyer ${b.selected ? "selected" : ""}">
    <label class="buyer-pick" title="Include in the emails"><input type="checkbox" data-select="${b.business_id}" ${b.selected ? "checked" : ""} aria-label="Include ${b.name} in the emails"></label>
    <div class="buyer-main">
      <div class="buyer-top">
        <strong class="buyer-name">${b.name}</strong>
        ${badge("", RELATION[b.relation] || "Candidate")}
        ${b.added === "manual" ? badge("", "Added by you") : ""}
        <span class="fit ${fitClass(b.fit)}" title="Fit score from Claude, 0–100">${b.fit ?? "–"}</span>
      </div>
      <div class="buyer-meta">${meta}</div>
      <div class="buyer-fin">${finLine(b)}</div>
      ${b.why ? html`<p class="buyer-why">${b.why}</p>` : ""}
      ${b.concerns ? html`<p class="buyer-concern">But: ${b.concerns}</p>` : ""}
      <div class="buyer-links">
        ${b.contact_email ? html`<span>✉ ${b.contact_name ? `${b.contact_name} · ` : ""}${b.contact_email}</span>`
          : b.contact_checked ? html`<span class="warn-text" title="Researched in full; add the address to its email by hand">No email found${b.has_website === false ? ": it has no website" : " on its website"}</span>`
          : html`<span class="warn-text">No email address found yet</span>`}
        <button type="button" class="linkish strong" data-action="open-buyer" data-buyer="${b.business_id}">${saved ? "Open company" : "Research this buyer"}</button>
        ${src.registry ? extLink(src.registry, "YTJ record") : ""}
        ${src.financials ? extLink(src.financials, "financial statement") : ""}
        ${b.website ? extLink(b.website, "website") : ""}
        <button type="button" class="linkish" data-action="cmp-remove" data-buyer="${b.business_id}">Remove</button>
      </div>
    </div>
  </li>`;
}

// ---------- step 4: outreach ----------

function renderOutreachTab() {
  const c = cmp.data;
  if (!c.buyers.length) {
    return html`<section class="card cmp-step">${stepHead(null, "Outreach emails", "A personal first email to each selected buyer")}
      <p class="empty-note">Find buyers first, then choose who to contact.</p>
      <a class="btn primary" href="${tabHref("buyers")}">Go to Buyers →</a></section>`;
  }
  return html`<div id="cmp-msg"></div>
    <section class="card cmp-step">
      <div id="cmp-emails-head">${renderEmailsHead()}</div>
      ${renderEmailsForm()}
      <div id="cmp-emails-progress">${renderEmailsProgress()}</div>
      <ol id="cmp-emails-list" class="email-list">${renderEmailsList()}</ol>
      <div id="cmp-emails-foot">${renderEmailsFoot()}</div>
    </section>`;
}

function renderEmailsHead() {
  const c = cmp.data;
  const selected = c.buyers.filter((b) => b.selected).length;
  const emails = Object.values(c.emails || {});
  const sent = emails.filter((e) => e.status !== "draft").length;
  const interested = emails.filter((e) => e.status === "interested").length;
  const due = Object.keys(c.emails || {}).filter((id) => followUpDue(c.emails[id]));
  const running = (cmp.jobs.emails && cmp.jobs.emails.status === "running") || (cmp.jobs.followup && cmp.jobs.followup.status === "running");
  const s = effectiveSender();
  const ready = s.name && s.email;
  const button = state.ai.configured ? html`
    ${due.length ? html`<button type="button" class="btn" data-action="cmp-followups" data-ids="${due.join(",")}" ${running ? "disabled" : ""}>Write ${plural(due.length, "follow-up", "follow-ups")}</button>` : ""}
    <button type="button" class="btn ${emails.length ? "" : "primary"}" data-action="cmp-emails" ${running || !selected || !ready ? "disabled" : ""}>Write ${plural(selected, "email", "emails")}</button>` : "";
  const sub = !ready ? "Add at least your name and email below"
    : !selected ? "Select buyers in the Buyers step"
    : emails.length ? [plural(emails.length, "email", "emails"), `${sent} sent`, interested ? `${interested} interested` : "", due.length ? `${due.length} follow-ups due` : ""].filter(Boolean).join(" · ")
    : `A personal first email to each of the ${selected} selected buyers`;
  return stepHead(null, "Outreach emails", sub, button);
}

function renderEmailsForm() {
  const c = cmp.data;
  const s = effectiveSender();
  const field = (key, label, placeholder = "", type = "text") => html`<label class="field">${label}
    <input type="${type}" data-sender="${key}" value="${s[key] || ""}" placeholder="${placeholder}"></label>`;
  return html`<div class="email-setup">
    <div class="sender-grid">
      ${field("name", "Your name")}
      ${field("title", "Title", "e.g. M&A advisor")}
      ${field("company", "Company")}
      ${field("email", "Email", "you@company.fi", "email")}
      ${field("phone", "Phone")}
    </div>
    <div class="email-opts">
      <span class="muted">Language</span>
      <label class="check"><input type="radio" name="cmp-lang" value="en" ${c.language !== "fi" ? "checked" : ""}> English</label>
      <label class="check"><input type="radio" name="cmp-lang" value="fi" ${c.language === "fi" ? "checked" : ""}> Suomi</label>
      <label class="check"><input type="checkbox" id="cmp-anon" ${c.anonymous !== false ? "checked" : ""}> Keep the seller anonymous</label>
      <span class="muted">Recommended: buyers learn the name after signing an NDA.</span>
    </div>
  </div>`;
}

function renderEmailsProgress() {
  const job = cmp.jobs.followup && (cmp.jobs.followup.status === "running" || !cmp.jobs.emails) ? cmp.jobs.followup : cmp.jobs.emails;
  if (!job) return "";
  const items = job.items || [];
  if (job.status === "running") {
    const done = items.filter((i) => i.status === "done" || i.status === "error").length;
    return working(`Claude is writing the emails: ${done} of ${items.length || "…"} done`, job, "about 30 seconds each, a few at a time");
  }
  if (job.status === "error") return failed(job, "The emails could not be written");
  const errors = items.filter((i) => i.status === "error");
  return errors.length ? notice("error", `${plural(errors.length, "email", "emails")} could not be written`,
    errors.map((i) => `${i.name || i.query}: ${i.note}`).join(" · ")) : "";
}

function renderEmailsList() {
  const c = cmp.data;
  return c.buyers.filter((b) => (c.emails || {})[b.business_id]).map((b) => renderEmail(b, c.emails[b.business_id]));
}

const renderWarnings = (e) => ((e.warnings || []).length
  ? html`<ul class="email-warn">${e.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : "");

function renderEmail(b, e) {
  const id = b.business_id;
  const status = STATUS_LABEL[e.status] ? e.status : "draft";
  return html`<li class="email status-${status}" id="email-${id}">
    <div class="email-top">
      <strong>${b.name}</strong>
      ${badge(STATUS_BADGE[status], STATUS_LABEL[status])}
      ${followUpDue(e) ? badge("warn", "Follow-up due") : ""}
      ${b.selected ? "" : badge("", "Not selected")}
      ${e.sent_at && status !== "draft" ? html`<span class="muted email-date">sent ${fmtDate(e.sent_at)}</span>` : ""}
      <span class="fit ${fitClass(b.fit)}" title="Fit score">${b.fit ?? "–"}</span>
    </div>
    <div id="warn-${id}">${renderWarnings(e)}</div>
    <label class="field">To<input type="email" data-email="${id}" data-field="to" value="${e.to || ""}" placeholder="name@company.fi"></label>
    <label class="field">Subject<input type="text" data-email="${id}" data-field="subject" value="${e.subject || ""}"></label>
    <label class="field">Message<textarea data-email="${id}" data-field="body" rows="13">${e.body || ""}</textarea></label>
    <div class="email-actions">
      <button type="button" class="btn small" data-action="email-copy" data-buyer="${id}">Copy</button>
      <button type="button" class="btn small" data-action="email-open" data-buyer="${id}">Open in email app</button>
      ${status === "draft" ? html`<button type="button" class="btn small" data-action="email-rewrite" data-buyer="${id}">Rewrite</button>` : ""}
      <label class="status-pick">Status
        <select data-email-status="${id}">${Object.entries(STATUS_LABEL).map(([k, v]) => html`<option value="${k}" ${k === status ? "selected" : ""}>${k === "interested" || k === "not_interested" ? `Replied: ${v.toLowerCase()}` : v}</option>`)}</select>
      </label>
      ${status === "sent" && !e.follow_up ? html`<button type="button" class="btn small" data-action="email-followup" data-buyer="${id}" title="Claude writes a short follow-up to this email">Write follow-up</button>` : ""}
    </div>
    ${e.follow_up ? renderFollowUp(id, e.follow_up) : ""}
    ${status === "interested" ? html`<p class="email-next">Next with this buyer: send your NDA; once it's signed, share the company's name and full profile and set up a call.</p>` : ""}
  </li>`;
}

function renderFollowUp(id, f) {
  const sent = f.status === "sent";
  return html`<div class="follow-up">
    <div class="email-top"><strong>Follow-up</strong> ${badge(sent ? "acc" : "", sent ? "Sent" : "Draft")}</div>
    <div id="fwarn-${id}">${renderWarnings(f)}</div>
    <label class="field">Subject<input type="text" data-follow="${id}" data-field="subject" value="${f.subject || ""}"></label>
    <label class="field">Message<textarea data-follow="${id}" data-field="body" rows="8">${f.body || ""}</textarea></label>
    <div class="email-actions">
      <button type="button" class="btn small" data-action="follow-copy" data-buyer="${id}">Copy</button>
      <button type="button" class="btn small" data-action="follow-open" data-buyer="${id}">Open in email app</button>
      ${sent ? "" : html`<button type="button" class="btn small" data-action="email-followup" data-buyer="${id}">Rewrite</button>`}
      <button type="button" class="btn small" data-action="follow-status" data-buyer="${id}" data-status="${sent ? "draft" : "sent"}">${sent ? "Mark as draft" : "Mark as sent"}</button>
    </div>
  </div>`;
}

function renderEmailsFoot() {
  if (!Object.keys(cmp.data.emails || {}).length) {
    return html`<p class="empty-note">Fill in your details, pick the language and write the emails. Claude builds each one around the buyer's own business: why owning this company would make sense for them. Your signature and an opt-out line are added automatically. Nothing is sent from the app.</p>`;
  }
  return html`<div class="email-foot">
    <div><a class="btn" href="/api/campaigns/${cmp.bid}/emails.csv">Download all for mail merge (CSV)</a></div>
    <details class="limits"><summary>How to send them</summary><ul>
      <li>Read every email before it goes out, and check the recipient address.</li>
      <li>A few emails: use "Open in email app" to send each one from your own work address.</li>
      <li>Many emails: load the CSV into a mail-merge tool, for example a Gmail mail-merge add-on or Word's mail merge with Outlook, using the columns to, subject and body.</li>
      <li>Send from a real person's business address, a handful per day, and follow up once after about a week. Stop if someone says no.</li>
      <li>Set each email's status as you go: sent, then the buyer's answer. After a week without an answer, the app suggests a follow-up.</li>
      <li>When a buyer is interested: send your NDA, and only then the company's name and full profile.</li>
    </ul></details>
  </div>`;
}

// ---------- jobs ----------

function redrawFor(kind) {
  if (!cmp.data || state.route.view !== "company") return;
  if (kind === "brief") setHtml("cmp-brief", renderBriefStep());
  if (kind === "find" || kind === "add" || kind === "brief") {
    setHtml("cmp-buyers-head", renderBuyersHead());
    setHtml("cmp-buyers-body", renderBuyersBody());
  }
  if (kind === "research") {
    setHtml("cmp-buyers-head", renderBuyersHead());
    setHtml("cmp-buyers-body", renderBuyersBody());
  }
  if (kind === "emails" || kind === "followup") {
    setHtml("cmp-emails-head", renderEmailsHead());
    setHtml("cmp-emails-progress", renderEmailsProgress());
  }
  refreshSteps();
}

// Follow a campaign job until it ends, then reload the campaign and the pipeline.
function followCampaignJob(kind, job) {
  const bid = cmp.bid;
  const slot = (cmp.jobs[kind] = { jobId: job.id, timer: null, status: "running", log: [], items: job.items || [], elapsed: job.elapsed || 0 });
  redrawFor(kind);
  poll(slot, job.id, async (j) => {
    if (!j) {
      Object.assign(slot, { status: "error", error: "The app was restarted while this was running. Try again." });
    } else {
      Object.assign(slot, { elapsed: j.elapsed, items: j.items, log: (j.items[0] && j.items[0].log) || [] });
      if (j.status !== "running") {
        const errors = j.items.filter((i) => i.status === "error");
        const allFailed = !["emails", "followup", "research"].includes(kind) && errors.length === j.items.length;
        Object.assign(slot, { status: allFailed ? "error" : "done", error: allFailed ? errors[0].note : null });
        await Promise.all([reloadCampaign(bid), loadCompanies()]);
        if (cmp.bid === bid && state.route.view === "company") refreshWorkspace();
        return;
      }
    }
    if (cmp.bid === bid) redrawFor(kind);
  });
}

async function startCampaignJob(kind, body = {}) {
  const bid = cmp.bid;
  cmp.jobs[kind] = { status: "running", log: [], items: [], elapsed: 0 };
  redrawFor(kind);
  try {
    const job = await api(`/api/campaigns/${bid}/${JOB_PATHS[kind]}`, { method: "POST", body: JSON.stringify(body) });
    refreshActivity();
    if (cmp.bid === bid) followCampaignJob(kind, job);
  } catch (e) {
    cmp.jobs[kind] = { status: "error", error: e.message };
    redrawFor(kind);
  }
}

// ---------- editing ----------

const fieldValue = (id, field) => {
  const el = document.querySelector(`[data-email="${id}"][data-field="${field}"]`);
  return el ? el.value : "";
};

const followValue = (id, field) => {
  const el = document.querySelector(`[data-follow="${id}"][data-field="${field}"]`);
  return el ? el.value : "";
};

function mailto(to, subject, body) {
  return `mailto:${EMAIL_OK.test(to.trim()) ? to.trim() : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
const mailtoFor = (id) => mailto(fieldValue(id, "to"), fieldValue(id, "subject"), fieldValue(id, "body"));

async function startContactSearch() {
  const targets = needContact().map((b) => b.business_id);
  if (!targets.length) return;
  const seller = cmp.bid;
  cmp.jobs.research = { status: "running", items: [], log: [], elapsed: 0 };
  redrawFor("research");
  try {
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify({
      kind: "batch", queries: targets, with_financials: true, with_website: true, with_ai: false, seller,
      title: `Finding contacts for ${plural(targets.length, "buyer", "buyers")} of ${cmp.seller.name}` }) });
    refreshActivity();
    if (cmp.bid === seller) followCampaignJob("research", job);
  } catch (e) {
    cmp.jobs.research = { status: "error", error: e.message };
    redrawFor("research");
  }
}

// After an email or follow-up changes: redraw its card, the counts and the workflow steps.
function redrawEmail(id) {
  const b = cmp.data.buyers.find((x) => x.business_id === id);
  const cardEl = document.getElementById(`email-${id}`);
  if (b && cardEl && cmp.data.emails[id]) cardEl.outerHTML = part(renderEmail(b, cmp.data.emails[id]));
  setHtml("cmp-emails-head", renderEmailsHead());
  loadCompanies();
  refreshSteps();
}

async function saveField(el) {
  if (el.id === "cmp-teaser") return edit({ teaser: el.value });
  if (el.dataset.sender) {
    const sender = {};
    $$("[data-sender]").forEach((i) => { sender[i.dataset.sender] = i.value.trim(); });
    cmp.data.sender = sender;
    pref.set("sender", sender);
    setHtml("cmp-emails-head", renderEmailsHead());
    return edit({ sender });
  }
  if (el.dataset.email) {
    const id = el.dataset.email;
    await edit({ email: { buyer: id, [el.dataset.field]: el.value } });
    if (cmp.data.emails[id]) setHtml(`warn-${id}`, renderWarnings(cmp.data.emails[id]));
  }
  if (el.dataset.follow) {
    const id = el.dataset.follow;
    await edit({ follow_up: { buyer: id, [el.dataset.field]: el.value } });
    const f = cmp.data.emails[id] && cmp.data.emails[id].follow_up;
    if (f) setHtml(`fwarn-${id}`, renderWarnings(f));
  }
}

async function flushActiveField() {
  const el = document.activeElement;
  if (el && el.closest && el.closest("#ws-body") && (el.dataset.email || el.dataset.follow || el.dataset.sender || el.id === "cmp-teaser")) {
    await saveField(el);
  }
}

// A buyer is a company too: open it in its own workspace, looking it up first if needed.
function openBuyer(buyerBid) {
  const seller = cmp.bid;
  if (companyRow(buyerBid)) location.hash = `#/c/${buyerBid}/research?from=${seller}`;
  else startAdd([buyerBid], { from: seller });
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || !cmp.bid || !el.closest("#ws-body")) return;
  const id = el.dataset.buyer;
  switch (el.dataset.action) {
    case "cmp-brief": startCampaignJob("brief"); break;
    case "cmp-find": startCampaignJob("find"); break;
    case "open-buyer": openBuyer(id); break;
    case "cmp-emails": {
      await flushActiveField();
      const sender = {};
      $$("[data-sender]").forEach((i) => { sender[i.dataset.sender] = i.value.trim(); });
      if (JSON.stringify(sender) !== JSON.stringify(cmp.data.sender || {})) edit({ sender });
      await editQueue; // the server must have the latest sender details
      startCampaignJob("emails", { buyer_ids: cmp.data.buyers.filter((b) => b.selected).map((b) => b.business_id) });
      break;
    }
    case "email-rewrite":
      await flushActiveField();
      await editQueue;
      startCampaignJob("emails", { buyer_ids: [id] });
      break;
    case "email-copy":
      try {
        await navigator.clipboard.writeText(`Subject: ${fieldValue(id, "subject")}\n\n${fieldValue(id, "body")}`);
        el.textContent = "Copied";
        setTimeout(() => { el.textContent = "Copy"; }, 1200);
      } catch { /* clipboard blocked */ }
      break;
    case "email-open": window.location.href = mailtoFor(id); break;
    case "cmp-contacts": startContactSearch(); break;
    case "email-followup":
      await flushActiveField();
      await editQueue;
      startCampaignJob("followup", { buyer_ids: [id] });
      break;
    case "cmp-followups":
      startCampaignJob("followup", { buyer_ids: el.dataset.ids.split(",") });
      break;
    case "follow-copy":
      try {
        await navigator.clipboard.writeText(`Subject: ${followValue(id, "subject")}\n\n${followValue(id, "body")}`);
        el.textContent = "Copied";
        setTimeout(() => { el.textContent = "Copy"; }, 1200);
      } catch { /* clipboard blocked */ }
      break;
    case "follow-open": window.location.href = mailto(fieldValue(id, "to"), followValue(id, "subject"), followValue(id, "body")); break;
    case "follow-status":
      await flushActiveField();
      await edit({ follow_up: { buyer: id, status: el.dataset.status } });
      redrawEmail(id);
      break;
    case "cmp-remove":
      if (el.dataset.confirm !== "1") { // ask once more, inline
        el.dataset.confirm = "1";
        el.textContent = "Click again to remove";
        setTimeout(() => { el.dataset.confirm = ""; el.textContent = "Remove"; }, 3000);
        break;
      }
      await edit({ remove_buyer: id });
      refreshWorkspace();
      break;
    default:
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (!cmp.bid || !el.closest || !el.closest("#ws-body")) return;
  if (el.dataset.select) {
    const b = cmp.data.buyers.find((x) => x.business_id === el.dataset.select);
    if (b) b.selected = el.checked;
    el.closest(".buyer").classList.toggle("selected", el.checked);
    setHtml("cmp-buyers-head", renderBuyersHead());
    refreshSteps();
    edit({ selected: { [el.dataset.select]: el.checked } });
  } else if (el.dataset.emailStatus) {
    const id = el.dataset.emailStatus;
    flushActiveField().then(() => edit({ email: { buyer: id, status: el.value } })).then(() => redrawEmail(id));
  } else if (el.name === "cmp-lang") {
    edit({ language: el.value });
  } else if (el.id === "cmp-anon") {
    edit({ anonymous: el.checked });
  } else if (el.dataset.sender || el.dataset.email || el.dataset.follow || el.id === "cmp-teaser") {
    saveField(el);
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "add-buyer") return;
  e.preventDefault();
  const q = $("#add-buyer-q").value.trim();
  if (q) startCampaignJob("add", { query: q });
});
