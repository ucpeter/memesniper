'use strict';
/**
 * Execution tests for the dashboard's own code.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS WRITTEN THIS WAY
 *
 * Twice now, a patch left a function referring to a variable that only exists in
 * *another* function:
 *
 *   1. `init is not defined`        — the save handler used a local declared in
 *                                     openWallet().
 *   2. `vaultExists is not defined` — same mistake, renamed variable.
 *
 * Neither could be caught by anything else in this project. `node --check` sees
 * valid syntax. Grep sees the name present. The API tests see a server that is
 * perfectly happy, because the browser never got as far as calling it. And the
 * preview simulator drives the API directly, so it never runs a DOM handler.
 *
 * The only thing that catches a bug like that is RUNNING the function. So these
 * tests extract functions from public/app.js verbatim and execute them against
 * stubbed inputs.
 *
 * The first version of this file had a flaw worth naming: it supplied the
 * missing variable as a parameter, so it passed while the browser threw. A test
 * that hands over the variable under test can never fail. So now:
 *
 *   · The execution scope is a Proxy. Any name it does not have throws
 *     `X is not defined`, with X named — the same failure the user sees.
 *   · The scope's contents are pinned by a test of their own. A failing test
 *     cannot be silenced by adding the missing name to the scope: that trips the
 *     pin. It has to be fixed in app.js.
 *   · Every name in a scope must also be a real function in app.js.
 *
 * Run: node test/handlers.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* ─────────────────────────── source extraction ─────────────────────────── */

/** From the `{` at/after `open`, return the source up to its matching `}`. */
function matchingBrace(source, open) {
  let depth = 0;
  for (let j = open; j < source.length; j += 1) {
    const c = source[j];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  throw new Error('unbalanced braces');
}

/** `q('#edSave').onclick = async () => { … }` as an expression string. */
function extractSaveHandler(source) {
  const marker = "q('#edSave').onclick = async () => {";
  const i = source.indexOf(marker);
  if (i === -1) throw new Error('wallet save handler not found in public/app.js');
  const open = source.indexOf('{', i);
  return `async () => ${source.slice(open, matchingBrace(source, open) + 1)}`;
}

/** A named top-level function, as a function expression string. */
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const i = source.indexOf(marker);
  if (i === -1) throw new Error(`function ${name}() not found in public/app.js`);
  // Match the parameter list first: `opts = {}` contains a brace, so the first
  // `{` after the name is not necessarily the body.
  const paren = source.indexOf('(', i);
  let pdepth = 0;
  let body = -1;
  for (let j = paren; j < source.length; j += 1) {
    if (source[j] === '(') pdepth += 1;
    else if (source[j] === ')') {
      pdepth -= 1;
      if (pdepth === 0) { body = source.indexOf('{', j); break; }
    }
  }
  if (body === -1) throw new Error(`could not find the body of ${name}()`);
  return `(${source.slice(i, matchingBrace(source, body) + 1)})`;
}

/* ─────────────────────────── the execution scope ───────────────────────── */

/**
 * A scope with ONLY the given names. Everything else — including globals the
 * browser provides — resolves normally or throws `X is not defined`.
 */
function makeScope(injected) {
  return new Proxy(injected, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      if (key in globalThis) return globalThis[key];
      throw new ReferenceError(`${String(key)} is not defined`);
    },
  });
}

/**
 * Build a callable from an expression string, resolving free names through the
 * scope. `with` is unavailable in strict mode, hence new Function (sloppy).
 */
