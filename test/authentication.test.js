import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createRunner, validate } from '../src/automation/runner.js';
import { authFixture } from './helpers/auth-fixture.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 65000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Authentication test timed out'); await sleep(25); }
}
const defaults = { minutes: 5 / 60, delay: 0.1, retries: 2, mode: 'text', target: 'Continue', showBrowser: false };
async function harness(options) {
  const fixture = await authFixture(options);
  const browser = await chromium.launch({ headless: true });
  let opens = 0, context;
  const runner = createRunner({ busy: false, async open() { opens++; context = await browser.newContext(); return context; } });
  return { ...fixture, runner, opens: () => opens, page: () => context.pages()[0], close: async () => { await runner.stop(); await browser.close(); await fixture.close(); } };
}
function assertNoSecrets(state, authentication) {
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(authentication.username)); assert.ok(!serialized.includes(authentication.password));
}
test('disabled authentication drops credentials; enabled authentication validates inputs', () => {
  const input = { ...defaults, urls: 'http://localhost/test', authentication: { enabled: false, username: 'unused', password: 'unused' } };
  assert.equal(validate(input).authentication.password, undefined);
  assert.equal(validate(input).authentication.username, undefined);
  assert.throws(() => validate({ ...input, authentication: { enabled: true } }), /username\/email and password/);
});
test('login waits five seconds, returns to original target, reuses session and recovers expiration', async () => {
  const h = await harness({ expire: true });
  try {
    h.runner.start({ ...defaults, authentication: h.authentication, urls: `${h.base}/target/one\n${h.base}/target/two\n${h.base}/target/three` });
    await until(() => !h.runner.active);
    const state = h.runner.snapshot();
    assert.equal(state.completed, 3, JSON.stringify(state.failed)); assert.equal(state.failed.length, 0);
    assert.equal(h.opens(), 1);
    const submissions = h.events.filter(e => e.type === 'submit'); assert.equal(submissions.length, 2);
    const waits = state.logs.filter(e => e.message === 'Waiting 5 seconds before login...');
    const entries = h.events.filter(e => e.type === 'username-filled');
    for (let i = 0; i < waits.length; i++) assert.ok(entries[i].time - Date.parse(waits[i].time) >= 5000);
    for (const name of ['one', 'two', 'three']) {
      const ready = h.events.find(e => e.type === 'target-ready' && e.path === `/target/${name}`);
      const click = h.events.find(e => e.type === `clicked:/target/${name}`);
      assert.ok(click.time - ready.time >= 5000, 'Full dwell must happen after target readiness');
    }
    assert.deepEqual(h.events.filter(e => e.type === 'target-request').map(e => e.path), ['/target/one', '/target/one', '/target/two', '/target/three', '/target/three']);
    assert.equal(h.events.filter(e => e.type === 'home').length, 2);
    assertNoSecrets(state, h.authentication);
  } finally { await h.close(); }
});
test('invalid credentials fail once despite URL retries and never start dwell', async () => {
  const h = await harness({ reject: true });
  try {
    h.runner.start({ ...defaults, urls: `${h.base}/target/one`, authentication: h.authentication });
    await until(() => !h.runner.active);
    const state = h.runner.snapshot();
    assert.equal(state.failed.length, 1); assert.match(state.failed[0].reason, /rejected the login/);
    assert.equal(h.events.filter(e => e.type === 'submit').length, 1);
    assert.ok(!state.logs.some(e => e.message.includes('starting')));
    assertNoSecrets(state, h.authentication);
  } finally { await h.close(); }
});
test('redirect to home without a valid session fails on return, without a login loop', async () => {
  const h = await harness({ forget: true });
  try {
    h.runner.start({ ...defaults, urls: `${h.base}/target/one`, authentication: h.authentication });
    await until(() => !h.runner.active);
    assert.match(h.runner.snapshot().failed[0].reason, /target page still requires login/);
    assert.equal(h.events.filter(e => e.type === 'submit').length, 1);
    assert.equal(h.runner.snapshot().completed, 0);
  } finally { await h.close(); }
});
test('Stop interrupts the five-second delay before any credentials are entered', async () => {
  const h = await harness();
  try {
    h.runner.start({ ...defaults, urls: `${h.base}/target/one\n${h.base}/target/two`, authentication: h.authentication });
    await until(() => h.runner.snapshot().phase === 'login-delay' || !h.runner.active, 15000);
    assert.equal(h.runner.snapshot().phase, 'login-delay');
    const before = Date.now(); await h.runner.stop();
    assert.ok(Date.now() - before < 3000);
    assert.equal(h.runner.snapshot().status, 'stopped');
    assert.ok(!h.events.some(e => e.type === 'username-filled' || e.type === 'submit'));
    assert.ok(!h.events.some(e => e.path === '/target/two'));
  } finally { await h.close(); }
});
test('disabled automatic login never starts dwell on a login page', async () => {
  const h = await harness();
  try {
    h.runner.start({ ...defaults, urls: `${h.base}/target/one`, authentication: { enabled: false, passwordSelector: '#secret' } });
    await until(() => !h.runner.active);
    assert.match(h.runner.snapshot().failed[0].reason, /Enable automatic login/);
    assert.ok(!h.events.some(e => e.type === 'submit'));
  } finally { await h.close(); }
});
test('headless verification challenges fail clearly without bypass or target click', async () => {
  const h = await harness({ challenge: true });
  try {
    h.runner.start({ ...defaults, urls: `${h.base}/target/one`, authentication: h.authentication });
    await until(() => !h.runner.active);
    assert.match(h.runner.snapshot().failed[0].reason, /Manual verification required/);
    assert.equal(h.events.filter(e => e.type === 'submit').length, 1);
    assert.ok(!h.events.some(e => e.type.startsWith('clicked:')));
  } finally { await h.close(); }
});

test('incorrect password selector fails before dwell instead of treating the login page as authenticated', async () => {
  const h = await harness();
  try {
    h.runner.start({ ...defaults, urls: `${h.base}/target/one`, authentication: { ...h.authentication, passwordSelector: '#missing' } });
    await until(() => !h.runner.active);
    assert.match(h.runner.snapshot().failed[0].reason, /configured password field was not found/);
    assert.ok(!h.events.some(e => e.type === 'submit'));
    assert.ok(!h.runner.snapshot().logs.some(e => e.message.includes('starting')));
  } finally { await h.close(); }
});
test('manual verification suspends authentication, then returns to the target', async () => {
  // The harness runs headlessly, but exercises the visible-mode state machine;
  // the fixture link simulates the user's manual verification action.
  const h = await harness({ challenge: true });
  try {
    h.runner.start({ ...defaults, showBrowser: true, urls: `${h.base}/target/one`, authentication: h.authentication });
    await until(() => h.runner.snapshot().phase === 'manual-authentication' || !h.runner.active, 20000);
    assert.equal(h.runner.snapshot().phase, 'manual-authentication', JSON.stringify(h.runner.snapshot()));
    assert.equal(h.runner.snapshot().remainingMs, 0);
    assert.ok(!h.runner.snapshot().logs.some(e => e.message.includes('starting')));
    await h.page().getByRole('link', { name: 'Verify manually' }).click();
    await until(() => !h.runner.active);
    assert.equal(h.runner.snapshot().completed, 1, JSON.stringify(h.runner.snapshot().failed));
    assert.equal(h.events.filter(e => e.type === 'submit').length, 1);
  } finally { await h.close(); }
});
