# Browser Runner

A small, local Chromium automation utility. Node.js serves a vanilla dashboard and Playwright processes one URL at a time. No database, account service, or frontend framework.

## Installation

Use Node.js 20 or newer:

```sh
cd browser-runner
npm install
npx playwright install chromium
npm run dev
```

Open **http://127.0.0.1:3000** (localhost:3000 also works). `npm start` runs the same server. Set `PORT` to change the port. The server binds only to loopback. A graphical desktop is required for visible Chromium and manual login.

## Authentication

### Automatic login

1. Enable **Authentication → Enable automatic login**.
2. Enter your username/email and password. The password is masked; **Show / Hide** toggles its visibility.
3. Paste the protected target URLs as usual. No separate login URL is required.
4. If needed, open **Advanced Authentication Settings** and change the CSS selectors. Defaults are `input[name="username"]`, `input[type="password"]`, and `button[type="submit"]`. Use unique selectors for visible elements; login forms inside iframes are not supported.
5. Click **Start run**. Both credential inputs clear immediately after submission. Re-enter them for another automatic-login run.

For every target, the runner waits for DOM readiness and checks for the visible configured password field for up to 1.8 seconds. If a login form appears, it verifies that the username/password/button are visible, waits a full **5 seconds**, then fills the username, fills the password, and clicks the login button. The delay is fixed independently of dwell time and Stop can cancel it. Browser scheduling and element actionability can add latency, but the runner never fills credentials before the five seconds have elapsed.

The runner allows up to 30 seconds for the login form to disappear **and** a redirect away from the login URL. It then explicitly navigates to the original queue URL, checks for the login form again, and confirms it reached that target. Only then does the normal dwell timer begin. This implementation is designed for login flows that redirect to Home after submission; a login that leaves the browser at exactly the same URL will time out rather than risk navigating away during a pending login request.

Use the final canonical target URL: the returned URL must match it (ignoring the fragment). Redirects to Home or another route do not start the dwell timer. Authentication consumes none of the configured dwell time. The next URL reuses the same persistent Chromium context. If the session expires later, login is detected and performed for that new target. If the site redirects to login during a dwell, the target button is not clicked; that URL fails and can be run again.

There is at most one automatic credential submission per queue entry, including its ordinary URL retries. Authentication failures skip retries and mark that URL failed; other URL failures retain normal retry behavior. This prevents a login → Home → target → login loop. Remaining queue entries continue processing. A rejected login, missing field, timeout, or target that still requires login never starts a dwell timer.

Obvious CAPTCHA/security page titles and one-time-code fields surface **Manual authentication may be required**. In visible mode, the runner waits up to two minutes for you to complete the challenge in Chromium, with Stop still available. Headless runs fail that URL with a manual-verification message. Detection is heuristic: an unrecognized challenge may produce an authentication timeout. There is no verification bypass. You can always stop and use the manual setup flow below.

Credentials are sent only in the local start request and retained in server memory for the current run, so they remain available if a session expires later. They are excluded from status responses, logs, configuration files, and frontend localStorage. The username is not remembered either. References are cleared when the run finishes or stops; JavaScript cannot guarantee secure memory erasure. Playwright authentication errors use sanitized messages rather than logging fill arguments. Never enable Playwright tracing or verbose API debug logs when using real credentials. The app does not enable these.

When automatic login is disabled, credential fields are hidden/disabled and no credentials are sent or used. A saved authenticated session can still be reused. If a login form is encountered, the URL fails with instructions to enable login or set up a session manually.

### Manual session setup

1. Stop any active run, then click **Login / Setup Session**.
2. In visible Chromium, navigate to your website and log in manually. Complete MFA or verification yourself if requested.
3. Leave Chromium open and click **Login complete — save session** in the dashboard. Chromium closes and its profile remains on disk.
4. Future runs reuse that profile, including cookies and local storage.

Alternatively, with the server stopped, run `npm run setup-session`, log in, then press Enter in the terminal. Do not run multiple server/CLI processes against the same profile. Session setup and automation are mutually exclusive in the dashboard.

