// Local QIF ledger — all state lives in IndexedDB in the user's browser.
// No network calls, no frameworks, no build step.

// ---------- QIF parser ----------

// Parse a QIF file body into an array of transaction objects.
// Tolerates Quicken "Bank" and similar flat formats. Records are terminated by "^".
function parseQIF(text) {
  const txs = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.date || cur.amount !== undefined || cur.payee)) {
      txs.push(cur);
    }
    cur = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("!")) continue; // header like !Type:Bank
    if (line === "^") { flush(); continue; }
    if (!cur) cur = { date: "", amount: 0, payee: "", memo: "", checknum: "", qifCategory: "" };
    const code = line[0];
    const value = line.slice(1);
    switch (code) {
      case "D": cur.date = parseQifDate(value); break;
      case "T":
      case "U": cur.amount = parseQifAmount(value); break;
      case "P": cur.payee = value; break;
      case "M": cur.memo = value; break;
      case "N": cur.checknum = value; break;
      case "L": cur.qifCategory = value; break;
      // C (cleared), A (address), S/E/$ (splits) — ignored for now
    }
  }
  flush();
  return txs;
}

// Accept "DD/MM/YYYY", "DD/MM/YY", "MM/DD/YYYY" (US), or "YYYY-MM-DD".
// For ambiguous DD/MM vs MM/DD we prefer DD/MM since that's what the user's bank exports.
function parseQifDate(s) {
  s = s.trim().replace(/\s+/g, "");
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  }
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  return s; // fall back to raw string rather than silently dropping
}

function pad2(n) { return String(n).padStart(2, "0"); }

function parseQifAmount(s) {
  // Remove thousands separators, accept comma or dot as decimal.
  s = s.replace(/\s/g, "").replace(/,(\d{2})$/, ".$1").replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Stable content hash (djb2). An `occurrence` index disambiguates genuine
// duplicates within a single QIF file (e.g. two identical laundry charges on
// the same day) while keeping re-imports of the same file idempotent — the
// Nth duplicate in file order always gets the same id.
function hashTx(tx, occurrence = 0) {
  const key = `${tx.date}|${tx.amount}|${tx.payee}|${tx.memo}|${tx.checknum}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  const suffix = occurrence ? `#${occurrence}` : "";
  return `${(h >>> 0).toString(16)}-${tx.date}${suffix}`;
}

// Assign occurrence indices for duplicates in file order.
function assignIds(parsed) {
  const counts = new Map();
  return parsed.map(p => {
    const baseKey = `${p.date}|${p.amount}|${p.payee}|${p.memo}|${p.checknum}`;
    const n = counts.get(baseKey) || 0;
    counts.set(baseKey, n + 1);
    return { parsed: p, id: hashTx(p, n) };
  });
}

// ---------- IndexedDB layer ----------

const DB_NAME = "finance";
const DB_VERSION = 1;
const STORE = "transactions";
const META = "meta";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("by_date", "date");
        os.createIndex("by_category", "category");
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, [STORE], "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(row) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE], "readwrite");
    t.objectStore(STORE).put(row);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE], "readwrite");
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE], "readwrite");
    t.objectStore(STORE).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Overwriting bulk put: used by operations that intentionally mutate
// user-editable fields (bulk categorize). Does NOT merge-preserve.
async function dbBulkOverwrite(rows) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE], "readwrite");
    const store = t.objectStore(STORE);
    for (const row of rows) store.put(row);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Merge-preserving bulk put: existing rows keep user-added category + comment.
async function dbBulkPut(rows) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = tx(db, [STORE], "readwrite");
    const store = t.objectStore(STORE);
    let added = 0, updated = 0, unchanged = 0;
    let i = 0;
    const next = () => {
      if (i >= rows.length) return;
      const row = rows[i++];
      const getReq = store.get(row.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) {
          store.put(row);
          added++;
        } else {
          // Preserve user fields, update everything else.
          const merged = {
            ...row,
            category: existing.category || row.category || "",
            comment: existing.comment || "",
          };
          const changed = JSON.stringify(existing) !== JSON.stringify(merged);
          if (changed) { store.put(merged); updated++; }
          else { unchanged++; }
        }
        next();
      };
      getReq.onerror = () => reject(getReq.error);
    };
    next();
    t.oncomplete = () => resolve({ added, updated, unchanged });
    t.onerror = () => reject(t.error);
  });
}

