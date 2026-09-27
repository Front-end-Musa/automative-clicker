const $ = id => document.getElementById(id);
const keys = ['minutes', 'delay', 'mode', 'target', 'retries', 'showBrowser', 'authEnabled', 'usernameSelector', 'passwordSelector', 'loginButtonSelector'];
const checkboxes = ['showBrowser', 'authEnabled'];
let snapshot, pending = false, lastLog = 0;
try { const saved = JSON.parse(localStorage.getItem('runner-settings') || '{}'); for (const key of keys) if (key in saved) { if (checkboxes.includes(key)) $(key).checked = saved[key]; else $(key).value = saved[key]; } } catch {}
function settings() { return Object.fromEntries([...keys, 'urls'].map(key => [key, checkboxes.includes(key) ? $(key).checked : $(key).value])); }
function updateEstimate() {
  const values = settings(), total = values.urls.split(/\r?\n/).filter(s => s.trim()).length;
  $('count').textContent = `Total URLs: ${total}`;
  const minutes = Math.max(0, Number(values.minutes) || 0) * total;
  $('estimate').textContent = `Estimated minimum runtime: ~${Math.floor(minutes / 60)}h ${Math.ceil(minutes % 60)}m`;
  delete values.urls;
  try { localStorage.setItem('runner-settings', JSON.stringify(values)); } catch {}
}
function authInputs() {
  const enabled = $('authEnabled').checked;
  $('auth-inputs').hidden = !enabled;
  for (const id of ['authUsername', 'authPassword']) {
    $(id).disabled = !enabled; $(id).required = enabled;
    if (!enabled) $(id).value = '';
  }
  if (!enabled) hidePassword();
}
function hidePassword() {
  $('authPassword').type = 'password'; $('showPassword').textContent = 'Show';
  $('showPassword').setAttribute('aria-pressed', 'false');
}
$('authEnabled').addEventListener('change', authInputs);
$('showPassword').onclick = () => {
  const show = $('authPassword').type === 'password';
  $('authPassword').type = show ? 'text' : 'password';
  $('showPassword').textContent = show ? 'Hide' : 'Show';
  $('showPassword').setAttribute('aria-pressed', String(show));
};
authInputs();
$('settings').addEventListener('input', updateEstimate); updateEstimate();
function time(ms) {
  const seconds = Math.ceil(ms / 1000), h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return (h ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function render(data) {
  snapshot = data;
  $('status').textContent = data.status.toUpperCase();
  $('session-status').textContent = data.session.busy ? 'Session setup open — complete login in Chromium' : data.session.available ? '✓ Saved session available (login validity depends on the website)' : 'No saved session yet';
  $('fields').disabled = data.active;
  $('start').disabled = pending || data.active || data.session.busy;
  $('login').disabled = pending || data.active || data.session.busy;
  $('save').hidden = !data.session.busy; $('save').disabled = pending;
  $('stop').disabled = !data.active || data.status === 'stopping';
  $('pause').disabled = pending || !data.active || data.phase !== 'waiting' || data.status === 'stopping';
  $('pause').textContent = data.paused ? 'Resume' : 'Pause';
  $('processing').textContent = data.total ? `Processing ${data.index} / ${data.total}` : 'Ready when you are';
  $('current-url').textContent = data.currentUrl || 'Add URLs to begin a sequential run.';
  $('timer').textContent = time(data.remainingMs);
  $('phase').textContent = data.paused ? 'PAUSED' : data.phase === 'waiting' ? 'TIME REMAINING' : data.phase.toUpperCase();
  const processed = data.completed + data.failed.length, percent = data.total ? Math.round(processed / data.total * 100) : 0;
  $('progress').value = percent; $('percent').textContent = `${percent}%`;
  $('progress-label').textContent = `${processed} / ${data.total} processed`;
  $('completed').textContent = data.completed; $('failed').textContent = data.failed.length; $('remaining').textContent = data.total - processed;
  $('failures').hidden = !data.failed.length;
  $('failure-list').replaceChildren(...data.failed.map(item => { const p = document.createElement('p'); p.textContent = `${item.url}\n${item.reason}`; return p; }));
  const newest = data.logs.at(-1)?.id || 0;
  if (newest !== lastLog) {
    $('logs').replaceChildren(...data.logs.map(item => { const p = document.createElement('p'); p.className = item.level; p.textContent = `[${new Date(item.time).toLocaleTimeString()}] ${item.message}`; return p; }));
    $('logs').scrollTop = $('logs').scrollHeight; lastLog = newest;
  }
}
async function poll() {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('Unable to read server status');
  render(await response.json());
}
async function action(path, body = {}) {
  pending = true; error(''); if (snapshot) render(snapshot);
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Runner-Request': '1' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
  } catch (e) { error(e.message); }
  finally {
    if (body.authentication) { body.authentication.username = ''; body.authentication.password = ''; }
    pending = false; await poll().catch(e => error(e.message));
  }
}
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  const input = settings();
  input.authentication = {
    enabled: $('authEnabled').checked,
    usernameSelector: $('usernameSelector').value,
    passwordSelector: $('passwordSelector').value,
    loginButtonSelector: $('loginButtonSelector').value
  };
  if (input.authentication.enabled) {
    input.authentication.username = $('authUsername').value;
    input.authentication.password = $('authPassword').value;
  }
  $('authUsername').value = ''; $('authPassword').value = ''; hidePassword();
  action('start', input);
});
$('stop').onclick = () => action('stop');
$('pause').onclick = () => action(snapshot?.paused ? 'resume' : 'pause');
$('login').onclick = () => action('session/start'); $('save').onclick = () => action('session/finish');
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(snapshot.failed.map(item => item.url).join('\n')); $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy Failed URLs', 1500); } catch { error('Clipboard unavailable. Select and copy URLs from the failed list.'); } };
async function loop() { try { await poll(); } catch { error('Local server disconnected. Check the terminal; closing this tab does not stop a run.'); } finally { setTimeout(loop, 1000); } }
loop();
