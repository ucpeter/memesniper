'use strict';
/**
 * Preview test — drives the offline demo simulator in public/app.js.
 *
 * The dashboard falls back to this simulator when there is no server, so that
 * every button in the preview performs a visible state change. That makes the
 * simulator load-bearing: if it drifts from the real API's behaviour, the
 * preview starts lying about what the buttons do.
 *
 * This suite pins it to the same contract as the real routes: the same errors,
 * the same confirm tokens, the same money arithmetic.
 *
 * Run: node test/preview.test.js
 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Extract just the pieces the simulator needs.
const grab = (name) => {
  const i = src.indexOf(name);
  if (i === -1) throw new Error(`missing ${name}`);
  return i;
};
const S = { wallets: [], positions: [], logs: [], status: { running: false, dryRun: true, stats: {} }, keystore: { initialised: true, unlocked: false }, config: {} };
const DEMO_PRESETS = { safe:{}, balanced:{}, aggressive:{}, degen:{}, scalper:{} };

const start = grab('const DEMO_MS');
const end = src.indexOf('/* ============================================================\n   EVENTS');
let sim = src.slice(start, end);
/* `upsertScanRow` lives outside the extracted block (it belongs to the render
 * layer) but the launch generator calls it. Passing it in as a parameter keeps
 * the slice runnable without dragging the DOM in — and lets the test see what the
 * preview put in the feed. */
const scanRows = [];
const noop = () => {};
const fn = new Function(
  'S', 'DEMO_PRESETS', 'upsertScanRow', '$', 'renderScanner', 'renderStats', 'renderWallets', 'renderPositions', 'renderScanFeed',
  `${sim}; return { demoApi, demoSellPosition, demoNewWallet, demoWalletOfPosition, demoTickAll, demoTickLaunches };`
);
const api = fn(
  S, DEMO_PRESETS,
  (row) => { scanRows.push(row); (S.scanFeed || (S.scanFeed = [])).unshift(row); },
  () => null, noop, noop, noop, noop, noop,
);

