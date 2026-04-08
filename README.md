# plainledger

A tiny, single-user web app for viewing and annotating bank transactions imported from QIF files.

Deployed at **https://plainledger.gjolly.dev**.

## What it does

- Import QIF exports from your bank (drag-and-drop).
- Browse, sort, and filter transactions in a plain table.
- Tag each transaction with one or more categories (with per-category percentage shares) and a free-form comment.
- See In / Out / Net totals for the current filter, with category shares weighted by percentage.
- Re-import the same QIF safely: your categories and comments are preserved.

## What it deliberately doesn't do

- No charts, no auto-categorization rules, no multi-account separation.
- No sync, no cloud storage, no product analytics, no telemetry of your ledger.
- No server-side code. The Cloudflare Worker only serves static assets.

## Privacy

All data lives in your browser's IndexedDB and never leaves it. The app is hosted on a Cloudflare Worker that ships static files only — there is no backend, no database, no third-party scripts. A strict `Content-Security-Policy` header (`connect-src 'none'`) enforces in-browser that the page can't make outbound network calls.

The one caveat: because the site is served from Cloudflare, Cloudflare's Workers observability logs request-level metadata (IP, user agent, requested path, timing) for the static asset fetches that happen when you load the page. That's request logging for the hosting itself, not analytics of your ledger — your transactions, categories, and comments are never sent anywhere. If you'd rather avoid even that, clone the repo and host it yourself.

## Stack

Vanilla HTML, CSS, and JavaScript. No framework, no bundler beyond an esbuild minify step. Hosted as a static-asset Cloudflare Worker.

## Running locally

```
npm install
npm run dev      # build + wrangler dev
npm run deploy   # build + wrangler deploy
```

See [AGENT.md](./AGENT.md) for architecture details and contributor notes.

## License

AGPL-3.0.
