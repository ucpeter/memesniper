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
async function bootDashboard({ wallets = 1, keystoreUnlocked = true, solUsd = null } = {}) {
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

  /* The SOL/USD rate the real server reports in /api/status. Offline there is none,
   * and a dollar helper that invented one would be worse than one that shows
   * nothing — so the tests that assert on dollars SET it, and the tests that do not
   * assert that no dollar sign appears where no rate exists. */
  if (solUsd !== null) {
    await window.eval(`S.status = Object.assign({}, S.status || {}, { solUsd: ${Number(solUsd)}, solUsdSource: 'test', solUsdStale: false });`);
  }

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

  await test('a heartbeat never erases a passphrase while it is being typed', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: false });
    // Render a locked browser-held wallet, the EXACT screen from the screenshot.
    window.eval(`S.wallets[0].id='w_phone'; S.wallets[0].name='Sniper 1';
      S.wallets[0].keyLocked=true; S.wallets[0].keyMissing=false;
      S.wallets[0].publicKey='PhoneAddress';
      window.WalletStore = { supported:()=>true,
        record:()=>({address:'PhoneAddress'}),list:()=>[{address:'PhoneAddress'}] };
      renderWallets();`);
    const field = $('[id^="armpass-"]');
    assert.ok(field, 'registered wallet shows its passphrase field');
    field.focus(); field.value = 'test passphrase';
    window.eval(`renderWallets(); handleWs({type:'tick', data:{
      status:S.status, wallets:S.wallets, prices:{} }});`);
    assert.strictEqual($('[id^="armpass-"]'), field, 'same input node; mobile keyboard stays open');
    assert.strictEqual(field.value, 'test passphrase', 'what the owner typed survives the tick');
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
    // Whatever the server keystore is doing. Its passphrase is no longer what
    // creating a wallet needs — the wallet's own passphrase seals its key in THIS
    // browser — so the field is there either way, and nothing asks anyone to
    // unlock a keystore first.
    for (const keystoreUnlocked of [true, false]) {
      const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked });

      await click(window, $('#btnAdd'));
      assert.ok($(MODAL), 'Add wallet did nothing');
      const text = $(MODAL).textContent;
      assert.match(text, /Create wallet/i, 'the form must offer Create wallet');
      assert.match(text, /this wallet/i, 'and say whose passphrase it wants');
      assert.ok(!/unlock/i.test(text), 'and must never use the word unlock');
      assert.ok($('#edPass'), 'the passphrase field is in the form itself, always');
      assert.match(text, /in this browser/i, 'and the form says where the key is created');
    }
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

  await test('a locked wallet card carries the control that unlocks IT', async () => {
    // This is the dead end the user hit: the card said "locked" and offered
    // nothing to do about it. Every locked card must carry its own way back —
    // a passphrase field when the key is sealed in this browser, an Import button
    // when it is not on this device at all.
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: false });
    // Pull the list through the simulator so it carries the same keyLocked flag
    // the real API sends. Setting S.wallets by hand skips that and would test
    // nothing.
    // A restart forgets the session keys: that is what `keyArmed: false` means.
    // With no key for this wallet in the browser either, the card must say so and
    // offer the one action that can bring it back — Import.
    await window.eval(`
      (async () => {
        S.wallets.forEach((w) => { w.keyArmed = false; });
        S.wallets = await demoApi('/api/wallets');
        window.WalletStore = { PASS_MIN: 8, supported: () => true, record: () => null, list: () => [] };
        renderAll();
      })()
    `);
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const card = $('.wallet');
    assert.match(card.textContent, /no key here/i, 'the card must say there is no key for it on this device');
    const importBtn = card.querySelector('button[data-importhere]');
    assert.ok(importBtn, 'a wallet whose key is not on this device offers Import');
    assert.ok(!card.querySelector('button[data-arm]'), 'and no Unlock button, which would be a lie');

    // With the key sealed here, the card shows the passphrase row and the Unlock
    // button instead — and typing a passphrase that does not open it must not
    // pretend it did.
    await window.eval(`
      S.wallets = S.wallets.map((w) => Object.assign({}, w, { id: 'w_dom', publicKey: 'ADDR_DOM' }));
      window.WalletStore = { PASS_MIN: 8, supported: () => true, record: () => ({ address: 'ADDR_DOM' }),
        list: () => [], unlock: async () => { throw new Error('Wrong passphrase for this wallet'); } };
      renderWallets();
    `);
    const locked = $('.wallet');
    assert.match(locked.textContent, /locked/i, 'with the key here, the card says locked');
    assert.match(locked.textContent, /sealed in this browser/i, 'and where the key is');
    const pass = locked.querySelector('input[type="password"]');
    assert.ok(pass, 'the locked card has a passphrase field of its own');
    const unlockBtn = locked.querySelector('button[data-arm]');
    assert.ok(unlockBtn, 'and an Unlock button');
    pass.value = 'not-it';
    await click(window, unlockBtn);
    assert.ok($('#toasts') ? /Wrong passphrase/i.test($('#toasts').textContent) : true, 'a wrong passphrase is reported');

    // A THIRD case, and it is the one every wallet made before the browser
    // keystore existed is in: the key is encrypted on the server, in the keystore
    // file, and one 🔐 away. Saying "no key here, import it" about that wallet is
    // false — and it is the card the user's own three wallets get, so it must offer
    // the keystore, not an import box.
    await window.eval(`
      S.wallets = S.wallets.map((w) => Object.assign({}, w, { keyLocked: true, keyArmed: false, keyMissing: false, balanceSol: null }));
      window.WalletStore = { PASS_MIN: 8, supported: () => true, record: () => null, list: () => [] };
      renderWallets();
    `);
    const inKeystore = $('.wallet');
    assert.match(inKeystore.textContent, /keystore/i, 'the card must say the key is in the keystore');
    assert.ok(inKeystore.querySelector('button[data-keystore]'), 'and offer to open it');
    assert.ok(!inKeystore.querySelector('button[data-importhere]'), 'importing is not the answer while the keystore may hold it');
    assert.ok(!inKeystore.querySelector('button[data-arm]'), 'nor is a passphrase field, which is for the browser-sealed case');
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

    // The user asked for short notes, twice: "I don't need a long note to
    // understand what a feature does". So this pins the two FACTS — trades are
    // simulated; funding and withdrawing are real — and not a word count of
    // prose. Anything longer than a line or two belongs in the README.
    assert.match(notices, /trades are simulated/i, 'the top strip must say what dry run does');
    assert.match(notices, /are real/i, 'and warn that funding and withdrawing are real regardless');
    const dryNotice = [...window.document.querySelectorAll('#notices .notice')]
      .find((el) => /trades are simulated/i.test(el.textContent));
    assert.ok(dryNotice, 'the dry-run notice must render');
    const len = dryNotice.textContent.replace(/\s+/g, ' ').trim().length;
    assert.ok(len < 90, `the dry-run notice is a note, not an essay (${len} chars)`);
    assert.match($('#modeText').textContent, /DRY RUN/i, 'the header chip as well');
    assert.match($('#modeChip').title || '', /simulated/i, 'and its tooltip must cover the same two facts');
    assert.match($('#modeBarSub').textContent, /simulated/i, 'and the mode bar, which is always on screen');
  });

  await test('a host that will wipe its disk warns BEFORE it does', async () => {
    // Render's free plan rebuilds data/ every time the service sleeps, which is how
    // the user lost a created wallet. If the API says the storage is ephemeral, the
    // dashboard has to say so too — and offer the way out.
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    const before = $('#notices').textContent;
    assert.ok(!/rebuilds its disk/i.test(before), 'no warning when the host keeps its disk');

    const storage = {
      dataDir: '/tmp/wherever',
      ephemeral: true,
      reason: 'This host rebuilds its disk when the service sleeps or redeploys.',
    };
    await window.eval(`S.status = Object.assign({}, S.status, { storage: ${JSON.stringify(storage)} }); renderAll();`);

    const after = $('#notices').textContent;
    assert.match(after, /rebuilds its disk/i, 'the warning must appear');
    assert.match(after, /wallets are safe/i, 'and say plainly that the wallets themselves are not at risk');
    assert.match(after, /sealed in this browser/i, 'because their keys live in the browser, not on that disk');
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

    // Arming live asks in a DIALOG DRAWN BY THE PAGE.
    //
    // It used to call window.prompt(). On a real phone the prompt was dismissed
    // and the app refused silently, so the user pressed LIVE and saw "Cancelled —
    // still in dry run" with nothing else: "what I get when I hit the live
    // button". A page-owned dialog cannot be swallowed by the browser.
    window.prompt = () => { throw new Error('window.prompt must not be used for this'); };
    await click(window, $('#modeLive'));
    const dialog = $('#modal') || window.document.querySelector('.modal-bg');
    assert.ok(dialog, 'tapping LIVE must open a confirmation dialog in the page');
    assert.strictEqual(window.eval('S.status.dryRun'), true, 'and it must not arm anything by itself');

    const word = window.document.querySelector('#lvWord');
    const arm = window.document.querySelector('#lvGo');
    assert.ok(word && arm, 'the dialog needs the word field and the arm button');
    assert.strictEqual(arm.disabled, true, 'the arm button starts disabled');

    word.value = 'no';
    word.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.strictEqual(arm.disabled, true, 'a wrong word keeps it disabled');
    await click(window, arm);
    assert.strictEqual(window.eval('S.status.dryRun'), true, 'and arming is refused');

    word.value = 'live';
    word.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.strictEqual(arm.disabled, false, 'the word LIVE — any case — unlocks the button');
    await click(window, arm);
    assert.strictEqual(window.eval('S.status.dryRun'), false, 'LIVE is armed');
    assert.ok($('#modeLive').classList.contains('on'), 'and the switch repaints');
    assert.match($('#modeBarTitle').textContent, /LIVE/);
    assert.match($('#modeText').textContent, /LIVE/i, 'and so does the header chip — it must not still say DRY RUN');
    assert.strictEqual(window.document.querySelector('.modal-bg'), null, 'the dialog closes itself');

    // …and going back to dry run is free: no dialog, no prompt, nothing to type.
    window.prompt = () => { throw new Error('returning to dry run must never ask'); };
    await click(window, $('#modeDry'));
    assert.strictEqual(window.eval('S.status.dryRun'), true, 'back to dry run');
    assert.match($('#modeBarTitle').textContent, /DRY RUN/);
    assert.strictEqual(window.document.querySelector('.modal-bg'), null, 'and it did not open a dialog');
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



  /**
   * The notes diet, pinned.
   *
   * "all the notes across the app saying what a feature does and does not ...
   * I don't need a long note to understand what a feature does".
   *
   * A CSS-selector rule for this would be brittle; what actually annoyed the user
   * was PARAGRAPHS on the dashboard, so this caps the visible notes there. Help
   * text the user deliberately opened (a settings field, a dialog) is not what
   * this measures.
   */
  await test('the notes on the dashboard are notes, not paragraphs', async () => {
    const { window, $ } = await bootDashboard({ wallets: 2, keystoreUnlocked: true });
    // Empty the lists first, so what is measured is the NOTE each panel shows and
    // not the table that replaces it once there is something to look at.
    await window.eval(`S.positions = []; S.history = []; S.scanFeed = []; renderPositions(); renderHistory(); renderWallets();`);
    for (const sel of ['#notices', '#modeBarSub', '#positions', '#history']) {
      const el = $(sel);
      if (!el) continue;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      assert.ok(
        text.length < 260,
        `${sel} carries ${text.length} characters of explanation — too long: "${text.slice(0, 120)}…"`,
      );
    }
    // And the two paragraphs the complaint started from are gone for good.
    const src = window.document.documentElement.innerHTML;
    assert.ok(!/because a settings flag must never be able to trap your money/.test(src), 'the withdraw essay is back');
    assert.ok(!/it does that every time/.test(src), 'the keystore-restart lecture is back');
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

  await test('terminal has no launch table, while wallet still has its own live feed', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    assert.strictEqual($('#scanFeed'), null, 'terminal launch table is removed');
    assert.ok($('#log'), 'terminal diagnostic log stays available');
    const walletFeed = $('[data-wallet-feed]');
    assert.ok(walletFeed, 'per-wallet launch table is retained');
    window.eval(`S.scanFeed = [{ mint: 'MINT_NEW', symbol: 'NEW', devHoldPct: 3,
      liquidityUsd: 2500, liquiditySol: 12.5, riskScore: 10, riskNotes: [],
      wallets: [{ name: S.wallets[0].name, action: 'skipped', reason: 'liquidity_below_min_usd' }],
      detectedAt: Date.now() }]; renderWallets();`);
    assert.match($('[data-wallet-feed]').textContent, /NEW/);
    assert.match($('[data-wallet-feed]').textContent, /liquidity below min usd/i);
    assert.strictEqual($('#scanFeed'), null);
  });

  /* ───────────── trades per wallet, and the overall card ───────────── */

  console.log('\nHow many trades, how many wins, how many losses\n');

  await test('every wallet\'s trades, wins and losses are on one card, with the total', async () => {
    const { window, $ } = await bootDashboard({ wallets: 3, keystoreUnlocked: true });
    await window.eval(`
      S.wallets[0].name = 'Alpha'; S.wallets[0].stats = { bought: 12, wins: 7, losses: 3, realisedPnlSol: 1.25, tradesToday: 4 };
      S.wallets[1].name = 'Beta';  S.wallets[1].stats = { bought: 8, wins: 2, losses: 5, realisedPnlSol: -0.5, tradesToday: 1 };
      S.wallets[2].name = 'Gamma'; S.wallets[2].stats = { bought: 0, wins: 0, losses: 0, realisedPnlSol: 0, tradesToday: 0 };
      S.status = Object.assign({}, S.status, { overall: { bought: 20, closed: 17, wins: 9, losses: 8, winRatePct: 52.9, open: 2 } });
      renderOverall();
    `);
    const card = $('#overall');
    assert.ok(card, 'the card must exist in the dashboard');
    const text = card.textContent;
    assert.match(text, /Alpha/, 'each wallet is named');
    assert.match(text, /Beta/);
    assert.match(text, /Gamma/);
    // Alpha: bought 12, closed 10, 7 won, 3 lost; Beta: bought 8, closed 7, 2 won, 5 lost.
    const alphaRow = [...card.querySelectorAll('tbody tr')].find((tr) => /Alpha/.test(tr.textContent));
    const cells = [...alphaRow.querySelectorAll('td')].map((td) => td.textContent.trim());
    assert.strictEqual(cells[1], '12', `Alpha must show the 12 tokens it bought (got ${cells[1]})`);
    assert.strictEqual(cells[2], '10', `and the 10 trades it closed (got ${cells[2]})`);
    assert.strictEqual(cells[3], '7', 'seven wins');
    assert.strictEqual(cells[4], '3', 'three losses');
    assert.match(cells[5], /70%/, 'and the win rate follows from them');
    assert.match(text, /All wallets/, 'and there is a totals row');
    assert.match(text, /17/, 'showing the overall closed count the server reported');
    assert.match(text, /20/, 'and the overall bought count');
  });

  await test('the wallet card counts what it BOUGHT, and its wins and losses', async () => {
    // "Add card to display how many token was bought how many win trade and loss
    // trade" — a wallet that bought eight tokens, closed ten trades of which four
    // won and six lost, shows all three numbers. The bought count is not the closed
    // count: positions that are still open were bought and have not closed.
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval(`
      S.wallets[0].name = 'Counter';
      S.wallets[0].stats = { bought: 8, wins: 4, losses: 6, realisedPnlSol: -0.2, tradesToday: 3 };
      renderWallets();
    `);
    const card = $('.wallet');
    const bought = [...card.querySelectorAll('.wstat')].find((el) => /Bought/.test(el.textContent));
    assert.ok(bought, 'the card must carry a Bought figure');
    assert.match(bought.textContent, /8/, 'the cards bought');
    assert.match(bought.textContent, /4W/, 'wins so far');
    assert.match(bought.textContent, /6L/, 'and losses so far');
  });

  await test('every SOL figure on a card carries its dollar value', async () => {
    // "all card holding sol to show the equivalent of the sol in dollar"
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true, solUsd: 200 });
    await window.eval(`
      S.wallets[0].stats = { bought: 2, wins: 2, losses: 1, realisedPnlSol: 1.5, tradesToday: 1 };
      renderWallets();
    `);
    const card = $('.wallet');
    assert.match(card.textContent, /\$/, 'the realised P&L shows a dollar equivalent');
    assert.match(card.textContent, /300/, '$1.5 at $200 a SOL is $300');
  });

  /* ─────────────────── the scanner log, per wallet ─────────────────── */

  console.log('\nEach wallet\'s own launches\n');

  await test('a wallet\'s feed shows what THAT wallet did, and not another wallet\'s rows', async () => {
    const { window, $ } = await bootDashboard({ wallets: 2, keystoreUnlocked: true });
    await window.eval(`
      S.wallets[0].name = 'Alpha'; S.wallets[0].id = 'w_alpha';
      S.wallets[1].name = 'Beta';  S.wallets[1].id = 'w_beta';
      S.scanFeed = [
        { mint: 'A'.repeat(40), symbol: 'ALPHACOIN', devHoldPct: 2, liquiditySol: 10, liquidityUsd: 2000,
          riskScore: 5, riskNotes: [], decision: 'bought', boughtBy: 'Alpha', detectedAt: Date.now(),
          wallets: [{ name: 'Alpha', action: 'bought' }, { name: 'Beta', action: 'skipped', reason: 'liquidity_below_min' }] },
        { mint: 'B'.repeat(40), symbol: 'BETACOIN', devHoldPct: 12, liquiditySol: 4, liquidityUsd: 800,
          riskScore: 30, riskNotes: [], decision: 'bought', boughtBy: 'Beta', detectedAt: Date.now(),
          wallets: [{ name: 'Alpha', action: 'filtered', reason: 'dev holds too much' }, { name: 'Beta', action: 'bought' }] },
      ];
      renderWallets();
    `);

    const feed = [...window.document.querySelectorAll('[data-wallet-feed]')]
      .find((el) => el.getAttribute('data-wallet-feed') === 'w_alpha');
    assert.ok(feed, 'the feed must be EMBEDDED in Alpha’s card');
    assert.match(feed.textContent, /ALPHACOIN/, 'a launch this wallet bought must be listed');
    assert.match(feed.textContent, /BETACOIN/, 'and a launch it declined must be listed');
    assert.match(feed.textContent, /bought/i, "with this wallet's own verdict");
    assert.match(feed.textContent, /dev holds too much/, 'including its own filter reason');
    assert.doesNotMatch(feed.textContent, /liquidity_below_min/, 'not Beta’s verdict');
    const beta = [...window.document.querySelectorAll('[data-wallet-feed]')]
      .find((el) => el.getAttribute('data-wallet-feed') === 'w_beta');
    assert.match(beta.textContent, /liquidity below min/, 'Beta has its own reason');
    assert.match(feed.textContent, /\$2,000/, 'liquidity displayed in dollars');
    assert.match(feed.textContent, /2\.0%/, 'dev hold appears on wallet card');
  });

  /* ────────────── withdrawing: who signs it, in plain words ────────────── */

  console.log('\nWithdrawing — signed here, or signed by the bot\n');

  await test('a wallet whose key is in this browser withdraws with a passphrase here, not a server key', async () => {
    const { window, $ } = await bootDashboard({ wallets: 1, keystoreUnlocked: true });
    await window.eval(`
      S.wallets[0].name = 'Signer'; S.wallets[0].id = 'w_sign'; S.wallets[0].publicKey = 'ADDR_SIGN';
      S.wallets[0].balanceSol = 2;
      window.WalletStore = { PASS_MIN: 8, supported: () => true, record: () => ({ address: 'ADDR_SIGN' }), list: () => [] };
      openWithdraw('w_sign');
    `);
    const modal = $('#modalRoot');
    assert.ok(modal.querySelector('#wdPass'), 'the dialog must ask for the passphrase that unseals the key HERE');
    assert.match(modal.textContent, /in this browser/i, 'and say where the signing happens');
    assert.match(modal.textContent, /never leave this device/i, 'and that the key does not travel');

    await window.eval(`
      S.wallets[0].name = 'ServerSigner'; S.wallets[0].id = 'w_srv';
      window.WalletStore = { PASS_MIN: 8, supported: () => true, record: () => null, list: () => [] };
      closeModal(); openWithdraw('w_srv');
    `);
    const second = $('#modalRoot');
    assert.ok(!second.querySelector('#wdPass'), 'a wallet whose key is NOT here must not be asked for a passphrase it cannot use');
    assert.match(second.textContent, /session key/i, 'and the dialog must say the bot signs it instead');
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