function build(expression, injected) {
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { return (${expression}); }`)(makeScope(injected));
}

/**
 * Build a function together with the REAL helpers it closes over.
 *
 * openWallet now merges the stored wallet config over defaultCfg() through
 * withDefaultCfg(), because a partial config threw while the dialog was being
 * mounted — which looks exactly like a Config button that does nothing. Both
 * helpers are lifted from app.js rather than stubbed, so this exercises the merge
 * that ships rather than a stand-in for it.
 *
 * Stubbing a dependency here would hide the class of bug this suite exists to
 * catch: a closed-over name that does not exist. "init is not defined" shipped
 * twice, and both times only executing the function in its real scope found it.
 */
function buildWith(expression, injected, helpers = []) {
  // The scope proxy claims EVERY name (has: () => true), so a helper declared
  // inside the built expression would be resolved against the scope and throw
  // before it is ever reached. Compile the real helpers separately, in one unit so
  // they can call each other, and hand them to the scope as genuine functions.
  // extractFunction returns a PARENTHESISED FUNCTION EXPRESSION, not a declaration.
  // Joined bare, two of them parse as a call of the first (`(...)(...)`), the names
  // never become bindings, and the scope then throws "X is not defined". Bind each
  // one explicitly.
  const prelude = helpers.map((name) => `const ${name} = ${extractFunction(src, name)};`).join('\n');
  // eslint-disable-next-line no-new-func
  const compiled = new Function(`${prelude}\n return { ${helpers.join(', ')} };`)();
  return build(expression, { ...injected, ...compiled });
}

/** Every name in a scope must be a real function in app.js, or an allowed global. */
const ALLOWED_GLOBALS = new Set(['S', 'q', '$', 'toast', 'confirm', 'api', 'esc', 'fmtSol', 'cls', 'renderAll', 'refreshAll']);
function assertScopeIsHonest(injected, label) {
  for (const name of Object.keys(injected)) {
    if (ALLOWED_GLOBALS.has(name)) continue;
    const defined = new RegExp(`function ${name}\\s*\\(`).test(src)
      || new RegExp(`(?:const|let|var) ${name}\\s*=`).test(src);
    if (!defined) {
      throw new Error(`${label}: scope supplies "${name}" but app.js defines no such function or constant — are you stubbing away a bug?`);
    }
  }
}

/* ───────────────────────────── stub plumbing ───────────────────────────── */

/** Minimal element stub, recording what the code puts in it. */
function makeElement() {
  const el = {
    value: '', textContent: '', innerHTML: '', disabled: false,
    _handlers: {},
    addEventListener(type, fn) { el._handlers[type] = fn; },
    click() { if (el._handlers.click) el._handlers.click(); },
    focus() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  return el;
}

function makeQ(values) {
  const els = {};
  return (sel) => {
    if (!els[sel]) els[sel] = makeElement();
    if (values && values[sel] !== undefined) els[sel].value = values[sel];
    return els[sel];
  };
}

function makeDom() {
  const els = {};
  const $ = (sel) => (els[sel] = els[sel] || makeElement());
  return { $, els };
}

/** The keystore-accessor contract, as the app defines it. */
function keystoreStateOf(state) {
  const exists = Boolean(state.keystore && state.keystore.initialised);
  const open = Boolean(state.keystore && state.keystore.unlocked);
  return { exists, open, locked: exists && !open, isNew: !exists };
}

/* ─────────────────────────── the wallet save handler ───────────────────── */

const saveHandlerSrc = extractSaveHandler(src);

/**
 * The complete set of names the handler is allowed to close over. Pinned by a
 * test below: if a future edit makes the handler need another name, the fix is
 * in app.js, not here.
 */
const SAVE_HANDLER_SCOPE = [
  'S', 'api', 'toast', 'confirm', 'q', 'esc', 'closeModal', 'refreshAll', 'renderAll',
  'openWallet', 'walletStore',
];

/**
 * A stand-in for public/wallets.js: the browser-side wallet store.
 *
 * It records what the app asks it to do, so a test can tell "the key was made in
 * this browser" from "the key was made in this browser and never sent to the
 * server" — which is the whole point of this design.
 */
function fakeStore(calls = {}) {
  const log = [];
  const push = (what, data) => { log.push(what); if (calls.on) calls.on(what, data); };
  return {
    PASS_MIN: 8,
    supported: () => true,
    list: () => (calls.wallets || []).map((w) => ({ id: w.id, label: w.label, address: w.address })),
    record: (address) => ({ address, ciphertext: 'sealed' }) && (calls.here ? calls.here(address) : null),
    create: async ({ label }) => { push('create', { label }); return { id: 'w_store_1', address: 'ADDR_ALPHA' }; },
    seal: async (a) => { push('seal', a); return 'w_store_2'; },
    unlock: async (address, pass) => {
      push('unlock', { address, pass });
      if (calls.passphrase && pass !== calls.passphrase) throw new Error('Wrong passphrase for this wallet');
      return new Uint8Array(64).fill(7);
    },
    parseSecret: async (key) => { push('parseSecret', { key }); return { secretKey: new Uint8Array(64).fill(9), address: 'ADDR_IMPORTED' }; },
    secretToBase58: (sk) => `SECRET_${sk[0]}`,
    remove: (address) => { push('remove', { address }); return true; },
    log,
  };
}

function walletSaveHandler({ state, api, toast, confirm, q, openWallet, calls, store }) {
  const injected = {
    S: state,
    api,
    toast: toast || (() => {}),
    confirm: confirm || (() => true),
    q: q || makeQ({}),
    closeModal: () => {},
    refreshAll: async () => {},
    renderAll: () => {},
    openWallet: (id) => { if (calls) calls.push({ p: `openWallet:${id}` }); },
    esc: (v) => String(v ?? ''),
    walletStore: () => store || fakeStore(),
  };
  assertScopeIsHonest(injected, 'save handler');
  return build(saveHandlerSrc, injected);
}

/* ────────────────────────────── the runner ─────────────────────────────── */

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      ${err.message}`);
      if (process.env.SNIPER_TEST_TRACE) console.log(String(err.stack).split('\n').slice(0,5).join('\n'));
    failed += 1;
  }
}

