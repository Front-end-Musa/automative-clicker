import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Synthetic credentials are generated in memory, never saved or logged.
export async function authFixture({ reject = false, forget = false, expire = false, challenge = false } = {}) {
  const username = `test-${randomUUID()}`, password = randomUUID();
  const events = [];
  let valid = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const url = new URL(req.url, 'http://fixture');
    const record = type => events.push({ type, path: url.pathname, time: Date.now() });
    const redirect = path => { res.writeHead(302, { Location: path }); res.end(); };
    if (url.pathname === '/event') { record(url.searchParams.get('type')); return res.end('ok'); }
    if (url.pathname === '/clicked') {
      record(`clicked:${url.searchParams.get('target')}`);
      if (expire && url.searchParams.get('target') === '/target/two') valid = false;
      return res.end('ok');
    }
    if (url.pathname.startsWith('/target/')) {
      record('target-request');
      if (!valid || !req.headers.cookie?.includes('authenticated=yes')) return redirect('/signin');
      setTimeout(() => {
        record('target-ready');
        res.end(`<button onclick="fetch('/clicked?target=${url.pathname}')">Continue</button>`);
      }, 150);
      return;
    }
    if (url.pathname === '/signin' && req.method === 'POST') {
      record('submit');
      let body = ''; for await (const chunk of req) body += chunk;
      const input = new URLSearchParams(body);
      if (reject || input.get('username') !== username || input.get('password') !== password) {
        res.end('<div role="alert">Invalid credentials</div><input type="password" id="secret">'); return;
      }
      if (challenge) { return redirect('/challenge'); }
      valid = !forget;
      res.setHeader('Set-Cookie', 'authenticated=yes; Path=/; HttpOnly');
      return redirect('/home');
    }
    if (url.pathname === '/signin') {
      record('login-ready');
      res.end(`<form method="post"><input id="email" name="username" oninput="fetch('/event?type=username-filled')"><input id="secret" type="password" name="password" oninput="fetch('/event?type=password-filled')"><button id="login" type="submit">LOG IN</button></form>`); return;
    }
    if (url.pathname === '/challenge') { record('challenge'); return res.end('<title>Verification required</title><input autocomplete="one-time-code"><a href="/verify-manually">Verify manually</a>'); }
    if (url.pathname === '/verify-manually') {
      valid = true; res.setHeader('Set-Cookie', 'authenticated=yes; Path=/; HttpOnly');
      return redirect('/home');
    }
    if (url.pathname === '/home') { record('home'); return res.end('<h1>Home page</h1>'); }
    res.end('ok');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`, events,
    authentication: { enabled: true, username, password, usernameSelector: '#email', passwordSelector: '#secret', loginButtonSelector: '#login' },
    close: () => new Promise(resolve => server.close(resolve))
  };
}
