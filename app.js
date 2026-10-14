"use strict";
/*
 * Bible Tracker. Data model:
 *   store.base    = last copy of the sheet: { "genesis 1": ["2025-07-01", "2026-08-01"], ... }
 *   store.pending = changes not yet confirmed by the sheet: [{ id, op: "add"|"remove", ch, key, date }]
 *   reads         = base + pending replayed = what the app shows.
 * Sync sends the pending ops to the Apps Script, which writes them into the sheet and
 * returns the full sheet state; that becomes the new base. Without sync set up,
 * everything simply stays in pending on this device.
 */

const APP_VERSION = "1.0.0";
const STORE_KEY = "bibletracker.v1";
const DEFAULT_SETTINGS = { url: "", token: "", theme: "auto", version: "NIV" };
const VERSIONS = ["NIV", "ESV", "KJV", "NKJV", "NLT", "CSB", "NASB"];

const KEY_TO_REF = {};
BOOKS.forEach(b => { for (let c = 1; c <= b.chapters; c++) KEY_TO_REF[chKey(b, c)] = { book: b, ch: c }; });

let store = loadStore();
let reads = {};
const ui = { logDate: null, mode: "log", testament: "OT", pass: null };
const $ = sel => document.querySelector(sel);

/* ---------------- Storage ---------------- */

function loadStore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* private mode or corrupt */ }
  s = s && typeof s === "object" ? s : {};
  return {
    base: s.base || {},
    pending: Array.isArray(s.pending) ? s.pending : [],
    settings: Object.assign({}, DEFAULT_SETTINGS, s.settings),
    lastSync: s.lastSync || null,
    snapshotCreated: s.snapshotCreated || null,
    lastError: s.lastError || null,
    problems: s.problems || [],
    unmatched: s.unmatched || { sheetOnly: [], missing: [] },
  };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch (e) { toast("Couldn't save on this device (storage blocked or full)."); }
}

/* ---------------- Dates ---------------- */

