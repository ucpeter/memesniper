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
  'openFund', 'openWalletDetail', 'isKeystoreUnlocked', 'keystoreState',
];

function walletSaveHandler({ state, api, toast, confirm, q, openWallet, calls }) {
  const injected = {
    S: state,
    api,
    toast: toast || (() => {}),
    confirm: confirm || (() => true),
    q: q || makeQ({}),
    closeModal: () => {},
    refreshAll: async () => {},
    renderAll: () => {},
    openFund: () => {},
    openWalletDetail: () => {},
    openWallet: (id) => { if (calls) calls.push({ p: `openWallet:${id}` }); },
    esc: (v) => String(v ?? ''),
    isKeystoreUnlocked: () => keystoreStateOf(state).open,
    keystoreState: () => keystoreStateOf(state),
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

  await test('a locked keystore with an existing file is opened, THEN the wallet is created', async () => {
    const calls = [];
    const state = { editing: { isNew: true }, keystore: { initialised: true, unlocked: false }, wallets: [] };
    const handler = walletSaveHandler({
      state,
      api: async (p, o) => {
        calls.push({ p, method: o && o.method });
        if (p === '/api/status') return { keystore: { initialised: true, unlocked: true } };
        return { ok: true, wallet: 'w_new' };
      },
      q: makeQ({ '#edName': 'Alpha', '#edPass': 'correct-horse', '#edKey': '' }),
    });

    // A ReferenceError here is the bug that shipped twice, as `init is not
    // defined` and then as `vaultExists is not defined`.
    await handler();

    const paths = calls.map((c) => c.p);
    const openAt = paths.indexOf('/api/keystore/unlock');
    const createAt = paths.indexOf('/api/wallets');
    assert.ok(openAt !== -1, `the keystore must be opened first, saw ${paths.join(', ') || 'nothing'}`);
    assert.ok(createAt !== -1, `the wallet must then be created, saw ${paths.join(', ')}`);
    assert.ok(openAt < createAt, 'and in that order');
    assert.strictEqual(calls[openAt].method, 'POST', 'opening it is a POST');
  });

  await test('a first run CREATES the keystore instead of trying to open one', async () => {
    const calls = [];
    const state = { editing: { isNew: true }, keystore: undefined, wallets: [] };
    const handler = walletSaveHandler({
      state,
      api: async (p, o) => {
        calls.push({ p, method: o && o.method });
        if (p === '/api/status') return { keystore: { initialised: true, unlocked: true } };
        return { ok: true, wallet: 'w_new' };
      },
      q: makeQ({ '#edName': 'First', '#edPass': 'eightchr', '#edKey': '' }),
    });

    await handler();

    const paths = calls.map((c) => c.p);
    assert.ok(paths.includes('/api/keystore/init'), `must create the keystore, saw ${paths.join(', ')}`);
    assert.ok(!paths.includes('/api/keystore/unlock'), 'must not try to open a keystore that does not exist');
    assert.ok(paths.includes('/api/wallets'), 'and then create the wallet');
  });

  await test('an empty passphrase stops before any request', async () => {
    const calls = [];
    const toasts = [];
    const state = { editing: { isNew: true }, keystore: { initialised: true, unlocked: false }, wallets: [] };
    const handler = walletSaveHandler({
      state,
      api: async (p) => { calls.push(p); return {}; },
      toast: (m) => toasts.push(m),
      q: makeQ({ '#edName': 'Alpha', '#edPass': '', '#edKey': '' }),
    });

    await handler();

    assert.strictEqual(calls.length, 0, 'nothing may be sent without a passphrase');
    assert.ok(toasts.some((t) => /passphrase/i.test(t)), 'the user must be told why');
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

  await test('a wrong passphrase is reported, and no wallet is created', async () => {
    const calls = [];
    const toasts = [];
    const state = { editing: { isNew: true }, keystore: { initialised: true, unlocked: false }, wallets: [] };
    const handler = walletSaveHandler({
      state,
      api: async (p) => {
        calls.push(p);
        if (p === '/api/keystore/unlock') throw new Error('Keystore unlock failed: wrong passphrase or the file has been tampered with.');
        return {};
      },
      // The handler funnels failures into toast(err.message, 'err') rather than
      // throwing at the caller — that is the app's existing error surface, so
      // assert on what the user actually sees.
      toast: (m, kind) => toasts.push({ m, kind }),
      q: makeQ({ '#edName': 'Alpha', '#edPass': 'wrong', '#edKey': '' }),
    });

    await handler();

    assert.ok(
      toasts.some((t) => /wrong passphrase/i.test(t.m)),
      `the reason must reach the user, saw: ${JSON.stringify(toasts)}`,
    );
    assert.ok(toasts.some((t) => t.kind === 'err'), 'and it must be shown as an error, not as success');
    assert.ok(!calls.includes('/api/wallets'), 'no wallet may be created on a failed unlock');
    assert.ok(!toasts.some((t) => /created/i.test(t.m)), 'and nothing may claim a wallet was created');
  });

  await test('an unlocked keystore creates the wallet with no passphrase', async () => {
    const calls = [];
    const state = { editing: { isNew: true }, keystore: { initialised: true, unlocked: true }, wallets: [] };
    const handler = walletSaveHandler({
      state,
      api: async (p, o) => { calls.push({ p, body: o && o.body }); return { ok: true, wallet: 'w_new' }; },
      q: makeQ({ '#edName': 'Alpha', '#edPass': '', '#edKey': '' }),
    });

    await handler();

    assert.deepStrictEqual(calls.map((c) => c.p), ['/api/wallets'], 'exactly one request');
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.name, 'Alpha', 'the name is sent');
    assert.strictEqual(body.secretKey, undefined, 'no key means a generated burner');
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
      ['S', 'api', 'toast', 'confirm', 'q', 'esc', 'closeModal', 'refreshAll', 'renderAll', 'openFund', 'openWalletDetail', 'isKeystoreUnlocked', 'keystoreState'].sort(),
      'the sanctioned name list changed — justify it in app.js first',
    );
  });

  console.log('\nThe wallets panel — executed, not just parsed\n');

  await test('an empty panel with a locked keystore renders (this is the crash that shipped)', () => {
    const { $, els } = makeDom();
    const state = { wallets: [], keystore: { initialised: true, unlocked: false } };
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
    });
    assertScopeIsHonest({
      $, S: state, keystoreState: () => {}, openKeystore: () => {}, esc: () => {}, fmtSol: () => {}, cls: () => {}, winRateOf: () => {},
    }, 'renderWallets');

    renderWallets(); // threw `vaultExists is not defined` before the fix

    const html = els['wallets'].innerHTML;
    assert.match(html, /No wallet is missing/, 'an empty panel with a locked keystore must explain itself');
    assert.match(html, /Create your first wallet/, 'and offer the one useful action');
    assert.ok(!/vault/i.test(html), 'the user-facing name is keystore');
  });

  await test('an empty panel with no keystore at all renders as a first run', () => {
    const { $, els } = makeDom();
    const state = { wallets: [], keystore: undefined };
    const opened = [];
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: (id) => opened.push(id),
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /Nothing here yet/, 'a first run must say there is nothing yet');
    assert.match(html, /no wallets, and no passphrase set/, 'and say plainly that nothing exists yet');
    assert.match(html, /Create your first wallet/, 'and offer to create one');
    // The button must open the CREATE FORM, not the keystore modal — the user
    // asked for this twice.
    els['emptyCreate'].click();
    assert.deepStrictEqual(opened, [null], 'the button opens the create form directly');
  });

  await test('an empty panel after a restart says nothing is missing, and still creates', () => {
    const { $, els } = makeDom();
    const state = { wallets: [], keystore: { initialised: true, unlocked: false } };
    const opened = [];
    let modals = 0;
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state),
      openKeystore: () => { modals += 1; }, openWallet: (id) => opened.push(id),
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /No wallet is missing/, 'a restart must not look like data loss');
    els['emptyCreate'].click();
    assert.strictEqual(modals, 0, 'and it must not put a keystore dialog in front of create');
    assert.deepStrictEqual(opened, [null], 'it opens the create form');
  });

  await test('an empty panel with an open keystore is just "add a wallet"', () => {
    const { $, els } = makeDom();
    const state = { wallets: [], keystore: { initialised: true, unlocked: true } };
    const renderWallets = build(extractFunction(src, 'renderWallets'), {
      $, S: state, keystoreState: () => keystoreStateOf(state), openKeystore: () => {}, openWallet: () => {},
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /Add a wallet/, 'the plain empty state');
    assert.ok(!/passphrase/i.test(html), 'no passphrase talk when none is needed');
    assert.ok(!/No wallet is missing/.test(html), 'and none of the recovery language');
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
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.strictEqual(els['walletCount'].textContent, 1, 'the count is set');
    assert.match(html, /Alpha/, 'the wallet name is shown');
    assert.match(html, /data-detail="w_1"/, 'and it keeps its own Trades control');
    assert.match(html, /data-withdraw="w_1"/, 'its own Withdraw control');
    assert.match(html, /data-close="w_1"/, 'and its own Kill all');
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

  await test('the form shows a passphrase field when the keystore is closed', () => {
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
    assert.match(html, /passphrase you chose when you created your first wallet/i,
      'the label must say WHICH passphrase is wanted');
    assert.match(html, /keystore/i, 'and name the file it belongs to');
    assert.match(html, /not a password for this new wallet/i,
      'and say out loud that it is not this wallet\'s own password');
    assert.ok(!/vault/i.test(html), 'never "vault"');
    assert.ok(!/unlock/i.test(html), 'and never tells anyone to unlock a wallet');
  });

  await test('the form asks a first-time user to CHOOSE a passphrase', () => {
    const captured = [];
    const state = { wallets: [], editing: null, keystore: undefined, config: {}, positions: [] };
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

    const html = captured[0];
    assert.match(html, /Choose a passphrase/, 'a first run is told to choose one');
    assert.match(html, /id="edPass"/, 'in the form itself');
    assert.ok(!/Keystore passphrase/.test(html), 'not told to produce one that exists');
  });

  await test('an unlocked session needs no passphrase in the form at all', () => {
    const captured = [];
    const state = { wallets: [], editing: null, keystore: { initialised: true, unlocked: true }, config: {}, positions: [] };
    const openWallet = buildWith(extractFunction(src, 'openWallet'), {
      S: state,
      keystoreState: () => keystoreStateOf(state),
      openModal: (html) => captured.push(html),
      esc: (s) => String(s ?? ''), fmtSol: (n) => String(n), cls: () => '',
      renderEditorPanes: () => {}, wireEditor: () => {}, toast: () => {}, q: makeQ({}),
      isKeystoreUnlocked: () => true,
      DEMO_PRESETS: { balanced: { label: 'Balanced', description: 'steady' } },
    }, ['defaultCfg', 'withDefaultCfg']);

    openWallet(null);

    const html = captured[0];
    assert.ok(!/id="edPass"/.test(html), 'no passphrase field when none is needed');
    assert.match(html, /Create wallet/, 'but the same Create wallet button');
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
      esc: (v) => String(v ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /Alpha/, 'the wallet is named, not hidden');
    assert.match(html, /6AQbPqPtB7ez/, 'and its on-chain address is shown');
    assert.match(html, /key locked/i, 'and it says why it cannot trade');
    assert.match(html, /This wallet is not lost/i, 'and that nothing has been lost');
    assert.match(html, /data-keystore/, 'and offers the one action that fixes it');
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
      esc: (v) => String(v ?? ''), fmtSol: (n) => String(n), cls: () => '', winRateOf: () => 0,
    });

    renderWallets();

    const html = els['wallets'].innerHTML;
    assert.match(html, /not in it|not in your keystore/i, 'it must say the key is not in the keystore');
    assert.match(html, /stays on chain/i, 'and that funds are unaffected');
    assert.match(html, /data-delrecord/, 'and offer to delete the record');
    assert.ok(!/data-keystore/.test(html), 'opening the keystore cannot help here, so it must not be offered');
  });

  await test('the banner counts only the wallets a keystore can still recover', () => {
    const { $ } = makeDom();
    const state = {
      wallets: [
        { id: 'a', name: 'A', keyLocked: true, config: {}, stats: {} },
        { id: 'b', name: 'B', keyLocked: true, keyMissing: true, config: {}, stats: {} },
        { id: 'c', name: 'C', config: {}, stats: {} },
      ],
      keystore: { initialised: true, unlocked: false },
      status: { dryRun: true },
    };
    const notices = [];
    const renderNotices = build(extractFunction(src, 'renderNotices'), {
      $: (sel) => ({ ...makeElement(), set innerHTML(v) { notices.push(v); }, querySelector: () => null }),
      S: state, esc: (v) => String(v ?? ''), openKeystore: () => {},
    });

    renderNotices();

    const html = notices.join('');
    // Shorter copy (round 9: "I don't need a long note to understand what a
    // feature does"), same two facts: HOW MANY are locked, and that opening the
    // keystore is the fix. The "not lost" reassurance lives on the wallet card,
    // where the user is actually looking when they wonder about one wallet.
    assert.match(html, /1 wallet is locked/, 'one recoverable wallet, not two');
    assert.match(html, /keystore locks on every restart/i, 'and say why it is locked at all');
    // Measure the LOCKED banner alone — the strip may legitimately carry other
    // one-line notices beside it.
    // The strip renders as one block, so pick out the LOCKED banner itself — the
    // dry-run notice legitimately sits beside it.
    const lockedHtml = notices
      .flatMap((strip) => String(strip).split('<div class="notice'))
      .filter((piece) => /wallet is locked|wallets are locked/.test(piece))
      .join('');
    const bannerText = lockedHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(bannerText.length < 130, `the locked-wallet banner reads ${bannerText.length} characters — too long for a note`);
    assert.match(html, /data-keystore/, 'with a button to open the keystore');
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