(async () => {
  const w = { id:'w1', name:'Alpha', enabled:true, balanceSol:4.82, exposureSol:0.4, publicKey:'DEMO-Alpha',
    stats:{ realisedPnlSol:2.41, wins:9, losses:5, tradesToday:14, paused:false },
    openPositions:[{ id:'p1', walletId:'w1', symbol:'MOON', solSpent:String(0.4e9), pnlSol:0.51, status:'OPEN' }],
    recentPositions:[], config:{ preset:'balanced', buy:{}, exits:{}, limits:{}, filters:{} } };
  S.wallets = [w];
  S.positions = [...w.openPositions];

  let pass = 0, fail = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ok  ${name}`); pass++; } catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

  await t('locked keystore refuses wallet creation with a clear error', async () => {
    let err = null; try { await api.demoApi('/api/wallets', { method:'POST', body: JSON.stringify({ name:'Nope' }) }); } catch (e) { err = e; }
    eq(Boolean(err), true, 'must throw'); 
    if (!/keystore_locked/.test(err.message)) throw new Error(`wrong error: ${err.message}`);
  });

  await t('unlock rejects a short passphrase, accepts 8+', async () => {
    let err = null; try { await api.demoApi('/api/keystore/unlock', { method:'POST', body: JSON.stringify({ passphrase:'short' }) }); } catch (e) { err = e; }
    if (!/at least 8/.test(err.message)) throw new Error('should reject short');
    const r = await api.demoApi('/api/keystore/unlock', { method:'POST', body: JSON.stringify({ passphrase:'eightchr' }) });
    eq(r.ok, true, 'must unlock'); eq(S.keystore.unlocked, true, 'state');
  });

  await t('creating a wallet adds it, with a non-spendable address', async () => {
    const r = await api.demoApi('/api/wallets', { method:'POST', body: JSON.stringify({ name:'Bravo', preset:'scalper' }) });
    eq(S.wallets.length, 2, 'wallet count');
    const created = S.wallets.find((x) => x.id === r.wallet);
    eq(/^DEMO-/.test(created.publicKey), true, 'address must be an obvious placeholder');
    eq(created.config.preset, 'scalper', 'preset applied');
  });

  await t('a wallet you create is created STOPPED', () => {
    const fresh = S.wallets.find((x) => x.name === 'Bravo');
    eq(fresh.enabled, false, 'creating a wallet is not a decision to trade');
    eq(fresh.armed, false, 'so the card shows ▶ Start, not ⏸ Stop');
  });

  await t('START/STOP are per wallet, and START actually ARMS it', async () => {
    // Round 8: Start only cleared `paused`, while the entry gate reads
    // `enabled` — which is false on every new wallet. Start did nothing a second
    // time, so no dry-run trade could ever open.
    const other = S.wallets[1];
    other.enabled = true; other.armed = true; // sanity for the "untouched" half
    await api.demoApi('/api/wallets/w1/stop', { method:'POST', body:'{}' });
    eq(w.stats.paused, true, 'stopped');
    eq(w.enabled, false, 'and disarmed');
    eq(w.armed, false);
    eq(other.stats.paused, false, 'the other wallet must be untouched');
    await api.demoApi('/api/wallets/w1/start', { method:'POST', body:'{}' });
    eq(w.stats.paused, false, 'restarted');
    eq(w.enabled, true, 'ARMED — the flag the entry gate reads');
    eq(w.armed, true, 'and the flag the card reads');
  });

  /**
   * Paper trading in the preview, pinned.
   *
   * The user's complaint was "in the dry run am not seeing any dry run trade
   * happening". The preview has to show the lifecycle, and these two tests are
   * what keeps that honest. They run against a throwaway wallet of their own and
   * restore S afterwards, because the fixture wallets below assert exact counts.
   */
  await t('the preview RUNS paper trades: launches arrive and armed wallets take them', async () => {
    const realRandom = Math.random;
    const savedWallets = S.wallets.slice();
    const savedPositions = S.positions;
    Math.random = () => 0.9; // deterministic: pinned high, so the preview always buys
    try {
      const probe = api.demoNewWallet('PaperProbe', 'balanced');
      probe.enabled = true; probe.armed = true; probe.stats.paused = false;
      S.wallets = [probe];
      S.positions = [];

      const before = scanRows.length;
      for (let i = 0; i < 6; i += 1) api.demoTickLaunches();
      if (scanRows.length <= before) throw new Error('no launches reached the scanner feed');
      const row = scanRows[scanRows.length - 1];
      if (!row.mint || !row.symbol) throw new Error('a feed row needs a mint and a symbol');
      if (!['bought', 'skipped'].includes(row.decision)) throw new Error(`odd decision: ${row.decision}`);
      if (!S.positions.length) throw new Error('an armed wallet in dry run must open a PAPER position');
      const p = S.positions[S.positions.length - 1];
      eq(p.simulated, true, 'and the position must be tagged simulated, so it is never mistaken for a real fill');
      if (!p.demoTargetPct) throw new Error('a paper position needs a target, or it can only ever stop out');
      eq(probe.openPositions.length, S.positions.length, 'the wallet and the board agree');
    } finally {
      Math.random = realRandom;
      S.wallets = savedWallets;
      S.positions = savedPositions;
    }
  });

  await t('a paper position closes into history at its target', async () => {
    const realRandom = Math.random;
    const savedWallets = S.wallets.slice();
    const savedPositions = S.positions;
    Math.random = () => 0.9;
    try {
      const probe = api.demoNewWallet('PaperProbe', 'scalper');
      probe.enabled = true; probe.armed = true; probe.stats.paused = false;
      S.wallets = [probe];
      S.positions = [];

      api.demoTickLaunches();
      api.demoTickLaunches();
      api.demoTickLaunches();
      const p = probe.openPositions[0];
      if (!p) throw new Error('no paper position open to close');
      p.pnlPct = p.demoTargetPct + 1;
      const histBefore = probe.recentPositions.length;
      S.demo = true; // demoTickAll is the preview's heartbeat; it only beats in demo mode
      api.demoTickAll();
      if (probe.recentPositions.length <= histBefore) throw new Error('the take-profit did not book');
      eq(probe.openPositions.length, 0, 'the paper position is closed');
      eq(probe.recentPositions[0].status, 'CLOSED', 'booked into history');
      eq(probe.recentPositions[0].exitReason.startsWith('tp_'), true, 'with the take-profit as its reason');
      if (!(probe.stats.realisedPnlSol > 0)) throw new Error('a winning paper trade must book realised P&L');
    } finally {
      Math.random = realRandom;
      S.wallets = savedWallets;
      S.positions = savedPositions;
    }
  });

  await t('config edits persist to the wallet', async () => {
    await api.demoApi('/api/wallets/w1', { method:'PUT', body: JSON.stringify({ name:'Alpha', buy:{ minAmountSol:0.42 }, filters:{ minLiquiditySol:2, maxLiquiditySol:9 }, resumeAfterRestart:false }) });
    eq(w.config.buy.minAmountSol, 0.42, 'buy block merged');
    eq(w.config.filters.maxLiquiditySol, 9, 'filters merged');
    eq(w.config.resumeAfterRestart, false, 'keep-running flag saved');
  });

  await t('arming live mode needs the confirm token', async () => {
    let err = null; try { await api.demoApi('/api/engine/dry-run', { method:'POST', body: JSON.stringify({ dryRun:false }) }); } catch (e) { err = e; }
    if (!err) throw new Error('must refuse without confirm');
    const ok = await api.demoApi('/api/engine/dry-run', { method:'POST', body: JSON.stringify({ dryRun:false, confirm:'I_UNDERSTAND_THE_RISK' }) });
    eq(ok.dryRun, false, 'with the phrase, live is armed');
    await api.demoApi('/api/engine/dry-run', { method:'POST', body: JSON.stringify({ dryRun:true }) });
    eq(S.status.dryRun, true, 'and back to dry run needs no phrase');
  });

  /**
   * The switch itself, pinned.
   *
   * "there is no switch between dry run and live trade" was the complaint. A
   * control that exists only in a settings dialog, and only for one of the two
   * directions, is not a switch — so both the markup and the wiring are pinned.
   */
  await t('the DRY RUN / LIVE switch exists in the page and both sides are wired', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    if (!/id="modeSwitch"/.test(html)) throw new Error('no switch in the page');
    if (!/id="modeDry"/.test(html)) throw new Error('no DRY RUN side');
    if (!/id="modeLive"/.test(html)) throw new Error('no LIVE side');
    if (!/id="modeBar"/.test(html)) throw new Error('the switch has no visible bar to live in');
    if (!/await setTradingMode\(false\)/.test(src)) throw new Error('the DRY RUN side is not wired');
    if (!/await setTradingMode\(true\)/.test(src)) throw new Error('the LIVE side is not wired');
    if (!/function setTradingMode\(/.test(src)) throw new Error('there is no single mode setter');
    // The settings dialog must use the same path, or the two can drift.
    if (!/await setTradingMode\(goingLive\)/.test(src)) throw new Error('settings has its own copy of the mode change');
    // …and neither of them may reach for window.prompt(), which is what made the
    // switch look broken on a phone.
    if (/prompt\(\s*['"`]LIVE MODE/.test(src)) throw new Error('the browser prompt is back in the LIVE path');
    if (!/function openLiveConfirm\(/.test(src)) throw new Error('the in-page confirmation is gone');
  });

  await t('the dashboard reads the launch feed the server sends', () => {
    if (!/msg\.data\.scanFeed/.test(src)) throw new Error('the snapshot\'s scanFeed is ignored — the panel stays empty on a live page');
    if (!/\/api\/scan\?limit=200/.test(src)) throw new Error('no initial fetch, so a reload before the first launch shows an empty panel');
    if (!/renderScanFeed\(\)/.test(src)) throw new Error('renderScanFeed is gone');
  });

  await t('deleting a wallet removes it and its positions', async () => {
    await api.demoApi('/api/wallets/w_demo_x', { method:'DELETE' }).catch(() => {});
    const other = S.wallets[1].id;
    await api.demoApi(`/api/wallets/${other}`, { method:'DELETE' });
    eq(S.wallets.length, 1, 'removed');
  });

  await t('an unknown endpoint fails loudly instead of silently', async () => {
    let err = null; try { await api.demoApi('/api/nope/nope', { method:'POST', body:'{}' }); } catch (e) { err = e; }
    if (!err) throw new Error('must throw');
  });

  /* ─────────────────── controls that must never go missing ─────────────── */

  /**
   * These pin CONTROLS, not behaviour.
   *
   * Twice now a control has quietly disappeared from view — the keystore
   * passphrase (it lived only in a modal that gets skipped when you are already
   * unlocked) and the wallet Delete button (it existed only in one of the two
   * places a wallet can be opened from) — and each time it looked like the
   * feature had been deleted. A test that fails when a control vanishes is the
   * only way to keep that honest.
   */
  await t('the create-wallet form contains a keystore passphrase field', () => {
    if (!/id="edPass"/.test(src)) throw new Error('no passphrase field in the create form');
    if (!/Keystore passphrase/.test(src)) throw new Error('the field is not labelled');
    if (!/Choose a passphrase/.test(src)) throw new Error('no label for a first-time user');
    if (!/init \? '\/api\/keystore\/init' : '\/api\/keystore\/unlock'/.test(src)) {
      throw new Error('the form collects a passphrase but never unlocks with it');
    }
  });

  await t('the create-wallet flow cannot silently skip the passphrase', () => {
    const i = src.indexOf("const name = q('#edName').value.trim();");
    if (i === -1) throw new Error('create handler not found');
    const handler = src.slice(i, i + 2000);
    if (!/if \(!isKeystoreUnlocked\(\)\)/.test(handler)) {
      throw new Error('the create handler does not check/repair lock state');
    }
    if (!/if \(!pass\) \{/.test(handler)) {
      throw new Error('no empty-passphrase guard in the handler');
    }
    if (!/Choose a passphrase to protect your wallet keys/.test(handler)
        && !/Enter your keystore passphrase/.test(handler)) {
      throw new Error('no guidance when the passphrase is empty');
    }
  });

  await t('Delete is reachable from BOTH wallet views, and wired', () => {
    if (!/id="edDelete"/.test(src)) throw new Error('missing from the config editor');
    if (!/id="wdDelete"/.test(src)) throw new Error('missing from the trades view');
    if (!/root\.querySelector\('#wdDelete'\)\.onclick/.test(src)) throw new Error('trades Delete is not wired');
    if (!/const del = root\.querySelector\('#edDelete'\)/.test(src)) throw new Error('editor Delete is not wired');
  });

  await t('Delete warns that funds stay on chain and that it is irreversible', () => {
    if (!/stay on chain/.test(src)) throw new Error('no warning about funds left behind');
    if (!/cannot be undone/.test(src)) throw new Error('does not say it is irreversible');
  });

  await t('the app is named MEME SNIPER and carries a self-contained icon', () => {
    const fs2 = require('fs');
    const path2 = require('path');
    const root = path2.join(__dirname, '..');
    for (const f of ['public/index.html', 'public/landing.html']) {
      const h = fs2.readFileSync(path2.join(root, f), 'utf8');
      if (!/<title>MEME SNIPER/.test(h)) throw new Error(`${f}: wrong title`);
      if (!/MEME SNIPER/.test(h)) throw new Error(`${f}: brand missing`);
      const m = h.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)"/);
      if (!m) throw new Error(`${f}: no inline favicon (external files cannot load in the preview)`);
      // Strip XML comments first: the icon carries a comment explaining WHY it
      // avoids stroked shapes, and that prose must not be mistaken for markup.
      const svg = decodeURIComponent(m[1].slice(m[1].indexOf(',') + 1)).replace(/<!--[\s\S]*?-->/g, '');
      if ((svg.match(/r="15\.6"/g) || []).length !== 2) throw new Error(`${f}: icon lost its binocular lenses`);
      if (!svg.includes('clipPath')) throw new Error(`${f}: icon lost the face-through-the-lens clipping`);
      // fill="none" strokes are dropped outright by some renderers, and an app
      // icon has to survive a favicon, a PWA install and a link preview alike.
      if (/fill="none"/.test(svg)) throw new Error(`${f}: icon relies on a fill="none" stroke`);
    }
  });

  /**
   * The keystore/wallet wording, pinned.
   *
   * "Unlock" and "wallet" together produced a genuinely confusing screen: the
   * user asked to CREATE a wallet and was told to UNLOCK one, when they did not
   * have one to open. A keystore is opened; a wallet is created. These assertions
   * keep those two verbs apart.
   */
  await t('no user-visible text offers to unlock a WALLET', () => {
    const banned = [
      'Unlock to add a wallet',
      'Unlock wallet',
      'unlock your wallet',
      'Unlock to continue',
    ];
    for (const b of banned) {
      if (src.includes(b)) throw new Error(`confusing phrasing present: "${b}"`);
    }
  });

  await t('creating a wallet does not detour through a separate unlock screen', () => {
    const i = src.indexOf("if (t.id === 'btnAdd' || t.id === 'btnAdd2')");
    if (i === -1) throw new Error('add-wallet handler not found');
    const handler = src.slice(i, i + 600);
    if (!/openWallet\(null\)/.test(handler)) throw new Error('the button no longer opens the wallet form');
    if (/promptUnlockThen/.test(handler)) {
      throw new Error('the unlock modal is back in front of the create form');
    }
  });

  await t('the passphrase block distinguishes "nothing yet" from "closed after a restart"', () => {
    // The two questions are answered in ONE place, by a function, because a local
    // variable cannot be seen by the handler that lives in another function —
    // that mistake has now shipped twice as `x is not defined`.
    if (!/function keystoreState\(\)/.test(src)) throw new Error('the keystore-state accessor is gone');
    if (/vaultExists|vaultLocked|vaultIsNew/.test(src)) {
      throw new Error('a keystore-state local is back — only keystoreState() may answer this');
    }
    // First run says "Choose a passphrase"; a returning session says "Keystore
    // passphrase". One label cannot serve both.
    if (!/'Choose a passphrase'/.test(src)) throw new Error('no label for a first-time user');
    if (!/'Keystore passphrase'/.test(src)) throw new Error('no label for a returning user');
    // The field must appear whenever the keystore is not open — which includes a
    // first run. `ks.locked` alone excluded it, and a brand-new user could not
    // create their first wallet at all.
    if (!/\$\{!ks\.open \? `/.test(src)) throw new Error('the passphrase field is hidden on a first run again');
    // The form must be able to create the keystore itself, in the same step.
    if (!/ksIsNew \? '\/api\/keystore\/init' : '\/api\/keystore\/unlock'/.test(src)) {
      throw new Error('the form cannot create the keystore it depends on');
    }
    // And the button must not narrate keystore mechanics.
    if (!/id="edSave">\$\{isNew \? 'Create wallet' : 'Save changes'\}/.test(src)) {
      throw new Error('the create button no longer simply says Create wallet');
    }
  });

  await t('the empty wallets panel covers all three states, and never says "unlock"', () => {
    if (!/Nothing here yet — no wallets, and no passphrase set/.test(src)) {
      throw new Error('no first-run wording for the empty panel');
    }
    if (!/The keystore locks on every restart/.test(src)) {
      throw new Error('the empty panel no longer says why a passphrase is being asked for');
    }
    if (!/No wallet is missing/.test(src)) {
      throw new Error('the restart case does not reassure that no wallet is missing');
    }
    if (!/Add a wallet to give it its own strategy/.test(src)) {
      throw new Error('the ordinary empty state is gone');
    }
    // One button, and it must open the CREATE FORM. It used to open the keystore
    // modal, which is a wall in front of "create" — the exact thing the user
    // objected to.
    if (!/id="emptyCreate">Create your first wallet/.test(src)) {
      throw new Error('the empty panel has no create button');
    }
    if (!/\$\('emptyCreate'\)[\s\S]{0,80}?openWallet\(null\)/.test(src)) {
      throw new Error('the empty panel button does not open the create form directly');
    }
    if (/\$\('emptyCreate'\)[\s\S]{0,80}?openKeystore/.test(src)) {
      throw new Error('the empty panel button opens the keystore modal again');
    }
  });

  await t('the keystore is named, explained, and never confused with a wallet', () => {
    // The panel button lives in the markup, so check there.
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    if (!/🔐 Keystore/.test(html)) throw new Error('the panel button is not labelled');
    // And the name must be the same one the boot log, the API and the file on
    // disk use — the user asked why it had been changed to "vault".
    if (/\bvault/i.test(src) || /\bvault/i.test(html)) throw new Error('a second name for the keystore is back');
    // Wherever the keystore is opened deliberately, it must say what it IS, in
    // terms of the wallets it belongs to.
    if (!/where your wallets' keys are kept/i.test(src)) {
      throw new Error('the keystore modal does not say what the keystore is');
    }
    if (!/password manager for this bot's wallets/.test(src)) {
      throw new Error('nothing explains the keystore in familiar terms');
    }
  });

  /* ───────── the create-wallet flow, in both vault states ───────── */
  // Self-contained: the simulator tests above leave wallets and an open vault
  // behind, and these tests are specifically about a first run.
  S.wallets = [];
  S.positions = [];
  S.keystore = undefined;

  /* ---- locked wallets, and starting over ---- */

  await t('the preview reports wallets whose key is locked, instead of hiding them', async () => {
    S.wallets = [];
    S.positions = [];
    S.keystore = undefined;
    await api.demoApi('/api/keystore/init', { method: 'POST', body: JSON.stringify({ passphrase: 'preview-pass' }) });
    await api.demoApi('/api/wallets', { method: 'POST', body: JSON.stringify({ name: 'Visible' }) });

    // Lock it, as a restart does.
    await api.demoApi('/api/keystore/lock', { method: 'POST', body: '{}' });

    const list = await api.demoApi('/api/wallets');
    eq(list.length, 1, 'the wallet is still listed');
    eq(list[0].name, 'Visible', 'with its name');
    eq(list[0].keyLocked, true, 'flagged as locked');
    eq(list[0].balanceSol, null, 'and with no invented balance');
    eq(Boolean(list[0].publicKey), true, 'and its address, which is what makes it identifiable');

    await api.demoApi('/api/keystore/unlock', { method: 'POST', body: JSON.stringify({ passphrase: 'preview-pass' }) });
    const back = await api.demoApi('/api/wallets');
    eq(back[0].keyLocked, undefined, 'and the flag is gone once the keystore is open');
  });

  await t('the preview can start over with a fresh keystore, and refuses a bare call', async () => {
    let err = null;
    try {
      await api.demoApi('/api/keystore/reset', { method: 'POST', body: JSON.stringify({ passphrase: 'newpassphrase' }) });
    } catch (e) { err = e; }
    eq(Boolean(err && /confirmation_required/.test(err.message)), true, 'without the confirm word it is refused');

    try {
      await api.demoApi('/api/keystore/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET', passphrase: 'short' }) });
    } catch (e) { err = e; }
    eq(/at least 8/.test(err.message), true, 'a short passphrase is refused even with the confirm word');

    const r = await api.demoApi('/api/keystore/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET', passphrase: 'newpassphrase' }) });
    eq(r.ok, true, 'with both, it resets');
    eq(S.keystore.unlocked, true, 'and leaves a fresh, open keystore');

    // Hand the simulator back in the state the next section asserts: nothing at
    // all. These tests created a wallet and a keystore; the first-run tests below
    // are entitled to a clean slate.
    S.wallets = [];
    S.positions = [];
    S.keystore = undefined;
  });

  await t("the create form says out loud that the passphrase is not the new wallet's", () => {
    // Round 9 shortened this line; the FACT it exists to prevent is unchanged —
    // someone reading "passphrase" while creating a wallet and thinking it is
    // that wallet's own password.
    if (!/not a password for this new wallet/i.test(src)) {
      throw new Error('the form must rule out the wrong reading of the passphrase field');
    }
    if (!/One passphrase, one <b>keystore<\/b> file, for every wallet/i.test(src)) {
      throw new Error('and say that there is one passphrase for all wallets');
    }
    if (!/id="edPassErr"/.test(src)) {
      throw new Error('the wrong-passphrase error needs somewhere to appear next to the field');
    }
    if (!/Forgot your passphrase\?/.test(src)) {
      throw new Error('a forgotten passphrase must have a way out');
    }
  });

  await t('the reset screen states the consequences before it acts', () => {
    const start = src.indexOf('function openKeystoreForgot');
    if (start === -1) throw new Error('the reset flow is missing');
    const block = src.slice(start, start + 4000);
    for (const must of [
      /cannot be recovered/i,
      /archived, not deleted/i,
      /keep their names and\s+addresses/i,
      /Nothing on chain moves/i,
    ]) {
      if (!must.test(block)) throw new Error('the reset screen does not mention ' + must);
    }
    if (!/confirm: 'RESET'/.test(block)) throw new Error('it must send the confirm word the server demands');
  });

  /* ---- STATE A: brand new install, no vault at all ---- */
  await t('first run: nothing exists, so there is no "unlock" to offer', () => {
    eq(Boolean(S.keystore && S.keystore.initialised), false, 'no vault yet');
    eq(!(S.keystore && S.keystore.unlocked), true, 'and therefore nothing unlocked');
  });

  await t('first run: setting a passphrase creates the vault AND the wallet in one step', async () => {
    // This is exactly what the form does: init the vault, then create the wallet.
    await api.demoApi('/api/keystore/init', { method: 'POST', body: JSON.stringify({ passphrase: 'my-vault-pass' }) });
    eq(S.keystore.initialised, true, 'vault created');
    eq(S.keystore.unlocked, true, 'and open');
    const r = await api.demoApi('/api/wallets', { method: 'POST', body: JSON.stringify({ name: 'Alpha', preset: 'balanced' }) });
    eq(S.wallets.length, 1, 'wallet created in the same step');
    eq(S.wallets[0].name, 'Alpha', 'with the name typed');
  });

  await t('first run: a short passphrase is refused with the reason', async () => {
    const saved = S.keystore;
    S.keystore = undefined;
    let err = null;
    try { await api.demoApi('/api/keystore/init', { method: 'POST', body: JSON.stringify({ passphrase: 'short' }) }); } catch (e) { err = e; }
    S.keystore = saved;
    if (!err) throw new Error('must refuse');
    if (!/at least 8/.test(err.message)) throw new Error(`unhelpful: ${err.message}`);
  });

  /* ---- STATE B: vault exists but the bot restarted, so it is locked ---- */
  await t('after a restart: the vault is locked, but the wallet form still works', async () => {
    S.keystore = { initialised: true, unlocked: false };
    eq(S.keystore.initialised, true, 'vault exists');
    eq(S.keystore.unlocked, false, 'and is locked — this is the state that confused you');

    // Creating a wallet while locked must fail loudly, not silently...
    let err = null;
    try { await api.demoApi('/api/wallets', { method: 'POST', body: JSON.stringify({ name: 'Beta' }) }); } catch (e) { err = e; }
    if (!err) throw new Error('must refuse while locked');
    if (!/keystore_locked/.test(err.message)) throw new Error(`wrong error: ${err.message}`);

    // ...which is why the form opens the vault first, using the SAME passphrase field.
    await api.demoApi('/api/keystore/unlock', { method: 'POST', body: JSON.stringify({ passphrase: 'my-vault-pass' }) });
    eq(S.keystore.unlocked, true, 'vault opened');
    await api.demoApi('/api/wallets', { method: 'POST', body: JSON.stringify({ name: 'Beta', preset: 'scalper' }) });
    eq(S.wallets.length, 2, 'and then the wallet is created');
  });

  await t('an empty passphrase is caught before any request is made', () => {
    // The form guards on this itself; the simulator would reject it too.
    const pass = '';
    if (pass) throw new Error('unreachable');
    // Assert the guard exists in the source rather than faking a request.
    if (!/if \(!pass\) \{/.test(src)) throw new Error('no empty-passphrase guard in the form');
    if (!/Choose a passphrase to protect your wallet keys/.test(src)) throw new Error('no first-time guidance');
    if (!/Enter your keystore passphrase/.test(src)) throw new Error('no returning-user guidance');
  });


  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