const pad = n => String(n).padStart(2, "0");
const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoToUtc(iso) { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); }
function addDays(iso, n) { const d = new Date(isoToUtc(iso) + n * 864e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function daysBetween(a, b) { return Math.round((isoToUtc(b) - isoToUtc(a)) / 864e5); }
function fmtDate(iso, opts) {
  if (!isIso(iso)) return String(iso);
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" });
}
const fmtMonth = iso => fmtDate(iso, { month: "short", year: "numeric" });
function cmpDate(a, b) { // non-date text first, then chronological
  const ia = isIso(a), ib = isIso(b);
  if (ia !== ib) return ia ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ---------------- Reads & ops ---------------- */

function recompute() {
  reads = {};
  for (const k in store.base) reads[k] = store.base[k].slice();
  store.pending.forEach(op => applyOp(reads, op));
}

function applyOp(r, op) {
  const arr = r[op.key] || (r[op.key] = []);
  if (op.op === "add") { arr.push(op.date); arr.sort(cmpDate); }
  else { const i = arr.lastIndexOf(op.date); if (i >= 0) arr.splice(i, 1); }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const label = (book, ch) => `${book.name} ${ch}`;
const countOf = key => (reads[key] || []).length;

function addRead(book, ch, date) {
  store.pending.push({ id: uid(), op: "add", ch: label(book, ch), key: chKey(book, ch), date });
  changed();
}

function removeRead(book, ch, date) {
  const key = chKey(book, ch);
  // If the add hasn't been uploaded yet, just drop it instead of queuing a remove.
  for (let i = store.pending.length - 1; i >= 0; i--) {
    const p = store.pending[i];
    if (p.key === key && p.date === date && p.op === "add") { store.pending.splice(i, 1); changed(); return; }
    if (p.key === key && p.date === date) break;
  }
  store.pending.push({ id: uid(), op: "remove", ch: label(book, ch), key, date });
  changed();
}

function changed() {
  save(); recompute(); render(); scheduleSync();
  if (navigator.vibrate) navigator.vibrate(8);
}

/* ---------------- Derived numbers ---------------- */

function allEntries() { // [{key, date}]
  const out = [];
  for (const k in reads) if (KEY_TO_REF[k]) reads[k].forEach(date => out.push({ key: k, date }));
  return out;
}

function maxPass() {
  let m = 0;
  for (const k in KEY_TO_REF) m = Math.max(m, countOf(k));
  return m;
}

function passCounts(k) { // chapters read at least k times
  const c = { OT: 0, NT: 0, ALL: 0 };
  for (const key in KEY_TO_REF) if (countOf(key) >= k) { c[KEY_TO_REF[key].book.testament]++; c.ALL++; }
  return c;
}

function currentPass() { // lowest read-through that isn't finished
  const m = maxPass();
  for (let k = 1; k <= m; k++) if (passCounts(k).ALL < TOTALS.ALL) return k;
  return m + 1;
}

function bookInfo(b) {
  let last = null; const counts = [];
  for (let c = 1; c <= b.chapters; c++) {
    const arr = reads[chKey(b, c)] || [];
    counts.push(arr.length);
    const d = arr.filter(isIso).pop();
    if (d && (!last || d > last)) last = d;
  }
  return { counts, last, atLeast: k => counts.filter(n => n >= k).length };
}

function streaks() {
  const days = [...new Set(allEntries().map(e => e.date).filter(isIso))].sort();
  const has = new Set(days);
  let d = todayIso(); if (!has.has(d)) d = addDays(d, -1);
  let current = 0; while (has.has(d)) { current++; d = addDays(d, -1); }
  let best = 0, run = 0;
  days.forEach((x, i) => { run = i && daysBetween(days[i - 1], x) === 1 ? run + 1 : 1; best = Math.max(best, run); });
  return { current, best };
}

// "Continue" suggestions: the chapter after the most recent read in each recently-read book.
function suggestions(limit) {
  const latest = [];
  BOOKS.forEach(b => {
    let best = null;
    for (let c = 1; c <= b.chapters; c++) {
      const d = (reads[chKey(b, c)] || []).filter(isIso).pop();
      if (d && (!best || d > best.date || (d === best.date && c > best.ch))) best = { book: b, ch: c, date: d };
    }
    if (best) latest.push(best);
  });
  latest.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const out = [], seenBooks = new Set();
  for (const l of latest) {
    let book = l.book, ch = l.ch + 1;
    if (ch > book.chapters) { book = BOOKS[(book.id + 1) % BOOKS.length]; ch = 1; }
    if (seenBooks.has(book.id)) continue; // one suggestion per book, from its most recent read
    seenBooks.add(book.id); out.push({ book, ch, after: l });
    if (out.length >= limit) break;
  }
  if (!out.length) out.push({ book: BOOKS[0], ch: 1, after: null });
  return out;
}

function booksBySinceRead() {
  return BOOKS.map(b => ({ book: b, last: bookInfo(b).last }))
    .sort((a, b) => (a.last || "") < (b.last || "") ? -1 : (a.last || "") > (b.last || "") ? 1 : a.book.id - b.book.id);
}

/* ---------------- Rendering helpers ---------------- */

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = n => n.toLocaleString();
const pct = (a, b) => (b ? (100 * a / b) : 0);
const pctTxt = (a, b) => { const p = pct(a, b); return (p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)) + "%"; };
const bar = (a, b) => `<div class="bar"><i style="width:${pct(a, b).toFixed(1)}%"></i></div>`;
const readUrl = (book, ch) => `https://www.biblegateway.com/passage/?search=${encodeURIComponent(label(book, ch))}&version=${encodeURIComponent(store.settings.version)}`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_OPEN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;

function route() {
  const h = location.hash.replace(/^#/, "") || "today";
  const [name, arg] = h.split("/");
  return { name, arg };
}

function render() {
  const r = route();
  const tab = r.name === "book" ? "books" : r.name;
  document.querySelectorAll(".tabbar button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("#backBtn").hidden = r.name !== "book";
  const view = $("#view");
  // Redraws (e.g. when the app comes back into view) must not wipe text typed but not yet saved.
  const typed = ["setUrl", "setToken"].map(id => [id, document.getElementById(id) && document.getElementById(id).value]);
  let html = "";
  if (r.name === "book" && BOOKS[+r.arg]) html = viewBook(BOOKS[+r.arg]);
  else if (r.name === "books") html = viewBooks();
  else if (r.name === "stats") html = viewStats();
  else if (r.name === "settings") html = viewSettings();
  else html = viewToday();
  view.innerHTML = html;
  typed.forEach(([id, v]) => { const el = document.getElementById(id); if (el && v) el.value = v; });
  renderPill();
}

function setTitle(t) { $("#title").textContent = t; document.title = t === "Today" ? "Bible Tracker" : `${t} · Bible Tracker`; }

/* ---------------- Views ---------------- */

function viewToday() {
  setTitle("Today");
  const today = todayIso();
  const m = Math.max(1, maxPass());
  let passes = "";
  for (let k = 1; k <= m; k++) {
    const c = passCounts(k).ALL;
    passes += `<div class="pass-line"><div class="row spread"><b>Read-through ${k}</b><span class="muted">${num(c)} / ${num(TOTALS.ALL)} · ${pctTxt(c, TOTALS.ALL)}</span></div>${bar(c, TOTALS.ALL)}</div>`;
  }
  const entries = allEntries();
  const week = entries.filter(e => isIso(e.date) && e.date >= addDays(today, -6) && e.date <= today).length;
  const year = entries.filter(e => e.date.startsWith(today.slice(0, 4))).length;
  const st = streaks();

  const next = suggestions(3).map(s => `
    <div class="card next-card">
      <div class="info">
        <div class="ref">${esc(label(s.book, s.ch))}</div>
        <div class="sub">${s.after ? `After ${esc(label(s.after.book, s.after.ch))} · ${fmtDate(s.after.date, { month: "short", day: "numeric" })}` : "Start at the beginning"}</div>
      </div>
      <div class="actions">
        <a class="btn sm ghost" href="${readUrl(s.book, s.ch)}" target="_blank" rel="noopener" aria-label="Read ${esc(label(s.book, s.ch))} online">${ICON_OPEN}</a>
        <button class="btn sm primary" data-action="quick-log" data-book="${s.book.id}" data-ch="${s.ch}">${ICON_CHECK} Read</button>
      </div>
    </div>`).join("");

  const todays = entries.filter(e => e.date === today).map(e => KEY_TO_REF[e.key])
    .sort((a, b) => a.book.id - b.book.id || a.ch - b.ch);
  const todayList = todays.length
    ? `<ul class="list">${todays.map(r => `<li><span class="grow">${esc(label(r.book, r.ch))}</span>
        <button class="btn sm ghost" data-action="unlog" data-book="${r.book.id}" data-ch="${r.ch}" data-date="${today}">Undo</button></li>`).join("")}</ul>`
    : `<div class="empty">Nothing logged yet today.</div>`;

  const stale = booksBySinceRead().slice(0, 5).map(x => `<li>
      <button class="linkish row" data-action="open-book" data-book="${x.book.id}">
        <span class="grow">${esc(x.book.name)}</span>
        <span class="chip ${x.last ? "" : "warn"}">${x.last ? `${num(daysBetween(x.last, today))} days` : "Never read"}</span>
      </button></li>`).join("");

  return `
    <p class="date-line">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
    <div class="card">
      <div class="passes">${passes}</div>
      <div class="kpis">
        <div class="kpi"><div class="num">${st.current}</div><div class="lbl">Day streak</div></div>
        <div class="kpi"><div class="num">${week}</div><div class="lbl">This week</div></div>
        <div class="kpi"><div class="num">${num(year)}</div><div class="lbl">This year</div></div>
      </div>
    </div>
    <h3 class="section-title">Continue reading</h3>
    ${next}
    <h3 class="section-title">Logged today</h3>
    <div class="card">${todayList}</div>
    <h3 class="section-title">Longest since you read</h3>
    <div class="card"><ul class="list">${stale}</ul>
      <button class="btn sm ghost block" data-action="go" data-to="stats">See all books</button></div>`;
}

function viewBooks() {
  setTitle("Books");
  const m = maxPass();
  if (ui.pass === null) ui.pass = Math.min(currentPass(), Math.max(1, m));
  const passBtns = [];
  for (let k = 1; k <= Math.max(1, m); k++) passBtns.push(`<button class="${ui.pass === k ? "on" : ""}" data-action="set-pass" data-pass="${k}">Read ${k}</button>`);
  const tiles = BOOKS.filter(b => b.testament === ui.testament).map(b => {
    const info = bookInfo(b), done = info.atLeast(ui.pass);
    return `<button class="book-tile ${done === b.chapters ? "done" : ""}" data-action="open-book" data-book="${b.id}">
        <span class="name">${esc(b.name)}</span>
        ${bar(done, b.chapters)}
        <span class="meta"><span>${done}/${b.chapters}</span><span>${info.last ? fmtMonth(info.last) : "—"}</span></span>
      </button>`;
  }).join("");
  const t = passCounts(ui.pass)[ui.testament], tot = TOTALS[ui.testament];
  return `
    <div class="books-toolbar">
      <div class="seg" role="tablist">
        <button class="${ui.testament === "OT" ? "on" : ""}" data-action="set-testament" data-t="OT">Old Testament</button>
        <button class="${ui.testament === "NT" ? "on" : ""}" data-action="set-testament" data-t="NT">New Testament</button>
      </div>
      ${passBtns.length > 1 ? `<div class="seg">${passBtns.join("")}</div>` : ""}
    </div>
    <p class="muted small" style="margin:8px 2px 12px">Read-through ${ui.pass}: ${num(t)} of ${num(tot)} chapters (${pctTxt(t, tot)})</p>
    <div class="book-grid">${tiles}</div>`;
}

function viewBook(b) {
  setTitle(b.name);
  if (!ui.logDate) ui.logDate = todayIso();
  const info = bookInfo(b);
  const m = Math.max(1, ...info.counts);
  const summary = [];
  for (let k = 1; k <= m; k++) summary.push(`Read ${k}: ${info.atLeast(k)}/${b.chapters}`);
  const cells = info.counts.map((n, i) => {
    const ch = i + 1, onDate = (reads[chKey(b, ch)] || []).includes(ui.logDate);
    return `<button class="ch ${onDate ? "on-date" : ""}" data-n="${Math.min(n, 4)}" data-action="tap-ch" data-book="${b.id}" data-ch="${ch}"
      aria-label="${esc(label(b, ch))}, read ${n} time${n === 1 ? "" : "s"}${onDate ? ", logged on selected date" : ""}">${ch}</button>`;
  }).join("");
  const isToday = ui.logDate === todayIso();
  const prev = BOOKS[b.id - 1], next = BOOKS[b.id + 1];
  return `
    <p class="muted small" style="margin:2px 2px 0">${summary.join(" · ")}${info.last ? ` · last read ${fmtDate(info.last)}` : ""}</p>
    <div class="book-head">
      <div class="seg">
        <button class="${ui.mode === "log" ? "on" : ""}" data-action="set-mode" data-mode="log">Tap to log</button>
        <button class="${ui.mode === "details" ? "on" : ""}" data-action="set-mode" data-mode="details">Tap for details</button>
      </div>
      <label class="logdate">Date
        <input type="date" value="${ui.logDate}" max="${todayIso()}" data-change="log-date" aria-label="Date to log reads on">
        ${isToday ? "" : `<button class="btn sm ghost" data-action="log-today">Today</button>`}
      </label>
    </div>
    <div class="ch-grid">${cells}</div>
    <div class="legend">
      <span><i style="background:var(--heat-0)"></i>Unread</span><span><i style="background:var(--heat-1)"></i>1×</span>
      <span><i style="background:var(--heat-2)"></i>2×</span><span><i style="background:var(--heat-3)"></i>3×</span>
      <span><i style="background:var(--heat-4)"></i>4×+</span><span>· ringed = read on ${isToday ? "today" : fmtDate(ui.logDate)}</span>
    </div>
    <div class="row" style="margin-top:16px; flex-wrap:wrap">
      <button class="btn sm" data-action="range-sheet" data-book="${b.id}">Log several chapters…</button>
      <a class="btn sm ghost" href="${readUrl(b, 1)}" target="_blank" rel="noopener">${ICON_OPEN} Read ${esc(b.name)} 1</a>
    </div>
    <div class="row spread" style="margin-top:18px">
      ${prev ? `<button class="btn sm ghost" data-action="open-book" data-book="${prev.id}">‹ ${esc(prev.name)}</button>` : "<span></span>"}
      ${next ? `<button class="btn sm ghost" data-action="open-book" data-book="${next.id}">${esc(next.name)} ›</button>` : "<span></span>"}
    </div>`;
}

function viewStats() {
  setTitle("Stats");
  const today = todayIso();
  const cols = Math.max(2, maxPass());
  const counts = []; for (let k = 1; k <= cols; k++) counts.push(passCounts(k));
  const head = counts.map((_, i) => `<th>Read ${i + 1}</th>`).join("");
  const rowFor = (lbl, t) => `<tr><td>${lbl}</td>${counts.map(c => `<td>${num(c[t])}<span class="pct">${pctTxt(c[t], TOTALS[t])}</span></td>`).join("")}</tr>`;

  const byMonth = {};
  allEntries().forEach(e => { if (isIso(e.date)) byMonth[e.date.slice(0, 7)] = (byMonth[e.date.slice(0, 7)] || 0) + 1; });
  const months = [];
  const d = new Date(); d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const k = `${x.getFullYear()}-${pad(x.getMonth() + 1)}`;
    months.push({ k, n: byMonth[k] || 0, lbl: x.toLocaleDateString(undefined, { month: "narrow" }) });
  }
  const peak = Math.max(1, ...months.map(x => x.n));
  const st = streaks();
  const total = allEntries().length;

  const list = booksBySinceRead().map(x => `<li>
      <button class="linkish row" data-action="open-book" data-book="${x.book.id}">
        <span class="grow">${esc(x.book.name)}</span>
        <span class="muted small">${x.last ? fmtDate(x.last) : ""}</span>
        <span class="chip ${x.last ? "" : "warn"}">${x.last ? `${num(daysBetween(x.last, today))} d` : "Never"}</span>
      </button></li>`).join("");

  return `
    <div class="card">
      <h2>Progress by read-through</h2>
      <table class="stat-table"><thead><tr><th></th>${head}</tr></thead><tbody>
        ${rowFor(`Old Testament <span class="muted small">(${TOTALS.OT})</span>`, "OT")}
        ${rowFor(`New Testament <span class="muted small">(${TOTALS.NT})</span>`, "NT")}
        ${rowFor(`<b>Whole Bible</b> <span class="muted small">(${num(TOTALS.ALL)})</span>`, "ALL")}
      </tbody></table>
    </div>
    <div class="card">
      <h2>Chapters per month</h2>
      <div class="months">${months.map(x => `<div class="m" title="${x.k}: ${x.n}"><span class="v">${x.n || ""}</span><i style="height:${(100 * x.n / peak).toFixed(0)}%"></i><span>${x.lbl}</span></div>`).join("")}</div>
      <div class="kpis">
        <div class="kpi"><div class="num">${st.current}</div><div class="lbl">Streak</div></div>
        <div class="kpi"><div class="num">${st.best}</div><div class="lbl">Best streak</div></div>
        <div class="kpi"><div class="num">${num(total)}</div><div class="lbl">Reads logged</div></div>
      </div>
    </div>
    <div class="card">
      <h2>What's next: longest since read</h2>
      <ul class="list">${list}</ul>
    </div>`;
}

function viewSettings() {
  setTitle("Settings");
  const s = store.settings, p = store.pending.length;
  const configured = !!(s.url && s.token);
  let status;
  if (!configured && store.snapshotCreated && !store.lastSync) status = `Not connected. Showing a snapshot of your sheet from ${fmtDate(store.snapshotCreated)}. New reads are saved on this device and upload once you connect.`;
  else if (!configured) status = "Not connected. Your reads are saved on this device only.";
  else if (store.lastError) status = `Last sync failed: ${esc(store.lastError)}`;
  else if (store.lastSync) status = `Last synced ${new Date(store.lastSync).toLocaleString()}.`;
  else status = "Connected, not synced yet.";
  const um = store.unmatched || { sheetOnly: [], missing: [] };
  const warn = [];
  if (um.sheetOnly.length) warn.push(`${um.sheetOnly.length} sheet row(s) didn't match a chapter: ${esc(um.sheetOnly.slice(0, 5).join(", "))}${um.sheetOnly.length > 5 ? "…" : ""}`);
  if (um.missing.length) warn.push(`${um.missing.length} chapter(s) have no row in the sheet: ${esc(um.missing.slice(0, 5).join(", "))}${um.missing.length > 5 ? "…" : ""}`);
  (store.problems || []).slice(0, 5).forEach(x => warn.push(esc(x)));
  const theme = t => `<button class="${s.theme === t ? "on" : ""}" data-action="set-theme" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`;

  return `
    <div class="card stack">
      <h2>Sync across devices <span class="muted small">(optional)</span></h2>
      <p class="muted small" style="margin:0">${status}${p ? ` <b>${p} change${p === 1 ? "" : "s"} waiting to upload.</b>` : ""}</p>
      ${warn.length ? `<p class="small" style="margin:0;color:var(--warn)">${warn.join("<br>")}</p>` : ""}
      <label class="field">Web app URL (from Apps Script → Deploy)
        <input id="setUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.url)}"></label>
      <label class="field">Token (cell B1 of the sheet's Setup tab)
        <input id="setToken" type="password" autocomplete="off" spellcheck="false" value="${esc(s.token)}"></label>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn primary" data-action="save-sync">Save & sync</button>
        ${configured ? `<button class="btn" data-action="sync-now">Sync now</button>` : ""}
        ${p ? `<button class="btn ghost danger" data-action="discard-pending">Discard unsynced</button>` : ""}
      </div>
      <p class="muted small" style="margin:0">Keeps your phone and computer in step through a Google Sheet you own. It syncs on its own once connected. Setup steps are in the README. Treat the URL and token like a password.</p>
    </div>
    <div class="card stack">
      <h2>Appearance & reading</h2>
      <div class="row spread"><span>Theme</span><div class="seg">${theme("auto")}${theme("light")}${theme("dark")}</div></div>
      <label class="field">Translation for "Read" links (opens BibleGateway)
        <select data-change="version">${VERSIONS.map(v => `<option ${v === s.version ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <div class="card stack">
      <h2>Backup</h2>
      <p class="muted small" style="margin:0">Your Google Sheet is the main backup. A file backup is useful if you don't sync. Importing only adds reads that are missing; it never deletes.</p>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" data-action="export">Export backup</button>
        <label class="btn">Import backup<input type="file" accept="application/json,.json" data-change="import" hidden></label>
      </div>
    </div>
    <div class="card stack">
      <h2>Install on your phone</h2>
      <p class="small" style="margin:0"><b>iPhone (Safari):</b> Share button → <i>Add to Home Screen</i>.<br>
      <b>Android (Chrome):</b> ⋮ menu → <i>Install app</i> or <i>Add to Home screen</i>.<br>
      <b>Computer (Chrome/Edge):</b> install icon at the right of the address bar.</p>
      <p class="muted small" style="margin:0">Once opened, the app works offline. Changes made offline upload the next time you open it online.</p>
    </div>
    <div class="card stack">
      <h2>This device</h2>
      <button class="btn ghost danger" data-action="clear-device">Clear data on this device</button>
      <p class="muted small" style="margin:0">Removes the local copy only. The Google Sheet is untouched; syncing again restores everything except unsynced changes.</p>
    </div>
    <p class="muted small" style="text-align:center">Bible Tracker ${APP_VERSION}</p>`;
}

/* ---------------- Sheets (bottom panels) & toast ---------------- */

function openSheet(html) {
  $("#sheet").innerHTML = html;
  $("#sheet").hidden = false; $("#sheetBackdrop").hidden = false;
}
function closeSheet() { $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true; $("#sheet").innerHTML = ""; }

function chapterSheet(b, ch) {
  const arr = reads[chKey(b, ch)] || [];
  const items = arr.length
    ? `<ul class="list">${arr.map((d, i) => `<li><span class="grow">Read ${i + 1}</span><span class="muted">${esc(fmtDate(d))}</span>
         <button class="btn sm ghost danger" data-action="sheet-remove" data-book="${b.id}" data-ch="${ch}" data-date="${esc(d)}">Remove</button></li>`).join("")}</ul>`
    : `<div class="empty">Not read yet.</div>`;
  openSheet(`
    <h2>${esc(label(b, ch))}</h2>
    <p class="muted small" style="margin:0 0 8px">Read ${arr.length} time${arr.length === 1 ? "" : "s"}</p>
    ${items}
    <div class="row" style="margin-top:12px; flex-wrap:wrap">
      <input type="date" id="sheetDate" value="${ui.logDate || todayIso()}" max="${todayIso()}" class="btn sm" style="font-weight:400">
      <button class="btn sm primary" data-action="sheet-add" data-book="${b.id}" data-ch="${ch}">Add read</button>
      <a class="btn sm ghost" href="${readUrl(b, ch)}" target="_blank" rel="noopener">${ICON_OPEN} Read</a>
    </div>`);
}

function rangeSheet(b) {
  const opts = sel => Array.from({ length: b.chapters }, (_, i) => `<option ${i + 1 === sel ? "selected" : ""}>${i + 1}</option>`).join("");
  openSheet(`
    <h2>Log several chapters</h2>
    <p class="muted small" style="margin:0 0 12px">${esc(b.name)}: adds one read to each chapter in the range.</p>
    <div class="row">
      <label class="field" style="flex:1">From<select id="rgFrom">${opts(1)}</select></label>
      <label class="field" style="flex:1">To<select id="rgTo">${opts(b.chapters)}</select></label>
    </div>
    <label class="field" style="margin-top:10px">Date<input type="date" id="rgDate" value="${ui.logDate || todayIso()}" max="${todayIso()}"></label>
    <button class="btn primary block" style="margin-top:14px" data-action="range-apply" data-book="${b.id}">Log chapters</button>`);
}

let toastTimer;
function toast(msg, undo, actionLabel = "Undo") {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button type="button">${esc(actionLabel)}</button>` : ""}`;
  t.hidden = false;
  if (undo) t.querySelector("button").onclick = () => { undo(); t.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 5000 : 3000);
}

/* ---------------- Events ---------------- */

document.addEventListener("click", e => {
  const tabBtn = e.target.closest(".tabbar button");
  if (tabBtn) { location.hash = tabBtn.dataset.tab; return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const book = el.dataset.book !== undefined ? BOOKS[+el.dataset.book] : null;
  const ch = el.dataset.ch ? +el.dataset.ch : null;

  switch (el.dataset.action) {
    case "go": location.hash = el.dataset.to; break;
    case "open-book": ui.logDate = null; location.hash = `book/${book.id}`; window.scrollTo(0, 0); break;
    case "quick-log": {
      const d = todayIso();
      addRead(book, ch, d);
      toast(`${label(book, ch)} logged`, () => removeRead(book, ch, d));
      break;
    }
    case "unlog": removeRead(book, ch, el.dataset.date); break;
    case "set-testament": ui.testament = el.dataset.t; render(); break;
    case "set-pass": ui.pass = +el.dataset.pass; render(); break;
    case "set-mode": ui.mode = el.dataset.mode; render(); break;
    case "log-today": ui.logDate = todayIso(); render(); break;
    case "tap-ch": {
      if (ui.mode === "details") { chapterSheet(book, ch); break; }
      const d = ui.logDate || todayIso();
      if ((reads[chKey(book, ch)] || []).includes(d)) {
        removeRead(book, ch, d);
        toast(`${label(book, ch)} unmarked`, () => addRead(book, ch, d));
      } else {
        addRead(book, ch, d);
        toast(`${label(book, ch)} logged`, () => removeRead(book, ch, d));
      }
      break;
    }
    case "sheet-remove": removeRead(book, ch, el.dataset.date); chapterSheet(book, ch); break;
    case "sheet-add": {
      const d = $("#sheetDate").value;
      if (isIso(d)) { addRead(book, ch, d); chapterSheet(book, ch); }
      break;
    }
    case "range-sheet": rangeSheet(book); break;
    case "range-apply": {
      let a = +$("#rgFrom").value, z = +$("#rgTo").value; const d = $("#rgDate").value;
      if (!isIso(d)) break;
      if (a > z) [a, z] = [z, a];
      const ids = [];
      for (let c = a; c <= z; c++) {
        const op = { id: uid(), op: "add", ch: label(book, c), key: chKey(book, c), date: d };
        store.pending.push(op); ids.push(op.id);
      }
      changed(); closeSheet();
      toast(`Logged ${book.name} ${a}${z > a ? "–" + z : ""}`, () => {
        // Only possible while the adds are still pending; after a sync, remove chapters individually.
        const before = store.pending.length;
        store.pending = store.pending.filter(o => !ids.includes(o.id));
        if (store.pending.length === before) for (let c = a; c <= z; c++) store.pending.push({ id: uid(), op: "remove", ch: label(book, c), key: chKey(book, c), date: d });
        changed();
      });
      break;
    }
    case "set-theme": store.settings.theme = el.dataset.theme; applyTheme(); save(); render(); break;
    case "save-sync":
      store.settings.url = $("#setUrl").value.trim();
      store.settings.token = $("#setToken").value.trim();
      store.lastError = null; save(); render();
      if (store.settings.url && store.settings.token) sync(true); else toast("Sync turned off.");
      break;
    case "sync-now": sync(true); break;
    case "discard-pending":
      if (confirm(`Discard ${store.pending.length} change(s) that haven't reached the sheet?`)) { store.pending = []; changed(); }
      break;
    case "export": exportBackup(); break;
    case "clear-device":
      if (confirm("Clear all Bible Tracker data on this device? (The Google Sheet is not affected.)")) {
        const settings = store.settings;
        store = loadStore(); store.base = {}; store.pending = []; store.settings = settings;
        store.lastSync = null; store.snapshotCreated = null; store.problems = []; store.unmatched = { sheetOnly: [], missing: [] };
        save(); recompute(); render(); toast("Cleared.");
        loadSnapshot();
      }
      break;
  }
});

document.addEventListener("change", e => {
  const el = e.target.closest("[data-change]");
  if (!el) return;
  if (el.dataset.change === "log-date") { if (isIso(el.value)) { ui.logDate = el.value; render(); } }
  else if (el.dataset.change === "version") { store.settings.version = el.value; save(); }
  else if (el.dataset.change === "import" && el.files[0]) importBackup(el.files[0]);
});

$("#sheetBackdrop").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
$("#backBtn").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "books"; });
$("#syncPill").addEventListener("click", () => {
  if (!(store.settings.url && store.settings.token)) location.hash = "settings"; else sync(true);
});
window.addEventListener("hashchange", () => { closeSheet(); render(); });

