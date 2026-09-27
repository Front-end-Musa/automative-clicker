import { performance } from 'node:perf_hooks';
import { authenticationConfig, prepareAuthenticatedTarget, verifyBeforeTargetClick } from './authentication.js';

export function validate(input) {
  const urls = String(input.urls ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!urls.length || urls.length > 10000) throw new Error('Enter between 1 and 10,000 URLs.');
  urls.forEach((value, i) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`Invalid URL on entry ${i + 1}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`Entry ${i + 1}: use HTTP(S) without embedded credentials.`);
  });
  const minutes = Number(input.minutes), delay = Number(input.delay), retries = Number(input.retries);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080) throw new Error('Dwell time must be greater than 0 and at most 10,080 minutes.');
  if (!Number.isFinite(delay) || delay < 0 || delay > 3600) throw new Error('Click delay must be 0–3,600 seconds.');
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error('Retries must be an integer from 0 to 10.');
  if (!['text', 'css'].includes(input.mode) || typeof input.target !== 'string' || !input.target.trim()) throw new Error('Choose a locator mode and enter a target.');
  return { authentication: authenticationConfig(input.authentication), urls, dwellMs: minutes * 60 * 1000, delayMs: delay * 1000, retries, mode: input.mode, target: input.target.trim(), showBrowser: input.showBrowser !== false };
}

export function createRunner(session) {
  let active = false, stopping = false, paused = false, context, task;
  let state = { status: 'idle', phase: 'idle', index: 0, total: 0, currentUrl: '', remainingMs: 0, completed: 0, failed: [], logs: [] };
  let logId = 0;
  let secrets = [];
  function redact(message) {
    for (const secret of secrets) {
      let encoded = '';
      try { encoded = encodeURIComponent(secret); } catch {}
      for (const value of [secret, encoded, JSON.stringify(secret).slice(1, -1)]) {
        if (value) message = message.split(value).join('[redacted]');
      }
    }
    return message;
  }
  function log(message, level = 'info') {
    state.logs.push({ id: ++logId, time: new Date().toISOString(), message: redact(message), level });
    if (state.logs.length > 500) state.logs.shift();
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function check() { if (stopping) throw new Error('Stopped'); }
  async function gate() { check(); while (paused) { await sleep(100); check(); } }
  async function wait(ms, countdown = false, page) {
    let remaining = ms, previous = performance.now();
    if (countdown) state.remainingMs = remaining;
    while (remaining > 0) {
      check();
      if (page?.isClosed()) throw new Error("Page or browser unexpectedly closed");
      await sleep(Math.min(100, remaining));
      const now = performance.now();
      if (!paused) remaining = Math.max(0, remaining - (now - previous));
      previous = now;
      if (countdown) state.remainingMs = remaining;
    }
    await gate();
  }
  async function ensureContext(settings) {
    if (!context) {
      const opened = await session.open(settings.showBrowser);
      context = opened;
      opened.on('close', () => { if (context === opened) context = undefined; });
      check();
    }
    return context;
  }
  async function pageWarning(page) {
    if (!page || page.isClosed()) return '';
    const title = await page.title().catch(() => '');
    if (/captcha|verify (you|your identity)|verification required|security check|just a moment|two.factor|multi.factor/i.test(title)) {
      return 'Possible verification challenge. Handle it manually in visible mode, or stop and set up the session again.';
    }
    if (/\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(page.url()) || await page.locator('input[type=password]').count().catch(() => 0)) {
      return 'Possible expired session. Manual login may be required.';
    }
    return '';
  }
  async function run(settings) {
    try {
      for (let i = 0; i < settings.urls.length; i++) {
        await gate();
        state.index = i + 1; state.currentUrl = settings.urls[i];
        const originalTargetUrl = settings.urls[i];
        const authenticationEvent = { attempted: false };
        let reason;
        for (let attempt = 0; attempt <= settings.retries; attempt++) {
          await gate();
          let page;
          try {
            state.phase = 'loading'; state.remainingMs = 0;
            log(`Opening URL ${i + 1}/${settings.urls.length} — attempt ${attempt + 1}`);
            const ctx = await ensureContext(settings);
            await gate();
            page = await ctx.newPage();
            page.setDefaultTimeout(10000);
            await gate();
            const response = await page.goto(originalTargetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
            await gate();
            state.phase = 'checking-authentication';
            await prepareAuthenticatedTarget({
              page, originalTargetUrl, config: settings.authentication,
              showBrowser: settings.showBrowser, event: authenticationEvent,
              log, wait, check, phase: value => { state.phase = value; }
            });
            check();
            if (authenticationEvent.attempted) await session.markAvailable?.();
            log('Target page ready');
            state.phase = 'waiting';
            log(`Page ready — starting ${settings.dwellMs / 60000}-minute timer`);
            await wait(settings.dwellMs, true, page);
            log('Timer completed');
            await verifyBeforeTargetClick(page, settings.authentication);
            await gate();
            state.phase = 'clicking';
            const locator = settings.mode === 'text' ? page.getByRole('button', { name: settings.target, exact: true }) : page.locator(settings.target);
            log(`Looking for ${settings.mode === 'text' ? 'button' : 'selector'} "${settings.target}"`);
            await locator.waitFor({ state: 'attached', timeout: 10000 });
            await gate();
            // Trial performs Playwright actionability checks without clicking.
            await locator.click({ trial: true, timeout: 10000 });
            await gate();
            log('Button found — clicking');
            await locator.click({ timeout: 10000, noWaitAfter: true });
            log('Button clicked successfully', 'success');
            state.phase = 'post-click';
            await wait(settings.delayMs);
            state.completed++; reason = undefined;
            break;
          } catch (error) {
            check();
            reason = redact(error.message).split('\n').slice(0, 3).join(' ').slice(0, 700);
            const warning = await pageWarning(page);
            if (warning) reason += ` ${warning}`;
            log(`URL ${i + 1} failed: ${reason}`, 'error');
            if (error.authentication) break;
            if (attempt < settings.retries) log('Retrying this URL from navigation and a fresh dwell timer.', 'warning');
          } finally { await page?.close().catch(() => {}); }
        }
        if (reason) state.failed.push({ url: settings.urls[i], reason });
      }
      state.status = 'completed'; log('Automation completed', 'success');
    } catch (error) {
      state.status = stopping ? 'stopped' : 'error';
      log(stopping ? 'Automation stopped' : error.message, stopping ? 'warning' : 'error');
    } finally {
      await context?.close().catch(() => {}); context = undefined;
      settings.authentication.username = ''; settings.authentication.password = ''; secrets = [];
      active = false; paused = false; state.phase = 'idle'; state.remainingMs = 0;
    }
  }
  return {
    get active() { return active; },
    snapshot: () => ({ ...state, active, paused }),
    start(input) {
      if (active || session.busy) throw new Error('A run or session setup is already active.');
      const settings = validate(input);
      secrets = [settings.authentication.username, settings.authentication.password].filter(Boolean);
      active = true; stopping = false; paused = false;
      state = { status: 'running', phase: 'starting', index: 0, total: settings.urls.length, currentUrl: '', remainingMs: 0, completed: 0, failed: [], logs: [] };
      log(`Automation started — ${settings.urls.length} URLs queued`);
      task = run(settings);
    },
    async stop() {
      if (!active) return;
      stopping = true; paused = false; state.status = 'stopping';
      await context?.close().catch(() => {});
      await task;
    },
    pause() {
      if (!active || stopping) throw new Error('No running automation.');
      // Pause only at a stable dwell boundary: no in-flight browser actions.
      if (state.phase !== 'waiting') throw new Error('Pause is available during the page dwell countdown.');
      paused = true; state.status = 'paused'; log('Countdown paused', 'warning');
    },
    resume() { if (paused) { paused = false; state.status = 'running'; log('Countdown resumed'); } }
  };
}
