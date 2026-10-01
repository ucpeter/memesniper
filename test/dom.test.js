'use strict';
/**
 * DOM test — boots the real dashboard in jsdom and CLICKS THE REAL BUTTONS.
 *
 * Why this suite exists
 * --------------------
 * Two rounds of bugs reached the user that no other test could see, because every
 * other test stops at the API boundary:
 *
 *   · the wallet card's Fund and Withdraw buttons rendered `data-fund` /
 *     `data-withdraw`, and the click handler never looked for those attributes —
 *     so on the live dashboard they did nothing at all, while the same features
 *     reached from ⚙ Config worked;
 *   · a transaction was signed with `tx.sign([keypair])` instead of
 *     `tx.sign(keypair)`, so web3.js read `.publicKey` off an Array and threw
 *     "Cannot read properties of undefined (reading 'toString')" — on withdraw,
 *     and on every live trade.
 *
 * Neither is an API bug. Both are "the user taps it and nothing happens" bugs. The
 * only way to catch that class is to load the page and tap.
 *
 * Run: node test/dom.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

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
    failed += 1;
  }
}

/**
 * Boot the dashboard offline.
 *
 * fetch rejects, so the app takes its own "no backend" path and drives the
 * embedded simulator. That is exactly what the preview does, and it exercises the
 * same DOM code: same renderers, same handlers, same modals.
 */
async function bootDashboard({ wallets = 1, keystoreUnlocked = true } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  const dom = new JSDOM(html.replace('<script src="./app.js"></script>', ''), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost:8787/terminal',
  });
  const { window } = dom;

  // No server: the app falls back to its simulator.
  window.fetch = async () => { throw new Error('offline'); };
  window.WebSocket = class { constructor() { this.readyState = 3; } addEventListener() {} close() {} send() {} };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));

  const script = window.document.createElement('script');
  script.textContent = appJs;
  window.document.body.appendChild(script);

  // Let boot() settle (it awaits a token fetch that rejects, then starts demo).
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));

  // `const S` at the top level of a classic script lives in the global LEXICAL
  // environment, not on `window`, so window.S is undefined. window.eval runs in
  // that same global scope and can reach it. (Cost me a debugging round: the
  // harness "passed" while setting nothing at all.)
  window.eval(`(function(){
    S.keystore = { initialised: true, unlocked: ${keystoreUnlocked} };
    S.demo = true;
    // Deterministic wallet count. demoNewWallet() copies the config of an
    // existing wallet, so the list must never be empty when it is called —
    // otherwise the first wallet gets a partial config.
    const seed = S.wallets[0] || (function () {
      const w = demoNewWallet('Seed', 'balanced');
      w.config = defaultCfg();
      return w;
    })();
    S.wallets.length = 0;
    for (let i = 1; i <= ${wallets}; i += 1) {
      const w = demoNewWallet('Wallet ' + i, 'balanced');
      w.config = defaultCfg();
      S.wallets.push(w);
    }
    S.positions = S.wallets.flatMap((w) => w.openPositions || []);
    renderAll();
    void seed;
  })()`);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

  return {
    dom,
    window,
    $: (sel) => window.document.querySelector(sel),
    $$: (sel) => [...window.document.querySelectorAll(sel)],
    evalInPage: (code) => window.eval(code),
  };
}

/** Click something and let the app's async handlers run.
 *
 * The wait matters: in the offline preview every api() call takes DEMO_MS (110ms)
 * of REAL time, and a handler routinely makes two or three of them in sequence
 * (act → refreshAll → renderAll). Spinning on setTimeout(0) — twenty macrotasks,
 * about 20ms — returned long before any of that had happened, so a click looked
 * like it had done nothing. That is how the round-8 tests first "failed": the
 * app was fine, the harness was too fast.
 */
async function click(window, el) {
  assert.ok(el, 'tried to click an element that does not exist');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 45; i += 1) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