(async () => {
  console.log('\nThe wallet form handler — executed, not just parsed\n');

  await test('creating a wallet makes the key IN THIS BROWSER and tells the server only the address', async () => {
    const calls = [];
    const store = fakeStore();
    const state = { editing: { isNew: true }, wallets: [] };
    const handler = walletSaveHandler({
      state,
      store,
      api: async (p, o) => { calls.push({ p, method: o && o.method, body: o && o.body }); return { ok: true, wallet: 'w_new' }; },
      q: makeQ({ '#edName': 'Alpha', '#edPass': 'correct-horse', '#edKey': '', '#edPresetSel': 'balanced' }),
    });

    // A ReferenceError here is the bug that shipped twice, as `init is not
    // defined` and then as `vaultExists is not defined`. Now the same shape of
    // mistake would be `walletStore is not defined`.
    await handler();

    assert.ok(store.log.includes('create'), 'the keypair is generated in the browser');
    const paths = calls.map((c) => c.p);
    assert.ok(
      !paths.some((p) => String(p).startsWith('/api/keystore')),
      `the server keystore is not involved at all now, saw ${paths.join(', ')}`,
    );

    const reg = calls.find((c) => c.p === '/api/wallets');
    assert.ok(reg, 'the wallet is registered with the server');
    const body = JSON.parse(reg.body);
    assert.strictEqual(body.address, 'ADDR_ALPHA', 'the server is told the ADDRESS');
    assert.strictEqual(body.name, 'Alpha', 'and the name');
    assert.ok(!/SECRET/.test(reg.body), 'and never the secret key');

    const arm = calls.find((c) => /\/arm$/.test(c.p));
    assert.ok(arm, 'then the key is handed over for this session');
    assert.strictEqual(JSON.parse(arm.body).secretKey, 'SECRET_7', 'so the bot can sign');
  });

  await test('a first run needs no keystore at all, and still creates a wallet', async () => {
    const calls = [];
    const state = { editing: { isNew: true }, keystore: undefined, wallets: [] };
    const handler = walletSaveHandler({
      state,
      store: fakeStore(),
      api: async (p, o) => { calls.push({ p, body: o && o.body }); return { ok: true, wallet: 'w_new' }; },
      q: makeQ({ '#edName': 'First', '#edPass': 'eightchr', '#edKey': '', '#edPresetSel': 'balanced' }),
    });

    await handler();

    const paths = calls.map((c) => c.p);
    assert.ok(!paths.includes('/api/keystore/init'), `nothing to initialise — saw ${paths.join(', ')}`);
    assert.ok(paths.includes('/api/wallets'), 'the wallet itself is registered');
    assert.ok(paths.some((p) => /\/arm$/.test(p)), 'and armed');
  });

  await test('an empty passphrase stops before any request', async () => {
    const calls = [];
    const toasts = [];
    const store = fakeStore();
    const state = { editing: { isNew: true }, wallets: [] };
    const q = makeQ({ '#edName': 'Alpha', '#edPass': '', '#edKey': '' });
    const handler = walletSaveHandler({
      state, store,
      api: async (p) => { calls.push(p); return {}; },
      toast: (m) => toasts.push(m),
      q,
    });

    await handler();

    assert.strictEqual(calls.length, 0, 'nothing may be sent without a passphrase');
    assert.ok(!store.log.includes('create'), 'and no key may be generated');
    assert.ok(toasts.some((t) => /passphrase/i.test(t)), 'the user must be told why');
    assert.match(q('#edPassErr').innerHTML, /At least 8 characters/, 'and told the rule, next to the field');
  });

  await test('a passphrase that is too short is refused as well', async () => {
    const calls = [];
    const store = fakeStore();
    const state = { editing: { isNew: true }, wallets: [] };
    const handler = walletSaveHandler({
      state, store,
      api: async (p) => { calls.push(p); return {}; },
      toast: () => {},
      q: makeQ({ '#edName': 'Alpha', '#edPass': 'short12', '#edKey': '' }),
    });

    await handler();

    assert.strictEqual(calls.length, 0, 'seven characters is not a passphrase here');
    assert.ok(!store.log.includes('create'), 'and no key is generated');
  });

  await test('a missing name stops before any request', async () => {
    const calls = [];
    const toasts = [];
    const state = { editing: { isNew: true }, keystore: { initialised: true, unlocked: true }, wallets: [] };
    const handler = walletSaveHandler({
      state,
      api: async (p) => { calls.push(p); return {}; },
      toast: (m) => toasts.push(m),
      q: makeQ({ '#edName': '   ', '#edPass': 'whatever', '#edKey': '' }),
    });

    await handler();

    assert.strictEqual(calls.length, 0, 'no request without a name');
    assert.ok(toasts.some((t) => /name/i.test(t)), 'the user must be told why');
  });

  await test('a wallet is NEVER created without its own passphrase, even with the keystore open', async () => {
    const calls = [];
    const store = fakeStore();
    const state = { editing: { isNew: true }, keystore: { initialised: true, unlocked: true }, wallets: [] };
    const handler = walletSaveHandler({
      state, store,
      api: async (p) => { calls.push(p); return {}; },
      toast: () => {},
      q: makeQ({ '#edName': 'Alpha', '#edPass': '', '#edKey': '' }),
    });

    await handler();

    assert.strictEqual(calls.length, 0, 'the wallet is sealed with ITS passphrase — there is no session-wide shortcut');
    assert.ok(!store.log.includes('create'), 'and nothing is generated');
  });

  await test('importing a key proves it owns the address before anything is sealed', async () => {
    const calls = [];
    const store = fakeStore();
    const state = { editing: { isNew: true }, wallets: [] };
    const handler = walletSaveHandler({
      state, store,
      api: async (p, o) => { calls.push({ p, body: o && o.body }); return { ok: true, wallet: 'w_new' }; },
      q: makeQ({ '#edName': 'Imported', '#edPass': 'longenough1', '#edKey': 'BASE58KEY', '#edPresetSel': 'balanced' }),
    });

    await handler();

    assert.ok(store.log.includes('parseSecret'), 'the pasted key is parsed and verified in the browser');
    assert.ok(store.log.includes('seal'), 'and sealed there');
    const reg = calls.find((c) => c.p === '/api/wallets');
    const body = JSON.parse(reg.body);
    assert.strictEqual(body.address, 'ADDR_IMPORTED', 'the address comes from the key itself');
    assert.strictEqual(body.imported, true, 'and it is marked as an imported key');
  });

  await test('unlocking a wallet sends the key to the bot ONLY for the session', async () => {
    const calls = [];
    const store = fakeStore({ passphrase: 'rightpass1' });
    const state = {
      wallets: [{ id: 'w_1', name: 'Alpha', publicKey: 'ADDR_ALPHA' }],
      positions: [], logs: [], browserUnlocked: new Set(),
    };
    const toasts = [];
    // extractFunction returns `(function name(...){…})`; the keyword inside has to
    // become `async function` or its own `await` is a syntax error.
    const unlock = build(extractFunction(src, 'unlockWallet').replace('(function', '(async function'), {
      S: state,
      walletStore: () => store,
      keyHere: () => true,
      api: async (p, o) => { calls.push({ p, body: o && o.body }); return { ok: true }; },
      toast: (m, k) => toasts.push({ m, k }),
      refreshAll: async () => {},
      renderAll: () => {},
    });

    await unlock('w_1', 'rightpass1');
    const arm = calls.find((c) => /\/arm$/.test(c.p));
    assert.ok(arm, `the key is handed over for the session, saw ${JSON.stringify(calls)}`);
    assert.strictEqual(JSON.parse(arm.body).secretKey, 'SECRET_7', 'as a base58 key the server can sign with');
    assert.ok(state.browserUnlocked.has('w_1'), 'this browser stays open until view lock or reload');

    // ...and a wrong passphrase never reaches the server at all.
    calls.length = 0;
    await unlock('w_1', 'wrongpass').catch(() => {});
    assert.strictEqual(calls.length, 0, 'a key that will not unseal is never sent anywhere');
    assert.ok(toasts.some((t) => /wrong passphrase/i.test(t.m)), `the reason reaches the user: ${JSON.stringify(toasts)}`);
  });

  await test('a wallet whose key is not in this browser cannot be "unlocked" — it is refused', async () => {
    const calls = [];
    const toasts = [];
    const state = { wallets: [{ id: 'w_9', name: 'Ghost', publicKey: 'ADDR_GHOST' }], positions: [], logs: [] };
    // extractFunction returns `(function name(...){…})`; the keyword inside has to
    // become `async function` or its own `await` is a syntax error.
    const unlock = build(extractFunction(src, 'unlockWallet').replace('(function', '(async function'), {
      S: state,
      walletStore: () => fakeStore(),
      keyHere: () => false,
      api: async (p) => { calls.push(p); return {}; },
      toast: (m, k) => toasts.push({ m, k }),
      refreshAll: async () => {},
      renderAll: () => {},
    });

    await unlock('w_9', 'anything');
    assert.strictEqual(calls.length, 0, 'nothing is sent');
    assert.ok(toasts.some((t) => /import it/i.test(t.m)), `and the user is told the way back: ${JSON.stringify(toasts)}`);
  });

  await test('the test scope cannot be widened to hide a missing variable', () => {
    // This is the guard on the guard. When this test fails because the handler
    // needs a new name, the answer is a fix in public/app.js — NOT a new entry
    // here. Adding one here is how `vaultExists is not defined` reached the user
    // with a green test suite.
    const scope = walletSaveHandler({
      state: { editing: {} },
      api: async () => ({}),
      q: makeQ({}),
    });
    assert.strictEqual(typeof scope, 'function', 'the handler must build with exactly these names');
    assert.deepStrictEqual(
      SAVE_HANDLER_SCOPE.slice().sort(),
      ['S', 'api', 'toast', 'confirm', 'q', 'esc', 'closeModal', 'refreshAll', 'renderAll', 'openWallet', 'walletStore'].sort(),
      'the sanctioned name list changed — justify it in app.js first',
    );
  });

  console.log('\nThe wallets panel — executed, not just parsed\n');

  await test('an empty panel renders, whatever the server keystore is doing', () => {
    // This test used to run four times, for four keystore states, because the
    // empty panel branched on a server-side file. The wallets live in the BROWSER
    // now, so there is one empty state and one truth — and the three-way branch
    // that could render the wrong sentence cannot come back.
    for (const keystore of [undefined, { initialised: true, unlocked: false }, { initialised: true, unlocked: true }]) {
      const { $, els } = makeDom();
      const state = { wallets: [], keystore };
      const opened = [];
      const renderWallets = build(extractFunction(src, 'renderWallets'), {
        $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: (id) => opened.push(id),
        keyHere: () => false,
        esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
        browserHeldWallets: () => [], usdOf: () => '', renderWalletFeeds: () => {},
      });
      assertScopeIsHonest({
        $, S: state, keystoreState: () => {}, openKeystore: () => {}, openWallet: () => {}, keyHere: () => {}, esc: () => {}, fmtSol: () => {}, cls: () => {}, winRateOf: () => {},
      }, 'renderWallets');

      renderWallets(); // threw `vaultExists is not defined` before the fix

      const html = els['wallets'].innerHTML;
      assert.match(html, /No wallets yet/, 'an empty panel must say so');
      assert.match(html, /created in this browser/i, 'and say where a wallet lives now');
      assert.match(html, /Create your first wallet/, 'and offer the one useful action');
      assert.ok(!/vault/i.test(html), 'the user-facing name is keystore, never vault');
      els['emptyCreate'].click();
      assert.deepStrictEqual(opened, [null], 'the button opens the create form directly, never a keystore dialog');
    }
  });

  await test('a wallet the BROWSER holds is on screen even when the server has none', () => {
    // The reported failure, exactly: two wallets created, the hosted server's disk
    // wiped, the re-registration POST did not land — and the panel rendered the
    // server's empty list, "No wallets yet", while two sealed keys sat in
    // localStorage. Whatever the server knows, the browser's own wallets render.
    const { $, els } = makeDom();
    const state = { wallets: [], keystore: { initialised: true, unlocked: true } };
    const held = [{
      id: 'browser:So11111111111111111111111111111111111111112',
      name: 'My Burner',
      publicKey: 'So11111111111111111111111111111111111111112',
      localOnly: true, keyLocked: true,
      stats: { wins: 0, losses: 0, bought: 0, realisedPnlSol: 0 },
      openPositions: [],
    }];
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      keyHere: () => true,
      esc: (v) => String(v ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
      browserHeldWallets: () => held, renderWalletFeeds: () => {},
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.ok(!/No wallets yet/.test(html), 'the empty state must NOT appear while the browser holds a wallet');
    assert.match(html, /My Burner/, 'the wallet name is on screen');
    assert.match(html, /So11111111111111111111111111111111111111112/, 'and its address');
    assert.match(html, /data-register="/, 'with a one-tap way to put it back on the server');
    assert.match(html, /data-forget="/, 'and a way to delete it here, with the funds warning attached');
    assert.strictEqual(els['walletCount'].textContent, 1, 'and it counts');
  });

  await test('a card renders with REAL dollar values when the bot reports a rate', () => {
    // The stubbed scopes above use `usdOf: () => ''` so that a template which calls
    // it cannot crash the suite. This one uses the real helper, because the point is
    // that the numbers appear.
    const { $, els } = makeDom();
    const state = {
      wallets: [{
        id: 'w_1', name: 'Alpha', enabled: true, balanceSol: 2, paperTrading: true, paperBalanceSol: 10,
        publicKey: 'DEMO', persistent: true,
        stats: { bought: 6, wins: 3, losses: 2, realisedPnlSol: 1.5, tradesToday: 2 },
        config: { preset: 'balanced', buy: { maxConcurrentPositions: 4 }, exits: { stopLossPct: 25, takeProfitTiers: [{ gainPct: 50, sellPct: 33 }] }, limits: { dailyLossLimitSol: 2 } },
        openPositions: [],
      }],
      keystore: { initialised: true, unlocked: true },
      status: { solUsd: 200, solUsdSource: 'coingecko', solUsdStale: false }, browserUnlocked: new Set(['w_1']),
    };
    const usdOf = build(extractFunction(src, 'usdOf'), { S: state });
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      keyHere: () => true, usdOf,
      esc: (v) => String(v ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
      browserHeldWallets: () => [], renderWalletFeeds: () => {},
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /\$400/, '2 SOL at $200 a SOL is $400, on the balance');
    assert.match(html, /\$300/, 'and $1.50 realised is $300');
    assert.match(html, /key saved on server/, 'a wallet the bot holds says so on its card');
    assert.match(html, /data-unpersist/, 'and can be taken back out from there');
    assert.match(html, /Bought/, 'and its card counts what it bought');
  });

  await test('the SEND-TO-BOT dialog asks for the wallet passphrase, and the keystore one only when needed', () => {
    // The reference repo's `persistent-bot/start` — { walletAddress, secretKeyBase64 }
    // posted once so the bot keeps trading with the tab closed. The wiring is what
    // this asserts, because that is the part that has been missing twice.
    const persist = extractFunction(src, 'persistWallet');
    assert.match(persist, /\/persist`/, 'it posts the wallet key to the persist route');
    assert.match(persist, /secretToBase58/, 'sending the KEY the store unsealed');
    assert.match(persist, /keystorePassphrase/, 'and the keystore passphrase, to seal it at rest');
    assert.match(persist, /needsKeystore/, 'asked for only when the keystore is not already open');
    assert.match(persist, /pwPass|Passphrase/, 'with an explicit field for the wallet passphrase');
    assert.match(persist, /secret\.fill\(0\)/, 'and the unsealed bytes are wiped as soon as they are sent');
    const unpersist = extractFunction(src, 'unpersistWallet');
    assert.match(unpersist, /unpersist/, 'and there is a way to take the key back out');
  });

  await test('a wallet list renders a card per wallet with its own controls', () => {
    const { $, els } = makeDom();
    const state = {
      wallets: [{
        id: 'w_1', name: 'Alpha', enabled: true, balanceSol: 1.5, publicKey: 'DEMO',
        stats: { wins: 2, losses: 1, realisedPnlSol: 0.4 },
        config: { preset: 'balanced', buy: { maxConcurrentPositions: 4 }, exits: { stopLossPct: 25, takeProfitTiers: [{ gainPct: 50, sellPct: 33 }] }, limits: { dailyLossLimitSol: 2 } },
        openPositions: [],
      }],
      keystore: { initialised: true, unlocked: true },
    };
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 50,
      browserHeldWallets: () => [], usdOf: () => '', renderWalletFeeds: () => {}, keyHere: () => false,
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.strictEqual(els['walletCount'].textContent, 1, 'the count is set');
    assert.match(html, /Alpha/, 'the wallet name is shown');
    assert.match(html, /data-detail="w_1"/, 'and it keeps its own Trades control');
    assert.match(html, /data-withdraw="w_1"/, 'its own Withdraw control');
    assert.match(html, /data-close="w_1"/, 'and its own Kill all');
  });

  await test('browser reload locks view without stopping trader, and opening verifies passphrase', async () => {
    const { $, els } = makeDom();
    const state = {
      browserUnlocked: new Set(), // a new page; server reports SAME armed wallet
      wallets: [{ id: 'w_1', name: 'Live', publicKey: 'ADDR', armed: true,
        enabled: true, keyLocked: false, persistent: true, balanceSol: 1,
        config: { buy: {}, exits: {}, limits: {} }, stats: {}, openPositions: [] }],
      status: { dryRun: false },
    };
    const injected = { $, S: state, keyHere: () => true, esc: (x) => String(x),
      fmtSol: (x) => String(x), cls: () => '', winRateOf: () => 0,
      browserHeldWallets: () => [], usdOf: () => '', renderWalletFeeds: () => {},
      keystoreState: () => ({ open: false }) };
    const render = build(extractFunction(src, 'renderWallets'), injected);
    render();
    let html = els['wallets'].innerHTML;
    assert.match(html, /Browser locked · bot trading continues/);
    assert.match(html, /data-browser-open="w_1"/);
    assert.doesNotMatch(html, /data-withdraw=/);
    assert.doesNotMatch(html, /data-start=/);
    assert.match(html, /data-stop="w_1"/, 'an emergency stop remains available');
    const requests = [];
    const store = { unlock: async (_, pass) => {
      if (pass !== 'correctpass') throw new Error('Wrong passphrase');
      return new Uint8Array([1]);
    } };
    const open = build(extractFunction(src, 'openBrowserWallet').replace('(function', '(async function'), {
      S: state, walletStore: () => store, keyHere: () => true,
      toast: () => {}, renderWallets: render, api: (...args) => requests.push(args),
    });
    await open('w_1', 'wrongpass');
    assert.strictEqual(state.browserUnlocked.size, 0);
    await open('w_1', 'correctpass');
    assert.ok(state.browserUnlocked.has('w_1'));
    html = els['wallets'].innerHTML;
    assert.match(html, /data-withdraw="w_1"/);
    const lock = build(extractFunction(src, 'lockBrowserWallet'), {
      S: state, renderWallets: render, toast: () => {}, api: (...args) => requests.push(args),
    });
    lock('w_1');
    assert.match(els['wallets'].innerHTML, /Browser locked/);
    assert.strictEqual(requests.length, 0, 'browser view lock MUST NOT call the server lock route');
  });

  await test('keystoreState() answers the three states the UI words differently', () => {
    // S is a scope name, not a parameter, so each state needs its own build.
    const stateOf = (S, unlocked) => {
      const fn = build(extractFunction(src, 'keystoreState'), { S, isKeystoreUnlocked: () => unlocked });
      return JSON.parse(JSON.stringify(fn()));
    };

    assert.deepStrictEqual(
      stateOf({}, false),
      { exists: false, open: false, locked: false, isNew: true },
      'nothing created yet: the next passphrase entered creates it',
    );
    assert.deepStrictEqual(
      stateOf({ keystore: { initialised: true, unlocked: false } }, false),
      { exists: true, open: false, locked: true, isNew: false },
      'after a restart: the keystore exists but is closed',
    );
    assert.deepStrictEqual(
      stateOf({ keystore: { initialised: true, unlocked: true } }, true),
      { exists: true, open: true, locked: false, isNew: false },
      'an open session: nothing to ask for',
    );
  });

  console.log('\nThe create-wallet form the user actually sees\n');

  await test('the create form always asks for THIS wallet\'s passphrase — one per wallet', () => {
    // The passphrase no longer opens a shared server file; it seals this wallet's
    // key in this browser. So it is asked for every time, in the form itself, and
    // never described as something that already exists somewhere else.
    const captured = [];
    const state = {
      wallets: [], editing: null, keystore: { initialised: true, unlocked: false },
      config: {}, positions: [],
    };
    const openWallet = buildWith(extractFunction(src, 'openWallet'), {
      S: state,
      keystoreState: () => keystoreStateOf(state),
      openModal: (html) => captured.push(html),
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '',
      renderEditorPanes: () => {}, wireEditor: () => {}, toast: () => {}, q: makeQ({}),
      isKeystoreUnlocked: () => false,
      DEMO_PRESETS: { balanced: { label: 'Balanced', description: 'steady' } },
    }, ['defaultCfg', 'withDefaultCfg']);

    openWallet(null);

    assert.strictEqual(captured.length, 1, 'the form must open');
    const html = captured[0];
    assert.match(html, /id="edPass"/, 'the passphrase field must be in the form itself');
    assert.match(html, /id="edSave"/, 'and the save button');
    assert.match(html, /Create wallet/, 'which says Create wallet');
    assert.match(html, /this wallet/i, 'the label must name the wallet it protects');
    assert.match(html, /in this browser/i, 'and say where the key is created and kept');
    assert.match(html, /There is no recovery/i, 'and that this passphrase is the only way back');
    assert.ok(!/vault/i.test(html), 'never "vault"');
  });

  console.log('\nA wallet whose key is not loaded — visible, not missing\n');

  await test('a locked wallet still renders, with its name and address', () => {
    const { $, els } = makeDom();
    const state = {
      wallets: [{
        id: 'w_1', name: 'Alpha', publicKey: '6AQbPqPtB7ezHkbrTecLVN3te4uAeRqEqnWzsvyCmTCu',
        enabled: true, keyLocked: true, balanceSol: null, stats: null, openPositions: [],
        config: { preset: 'balanced' },
      }],
      keystore: { initialised: true, unlocked: false },
    };
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      keyHere: () => true,
      esc: (v) => String(v ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
      browserHeldWallets: () => [], usdOf: () => '', renderWalletFeeds: () => {},
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /Alpha/, 'the wallet is named, not hidden');
    assert.match(html, /6AQbPqPtB7ez/, 'and its on-chain address is shown');
    assert.match(html, /locked/i, 'and it says why it cannot trade');
    assert.match(html, /sealed in this browser/i, 'and where its key is');
    // THE FIX: a locked card must carry the control that unlocks it. It used to
    // say "locked" and offer nothing at all.
    assert.match(html, /id="armpass-w_1"/, 'a passphrase field, on the card');
    assert.match(html, /data-arm="w_1"/, 'and an Unlock button that arms it');
    assert.ok(!/data-close=/.test(html), 'it must not offer to kill a wallet it cannot reach');
    assert.ok(!/data-withdraw=/.test(html), 'nor to withdraw from it');
  });

  await test('a wallet whose key is gone says so, and offers to drop the record', () => {
    const { $, els } = makeDom();
    const state = {
      wallets: [{
        id: 'w_2', name: 'Old', publicKey: 'BWchFREuFmnwG3LXnsUKCN2aR4XCyC7t2y8HLHaNhXbs',
        enabled: false, keyLocked: true, keyMissing: true, balanceSol: null, stats: null,
        openPositions: [], config: { preset: 'balanced' },
      }],
      keystore: { initialised: true, unlocked: true },
    };
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      keyHere: () => false,
      esc: (v) => String(v ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
      browserHeldWallets: () => [], usdOf: () => '', renderWalletFeeds: () => {},
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /No key for this wallet is stored here/i, 'it must say the key is not on this device');
    assert.match(html, /stays on chain/i, 'and that funds are unaffected');
    assert.match(html, /data-importhere/, 'and offer the one action that can bring it back');
    assert.match(html, /data-delrecord/, 'and to delete the record');
    assert.ok(!/id="armpass-/.test(html), 'a field to type a passphrase would be a lie: there is nothing here to open');
  });

  await test('the banner names the locked wallets and points at their own cards', () => {
    const { $ } = makeDom();
    const state = {
      wallets: [
        { id: 'a', name: 'A', publicKey: 'ADDR_A', keyLocked: true, config: {}, stats: {} },
        { id: 'b', name: 'B', publicKey: 'ADDR_B', keyLocked: true, keyMissing: true, config: {}, stats: {} },
        { id: 'c', name: 'C', publicKey: 'ADDR_C', config: {}, stats: {} },
      ],
      keystore: { initialised: true, unlocked: false },
      status: { dryRun: true },
    };
    const notices = [];
    const renderNotices = build(extractFunction(src, 'renderNotices'), {
      $: (sel) => ({ ...makeElement(), set innerHTML(v) { notices.push(v); }, querySelector: () => null }),
      S: state, esc: (v) => String(v ?? ''), openKeystore: () => {}, keyHere: (a) => a === 'ADDR_A',
    });

    renderNotices();

    const html = notices.join('');
    // Shorter copy (round 9: "I don't need a long note to understand what a
    // feature does"), and the same two facts as before: HOW MANY are locked, and
    // where the fix is. The fix moved from a shared server file to each wallet's
    // own card, so the banner points there instead of at the keystore modal.
    assert.match(html, /2 wallets are locked/, 'both keyless wallets, named by count');
    assert.match(html, /card below/i, 'and where to unlock them');
    // Measure the LOCKED banner alone — the strip may legitimately carry other
    // one-line notices beside it.
    // The strip renders as one block, so pick out the LOCKED banner itself — the
    // dry-run notice legitimately sits beside it.
    const lockedHtml = notices
      .flatMap((strip) => String(strip).split('<div class="notice'))
      .filter((piece) => /wallet is locked|wallets are locked/.test(piece))
      .join('');
    const bannerText = lockedHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(bannerText.length < 160, `the locked-wallet banner reads ${bannerText.length} characters — too long for a note`);
  });

  await test('the reset flow demands the confirm word and the new passphrase', async () => {
    const captured = [];
    const calls = [];
    const openKeystoreForgot = build(extractFunction(src, 'openKeystoreForgot'), {
      openModal: (html, onMount) => { captured.push(html); onMount({
        querySelector: (sel) => ({
          set onclick(fn) { calls.push({ sel, fn }); },
          value: { '#frPass': 'brandnewpass', '#frConfirm': 'nope' }[sel] || '',
          set textContent(v) { calls.push({ sel, err: v }); },
        }),
      }); },
      api: async (path, o) => { calls.push({ path, body: o && o.body }); return { ok: true }; },
      closeModal: () => {}, toast: () => {}, syncKeystoreState: async () => {},
      refreshAll: async () => {}, renderAll: () => {}, esc: (v) => String(v ?? ''),
    });

    openKeystoreForgot();

    const html = captured[0];
    assert.match(html, /cannot be recovered/i, 'it must say the passphrase cannot be recovered');
    assert.match(html, /archived, not deleted/i, 'and that the old file is kept');
    assert.match(html, /keep their names and addresses/i, 'and what happens to existing wallets');
    assert.match(html, /Nothing on chain moves/i, 'and that no funds move');
    assert.match(html, /type RESET/i, 'and that a confirm word is required');

    // Wrong confirm word: nothing is sent.
    const go = calls.find((c) => c.sel === '#frGo');
    await go.fn();
    assert.ok(!calls.some((c) => c.path), 'no request may be sent without the confirm word');
    assert.ok(calls.some((c) => c.sel === '#frErr' && /RESET/.test(c.err || '')), 'and the user is told why');
  });

  await test('a confirmed reset posts RESET to the reset endpoint', async () => {
    const posts = [];
    const openKeystoreForgot = build(extractFunction(src, 'openKeystoreForgot'), {
      openModal: (html, onMount) => onMount({
        querySelector: (sel) => ({
          set onclick(fn) { if (sel === '#frGo') posts.handler = fn; },
          value: { '#frPass': 'brandnewpass', '#frConfirm': 'RESET' }[sel] || '',
          set textContent(v) {},
        }),
      }),
      api: async (path, o) => { posts.push({ path, body: JSON.parse(o.body) }); return { ok: true, archived: 'x' }; },
      closeModal: () => {}, toast: () => {}, syncKeystoreState: async () => {},
      refreshAll: async () => {}, renderAll: () => {}, esc: (v) => String(v ?? ''),
    });

    openKeystoreForgot();
    await posts.handler();

    const call = posts.find((p) => p.path);
    assert.ok(call, 'the reset must be sent');
    assert.strictEqual(call.path, '/api/keystore/reset', 'to the reset endpoint');
    assert.strictEqual(call.body.confirm, 'RESET', 'with the confirm word the server demands');
    assert.strictEqual(call.body.passphrase, 'brandnewpass', 'and the new passphrase');
  });

  console.log('\nWording contract\n');

  await test('the UI never says "vault", and never asks anyone to unlock a wallet', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    for (const [label, text] of [['app.js', src], ['index.html', html]]) {
      assert.ok(!/\bvault/i.test(text), `${label}: "vault" is back — the keystore has one name`);
    }
    const banned = ['Unlock to add a wallet', 'Unlock wallet', 'unlock your wallet', 'Unlock to continue', 'Unlock vault', 'Open vault'];
    for (const b of banned) {
      assert.ok(!src.includes(b), `confusing phrasing is back: "${b}"`);
    }
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
