import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createRunner, validate } from '../src/automation/runner.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, timeout = 15000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await sleep(20); } }
const defaults = { minutes: 0.003, delay: 0, retries: 1, mode: 'text', target: 'Continue', showBrowser: false };
test('validation preserves order and rejects unsafe or invalid settings', () => {
  assert.deepEqual(validate({ ...defaults, urls: ' https://a.test/\n\nhttps://b.test/ ' }).urls, ['https://a.test/', 'https://b.test/']);
  for (const input of [{ urls: '' }, { urls: 'file:///etc/passwd' }, { urls: 'http://user:pass@example.com' }, { minutes: 0 }, { retries: -1 }, { target: '' }]) assert.throws(() => validate({ ...defaults, urls: 'https://a.test', ...input }));
});
test('real Chromium sequential execution, retry, pause, stop and closed browser recovery', async () => {
  let browser;
  const visits = [], clicks = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/clicked')) { clicks.push(req.url); return res.end('ok'); }
    if (req.url === '/bad') { visits.push(req.url); res.writeHead(503); return res.end('offline'); }
    if (req.url === '/favicon.ico') return res.end();
    visits.push(req.url);
    res.end(`<button onclick="fetch('/clicked?from=${req.url}');this.textContent='Done'">Continue</button>`);
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = { busy: false, async open() { browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); context.on('close', () => browser.close()); return context; } };
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
