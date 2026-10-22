// Recording helpers: a 16:9 Excel window (excel-frame.html) with the add-in task pane inside, captions and a visible pointer.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
export const SP = '/tmp/claude-0/-home-claude/c8eb4696-ce79-544f-9af6-5afa8b7c6de4/scratchpad';
export const SESSION_KEY = 'dwfxSession';
export const SIZE = { width: 1366, height: 768 };
export const EMAIL = 'qs.demo@example.com', PW = 'Demo-pass-123', PROJECT = 'Project XXXXX';
export const DWFX = SP + '/Project-XXXXX-Structure.dwfx', DWFX2 = SP + '/Project-XXXXX-Structure-rev2.dwfx';
const sim = fs.readFileSync(SP + '/officesim-frame.js', 'utf8'), harness = fs.readFileSync(SP + '/excel-frame.html', 'utf8');
export const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'] });

let TOKEN = null;
async function token() { if (!TOKEN) { const r = await fetch('http://localhost:3077/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW }) }); TOKEN = await r.json(); } return TOKEN; }
export async function session(name, fn, { signedIn = true } = {}) {
  const dir = SP + '/rec/' + name; fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE } });
  await ctx.route('https://appsforoffice.microsoft.com/**', r => r.fulfill({ contentType: 'text/javascript', body: sim }));
  await ctx.route('**/__excel.html', r => r.fulfill({ contentType: 'text/html', body: harness }));
  await ctx.addInitScript(() => {
    // dialogs open as a floating Excel window inside the harness; a visible pointer in every frame; captions in the top page
    if (window.top !== window) window.open = (url) => { window.top.__openDialog(url); return { closed: false, close() { window.top.__closeDialog(); }, focus() {}, postMessage() {} }; };
    window.addEventListener('DOMContentLoaded', () => {
      const d = document.createElement('div'); d.id = '__ptr';
      Object.assign(d.style, { position: 'fixed', width: '20px', height: '20px', marginLeft: '-10px', marginTop: '-10px', borderRadius: '50%', background: 'rgba(242,169,0,.85)', border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.35)', zIndex: 2147483647, pointerEvents: 'none', left: '-40px', top: '-40px', display: 'none' });
      document.body.append(d);
      const mv = (e) => { d.style.display = e.target.tagName === 'IFRAME' ? 'none' : 'block'; d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; };
      document.addEventListener('mousemove', mv, true); document.addEventListener('mouseover', mv, true);
      document.documentElement.addEventListener('mouseleave', () => { d.style.display = 'none'; });
      if (window.top === window) {
        const c = document.createElement('div'); c.id = '__cap';
        Object.assign(c.style, { position: 'fixed', left: '250px', bottom: '30px', width: '660px', zIndex: 2147483646, background: 'rgba(10,80,130,.96)', color: '#fff', font: '600 17px/23px Segoe UI, Arial, sans-serif', padding: '10px 16px', borderRadius: '8px', boxShadow: '0 6px 18px rgba(0,0,0,.35)', display: 'none', pointerEvents: 'none' });
        document.body.append(c);
      }
    });
  });
  if (signedIn) { const t = await token(); await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [SESSION_KEY, JSON.stringify({ token: t.token, user: t.user })]); }
  const errs = [];
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => m.type() === 'error' && !/TUNNEL|401|favicon/.test(m.text()) && errs.push('console: ' + m.text().slice(0, 200)));
  await p.goto('http://localhost:3077/__excel.html');
  const pane = () => p.frames().find(f => f.url().includes('/taskpane.html'));
  const dlg = () => p.frames().find(f => /viewer\.html|\?dlg=/.test(f.url()));
  const T = {
    p, pane, dlg, errs,
    cap: async (t, ms = 2400) => { await p.evaluate((t) => { const c = document.getElementById('__cap'); if (c) { c.textContent = t; c.style.display = t ? 'block' : 'none'; } }, t); await p.waitForTimeout(ms); },
    wait: (ms) => p.waitForTimeout(ms),
    // generic: fr() gives the frame (default: the task pane)
    find: async (sel, fr = pane) => fr().waitForSelector(sel, { state: 'visible', timeout: 180000 }),
    move: async (sel, fr = pane) => { const el = await fr().waitForSelector(sel, { state: 'visible', timeout: 180000 }); await el.scrollIntoViewIfNeeded(); const b = await el.boundingBox(); await p.mouse.move(b.x + Math.min(b.width / 2, 90), b.y + b.height / 2, { steps: 12 }); await p.waitForTimeout(250); return el; },
    click: async (sel, wait = 800, fr = pane, opts = {}) => { const el = await T.move(sel, fr); await el.click({ timeout: 20000, ...opts }); await p.waitForTimeout(wait); },
    type: async (sel, text, fr = pane) => { await T.click(sel, 150, fr); await fr().fill(sel, ''); await fr().type(sel, text, { delay: 38 }); },
    top: (sel, wait = 800) => T.click(sel, wait, () => p.mainFrame()),
    status: () => pane().textContent('#status'),
  };
  await T.wait(500);
  await fn(T);
  await T.cap('', 600); await p.waitForTimeout(500);
  const video = p.video(); await ctx.close();
  fs.mkdirSync(SP + '/media', { recursive: true });
  fs.copyFileSync(await video.path(), `${SP}/media/${name}.webm`);
  console.log(name, 'errors:', errs.length ? errs.slice(0, 5) : 'none', Math.round(fs.statSync(`${SP}/media/${name}.webm`).size / 1024) + ' KB');
}
export const signIn = async (T, say = true) => {
  const { pane } = T;
  await T.find('#siEmail'); 
  await T.type('#siEmail', EMAIL); await T.type('#siPw', PW); await T.click('#siGo', 1200);
  await T.find('#pNew, .crumbs');
  if (await pane().$('.crumbs')) await T.click('#backList');
};
export const ribbon = async (T, fn, say) => { await T.top('#tabs [data-tab="DWFx Measure"]', 500); await T.top(`#ribbon [data-fn=${fn}]`, 900); };
export const openProject = async (T) => { await T.find('.prow'); await T.click(`.prow:has-text("${PROJECT}")`); };
export const openModel = async (T, ver = 'v1') => {
  const sel = `.vrow:has(.vnum:text-is("${ver}")) [data-open]`;
  await T.find(sel); const el = await T.pane().$(sel); await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox(); await T.p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 }); await el.click();
  await T.pane().waitForFunction(() => window.__viewer?.n > 0, null, { timeout: 120000 }); await T.wait(900);
};
/** page coordinates of an element inside a frame (iframe offset + element box) */
export const box = async (T, sel, fr, iframeSel) => { const off = await T.p.locator(iframeSel).boundingBox(); const r = await fr().$eval(sel, el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }); return { x: off.x + r.x, y: off.y + r.y, w: r.w, h: r.h }; };
export const open3D = async (T) => {
  await T.top('#tabs [data-tab="DWFx Measure"]', 300); await T.top('#ribbon [data-fn=view3DWindow]', 900); await T.click('.vpop [data-w=normal]', 800);
  for (let i = 0; i < 100 && !T.dlg(); i++) await T.wait(300);
  if (!T.dlg()) { console.log('FRAMES', T.p.frames().map(f => f.url()), await T.pane().evaluate(() => [window.__lastDialog, window.__dialogs, document.getElementById('status').textContent])); }
  await T.dlg().waitForFunction(() => window.__win?.V?.n > 0 && document.querySelector('#topTree .tr-row'), null, { timeout: 120000 }); await T.wait(900);
};
