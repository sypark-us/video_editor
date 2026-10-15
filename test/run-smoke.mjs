// Browser smoke test runner: serves the project, launches headless Chrome with the DevTools
// protocol, waits for test/smoke.html to finish, prints the results and exits 1 on failure.
// Usage: node test/run-smoke.mjs [path-to-chrome]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 8124, CDP = 9334;
const candidates = [process.argv[2], process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found; set CHROME_PATH'); process.exit(2); }

const server = spawn(process.execPath, [new URL('./serve.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), String(PORT)], { stdio: 'ignore' });
await delay(600);
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${process.env.TEMP || '/tmp'}/cutroom-smoke-profile`, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { browser.kill(); } catch { } try { server.kill(); } catch { } };
process.on('exit', cleanup);

let targets = null;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { await delay(200); }
}
if (!targets) { console.error('Could not connect to Chrome DevTools'); process.exit(2); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.args.map((a) => a.value ?? a.description).join(' '); if (!/^PASS /.test(t)) console.log('  [console]', t); } else if (m.method === 'Runtime.exceptionThrown') { console.log('  [exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/test/smoke.html` });
let text = '';
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  text = (await evaluate("document.getElementById('out') ? document.getElementById('out').textContent : ''")) || '';
  if (text.startsWith('SMOKE-RESULTS')) break;
  await delay(250);
}
console.log(text || '(no output)');
const failed = !text.startsWith('SMOKE-RESULTS') || /\nFAIL |\nEXCEPTION|ERRORS [1-9]/.test(text);
console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
ws.close();
cleanup();
process.exit(failed ? 1 : 0);