/* ---------------- Backup ---------------- */

function exportBackup() {
  const data = { app: "bible-tracker", version: APP_VERSION, exported: new Date().toISOString(), reads: {} };
  for (const k in reads) if (KEY_TO_REF[k] && reads[k].length) data.reads[label(KEY_TO_REF[k].book, KEY_TO_REF[k].ch)] = reads[k];
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `bible-tracker-backup-${todayIso()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importBackup(file) {
  file.text().then(txt => {
    const data = JSON.parse(txt);
    if (!data || typeof data.reads !== "object") throw new Error("Not a Bible Tracker backup.");
    let added = 0;
    for (const lbl in data.reads) {
      const ref = KEY_TO_REF[normKey(lbl)];
      if (!ref || !Array.isArray(data.reads[lbl])) continue;
      const have = (reads[normKey(lbl)] || []).slice();
      data.reads[lbl].forEach(d => {
        const i = have.indexOf(d);
        if (i >= 0) { have.splice(i, 1); return; } // already present
        store.pending.push({ id: uid(), op: "add", ch: label(ref.book, ref.ch), key: normKey(lbl), date: String(d) });
        added++;
      });
    }
    changed();
    toast(added ? `Imported ${added} read${added === 1 ? "" : "s"}.` : "Nothing new to import.");
  }).catch(err => toast(`Import failed: ${err.message}`));
}

/* ---------------- Snapshot ---------------- */

// Until sync is set up, show the progress baked into snapshot.js (made by
// tools/sheet_to_snapshot.py). The first real sync replaces it with the live sheet.
function loadSnapshot() {
  const snap = window.BIBLE_SNAPSHOT; // undefined if snapshot.js was deleted
  if ((store.settings.url && store.settings.token) || store.lastSync) return;
  if (!snap || !snap.chapters || snap.created === store.snapshotCreated) return;
  const base = {};
  for (const k in snap.chapters) if (KEY_TO_REF[k]) base[k] = snap.chapters[k].map(String).sort(cmpDate);
  store.base = base;
  store.snapshotCreated = snap.created;
  save(); recompute(); render();
}

/* ---------------- Sync ---------------- */

let syncing = false, syncAgain = false, syncTimer = null;

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(false), 1500);
}

async function callSheet(ops) {
  const { url, token } = store.settings;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000); // generous: first upload of a whole history
  try {
    // text/plain keeps this a "simple" request, so Apps Script doesn't need CORS preflight.
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ token, ops }), signal: ctrl.signal });
    const data = await res.json().catch(() => { throw new Error(`Unexpected response (HTTP ${res.status}). Check the URL and deployment access.`); });
    if (!data.ok) throw new Error(data.error || "Sync failed");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const totalReads = chapters => Object.values(chapters || {}).reduce((s, a) => s + a.length, 0);

async function sync(manual) {
  const { url, token } = store.settings;
  if (!url || !token) { renderPill(); return; }
  if (!navigator.onLine) { renderPill(); if (manual) toast("You're offline. Changes will upload later."); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; renderPill();
  const before = JSON.stringify(store.base) + store.pending.length;
  let seeded = 0;
  try {
    // First connection on this device: if the sheet is empty, upload the progress this
    // device already has (e.g. the snapshot) instead of replacing it with nothing.
    if (!store.lastSync && totalReads(store.base) > 0) {
      const probe = await callSheet([]);
      if (totalReads(probe.chapters) === 0) {
        const seed = [];
        for (const k in store.base) {
          const ref = KEY_TO_REF[k];
          if (ref) store.base[k].forEach(date => seed.push({ id: uid(), op: "add", ch: label(ref.book, ref.ch), key: k, date }));
        }
        store.pending = seed.concat(store.pending);
        store.base = {};
        seeded = seed.length;
        save();
      }
    }
    const ops = store.pending.map(({ id, op, ch, date }) => ({ id, op, ch, date }));
    const data = await callSheet(ops);
    const applied = new Set(data.applied || []);
    store.pending = store.pending.filter(o => !applied.has(o.id));
    const base = {}, sheetOnly = [];
    for (const k in data.chapters) {
      if (KEY_TO_REF[k]) base[k] = data.chapters[k].map(String).sort(cmpDate);
      else sheetOnly.push(k);
    }
    store.base = base;
    store.unmatched = { sheetOnly, missing: Object.keys(KEY_TO_REF).filter(k => !(k in data.chapters)).map(k => label(KEY_TO_REF[k].book, KEY_TO_REF[k].ch)) };
    store.problems = data.problems || [];
    store.lastSync = Date.now(); store.lastError = null;
    if (seeded) toast(`Uploaded your ${num(seeded)} existing reads to the sheet.`);
    else if (manual) toast("Synced with your sheet.");
  } catch (err) {
    store.lastError = err.name === "AbortError" ? "Timed out"
      : err instanceof TypeError ? "Couldn't reach the sheet (no connection, or the URL is wrong)."
      : err.message;
    if (manual || seeded) toast(`Sync failed: ${store.lastError}`);
  } finally {
    syncing = false;
    save(); recompute();
    // Background syncs only redraw when something changed, and never while typing in a field.
    const typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (JSON.stringify(store.base) + store.pending.length !== before && !typing) render(); else renderPill();
    if (syncAgain) { syncAgain = false; sync(false); }
  }
}

function renderPill() {
  const pill = $("#syncPill"), lbl = pill.querySelector(".label");
  const p = store.pending.length, configured = store.settings.url && store.settings.token;
  let state, text;
  if (!configured) { state = "off"; text = store.snapshotCreated && !store.lastSync ? "Snapshot" : "Local only"; }
  else if (syncing) { state = "busy"; text = "Syncing…"; }
  else if (!navigator.onLine) { state = "pending"; text = p ? `Offline · ${p}` : "Offline"; }
  else if (store.lastError) { state = "error"; text = "Sync error"; }
  else if (p) { state = "pending"; text = `${p} to sync`; }
  else { state = "ok"; text = "Synced"; }
  pill.dataset.state = state; lbl.textContent = text;
  pill.title = store.lastError || (store.lastSync ? `Last synced ${new Date(store.lastSync).toLocaleString()}` : "");
}

window.addEventListener("online", () => sync(false));
// While the app is open, pick up reads logged on other devices.
setInterval(() => { if (document.visibilityState === "visible") sync(false); }, 2 * 60 * 1000);
window.addEventListener("offline", renderPill);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); sync(false); } });

/* ---------------- Theme, service worker, start ---------------- */

function applyTheme() {
  const t = store.settings.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then(reg => {
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w && w.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) toast("A new version is ready.", () => location.reload(), "Reload");
      });
    });
  }).catch(() => { /* offline support unavailable; app still works */ });
}

applyTheme();
recompute();
render();
loadSnapshot();
sync(false);
