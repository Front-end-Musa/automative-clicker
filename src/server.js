import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createSession } from './automation/session.js';
import { createRunner } from './automation/runner.js';
const session = createSession(process.env.RUNNER_PROFILE_DIR), runner = createRunner(session);
const port = Number(process.env.PORT || 3000);
const origin = `http://127.0.0.1:${port}`;
const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 2000000) throw new Error('Request too large'); }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error('Invalid JSON request body.'); }
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Invalid host' });
  if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: 'Invalid origin' });
  try {
    if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, { ...runner.snapshot(), session: await session.status() });
    if (req.method === 'POST' && req.url.startsWith('/api/')) {
      if (req.headers['x-runner-request'] !== '1') return json(res, 403, { error: 'Missing local request header' });
      const input = await body(req);
      switch (req.url) {
        case '/api/start': runner.start(input); break;
        case '/api/stop': await runner.stop(); break;
        case '/api/pause': runner.pause(); break;
        case '/api/resume': runner.resume(); break;
        case '/api/session/start':
          if (runner.active) throw new Error('Stop the run before session setup.');
          await session.start(); break;
        case '/api/session/finish': await session.finish(); break;
        default: return json(res, 404, { error: 'Not found' });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && files[req.url]) {
      const [name, type] = files[req.url];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(await readFile(new URL(`./public/${name}`, import.meta.url)));
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 400, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Browser Runner: ${origin}`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  await runner.stop(); await session.close(); server.close();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
