#!/usr/bin/env node
'use strict';
/**
 * Build the standalone single-file dashboard.
 *
 * `dashboard.html` is what you get when you double-click a file instead of running a
 * server. It has to be self-contained: the preview iframe it is usually opened in has
 * no network access, so an external stylesheet or script would simply not load and
 * the page would render as unstyled text — which is exactly how "the buttons do
 * nothing" reports start.
 *
 * So: public/index.html with public/styles.css and public/app.js inlined, and no
 * external references left. A test asserts the result has zero of them.
 *
 * Usage:  node scripts/build-dashboard.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let html = read('public/index.html');
const css = read('public/styles.css');
const app = read('public/app.js');

const styleTag = /<link[^>]+href="\.\/styles\.css"[^>]*>/;
const scriptTag = /<script[^>]+src="\.\/app\.js"[^>]*><\/script>/;

if (!styleTag.test(html)) throw new Error('index.html: no ./styles.css link to inline');
if (!scriptTag.test(html)) throw new Error('index.html: no ./app.js script to inline');

// `</script>` inside a string literal would end the tag early; escape it.
const safeJs = app.replace(/<\/script>/gi, '<\\/script>');

html = html
  .replace(styleTag, `<style>\n${css}\n</style>`)
  .replace(scriptTag, `<script>\n${safeJs}\n</script>`);

// Report rather than assume: a leftover external reference is a broken preview.
// Check for TAGS, not for `src="..."` anywhere — app.js builds markup in strings, and
// a naive scan matches its own template literals.
// A data: URI is self-contained (the favicon is one), so it does not count.
const external = (re) => [...html.matchAll(re)].filter((m) => !/href="data:|src="data:/i.test(m[0]));
const leftover = [
  ...external(/<script[^>]+src=[^>]*>/gi),
  ...external(/<link[^>]+href=[^>]*>/gi),
  ...external(/@import\s+url\([^)]*\)/gi),
];
if (leftover.length) {
  throw new Error(`dashboard.html would still load external files: ${leftover.map((m) => m[0]).join(', ')}`);
}

const out = path.join(ROOT, 'dashboard.html');
fs.writeFileSync(out, html);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log('dashboard.html written');
console.log(`  ${kb(Buffer.byteLength(html))}  (was ${fs.existsSync(out) ? 'replaced' : 'new'})`);
console.log(`  css inlined: ${kb(Buffer.byteLength(css))}`);
console.log(`  js  inlined: ${kb(Buffer.byteLength(app))}`);
console.log('  external references: 0');
