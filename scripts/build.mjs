#!/usr/bin/env node
// Minify src/ into public/ for the Cloudflare Worker static-asset handler.
import { rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { build } from "esbuild";

const SRC = "src";
const OUT = "public";

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const entries = await readdir(SRC, { withFileTypes: true });
const files = entries.filter((e) => e.isFile()).map((e) => e.name);

// JS + CSS via esbuild (minify, no bundling — keep separate request URLs)
const jsAndCss = files.filter((f) => [".js", ".css"].includes(extname(f)));
if (jsAndCss.length) {
  await build({
    entryPoints: jsAndCss.map((f) => join(SRC, f)),
    outdir: OUT,
    minify: true,
    bundle: false,
    logLevel: "info",
    target: ["es2022"],
  });
}

// HTML and anything else: copy verbatim. HTML minification is intentionally
// skipped — Cloudflare gzips/brotlis static assets, so the savings are tiny
// and not worth a second toolchain.
const rest = files.filter((f) => ![".js", ".css"].includes(extname(f)));
for (const f of rest) {
  await writeFile(join(OUT, f), await readFile(join(SRC, f)));
}

console.log(`built ${files.length} file(s) into ${OUT}/`);
