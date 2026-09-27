import { chromium } from 'playwright';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
const directory = fileURLToPath(new URL('../../data/session/', import.meta.url));
export function createSession(profileDirectory = directory) {
  const marker = `${profileDirectory}/.ready`;
  let setup, launching = false;
  async function open(visible) {
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    return chromium.launchPersistentContext(profileDirectory, { headless: !visible, viewport: null, timeout: 30000 });
  }
  return {
    open,
    async markAvailable() { await writeFile(marker, 'Session setup completed\n', { mode: 0o600 }); },
    get busy() { return launching || Boolean(setup); },
    async status() { return { busy: launching || Boolean(setup), available: await access(marker).then(() => true, () => false) }; },
    async start() {
      if (launching || setup) throw new Error('Session setup is already open.');
      launching = true;
      try {
        setup = await open(true);
        setup.on('close', () => { setup = undefined; });
        if (!setup.pages().length) await setup.newPage();
      } finally { launching = false; }
    },
    async finish() {
      if (!setup) throw new Error('Open session setup first.');
      await setup.close(); setup = undefined;
      await writeFile(marker, 'Session setup completed\n', { mode: 0o600 });
    },
    async close() { await setup?.close(); setup = undefined; }
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const session = createSession();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await session.start();
    await readline.question('Log in manually in Chromium, then press Enter here to save and close. ');
    await session.finish();
    console.log('Session saved.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { readline.close(); await session.close(); }
}