// ---------- State + rendering ----------

const state = {
  rows: [],        // full dataset from DB
  filtered: [],    // after filters
  sort: { key: "date", dir: "desc" },
  filters: {
    search: "",
    from: "",
    to: "",
    sign: "all",
    categories: new Set(),
  },
  editing: null,
  allCategories: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function fmtAmount(n) {
  const sign = n < 0 ? "-" : "";
  return sign + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function applyFilters() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  state.filtered = state.rows.filter(r => {
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (f.sign === "debit" && r.amount >= 0) return false;
    if (f.sign === "credit" && r.amount < 0) return false;
    if (f.categories.size && !f.categories.has(r.category || "")) return false;
    if (q) {
      const hay = `${r.payee} ${r.memo} ${r.comment || ""} ${r.category || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const { key, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  state.filtered.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === "amount") return (av - bv) * mul;
    av = (av || "").toString().toLowerCase();
    bv = (bv || "").toString().toLowerCase();
    return av < bv ? -1 * mul : av > bv ? 1 * mul : 0;
  });
}

function render() {
  applyFilters();
  const body = $("#tx-body");
  body.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const r of state.filtered) {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    const amtClass = r.amount < 0 ? "debit" : "credit";
    tr.innerHTML = `
      <td>${fmtDate(r.date)}</td>
      <td class="payee">${escapeHtml(r.payee)}</td>
      <td class="num ${amtClass}">${fmtAmount(r.amount)}</td>
      <td class="category">${escapeHtml(r.category || "")}</td>
      <td class="comment">${escapeHtml(r.comment || "")}</td>
    `;
    frag.appendChild(tr);
  }
  body.appendChild(frag);

  $("#empty-state").hidden = state.rows.length > 0;
  $("#tx-table").hidden = state.rows.length === 0;

  // Summary
  let cIn = 0, cOut = 0;
  for (const r of state.filtered) {
    if (r.amount >= 0) cIn += r.amount;
    else cOut += r.amount;
  }
  $("#s-count").textContent = state.filtered.length;
  $("#s-in").textContent = fmtAmount(cIn);
  $("#s-out").textContent = fmtAmount(cOut);
  const net = cIn + cOut;
  const netEl = $("#s-net");
  netEl.textContent = fmtAmount(net);
  netEl.className = net < 0 ? "debit" : "credit";

  // Sort indicators
  for (const th of $$("#tx-table thead th")) {
    th.classList.remove("sorted", "asc");
    if (th.dataset.sort === state.sort.key) {
      th.classList.add("sorted");
      if (state.sort.dir === "asc") th.classList.add("asc");
    }
  }

  refreshCategoryUI();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function refreshCategoryUI() {
  const cats = new Set();
  for (const r of state.rows) if (r.category) cats.add(r.category);
  const sorted = Array.from(cats).sort();
  state.allCategories = sorted;

  const sel = $("#f-category");
  const prev = new Set(state.filters.categories);
  sel.innerHTML = sorted.map(c =>
    `<option value="${escapeHtml(c)}"${prev.has(c) ? " selected" : ""}>${escapeHtml(c)}</option>`
  ).join("");
  sel.size = Math.min(Math.max(sorted.length, 1), 6);
}

// ---------- Import / Export ----------

async function importQifFile(file) {
  const text = await readFileSmart(file);
  const parsed = parseQIF(text);
  const rows = assignIds(parsed).map(({ parsed: p, id }) => ({
    id,
    date: p.date,
    amount: p.amount,
    payee: p.payee,
    memo: p.memo,
    checknum: p.checknum,
    category: p.qifCategory || "",
    comment: "",
  }));
  const { added, updated, unchanged } = await dbBulkPut(rows);
  showToast(`Imported ${added} new, ${updated} updated, ${unchanged} unchanged`);
  await reload();
}

// Bank exports are often latin-1 (windows-1252). Try UTF-8 first; if we see
// the replacement char, fall back to windows-1252.
function readFileSmart(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const utf8 = r.result;
      if (typeof utf8 === "string" && !utf8.includes("\uFFFD")) {
        resolve(utf8);
        return;
      }
      const r2 = new FileReader();
      r2.onload = () => resolve(r2.result);
      r2.onerror = () => reject(r2.error);
      r2.readAsText(file, "windows-1252");
    };
    r.onerror = () => reject(r.error);
    r.readAsText(file, "utf-8");
  });
}

async function exportJson() {
  const rows = await dbAll();
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `finance-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importJsonFile(file) {
  const text = await file.text();
  let rows;
  try { rows = JSON.parse(text); }
  catch (e) { showToast("Invalid JSON"); return; }
  if (!Array.isArray(rows)) { showToast("Expected a JSON array"); return; }
  // Use bulkPut so existing rows merge-preserve, matching QIF semantics.
  const { added, updated, unchanged } = await dbBulkPut(rows);
  showToast(`Restored ${added} new, ${updated} updated, ${unchanged} unchanged`);
  await reload();
}

// ---------- Category combobox ----------

// Minimal combobox: click to browse all categories, type to filter, or type a
// brand-new value. The input is the source of truth. Factory so multiple
// inputs (drawer, bulk categorize panel) can share the same behavior.
function createCategoryCombo({ inputSel, listSel, toggleSel, onPick }) {
  let activeIndex = -1;
  let visible = [];

  const input = () => $(inputSel);
  const list = () => $(listSel);

  function open() {
    renderList();
    if (visible.length === 0) { close(); return; }
    list().hidden = false;
    input().setAttribute("aria-expanded", "true");
  }

  function close() {
    list().hidden = true;
    input().setAttribute("aria-expanded", "false");
    activeIndex = -1;
  }

  function renderList() {
    const q = input().value.trim().toLowerCase();
    visible = q
      ? state.allCategories.filter(c => c.toLowerCase().includes(q))
      : state.allCategories.slice();
    if (activeIndex >= visible.length) activeIndex = visible.length - 1;
    const ul = list();
    ul.innerHTML = visible.map((c, i) =>
      `<li role="option" data-index="${i}"${i === activeIndex ? ' class="active"' : ""}>${escapeHtml(c)}</li>`
    ).join("");
  }

  function pick(i) {
    if (i < 0 || i >= visible.length) return;
    input().value = visible[i];
    close();
    if (onPick) onPick(visible[i]);
  }

  function moveActive(delta) {
    if (visible.length === 0) return;
    activeIndex = (activeIndex + delta + visible.length) % visible.length;
    renderList();
    const el = list().querySelector("li.active");
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function init() {
    const inp = input();
    const ul = list();
    const toggle = $(toggleSel);

    inp.addEventListener("focus", open);
    inp.addEventListener("input", () => {
      activeIndex = visible.length ? 0 : -1;
      open();
    });
    inp.addEventListener("blur", () => {
      setTimeout(close, 120);
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list().hidden) open(); else moveActive(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (list().hidden) open(); else moveActive(-1); }
      else if (e.key === "Enter") {
        if (!list().hidden && activeIndex >= 0) {
          e.preventDefault();
          pick(activeIndex);
        }
      } else if (e.key === "Escape") {
        if (!list().hidden) { e.stopPropagation(); close(); }
      }
    });

    toggle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (list().hidden) { inp.focus(); open(); }
      else { close(); }
    });

    ul.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      e.preventDefault();
      pick(parseInt(li.dataset.index, 10));
    });
  }

  return { init, close };
}

const categoryCombo = createCategoryCombo({
  inputSel: "#d-category",
  listSel: "#d-category-list",
  toggleSel: "#d-category-combo .combobox-toggle",
});

const bulkCategoryCombo = createCategoryCombo({
  inputSel: "#bc-category",
  listSel: "#bc-category-list",
  toggleSel: "#bc-category-combo .combobox-toggle",
});

// ---------- Drawer ----------

function openDrawer(id) {
  const row = state.rows.find(r => r.id === id);
  if (!row) return;
  state.editing = id;
  $("#d-date").textContent = fmtDate(row.date);
  $("#d-payee").textContent = row.payee || "";
  $("#d-memo").textContent = row.memo || "—";
  const amtEl = $("#d-amount");
  amtEl.textContent = fmtAmount(row.amount);
  amtEl.className = row.amount < 0 ? "debit" : "credit";
  $("#d-category").value = row.category || "";
  $("#d-comment").value = row.comment || "";
  categoryCombo.close();
  $("#drawer").hidden = false;
}

function closeDrawer() {
  state.editing = null;
  categoryCombo.close();
  $("#drawer").hidden = true;
}

async function saveDrawer() {
  if (!state.editing) return;
  const row = state.rows.find(r => r.id === state.editing);
  if (!row) return;
  row.category = $("#d-category").value.trim();
  row.comment = $("#d-comment").value;
  await dbPut(row);
  closeDrawer();
  render();
  showToast("Saved");
}

async function deleteDrawer() {
  if (!state.editing) return;
  if (!confirm("Delete this transaction?")) return;
  await dbDelete(state.editing);
  closeDrawer();
  await reload();
}

// ---------- Bulk categorize filtered results ----------

async function applyBulkCategorize() {
  const category = $("#bc-category").value.trim();
  if (!category) { showToast("Category required"); return; }
  const matches = state.filtered;
  if (matches.length === 0) { showToast("No filtered results"); return; }
  if (!confirm(`Categorize ${matches.length} transaction${matches.length === 1 ? "" : "s"} as "${category}"?`)) return;
  const updated = matches.map(r => ({ ...r, category }));
  await dbBulkOverwrite(updated);
  $("#bc-category").value = "";
  await reload();
  showToast(`Categorized ${matches.length}`);
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

// ---------- Wiring ----------

async function reload() {
  state.rows = await dbAll();
  render();
}

function wire() {
  // Import QIF via file input
  $("#file-input").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await importQifFile(f);
    e.target.value = "";
  });

  // Drag and drop
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && e.target !== dz) return;
    dz.classList.remove("drag");
  }));
  dz.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files[0];
    if (f) await importQifFile(f);
  });
  // Also accept drops anywhere on the page for convenience.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (e.target.closest("#dropzone")) return;
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importQifFile(f);
  });

  // Export / Import JSON
  $("#export-json").addEventListener("click", exportJson);
  $("#json-input").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await importJsonFile(f);
    e.target.value = "";
  });

  // Clear all
  $("#clear-all").addEventListener("click", async () => {
    if (!confirm("Delete ALL transactions from this browser? This cannot be undone.")) return;
    await dbClear();
    await reload();
    showToast("Cleared");
  });

  // Filters
  $("#f-search").addEventListener("input", (e) => { state.filters.search = e.target.value; render(); });
  $("#f-from").addEventListener("change", (e) => { state.filters.from = e.target.value; render(); });
  $("#f-to").addEventListener("change", (e) => { state.filters.to = e.target.value; render(); });
  $("#f-sign").addEventListener("change", (e) => { state.filters.sign = e.target.value; render(); });
  $("#f-category").addEventListener("change", (e) => {
    state.filters.categories = new Set(Array.from(e.target.selectedOptions).map(o => o.value));
    render();
  });
  $("#f-reset").addEventListener("click", () => {
    state.filters = { search: "", from: "", to: "", sign: "all", categories: new Set() };
    $("#f-search").value = "";
    $("#f-from").value = "";
    $("#f-to").value = "";
    $("#f-sign").value = "all";
    render();
  });

  // Sort
  for (const th of $$("#tx-table thead th[data-sort]")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = key === "date" || key === "amount" ? "desc" : "asc";
      }
      render();
    });
  }

  // Row click -> drawer
  $("#tx-body").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    openDrawer(tr.dataset.id);
  });

  // Category combobox inside the drawer
  categoryCombo.init();
  bulkCategoryCombo.init();

  // Bulk categorize current filtered results
  $("#bc-apply").addEventListener("click", applyBulkCategorize);

  // Drawer actions
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#d-save").addEventListener("click", saveDrawer);
  $("#d-delete").addEventListener("click", deleteDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
  });
}

wire();
reload().catch(err => {
  console.error(err);
  showToast("Failed to load database");
});
