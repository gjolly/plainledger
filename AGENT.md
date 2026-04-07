# Finance — local QIF ledger

A single-user static web app for viewing and annotating bank transactions imported from QIF files. All data lives in the user's browser (IndexedDB). No backend, no build step, no network calls.

## Project shape

```
finance/
├── index.html   # UI shell: topbar, dropzone, filters, summary, table, drawer
├── styles.css   # All styling (CSS custom properties at the top)
├── app.js       # Parser + IndexedDB layer + rendering + event wiring
└── *.qif        # Sample bank exports (kept for manual testing)
```

Three files. No framework, no bundler, no package.json. If you're tempted to add one, don't — the whole point is that this runs from `file://` with zero setup.

## Running it

Open `index.html` directly in a browser. If the browser blocks IndexedDB on `file://` (some Chrome configurations), serve the directory instead:

```
python3 -m http.server
# then open http://localhost:8000
```

There are no tests, no linters, no CI. Verification is manual: import a QIF, check the table, edit a row, reload, confirm persistence. For parser changes, the quick sanity check is:

```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("app.js", "utf8");
const code = src.replace(/\/\/ ---------- IndexedDB layer ----------[\s\S]*$/, "")
  + "\nmodule.exports = { parseQIF, assignIds };";
const m = { exports: {} };
new Function("module", "exports", code)(m, m.exports);
const { parseQIF, assignIds } = m.exports;
const txt = fs.readFileSync("example.qif", "utf8");
console.log(assignIds(parseQIF(txt)).length, "rows");
'
```

This works because everything above the IndexedDB section is browser-agnostic.

## Architecture

### Data model

A transaction row is a flat object keyed by a stable content hash:

```js
{
  id:       "788bb404-2026-04-07",   // djb2(date|amount|payee|memo|checknum) + date, plus "#N" for duplicates
  date:     "2026-04-07",             // ISO, always — parser normalises DD/MM/YYYY
  amount:   132.00,                   // number, negative = debit
  payee:    "VIR C.P.A.M. TOULOUSE",
  memo:     "",
  checknum: "",
  category: "",                       // user-editable
  comment:  ""                        // user-editable
}
```

### Storage: IndexedDB

- DB `finance`, version 1
- Object store `transactions` keyed by `id`, with indexes `by_date` and `by_category`
- Object store `meta` (reserved, currently unused)

All DB access goes through the small promise wrappers in `app.js` (`dbAll`, `dbPut`, `dbDelete`, `dbClear`, `dbBulkPut`). Don't reach into `indexedDB` directly from elsewhere.

### Import idempotency — critical invariant

`dbBulkPut` is **merge-preserving**: if a row with the same `id` already exists, the user's `category` and `comment` are kept and only bank-derived fields update. This is what makes re-importing the same QIF safe.

Genuine duplicate transactions within a single QIF (e.g. two identical laundry charges on the same day) are disambiguated by `assignIds`, which appends `#1`, `#2`, … in file order. The Nth duplicate in file order always gets the same id across re-imports, so idempotency holds. **Do not** swap in random ids or timestamps — you will break this.

### Encoding

French bank QIF exports are often `windows-1252`, not UTF-8. `readFileSmart` tries UTF-8 first, then falls back to `windows-1252` if it detects the U+FFFD replacement character. Keep this fallback.

### State & rendering

A single `state` object in `app.js` holds `rows`, `filtered`, `sort`, `filters`, and `editing`. One `render()` function does everything: apply filters, sort, rebuild the `<tbody>`, update the summary strip, update sort indicators, refresh the category UI. Call `render()` after any state change. Call `reload()` after any DB mutation that changes which rows exist.

No virtual DOM, no diffing. The table is rebuilt on every render. This is fine for tens of thousands of rows; don't optimise until it isn't.

## Conventions

- **Vanilla everything.** No dependencies. No TypeScript. No JSX. No CSS preprocessors.
- **Escape user content.** All row content goes through `escapeHtml()` before being inserted as HTML. If you add a new column or field, escape it.
- **CSS `hidden` attribute.** Elements toggled via the `hidden` attribute need an explicit `.thing[hidden] { display: none; }` rule if they also have a `display:` in the base rule (otherwise the base rule wins and `hidden` is silently ignored — this bit us once on `.drawer`).
- **No emojis in code or UI** unless the user explicitly asks.
- **Colours**: credits green (`--credit`), debits red (`--debit`). Both defined as CSS custom properties at the top of `styles.css`.

## What this app deliberately does NOT do

- No charts or graphs.
- No auto-categorization rules.
- No multi-account separation (flat ledger; QIF `!Type:` headers are read but only `Bank`-style records are exercised).
- No sync, no export to anything except a plain JSON backup, no cloud.
- No service worker / PWA install. It already works offline from `file://`.

Keep it that way unless the user asks otherwise. YAGNI is load-bearing here.

## Privacy

This is the user's personal financial data. It never leaves the browser. Do not add analytics, telemetry, CDN-hosted fonts/scripts, or any fetch() calls to third-party domains.
