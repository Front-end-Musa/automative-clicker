import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { firefox } from 'playwright';
import { createRunner, validate } from '../src/automation/runner.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, timeout = 15000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await sleep(20); } }
const defaults = { minutes: 0.003, delay: 0, retries: 1, mode: 'text', target: 'Continue', showBrowser: false };
test('validation preserves order and rejects unsafe or invalid settings', () => {
  assert.deepEqual(validate({ ...defaults, urls: ' https://a.test/\n\nhttps://b.test/ ' }).urls, ['https://a.test/', 'https://b.test/']);
  for (const input of [{ urls: '' }, { urls: 'file:///etc/passwd' }, { urls: 'http://user:pass@example.com' }, { minutes: 0 }, { retries: -1 }, { target: '' }, { clickCount: 0 }, { clickCount: 1.5 }, { clickCount: 10001 }, { clickInterval: -1 }, { clickInterval: 'invalid' }, { clickInterval: 3601 }]) assert.throws(() => validate({ ...defaults, urls: 'https://a.test', ...input }));
});
test('real Firefox sequential execution, retry, pause, stop and closed browser recovery', async () => {
  let browser;
  const visits = [], clicks = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/clicked')) { clicks.push(req.url); return res.end('ok'); }
    if (req.url === '/bad') { visits.push(req.url); res.writeHead(503); return res.end('offline'); }
    if (req.url === '/favicon.ico') return res.end();
    visits.push(req.url);
    res.end(`<button onclick="fetch('/clicked?from=${req.url}');this.textContent='Done'">Continue</button>`);
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = { busy: false, async open() { browser = await firefox.launch({ headless: true }); const context = await browser.newContext(); context.on('close', () => browser.close()); return context; } };
  const runner = createRunner(session);
  try {
    runner.start({ ...defaults, urls: `${base}/one\n${base}/bad\n${base}/two` });
    assert.throws(() => runner.start({ ...defaults, urls: base }));
    await until(() => !runner.active);
    assert.equal(runner.snapshot().completed, 2); assert.equal(runner.snapshot().failed.length, 1);
    assert.deepEqual(visits, ['/one', '/bad', '/bad', '/two']);
    assert.deepEqual(clicks, ['/clicked?from=/one', '/clicked?from=/two']);
    runner.start({ ...defaults, minutes: 0.02, urls: `${base}/pause` });
    await until(() => runner.snapshot().phase === 'waiting');
    runner.pause(); const remaining = runner.snapshot().remainingMs, clickCount = clicks.length;
    await sleep(1400);
    assert.equal(runner.snapshot().remainingMs, remaining); assert.equal(clicks.length, clickCount);
    runner.resume(); await until(() => !runner.active); assert.equal(runner.snapshot().completed, 1);
    runner.start({ ...defaults, minutes: 1, urls: `${base}/stop\n${base}/never` });
    await until(() => runner.snapshot().phase === 'waiting'); runner.pause();
    await runner.stop(); assert.equal(runner.snapshot().status, 'stopped'); assert.ok(!visits.includes('/never'));
    runner.start({ ...defaults, urls: `${base}/closed` });
    await until(() => runner.snapshot().phase === 'waiting'); await browser.close();
    await until(() => !runner.active); assert.equal(runner.snapshot().completed, 1);
  } finally { await runner.stop(); await browser?.close(); await new Promise(r => server.close(r)); }
});

test('repeated clicks use the requested intervals and Stop cancels remaining clicks and URLs', async () => {
  const events = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/clicked') {
      events.push({ type: 'click', page: url.searchParams.get('page'), time: Number(url.searchParams.get('time')) });
      return res.end('ok');
    }
    if (url.pathname === '/favicon.ico') return res.end();
    events.push({ type: 'navigation', page: url.pathname, time: Date.now() });
    res.end(`<button onclick="fetch('/clicked?page=${url.pathname}&time=' + Date.now())">Continue</button>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await firefox.launch({ headless: true });
  const runner = createRunner({ busy: false, open: () => browser.newContext() });
  try {
    const config = { ...defaults, clickCount: 3, clickInterval: 0.3, delay: 0.4, retries: 0 };
    runner.start({ ...config, urls: `${base}/first\n${base}/second` });
    await until(() => !runner.active, 20000);
    assert.equal(runner.snapshot().completed, 2, JSON.stringify(runner.snapshot().failed));
    const clicks = events.filter(e => e.type === 'click');
    assert.deepEqual(clicks.map(e => e.page), ['/first', '/first', '/first', '/second', '/second', '/second']);
    for (const start of [0, 3]) {
      assert.ok(clicks[start + 1].time - clicks[start].time >= 300);
      assert.ok(clicks[start + 2].time - clicks[start + 1].time >= 300);
    }
    const nextPage = events.find(e => e.type === 'navigation' && e.page === '/second');
    assert.ok(nextPage.time - clicks[2].time >= 400, 'Final delay must finish before the next URL');
    assert.equal(runner.snapshot().clicksCompleted, 3);
    runner.start({ ...config, clickInterval: 30, urls: `${base}/stop-between\n${base}/never-open` });
    await until(() => runner.snapshot().phase === 'between-clicks');
    assert.equal(runner.snapshot().clicksCompleted, 1);
    await runner.stop();
    await sleep(200);
    assert.equal(runner.snapshot().status, 'stopped');
    assert.equal(events.filter(e => e.type === 'click' && e.page === '/stop-between').length, 1);
    assert.ok(!events.some(e => e.page === '/never-open'));
  } finally { await runner.stop(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
