// Credentials are run-scoped; no authentication configuration is written to disk.
export const defaultSelectors = {
  usernameSelector: 'input[name="username"]',
  passwordSelector: 'input[type="password"]',
  loginButtonSelector: 'button[type="submit"]'
};
export function authenticationConfig(input = {}) {
  const enabled = input?.enabled === true;
  const config = { enabled, ...defaultSelectors };
  for (const key of Object.keys(defaultSelectors)) {
    if (input?.[key] !== undefined) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error('Authentication selectors must be non-empty CSS selectors.');
      config[key] = input[key].trim();
    }
  }
  if (enabled) {
    if (typeof input.username !== 'string' || !input.username.trim() || typeof input.password !== 'string' || !input.password) {
      throw new Error('Enter a username/email and password to enable automatic login.');
    }
    config.username = input.username.trim();
    config.password = input.password;
  }
  return config;
}
function failure(message) {
  const error = new Error(message);
  error.authentication = true;
  return error;
}
async function step(message, operation) {
  try { return await operation(); }
  catch { throw failure(message); } // Playwright fill errors can include entered values.
}
function field(page, selector) { return page.locator(`css=${selector}`); }
const loginPath = url => /\/(login|log-in|signin|sign-in)(\/|\?|$)/i.test(url);
async function loginVisible(page, config, timeout = 1800) {
  try {
    await field(page, config.passwordSelector).waitFor({ state: 'visible', timeout });
    return true;
  } catch (error) {
    if (error.name === 'TimeoutError') {
      const otherPassword = await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false);
      if (otherPassword) throw failure('Login form detected, but the configured password field was not found. Check the password CSS selector.');
      return false;
    }
    throw failure('Cannot detect the login form: check the password CSS selector and browser connection.');
  }
}
async function challengeVisible(page) {
  const title = await page.title().catch(() => '');
  if (/captcha|verify (you|your identity)|verification required|security check|just a moment|two.factor|multi.factor/i.test(title)) return true;
  return page.locator('input[autocomplete="one-time-code"], iframe[src*="recaptcha"][title*="challenge"], iframe[src*="hcaptcha"][title*="challenge"]').first().isVisible().catch(() => false);
}
const sameTarget = (current, original) => {
  const a = new URL(current), b = new URL(original);
  a.hash = ''; b.hash = '';
  return a.href === b.href;
};

export async function prepareAuthenticatedTarget({ page, originalTargetUrl, config, showBrowser, event, log, wait, check, phase }) {
  async function manualChallenge() {
    if (!await challengeVisible(page)) return false;
    log('Manual authentication may be required.', 'warning');
    if (!showBrowser) throw failure('Manual verification required. Restart with Show browser enabled or use Login / Setup Session.');
    phase('manual-authentication');
    log('Complete verification in Chromium within 2 minutes. Stop remains available.', 'warning');
    const deadline = Date.now() + 120000;
    while (await challengeVisible(page)) {
      check();
      if (Date.now() >= deadline) throw failure('Manual verification timed out.');
      await wait(250, false, page);
    }
    phase('authenticating');
    return true;
  }
  const handledInitialChallenge = await manualChallenge();
  if (handledInitialChallenge && !sameTarget(page.url(), originalTargetUrl)) {
    log('Returning to original target URL after manual verification...');
    const response = await step('Unable to return to the original target after manual verification.', () => page.goto(originalTargetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    if (response && response.status() >= 400) throw failure(`Target returned HTTP ${response.status()} after manual verification.`);
    if (await challengeVisible(page)) throw failure('Manual verification did not establish access to the target.');
  }
  if (!await loginVisible(page, config)) {
    if (loginPath(page.url())) throw failure('Login page detected, but the configured password field was not found. Check Advanced Authentication Settings.');
    if (!sameTarget(page.url(), originalTargetUrl)) throw failure('The original target redirected to a different page. Dwell timer was not started.');
    log('Already authenticated — no login form detected');
    return;
  }
  log('Authentication required');
  phase('authenticating');
  if (!config.enabled) throw failure('Authentication required. Enable automatic login or use Login / Setup Session.');
  if (event.attempted) throw failure('Authentication failed: automatic login was already attempted for this target.');
  event.attempted = true;
  const username = field(page, config.usernameSelector);
  const password = field(page, config.passwordSelector);
  const submit = field(page, config.loginButtonSelector);
  await step('Username field not found or not visible. Check the username selector.', () => username.waitFor({ state: 'visible', timeout: 10000 }));
  await step('Password field not found or not visible. Check the password selector.', () => password.waitFor({ state: 'visible', timeout: 10000 }));
  await step('Login button not found or not visible. Check the login button selector.', () => submit.waitFor({ state: 'visible', timeout: 10000 }));
  const loginUrl = page.url();
  log('Waiting 5 seconds before login...');
  phase('login-delay');
  await wait(5000, false, page);
  check(); phase('authenticating');
  log('Entering username...');
  await step('Unable to fill username field.', () => username.fill(config.username));
  check(); log('Entering password...');
  await step('Unable to fill password field.', () => password.fill(config.password));
  check(); log('Submitting login...');
  await step('Login button could not be clicked.', () => submit.click({ timeout: 10000, noWaitAfter: true }));
  // Require a completed redirect AND a hidden form. A hidden form alone may be
  // a pending request, and navigating away then could cancel authentication.
  const deadline = Date.now() + 30000;
  let manualHandled = false;
  while (true) {
    check();
    if (await challengeVisible(page)) { await manualChallenge(); manualHandled = true; }
    const visible = await step('Browser closed or login selector invalid during authentication.', () => password.isVisible());
    if (!visible && page.url() !== loginUrl && !loginPath(page.url())) break;
    if (await page.getByRole('alert').filter({ hasText: /invalid|incorrect|wrong|failed|denied/i }).first().isVisible().catch(() => false)) {
      throw failure('Authentication failed: the website rejected the login. Check your credentials.');
    }
    if (Date.now() >= deadline) {
      throw failure(manualHandled ? 'Authentication failed after manual verification.' : 'Authentication timeout: login form still visible or no completed redirect. Invalid credentials or manual verification may be the cause.');
    }
    await wait(200, false, page);
  }
  await step('Authentication redirect did not finish loading.', () => page.waitForLoadState('domcontentloaded', { timeout: 30000 }));
  // Recheck on the loaded redirect document: its URL may change before its
  // challenge title or fields become observable.
  await manualChallenge();
  log('Website redirected away from the login page');
  log('Returning to original target URL...');
  phase('returning-to-target');
  const response = await step('Unable to return to the original target after authentication.', () => page.goto(originalTargetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
  if (response && response.status() >= 400) throw failure(`Target returned HTTP ${response.status()} after authentication.`);
  await manualChallenge();
  if (await loginVisible(page, config) || loginPath(page.url())) throw failure('Authentication failed: target page still requires login.');
  if (!sameTarget(page.url(), originalTargetUrl)) throw failure('Authentication failed: the original target redirected to a different page. Dwell timer was not started.');
  log('Authentication successful', 'success');
}

// Guard the target-page action if a session expires during its dwell period.
export async function verifyBeforeTargetClick(page, config) {
  const login = await step('Unable to verify authentication before clicking.', () => field(page, config.passwordSelector).isVisible());
  const otherPassword = await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false);
  if (login || otherPassword || loginPath(page.url())) throw failure('Session expired during the dwell timer. Target button was not clicked; run this URL again to authenticate.');
  if (await challengeVisible(page)) throw failure('Manual verification required before the target button can be clicked.');
}