(async () => {
  console.log('\nThe dashboard, in a real DOM — every control must do something\n');

  const MODAL = '#modalRoot .modal';

  await test('the dashboard renders wallets', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 2 });
    const cards = $$('.wallet');
    assert.strictEqual(cards.length, 2, `expected 2 wallet cards, saw ${cards.length}`);
    const html = window.document.body.innerHTML;
    assert.match(html, /MEME SNIPER/, 'the app title must be present');
    assert.match(html, /Wallet 1/, 'and the wallet names');
  });

  await test('a wallet card offers Fund, and tapping it OPENS the fund dialog', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1 });
    const fundBtn = $$('.wallet button[data-fund]')[0];
    assert.ok(fundBtn, 'the card must render a Fund button');

    assert.strictEqual($(MODAL), null, 'nothing should be open yet');
    await click(window, fundBtn);

    assert.ok($(MODAL), `tapping Fund on a wallet card did nothing — no dialog opened`);
    assert.match($(MODAL).textContent, /Fund/i, 'and it must be the funding dialog');
  });

  await test('a wallet card offers Withdraw, and tapping it OPENS the withdraw dialog', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1 });
    const wdBtn = $$('.wallet button[data-withdraw]')[0];
    assert.ok(wdBtn, 'the card must render a Withdraw button');

    await click(window, wdBtn);

    assert.ok($(MODAL), 'tapping Withdraw on a wallet card did nothing — no dialog opened');
    assert.match($(MODAL).textContent, /Withdraw/i, 'and it must be the withdraw dialog');
  });

  await test('every dialog can be CLOSED by its own button', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1 });

    const openers = [
      ['Fund', () => $$('.wallet button[data-fund]')[0]],
      ['Withdraw', () => $$('.wallet button[data-withdraw]')[0]],
      ['Trades', () => $$('.wallet button[data-detail]')[0]],
      ['Config', () => $$('.wallet button[data-edit]')[0]],
    ];

    for (const [label, pick] of openers) {
      const opener = pick();
      assert.ok(opener, `${label}: the control is missing from the card`);
      await click(window, opener);
      assert.ok($(MODAL), `${label}: the dialog did not open`);

      // Whichever close affordance the dialog offers — a Close/Cancel button or a
      // backdrop click. Every modal must have one that works.
      const closers = $$('#modalRoot button').filter((b) => /close|cancel/i.test(b.textContent));
      assert.ok(closers.length, `${label}: the dialog has NO close button at all`);

      let closed = false;
      for (const c of closers) {
        await click(window, c);
        if (!$(MODAL)) { closed = true; break; }
      }
      assert.ok(closed, `${label}: none of its close buttons closed the dialog (tried ${closers.length})`);
    }
  });

  await test('the add-wallet control opens the create form, not a keystore wall', async () => {
    // Keystore OPEN: the form still opens, and asks for no passphrase, because
    // none is needed. (The locked case is the next test.)
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });

    await click(window, $('#btnAdd'));
    assert.ok($(MODAL), 'Add wallet did nothing');
    const text = $(MODAL).textContent;
    assert.match(text, /Create wallet/i, 'the form must offer Create wallet');
    assert.ok(!/unlock/i.test(text), 'and must never use the word unlock');
    assert.strictEqual($('#edPass'), null, 'an open keystore needs no passphrase field');
  });

  await test('with the keystore closed, the create form carries the passphrase in itself', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: false });

    await click(window, $('#btnAdd'));
    assert.ok($(MODAL), 'Add wallet did nothing');
    assert.ok($('#edPass'), 'the passphrase field must be IN the form, never only in a dialog behind it');
    assert.match($(MODAL).textContent, /Create wallet/i, 'and the button just says Create wallet');
    assert.ok(!/unlock/i.test($(MODAL).textContent), 'and never says unlock');
  });

  await test('the create form can be closed too', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1 });
    await click(window, $('#btnAdd'));
    assert.ok($(MODAL), 'the form opened');

    const cancel = $$('#modalRoot button').find((b) => /cancel/i.test(b.textContent));
    assert.ok(cancel, 'the create form must have a Cancel button');
    await click(window, cancel);
    assert.strictEqual($(MODAL), null, 'Cancel must close the form');
  });

  await test('a locked wallet card offers a way to open the keystore', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1, keystoreUnlocked: false });
    // Pull the list through the simulator so it carries the same keyLocked flag
    // the real API sends. Setting S.wallets by hand skips that and would test
    // nothing.
    await window.eval("(async () => { S.wallets = await demoApi('/api/wallets'); renderAll(); })()");
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const card = $('.wallet');
    assert.match(card.textContent, /key locked/i, 'the card must say the key is locked');
    const ksBtn = card.querySelector('button[data-keystore]');
    assert.ok(ksBtn, 'and offer a button to open the keystore');

    await click(window, ksBtn);
    assert.ok($(MODAL), 'that button must open the keystore dialog');
    assert.match($(MODAL).textContent, /keystore/i, 'and it must be the keystore dialog');
  });

  await test('the wallet card separates REAL money from the simulation', async () => {
    // The card used to show "PAPER BAL. 10.000" for a wallet holding 0 SOL on chain,
    // and there was no way to tell which number was real. Real balance first, and
    // the simulated one named as simulated.
    const { $ } = await bootDashboard({ wallets: 2, keystoreUnlocked: true });
    const card = $('.wallet');
    const text = card.textContent;

    assert.match(text, /Real bal\./i, 'the real balance must be on the card');
    assert.match(text, /Sim\. balance/i, 'the simulated balance must be named as such');
    assert.match(text, /SIMULATED/i, 'and tagged SIMULATED, not "PAPER"');
    assert.ok(!/Paper bal/i.test(text), 'the old unreadable label must be gone');
  });

  await test('the dashboard states what dry run does and does not cover', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    const notices = $('#notices').textContent;

    assert.match(notices, /nothing here is buying or selling/i, 'the top strip must say so plainly');
    assert.match(notices, /simulated/i, 'and use the word for the simulated trades');
    assert.match(notices, /are real/i, 'and warn that funding and withdrawing are real regardless');
    assert.match($('#modeText').textContent, /DRY RUN/i, 'the header chip as well');
    assert.match($('#modeChip').title || '', /funding a wallet/i, 'and its tooltip must cover the same two facts');
  });

  await test('a host that will wipe its disk warns BEFORE it does', async () => {
    // Render's free plan rebuilds data/ every time the service sleeps, which is how
    // the user lost a created wallet. If the API says the storage is ephemeral, the
    // dashboard has to say so too — and offer the way out.
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    const before = $('#notices').textContent;
    assert.ok(!/deletes your wallets/i.test(before), 'no warning when the host keeps its disk');

    const storage = {
      dataDir: '/tmp/wherever',
      ephemeral: true,
      reason: 'This host rebuilds its disk when the service sleeps or redeploys.',
    };
    await window.eval(`S.status = Object.assign({}, S.status, { storage: ${JSON.stringify(storage)} }); renderAll();`);

    const after = $('#notices').textContent;
    assert.match(after, /deletes your wallets/i, 'the warning must appear');
    assert.match(after, /rebuilds its disk/i, 'with the reason from the API');
    assert.ok($('#notices').querySelector('[data-backup]'), 'and offer a Backup button');
    assert.ok($('#notices').querySelector('[data-restore]'), 'and a Restore button');
  });

  await test('the keystore dialog offers Backup and Restore, and they are wired', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: false });
    await window.eval('openKeystore()');
    const modal = $(MODAL);

    assert.ok(modal, 'the keystore dialog must open');
    assert.ok($('#ksBackup'), 'Backup button missing');
    assert.ok($('#ksRestore'), 'Restore button missing');
    assert.strictEqual(typeof $('#ksBackup').onclick, 'function', 'Backup must have a handler');
    assert.strictEqual(typeof $('#ksRestore').onclick, 'function', 'Restore must have a handler');

    // Restore opens its own dialog, and that dialog must close again.
    await click(window, $('#ksRestore'));
    const restore = $(MODAL);
    assert.match(restore.textContent, /Restore from a backup/i);
    assert.ok($('#rsFile'), 'a file picker is required');
    await click(window, [...restore.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent)));
    assert.strictEqual($(MODAL), null, 'Cancel must close the restore dialog');
  });

  await test('Backup and Restore really work in the offline preview', async () => {
    // The preview has no server. Every other control in it was made to work anyway,
    // so these two cannot be the exception: a button that only works when a server
    // happens to be running is a button that lies about the product.
    const { window, $ } = await bootDashboard({ wallets: 3, keystoreUnlocked: true });

    const backup = await window.eval("demoApi('/api/backup')");
    assert.strictEqual(backup.kind, 'meme-sniper-backup', 'the backup must be recognisable by the restore path');
    assert.strictEqual(backup.config.wallets.length, 3, 'and must carry the wallet list');
    assert.strictEqual(backup.keystore, null, 'the preview has no keystore, and must not pretend otherwise');

    // Losing wallets, then restoring them, is the whole point of the feature.
    await window.eval(`S.wallets.length = 0; renderAll();`);
    assert.strictEqual(window.eval('S.wallets.length'), 0, 'wallets cleared for the test');

    const payload = {
      confirm: 'RESTORE',
      backup: {
        kind: 'meme-sniper-backup',
        config: {
          wallets: [{
            id: 'w_x', name: 'Restored', publicKey: 'DEMO-Restored-not-a-real-address',
            enabled: true, config: {}, stats: {},
          }],
        },
      },
    };
    // demoApi parses opts.body, so the body must be a JSON *string*.
    const res = await window.eval(`demoApi('/api/restore', { method: 'POST', body: ${JSON.stringify(JSON.stringify(payload))} })`);
    assert.strictEqual(res.ok, true, 'the restore must succeed');
    assert.strictEqual(res.wallets, 1);
    assert.match($('#wallets').textContent, /Restored/, 'and the wallet must be back on the page');
  });

  await test('the live launch scanner renders each launch with its verdict and reason', async () => {
    // The user asked for this twice: a live pump.fun launch scanner display. The
    // panel must show rows, and a skipped row must say WHY it was skipped.
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    const panel = $('#scanFeed');

    assert.ok(panel, 'the launch scanner panel must exist on the dashboard');
    const rows = window.eval('S.scanFeed.length');
    assert.ok(rows >= 4, `expected the preview feed to carry rows, got ${rows}`);

    const text = panel.textContent;
    assert.match(text, /bought/i, 'a bought launch must be shown');
    assert.match(text, /skipped/i, 'so must a filtered one');
    assert.match(text, /dev hold/i, 'the filters must be intelligible on the row');
    assert.match(text, /liquidity/i, 'including the liquidity figure');
    assert.match(text, /infra error/i, 'and an RPC failure must be labelled as infrastructure');

    // The column headers are what make the numbers mean anything.
    for (const col of ['Token', 'Dev', 'Dev hold', 'Liquidity', 'Risk', 'Decision']) {
      assert.ok(panel.textContent.includes(col), `the table must have a "${col}" column`);
    }
  });

  await test('a live row patches in place instead of re-rendering the table', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    const before = $('#scanFeed').querySelectorAll('tbody tr').length;

    await window.eval(`handleWs({ type: 'scan', data: {
      mint: 'BRANDNEWmintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', symbol: 'NEWBIE', name: 'just launched',
      devWallet: 'Dev-not-real', devHoldPct: 1.5, liquiditySol: 5.5, riskScore: 0, riskNotes: [],
      decision: 'bought', skipReason: null, detectedAt: Date.now(), wallets: [{ name: 'Alpha', action: 'bought' }],
    } })`);

    const after = $('#scanFeed').querySelectorAll('tbody tr').length;
    assert.strictEqual(after, before + 1, 'a new launch must add exactly one row');
    assert.match($('#scanFeed').textContent, /NEWBIE/, 'and it must be on screen');

    // The same mint again is an UPDATE, not a second row — three wallets evaluating
    // one launch must not produce three identical lines.
    await window.eval(`handleWs({ type: 'scan', data: {
      mint: 'BRANDNEWmintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', symbol: 'NEWBIE', name: 'just launched',
      devWallet: 'Dev-not-real', devHoldPct: 1.5, liquiditySol: 5.5, riskScore: 0, riskNotes: [],
      decision: 'skipped', skipReason: 'top10_concentrated(41.2%)', detectedAt: Date.now(), wallets: [],
    } })`);
    assert.strictEqual($('#scanFeed').querySelectorAll('tbody tr').length, before + 1, 'the same mint must not add a row');
    assert.match($('#scanFeed').textContent, /top10 concentrated/i,
      'and the updated reason must replace the old verdict, in readable words');
  });

  /**
   * An empty scanner panel has three completely different causes and, before
   * round 8, one sentence for all of them. The user's complaint — "the pumpfun
   * lunch scanner is showing nothing and token scanned card is showing number of
   * token scanned" — is precisely the case where the counter moves and the panel
   * does not, so the panel has to say which cause it is instead of leaving the
   * contradiction on screen.
   */
  await test('the empty scanner panel names which of the three causes it is', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });

    await window.eval(`S.status = Object.assign({}, S.status, { running: false, scanner: { source: 'pumpportal', connected: false } });
      S.scanFeed = []; renderScanFeed();`);
    assert.match($('#scanFeed').textContent, /engine is stopped/i, 'the engine being off is one cause');
    assert.match($('#scanFeed').textContent, /▶ Engine/, 'and it must name the control that fixes it');

    await window.eval(`S.status = Object.assign({}, S.status, { running: true, scanner: { source: 'pumpportal', connected: true } });
      renderScanFeed();`);
    assert.match($('#scanFeed').textContent, /no launch has arrived yet/i, 'watching and quiet is another');

    await window.eval(`S.status = Object.assign({}, S.status, { running: true, scanner: { source: 'pumpportal', connected: false } });
      renderScanFeed();`);
    assert.match($('#scanFeed').textContent, /feed is not connected/i, 'a dead feed is the third — the one that read as the counter lying');
  });

  await test('the panel counter, the list and the meta line agree', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval(`S.status = Object.assign({}, S.status, { running: true,
      scanner: { source: 'pumpportal', connected: true },
      stats: { detected: 101, bought: 0, skipped: 101 } });
      S.scanFeed = [];
      upsertScanRow({ mint: 'M1', symbol: 'AAA', decision: 'skipped', skipReason: 'liquidity_below_min(0.4)' });
      upsertScanRow({ mint: 'M2', symbol: 'BBB', decision: 'checking' });
      renderScanFeed();`);
    assert.strictEqual($('#scanCount').textContent, '2', 'the panel counter is the number of rows in the list');
    assert.strictEqual($('#scanFeed').querySelectorAll('tbody tr').length, 2);
    const meta = $('#scanMeta').textContent;
    assert.match(meta, /2 launches in this list/, 'and the meta line says what the list holds');
    assert.match(meta, /101/, 'while reconciling it with the tokens-scanned counter instead of contradicting it');
  });

  /* ── the DRY RUN ⇄ LIVE switch ───────────────────────────────────────── */

  await test('the DRY RUN ⇄ LIVE switch is on the page, outside any dialog', async () => {
    const { $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    assert.ok($('#modeSwitch'), 'the switch must exist');
    assert.ok($('#modeDry'), 'DRY RUN side');
    assert.ok($('#modeLive'), 'LIVE side');
    assert.strictEqual($('#modeSwitch').closest('.modal-bg'), null, 'the switch must not be hidden inside a dialog');
    assert.strictEqual($('#modeBar').closest('.modal-bg'), null);
  });

  await test('the switch shows which mode is active, and flips it', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval('S.status.dryRun = true; renderChips();');
    assert.ok($('#modeDry').classList.contains('on'), 'dry run is the active side');
    assert.strictEqual($('#modeDry').getAttribute('aria-pressed'), 'true');
    assert.strictEqual($('#modeLive').getAttribute('aria-pressed'), 'false');
    assert.match($('#modeBarTitle').textContent, /DRY RUN/);

    // Arming live asks for the typed phrase first.
    window.prompt = () => 'nope';
    await click(window, $('#modeLive'));
    assert.strictEqual(window.eval('S.status.dryRun'), true, 'a wrong phrase must NOT arm live');

    window.prompt = () => 'I_UNDERSTAND_THE_RISK';
    await click(window, $('#modeLive'));
    assert.strictEqual(window.eval('S.status.dryRun'), false, 'the right phrase arms live');
    assert.ok($('#modeLive').classList.contains('on'), 'and the switch repaints');
    assert.match($('#modeBarTitle').textContent, /LIVE/);

    // …and going back to dry run is free: no phrase, and no prompt at all.
    window.prompt = () => { throw new Error('returning to dry run must never prompt'); };
    await click(window, $('#modeDry'));
    assert.strictEqual(window.eval('S.status.dryRun'), true, 'back to dry run');
    assert.match($('#modeBarTitle').textContent, /DRY RUN/);
  });

  /* ── a wallet you create is not a wallet that is trading ─────────────── */

  await test('a newly created wallet shows ▶ Start, not ⏸ Stop', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval(`S.wallets.push(demoNewWallet('Fresh', 'balanced')); renderAll();`);
    assert.ok($$('[data-start]').length >= 2, 'the fresh wallet and the un-armed seed both offer ▶ Start');
    assert.match($('#wallets').textContent, /not started/i, 'and the card says the wallet is not trading yet');
    // The seed wallet in the harness is un-armed too, so no ⏸ Stop anywhere.
    assert.strictEqual($$('[data-stop]').length, 0, 'nothing may look like it is already trading');
  });

  await test('pressing ▶ Start arms the wallet, and then it trades', async () => {
    const { window, $, $$ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval(`S.wallets.push(demoNewWallet('Fresh', 'balanced')); renderAll();`);
    const btn = $$('[data-start]')[0];
    assert.ok(btn, 'a Start button');
    const id = btn.dataset.start;
    await click(window, btn);
    assert.strictEqual(window.eval(`S.wallets.find((w) => w.id === '${id}').enabled`), true, 'the wallet is armed');
    assert.strictEqual(window.eval(`S.wallets.find((w) => w.id === '${id}').armed`), true);
    assert.ok($$('[data-stop]').length > 0, 'and its card now offers Stop');
  });

  /* ── paper trades are visibly paper ──────────────────────────────────── */

  await test('dry-run positions and history rows are labelled SIM', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval(`S.status.dryRun = true;
      const w = S.wallets[0];
      w.openPositions.push({ id: 'pz', walletId: w.id, wallet: w.name, symbol: 'PAPERCOIN', mint: 'PZ',
        status: 'OPEN', openedAt: Date.now(), solSpent: String(0.2e9), tokensHeld: '0', originalTokens: '0',
        pnlSol: 0.01, pnlPct: 5, priceGainPct: 5, peakGainPct: 7, stopLevelPct: -25, tiers: [], simulated: true });
      w.recentPositions.push({ id: 'cz', walletId: w.id, wallet: w.name, symbol: 'CLOSEDPAPER', mint: 'CZ',
        status: 'CLOSED', openedAt: Date.now() - 60000, closedAt: Date.now(), solSpent: String(0.2e9),
        realisedSol: String(0.24e9), pnlSol: 0.04, pnlPct: 20, exitReason: 'tp_20pct', simulated: true });
      S.positions = S.wallets.flatMap((x) => x.openPositions || []);
      S.history = S.wallets.flatMap((x) => x.recentPositions || []);
      renderAll();`);
    assert.match($('#positions').textContent, /PAPERCOIN/);
    assert.match($('#positions').textContent, /SIM/, 'an open paper position says so');
    assert.match($('#history').textContent, /CLOSEDPAPER/);
    assert.match($('#history').textContent, /SIM/, 'a closed paper trade says so');
    assert.match($('#stats').textContent, /paper/i, 'and the headline P&L says it is paper');
  });

  await test('the feed dot distinguishes "scanner stopped" from "feed offline"', async () => {
    // Both are "no rows arriving", but they are different problems with different
    // fixes, so they must not look identical.
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });

    await window.eval("S.status = Object.assign({}, S.status, { running: true, scanner: { source: 'pumpportal', connected: true } }); renderScanFeed();");
    assert.strictEqual($('#scanDotText').textContent, 'live');

    await window.eval("S.status = Object.assign({}, S.status, { running: false, scanner: { source: 'pumpportal', connected: true } }); renderScanFeed();");
    assert.strictEqual($('#scanDotText').textContent, 'scanner stopped');

    await window.eval("S.status = Object.assign({}, S.status, { running: true, scanner: { source: 'pumpportal', connected: false } }); renderScanFeed();");
    assert.strictEqual($('#scanDotText').textContent, 'offline');
  });

  await test('every Close and Cancel button in the app has a real handler', () => {
    // The Fund and Withdraw dialogs each rendered a Close button with an id
    // nothing ever wired, so tapping Close did nothing. One delegated path
    // (data-close-modal) now serves them all; this test fails if a new dialog
    // introduces another decorative button.
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const buttons = [...src.matchAll(/<button[^>]*>\s*(Close|Cancel)\s*<\/button>/gi)];

    assert.ok(buttons.length >= 6, `expected several close controls, found ${buttons.length}`);
    for (const [markup] of buttons) {
      const handled = /data-close-modal/.test(markup) || /onclick="closeModal\(\)"/.test(markup);
      if (handled) continue;
      // Otherwise it must be an id that something wires up.
      const id = (markup.match(/id="([^"]+)"/) || [])[1];
      const wired = id && new RegExp(`(querySelector\\('#${id}'\\)|\\$\\('#${id}'\\))[\\s\\S]{0,80}?onclick|addEventListener\\('click', closeModal\\)`).test(src);
      assert.ok(wired, `this close control does nothing when tapped: ${markup.trim()}`);
    }
  });

  await test('no wallet card control is left without a handler', async () => {
    // The general form of the bug: an attribute-based action that the delegated
    // click handler does not know about is a button that does nothing.
    const { window, $$ } = await bootDashboard({ wallets: 1, keystoreUnlocked: false });
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const delegated = new Set();
    for (const m of src.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*t\.dataset/g)) {
      m[1].split(',').forEach((k) => delegated.add(k.split(':')[0].trim()));
    }
    for (const m of src.matchAll(/t\.dataset\.([a-zA-Z]+)/g)) delegated.add(m[1]);

    const attrs = new Set();
    for (const el of $$('[data-fund],[data-withdraw],[data-detail],[data-edit],[data-stop],[data-start],[data-close],[data-keystore],[data-delrecord]')) {
      Object.keys(el.dataset).forEach((k) => attrs.add(k));
    }
    const orphans = [...attrs].filter((a) => !delegated.has(a));
    assert.deepStrictEqual(orphans, [], `these card actions have no click handler: ${orphans.join(', ')}`);
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