Automatic and manual login use the existing dedicated persistent profile in **data/session/**; a separate `auth.json` is unnecessary. “Saved session available” means setup or automatic authentication completed, not that the website still accepts the session. Some websites use session-only mechanisms requiring login again. Avoid saving passwords in Chromium's password manager.

## Usage

- Paste HTTP or HTTPS URLs, one per line. Blank lines and surrounding whitespace are ignored; order and duplicates are preserved. Invalid entries prevent the run from starting.
- **Time on each page** defaults to **15 minutes**, and accepts positive fractional values for testing. The engine converts the supplied value with `minutes * 60 * 1000`.
- Choose **Button text** for an exact accessible button name (for example `Continue`) or **CSS selector** for `#continue-button`, `button.submit`, or `[data-action="continue"]`. Locators must identify a single element. Text mode uses Playwright's resilient button role locator. Targets inside iframes are not supported by this small UI.
- Set the post-click delay (default 2 seconds), maximum additional retries (default 1), and **Show browser** (on by default).
- Click **Start run**. Each page navigates with `domcontentloaded`, so analytics or streaming requests do not block readiness. The dwell timer starts only after that navigation succeeds. Sites can continue rendering after this event; Playwright waits for button actionability at click time.
- The countdown displays MM:SS or HH:MM:SS. Progress measures URLs fully processed, including failures, rather than elapsed dwell time. Successful, failed, and remaining counts are separate.
- **Pause** is enabled during the dwell countdown only, where no browser action is in flight. It freezes the timer and leaves the page open; **Resume** continues the remaining time. The site itself can still run scripts or redirect while paused.
- **Stop** cancels waiting, closes the browser context, and prevents further URLs. A browser launch already in progress may take up to its 30-second launch timeout to settle before Stop finishes. Closing the dashboard tab does **not** stop automation. Use Stop, or Ctrl+C in the server terminal for clean shutdown.
- Failed URLs and reasons appear in the dashboard; **Copy Failed URLs** copies only the URLs for a later run.

A retry repeats navigation and the entire dwell period. A failure around a click can leave its outcome uncertain: retries may repeat an action. Use zero retries for actions where duplicate submission would be harmful. Click success means Playwright completed the DOM click, not that the website's business operation succeeded. Post-click navigation is not awaited indefinitely.

Non-sensitive settings are stored in this dashboard origin's localStorage. URL lists, results, and the last 500 log events stay in memory and are lost when the server restarts. Authentication is stored only on the backend. Use the same localhost/127.0.0.1 address consistently to retain UI preferences.

## Session Storage

Chromium's dedicated persistent profile is at **data/session/**, relative to this project (independent of the terminal's working directory). It contains sensitive cookies and other authenticated browser data. The entire `data/` directory is ignored by Git, along with `.env`, dependencies, and test output.

**DO NOT COMMIT SESSION FILES.** Do not share or back up this profile to public locations. Stop Chromium and the server before deleting `data/session/` to reset the session. The application creates the profile directory with owner-only permissions where the OS supports them. It does not encrypt the profile itself.

## Troubleshooting

- **Button not found / hidden / disabled:** inspect the page in visible mode. Verify the exact accessible button name or use a unique CSS selector. A target must be attached, visible, enabled, stable, and able to receive pointer events. Each actionability check/click has a bounded 10-second timeout. Multiple matching elements produce an error rather than an arbitrary click.
- **Navigation timeout / DNS / HTTP error:** navigation allows 30 seconds. Failed attempts are logged and retried up to the configured limit, then processing continues. Check internet access and the destination URL.
- **Expired session:** an obvious login redirect or password field on a failed page produces a possible-expiration warning. Obvious verification/challenge page titles also produce a manual-handling warning. These are heuristics, not guarantees. Stop, repeat manual session setup, then restart. Enable automatic login with current credentials if you want the runner to fill the configured login form.
- **CAPTCHA, MFA, or verification:** use visible mode and pause during dwell to handle the challenge manually. If unattended, the target may time out and the failure is reported. There is no CAPTCHA solving, stealth, proxy rotation, or restriction bypass.
- **Page/browser unexpectedly closed:** the current attempt fails. With retries remaining, a fresh context is opened if needed; otherwise the URL fails and processing continues. Use Stop rather than closing Chromium to end a run.
- **Chromium missing:** run `npx playwright install chromium` after installing/upgrading Playwright.
- **Linux missing browser libraries:** use Playwright's documented OS dependencies installer, `npx playwright install --with-deps chromium` (may require administrator privileges). A headless-only machine cannot perform visible manual login without a desktop/display.
- **Installation/network problems:** verify Node/npm versions, internet access, and filesystem permissions. Re-run `npm install` and the Chromium install command. Do not disable TLS verification.
- **Profile already in use:** close another setup CLI, server, or Chromium instance using this project's profile.
- **Long jobs / sleeping computer:** 20 pages × 15 minutes is at least 5 hours; 40 pages take at least 10. Keep the computer awake, powered, and connected. Sleep, suspend, network loss, or manually closing Chromium can interrupt work. No OS sleep prevention is implemented. The estimate excludes authentication, loading, clicking, post-click delays, and retries.

## Development and tests

```sh
npm run smoke  # real Chromium, local page, five-second dwell, button click
npm test       # dashboard, authentication, security, and Chromium lifecycle tests
```

Tests run headlessly against local fixtures. Authentication tests use real five-second pre-fill delays and five-second dwell timers, generated test credentials, and isolated test profiles. They verify redirects, session reuse/expiration, failed login, Stop, and credential exclusion. Set `RUNNER_PROFILE_DIR` only when you need an isolated profile (the test server uses this); normal runs use `data/session/`. They never contact third-party websites. The dashboard's default is still 15 minutes. The server API is intentionally small: `GET /api/status` (including bounded logs), and `POST /api/start`, `/stop`, `/pause`, `/resume`, `/session/start`, `/session/finish`. POST requests require `X-Runner-Request: 1`; start accepts `urls`, `minutes`, `delay` (seconds), `mode` (`text`/`css`), `target`, `retries`, and `showBrowser`. Optional `authentication` contains `enabled`, `username`, `password`, `usernameSelector`, `passwordSelector`, and `loginButtonSelector`. Credentials are required only when enabled and are never returned by the API. Host/origin validation and the custom request header prevent ordinary cross-origin websites from controlling the local runner. This is a personal utility, not a remotely exposed multi-user service.
