# Plainledger — QIF ledger on Cloudflare Workers

A single-user web app for viewing and annotating bank transactions imported from QIF files. Deployed as a Cloudflare Worker that serves static assets only — there is no server-side code, no database, no network calls. All data still lives in the user's browser (IndexedDB).

## Project shape

```
plainledger/
├── src/                # Authoritative source — edit files here
│   ├── index.html      # UI shell: topbar, dropzone, filters, summary, table, drawer
│   ├── styles.css      # All styling (CSS custom properties at the top)
│   └── app.js          # Parser + IndexedDB layer + rendering + event wiring
├── public/             # Build output served by the Worker. DO NOT edit by hand — wiped on every build.
├── scripts/
│   └── build.mjs       # Minifies src/ → public/ via esbuild (JS+CSS only; HTML copied verbatim)
├── wrangler.jsonc      # Worker config — `assets.directory` points at ./public
├── package.json        # devDeps: esbuild + wrangler. Scripts: build / dev / deploy
└── *.qif               # Sample bank exports (kept for manual testing)
```

The code is still vanilla HTML/CSS/JS — no framework, no bundler, no client-side imports. The build step is intentionally minimal: esbuild minifies `src/*.js` and `src/*.css` into `public/`, with `bundle: false` so `index.html` keeps loading them as separate URLs. HTML is copied through unchanged (Cloudflare gzips/brotlis it anyway). The Worker has no entry script (no `main` in `wrangler.jsonc`); it's pure static-asset serving via Cloudflare's asset handler. Don't add a real bundler, a framework, or server-side Worker logic.

`public/` is generated. Never edit it directly — your changes will vanish on the next `npm run build`.

## Running it

Local dev (builds first, then runs Wrangler's local runtime `workerd` against `public/`):

```
npm run dev      # = npm run build && wrangler dev
```

Deploy:

```
npm run deploy   # = npm run build && wrangler deploy
```

The `predev` and `predeploy` hooks in `package.json` call the build automatically — you should never need to invoke `wrangler` directly. If you want a one-off rebuild without serving, `npm run build`.

You can still open `src/index.html` directly in a browser for quick edits (the un-minified source works fine), but if the browser blocks IndexedDB on `file://` (some Chrome configurations) use `npm run dev` instead.

There are no tests, no linters, no CI. Verification is manual: import a QIF, check the table, edit a row, reload, confirm persistence. For parser changes, the quick sanity check is:

```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("src/app.js", "utf8");
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
  id:         "788bb404-2026-04-07",  // djb2(date|amount|payee|memo|checknum) + date, plus "#N" for duplicates
  date:       "2026-04-07",            // ISO, always — parser normalises DD/MM/YYYY
  amount:     132.00,                  // number, negative = debit
  payee:      "VIR C.P.A.M. TOULOUSE",
  memo:       "",
  checknum:   "",
  categories: [                        // user-editable; empty means uncategorized
    { name: "insurance", pct: 100 },
    { name: "car",       pct: 100 },   // two 100% entries are valid (no normalization)
  ],
  comment:    ""                       // user-editable
}
```

A transaction can belong to multiple categories, each with an independent percentage share (0–100). The table always shows the full transaction amount; the summary (In/Out/Net) weights by percentage only when a category filter is active. Legacy rows with `category: "foo"` are migrated on load by `normalizeRow` (in `app.js`) to `categories: [{name: "foo", pct: 100}]` and persisted back via `dbBulkOverwrite`.

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
- No service worker / PWA install.
- No server-side logic in the Worker. It serves static assets, nothing else. Don't add a fetch handler, KV, D1, R2, Durable Objects, or any binding without an explicit ask.

Keep it that way unless the user asks otherwise. YAGNI is load-bearing here.

## Privacy

This is the user's personal financial data. It never leaves the browser — even though the app is now hosted on a Cloudflare Worker, the Worker only ships static assets. Do not add analytics, telemetry, CDN-hosted fonts/scripts, server-side logging, or any fetch() calls to third-party domains. Do not introduce a Worker fetch handler that touches transaction data.
