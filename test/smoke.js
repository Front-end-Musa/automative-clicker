import { firefox } from 'playwright';
import { createServer } from 'node:http';
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<button onclick="this.textContent=\'Done\'">Continue</button>'); }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
let browser;
try {
  browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  if (await page.getByRole('button').innerText() !== 'Done') throw new Error('Click failed');
  console.log('Firefox navigation → 5-second dwell → click passed');
} finally { await browser?.close(); server.close(); }
