'use strict';
/**
 * Session test — the dashboard must survive the server restarting under it.
 *
 * The session token is minted per boot, so a page that was already open holds a
 * stale one and every write comes back 401. That is not a theoretical case: it
 * is what happens on every redeploy, and it is what made "Add wallet" appear to
 * be a locked door — the unlock modal sat there and tapping Unlock produced the
 * same error forever, because the failing request was the unlock itself.
 *
 * These tests drive the real api() from public/app.js against a stubbed fetch.
 *
 * Run: node test/session.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* Pull out the request layer verbatim: api() plus the two helpers it uses. */
const start = src.indexOf('async function refreshSessionToken(');
const end = src.indexOf('function toast(');
assert.ok(start !== -1 && end > start, 'could not locate the request layer in public/app.js');

const S = { demo: false, token: 'STALE_TOKEN', keystore: { initialised: true, unlocked: true } };
const renderAll = () => {};
const demoApi = async () => { throw new Error('demoApi must not be reached when S.demo is false'); };

const build = (fetchImpl) => {
  const factory = new Function('S', 'fetch', 'renderAll', 'demoApi',
    `${src.slice(start, end)}
     return { api };`);
  return factory(S, fetchImpl, renderAll, demoApi);
};

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

(async () => {
  console.log('\nSession recovery\n');

  await test('RECOVERY: a 401 refreshes the token and retries the same request', async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url, token: (opts.headers || {})['x-session-token'] });
      if (url === '/api/session-token') {
        return { ok: true, status: 200, json: async () => ({ token: 'FRESH_TOKEN' }) };
      }
      // The write: rejected while the stale token is used, accepted with the new one.
      if ((opts.headers || {})['x-session-token'] === 'FRESH_TOKEN') {
        return { ok: true, status: 200, json: async () => ({ ok: true, walletsLoaded: 3 }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorised' }) };
    };

    S.token = 'STALE_TOKEN';
    S.demo = false;
    const { api } = build(fetchImpl);

    const res = await api('/api/keystore/unlock', {
      method: 'POST', body: JSON.stringify({ passphrase: 'x' }),
    });

    assert.strictEqual(res.ok, true, 'the retry must succeed, not throw');
    assert.strictEqual(res.walletsLoaded, 3, 'the real response body is returned');
    assert.strictEqual(S.token, 'FRESH_TOKEN', 'the page adopts the new token');

    const write = calls.filter((c) => c.url === '/api/keystore/unlock');
    assert.strictEqual(write.length, 2, 'the write must be attempted exactly twice');
    assert.strictEqual(write[0].token, 'STALE_TOKEN', 'first attempt uses the old token');
    assert.strictEqual(write[1].token, 'FRESH_TOKEN', 'the retry uses the fresh one');
  });

  await test('RECOVERY: a 401 also re-reads the keystore state', async () => {
    let keystoreReads = 0;
    const fetchImpl = async (url, opts = {}) => {
      if (url === '/api/keystore/status') {
        keystoreReads += 1;
        return { ok: true, status: 200, json: async () => ({ initialised: true, unlocked: false }) };
      }
      if (url === '/api/session-token') {
        return { ok: true, status: 200, json: async () => ({ token: 'FRESH_TOKEN' }) };
      }
      if ((opts.headers || {})['x-session-token'] === 'FRESH_TOKEN') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorised' }) };
    };

    S.token = 'STALE_TOKEN';
    S.keystore = { initialised: true, unlocked: true }; // the page thinks it is open
    const { api } = build(fetchImpl);

    await api('/api/wallets', { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 10)); // syncKeystoreState is fire-and-forget

    assert.strictEqual(keystoreReads, 1, 'keystore state must be re-read after a restart');
    assert.strictEqual(S.keystore.unlocked, false, 'a restart re-locks it: the page must agree');
  });

  await test('RECOVERY: an unrecoverable 401 says what to do, not "unauthorised"', async () => {
    const fetchImpl = async (url) => {
      if (url === '/api/session-token') {
        return { ok: true, status: 200, json: async () => ({ token: 'STALE_TOKEN' }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorised', hint: 'Set x-session-token header.' }) };
    };

    S.token = 'STALE_TOKEN';
    const { api } = build(fetchImpl);

    await assert.rejects(
      () => api('/api/wallets', { method: 'POST', body: '{}' }),
      (err) => {
        assert.match(err.message, /reload/i, 'it must tell the user what to do');
        assert.doesNotMatch(err.message, /^unauthorised$/, 'a bare "unauthorised" is not an instruction');
        return true;
      }
    );
  });

  await test('RECOVERY: a non-401 error is passed through untouched', async () => {
    const fetchImpl = async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'keystore_locked', hint: 'Unlock the keystore before adding wallets.' }),
    });

    S.token = 'CURRENT_TOKEN';
    const { api } = build(fetchImpl);

    await assert.rejects(
      () => api('/api/wallets', { method: 'POST', body: '{}' }),
      /keystore_locked/,
      'the existing error surface must not change'
    );
  });

  await test('RECOVERY: a healthy request is untouched (no extra round trips)', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    S.token = 'CURRENT_TOKEN';
    const { api } = build(fetchImpl);

    const res = await api('/api/status');
    assert.strictEqual(res.ok, true, 'normal response');
    assert.strictEqual(calls.length, 1, 'exactly one fetch on the happy path');
    assert.strictEqual(calls[0], '/api/status', 'and it is the requested endpoint');
  });

  await test('RECOVERY: refreshSessionToken tolerates a dead server', async () => {
    const fetchImpl = async () => { throw new Error('network down'); };
    S.token = 'STALE_TOKEN';
    const { api } = build(fetchImpl);

    await assert.rejects(() => api('/api/status'), /network down/);
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
