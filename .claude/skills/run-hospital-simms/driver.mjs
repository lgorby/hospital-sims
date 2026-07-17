// Agent driver for Hospital Simms — headless Edge via playwright-core.
// Usage:  node .claude/skills/run-hospital-simms/driver.mjs  <<'EOF'
//   <one command per line — see COMMANDS below>
// EOF
// Requires the Vite dev server already running (npm run dev, port 5173).
//
// COMMANDS (stdin, one per line; lines starting with # are comments):
//   goto [url]           open the game (default http://localhost:5173)
//   ss <name>            screenshot -> .claude/skills/run-hospital-simms/shots/<name>.png
//   hud                  print clock/cash/rep/tick chips
//   debug                toggle the backtick debug panel
//   button <text>        click the first <button> whose text includes <text>
//   click <x> <y>        mouse click at page coords (canvas world clicks)
//   key <key>            press a key (Playwright key name, e.g. Backquote, 1)
//   eval <js>            evaluate JS in the page, print JSON result
//   wait <ms>            sleep
//   waitticks <n>        wait until the sim advances >= n ticks from now
//   quit                 close browser and exit (implicit at EOF)
import { chromium } from 'playwright-core';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(SHOT_DIR, { recursive: true });

// System browser: no bundled Playwright browsers are installed, so use Edge/Chrome.
// Override with HS_BROWSER=<path to a chromium exe> if neither default exists.
import { existsSync } from 'node:fs';
const CANDIDATES = [
  process.env.HS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const exe = CANDIDATES.find((p) => existsSync(p));
const browser = await chromium.launch(
  exe ? { executablePath: exe, headless: true } : { channel: 'msedge', headless: true },
);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[page-error] ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`[page-crash] ${e.message}`));

// HUD chips are classed spans (Hud.chip in src/ui/hud.ts), not IDs.
const hudRead = () =>
  page.evaluate(() => {
    const chip = (cls) => document.querySelector(`.${cls}`)?.textContent ?? '?';
    return `clock=${chip('hud-clock')} | cash=${chip('hud-cash')} | rep=${chip('hud-rep')} | ${chip('hud-tick')}`;
  });
const tickNow = async () => {
  const t = await page.evaluate(() => document.querySelector('.hud-tick')?.textContent ?? '');
  return Number(/\d+/.exec(t)?.[0] ?? 0);
};

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = trimmed.slice(cmd.length).trim();
  try {
    switch (cmd) {
      case 'goto': {
        await page.goto(arg || 'http://localhost:5173', { waitUntil: 'load' });
        await page.waitForSelector('.hud-clock', { timeout: 15000 });
        await page.waitForTimeout(500); // let Pixi paint a frame
        console.log(`[goto] loaded — ${await hudRead()}`);
        break;
      }
      case 'ss': {
        const file = join(SHOT_DIR, `${arg || 'shot'}.png`);
        await page.screenshot({ path: file });
        console.log(`[ss] ${file}`);
        break;
      }
      case 'hud':
        console.log(`[hud] ${await hudRead()}`);
        break;
      case 'inspect': {
        // The inspect panel (id #inspect) opens on canvas-click of any entity.
        const text = await page.evaluate(() => {
          const el = document.getElementById('inspect');
          return el && !el.classList.contains('hidden') ? el.innerText.replace(/\n+/g, ' | ') : '(closed)';
        });
        console.log(`[inspect] ${text}`);
        break;
      }
      case 'debug':
        await page.keyboard.press('Backquote');
        console.log(`[debug] panel toggled`);
        break;
      case 'button': {
        const btn = page.locator('button', { hasText: arg }).first();
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(300); // let the command apply on the next frame
        console.log(`[button] clicked "${arg}"`);
        break;
      }
      case 'click': {
        const [x, y] = rest.map(Number);
        await page.mouse.click(x, y);
        await page.waitForTimeout(300); // selection/inspect updates on a render frame
        console.log(`[click] ${x},${y}`);
        break;
      }
      case 'key':
        await page.keyboard.press(arg);
        console.log(`[key] ${arg}`);
        break;
      case 'eval': {
        const result = await page.evaluate(arg);
        console.log(`[eval] ${JSON.stringify(result)}`);
        break;
      }
      case 'wait':
        await page.waitForTimeout(Number(arg));
        console.log(`[wait] ${arg}ms`);
        break;
      case 'waitticks': {
        const start = await tickNow();
        const target = start + Number(arg);
        const deadline = Date.now() + 60000;
        while ((await tickNow()) < target) {
          if (Date.now() > deadline) throw new Error(`sim stuck at tick ${await tickNow()} (wanted ${target})`);
          await page.waitForTimeout(200);
        }
        console.log(`[waitticks] tick ${start} -> ${await tickNow()}`);
        break;
      }
      case 'quit':
        await browser.close();
        process.exit(0);
        break;
      default:
        console.log(`[?] unknown command: ${cmd}`);
    }
  } catch (err) {
    console.log(`[error] ${cmd}: ${err.message.split('\n')[0]}`);
  }
}
await browser.close();
