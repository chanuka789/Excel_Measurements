// DWFx Measure task pane: start-up, sign-in, tabs, theme and the ribbon commands. The pane shows the measurements
// and links them to the workbook; measuring is done in the measurement window, DWFx schedules in their own window.
import { $, esc, App, api, session, status, confirmBox } from './js/core.js';
import { S } from './js/state.js';
import { showProjects, openProject, refreshProject, currentProject, resetProjects } from './js/project.js';
import { showAdmin } from './js/admin.js';
import { initExcel, addToExcel } from './js/excel.js';
import { initPaneHost, onExcelSelect } from './js/panehost.js';
import { initWinHost, openWindow, closeAll, sendTo, windowInit } from './js/winhost.js';
import { ensureVersion, closeVersion } from './js/panemodel.js';
import { renderMeasurements, initMeasurements } from './js/panemeasure.js';
import * as CX from './js/cxlinks.js';

// ================================================================== tabs
let currentTab = 'meas';
function selectTab(name) {
  if (name === 'admin' && session.get()?.user?.role !== 'admin') name = 'meas';
  currentTab = name;
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
  if (name === 'meas') renderMeasurements();
  if (name === 'admin') showAdmin();
  if (name === 'project' && currentProject()) refreshProject();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.tabs button:not([hidden])')];
  const i = tabs.findIndex(t => t.dataset.tab === currentTab);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(next.dataset.tab); next.focus();
});

// ================================================================== sign-in, header, theme
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }
function showSignedIn(user) {
  $('signin').hidden = true; $('shell').hidden = false;
  $('userBtn').textContent = initials(user.name); $('userBtn').title = `${user.name} (${user.email})`;
  $('umName').textContent = user.name; $('umEmail').textContent = user.email;
  $('adminTab').hidden = user.role !== 'admin';
}
function showSignIn(msg) {
  $('shell').hidden = true; $('signin').hidden = false; $('userMenu').hidden = true;
  $('siErr').hidden = !msg; $('siErr').textContent = msg || '';
  setTimeout(() => ($('siEmail').value ? $('siPw') : $('siEmail')).focus(), 0);
}
App.onSignedOut = () => { resetProjects(); closeAll(); closeVersion(); showSignIn('Your session has ended. Please sign in again.'); };
$('signinForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('siEmail').value.trim(), password = $('siPw').value;
  if (!email || !password) { $('siErr').hidden = false; $('siErr').textContent = 'Enter your email and password.'; return; }
  $('siGo').disabled = true; $('siGo').textContent = 'Signing in…';
  try {
    const r = await api('POST', '/auth/login', { email, password });
    session.set({ token: r.token, user: r.user }); $('siPw').value = '';
    try { localStorage.setItem('dwfxEmail', email); } catch { /* storage blocked */ }
    showSignedIn(r.user); await startProjects();
  } catch (err) { $('siErr').hidden = false; $('siErr').textContent = err.status === 401 ? 'The email or password is not correct.' : err.message; }
  finally { $('siGo').disabled = false; $('siGo').textContent = 'Sign in'; }
};
$('userBtn').onclick = (e) => { e.stopPropagation(); const m = $('userMenu'); m.hidden = !m.hidden; $('userBtn').setAttribute('aria-expanded', String(!m.hidden)); if (!m.hidden) m.querySelector('button').focus(); };
document.addEventListener('click', (e) => { if (!$('userMenu').contains(e.target)) { $('userMenu').hidden = true; $('userBtn').setAttribute('aria-expanded', 'false'); } });
$('userMenu').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('userMenu').hidden = true; $('userBtn').focus(); } });
$('umOut').onclick = async () => {
  if (!await confirmBox({ title: 'Sign out?', body: '<p>Your projects stay saved on the server. Your workbook is not changed.</p>', confirmLabel: 'Sign out' })) return;
  try { await api('POST', '/auth/logout'); } catch { /* already signed out */ }
  session.set(null); resetProjects(); closeAll(); closeVersion(); showSignIn();
};
/** Help opens in an Office dialog inside Excel, or a new browser tab elsewhere. */
function openHelp(anchor = '') {
  const url = new URL('help/index.html' + (anchor ? '#' + anchor : ''), location.href).href;
  if (S.inExcel && typeof Office !== 'undefined' && Office.context?.ui?.displayDialogAsync) {
    Office.context.ui.displayDialogAsync(url, { height: 85, width: 60, displayInIframe: false }, (r) => { if (r.status !== Office.AsyncResultStatus.Succeeded) window.open(url, '_blank'); });
  } else window.open(url, '_blank');
}
App.openHelp = openHelp;
$('umHelp').onclick = () => { $('userMenu').hidden = true; openHelp(); };
$('siHelp').onclick = () => openHelp();
$('umKeys').onclick = () => confirmBox({ title: 'Keyboard shortcuts', confirmLabel: 'Close', body: `<table class="tbl"><tbody>
  <tr><td colspan="2"><strong>Measurement window</strong></td></tr>
  <tr><td>Ctrl+F1 / double-click a tab</td><td>Collapse or show the ribbon</td></tr>
  <tr><td>1 – 7</td><td>Top, front, right, back, left, bottom, isometric (3D view focused)</td></tr>
  <tr><td>F</td><td>Fit the view</td></tr><tr><td>Click / Ctrl+click</td><td>Select / add to the selection</td></tr>
  <tr><td>Double-click a dimension</td><td>Link it to the selected Excel cell</td></tr>
  <tr><td>Esc</td><td>Stop measuring, close menus</td></tr><tr><td>Ctrl+Z / Ctrl+Y</td><td>Undo / redo</td></tr>
  <tr><td colspan="2"><strong>Task pane</strong></td></tr>
  <tr><td>Double-click a group</td><td>Link it to the selected Excel cell</td></tr></tbody></table>` });

const THEMES = ['office', 'light', 'dark'];
const THEME_LABEL = { office: 'Theme: follow Office', light: 'Theme: light', dark: 'Theme: dark' };
let themePref = 'office';
try { themePref = localStorage.getItem('dwfxTheme') || 'office'; } catch { /* storage blocked */ }
function officeIsDark() {
  try {
    const bg = Office.context.officeTheme?.bodyBackgroundColor;
    if (!bg) return null;
    const n = parseInt(bg.replace('#', ''), 16), lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
    return lum < 128;
  } catch { return null; }
}
function applyTheme() {
  const d = document.documentElement;
  const dark = themePref === 'dark' ? true : themePref === 'light' ? false : officeIsDark();
  if (dark == null) d.removeAttribute('data-theme'); else d.dataset.theme = dark ? 'dark' : 'light';
  $('umTheme').textContent = THEME_LABEL[themePref];
}
$('umTheme').onclick = () => {
  themePref = THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length];
  try { localStorage.setItem('dwfxTheme', themePref); } catch { /* storage blocked */ }
  applyTheme();
};

async function startProjects() {
  let last = null; try { last = localStorage.getItem('dwfxLastProject:' + (session.get()?.user?.id || '')); } catch { /* storage blocked */ }
  if (last) await openProject(last, false, true); else await showProjects();
  selectTab(currentProject() ? 'meas' : 'project');
}

// ================================================================== the windows
const needProject = () => { if (App.currentProjectId()) return true; selectTab('project'); status('Open a project first.', 'bad'); return false; };
function openMeasureWindow(init = {}) { if (needProject()) openWindow('measure', 'normal', init); }
function openSchedulesWindow(init = {}) { if (needProject()) openWindow('schedules', 'normal', { versionId: init.versionId || windowInit('measure')?.versionId || null, label: init.label || '' }); }

// ================================================================== sharing with people who do not have the add-in
async function shareCopy() {
  if (!S.inExcel) { status('Open the add-in in Excel first.', 'bad'); return; }
  if (!await confirmBox({ title: 'Share a copy?', confirmLabel: 'Make plain numbers',
    body: `<p>People without the DWFx Measure add-in cannot calculate the live links (<code>=CX.QTY</code>), so they would see <code>#NAME?</code>.</p>
      <ol><li>This turns every linked cell in <strong>this workbook</strong> into its current number. The formulas are kept inside the workbook.</li>
      <li>Then save a copy (<strong>File › Save a Copy</strong>) and send that copy.</li>
      <li>Then press <strong>Restore links</strong> to make your links live again.</li></ol>` })) return;
  try {
    const r = await CX.freezeLinks();
    status(r.cells ? `${r.cells} linked cell${r.cells === 1 ? '' : 's'} on ${r.sheets} sheet${r.sheets === 1 ? '' : 's'} are now plain numbers${r.notReady ? ` (${r.notReady} not calculated yet, left as formulas)` : ''}. Save a copy now (File › Save a Copy), then press Restore links.` : 'There are no linked cells in this workbook.', r.cells ? 'ok' : 'info');
  } catch (err) { status(err.message, 'bad'); }
}
async function restoreLinks() {
  if (!S.inExcel) { status('Open the add-in in Excel first.', 'bad'); return; }
  try {
    const r = await CX.restoreLinks();
    status(r.restored || r.changed || r.missing || r.moved ? `${r.restored} link${r.restored === 1 ? '' : 's'} restored${r.changed ? `; ${r.changed} cell${r.changed === 1 ? ' was' : 's were'} changed by hand and left as is` : ''}${r.missing ? `; ${r.missing} on a sheet that is not in this workbook (kept for later)` : ''}${r.moved ? `; ${r.moved} moved since sharing and use other cells, so they were left as numbers: check them and link them again` : ''}.` : 'Nothing to restore: the links are already live.', 'ok');
  } catch (err) { status(err.message, 'bad'); }
}

// ================================================================== App registry (used by the modules and the ribbon)
Object.assign(App, {
  selectTab, addToExcel, refreshProject,
  currentTab: () => currentTab,
  currentVersionId: () => windowInit('measure')?.versionId || null,
  currentProject, currentProjectId: () => currentProject()?.project?.id || null,
  inExcel: () => S.inExcel,
  isAdmin: () => session.get()?.user?.role === 'admin',
  setContext: (project) => {
    $('ctxProject').textContent = project ? project.name : 'DWFx Measure';
    CX.loadTree(project?.id || null).then(() => { if (S.inExcel && project) CX.broadcastLinks().catch(() => {}); });
    if (!project) closeAll();
  },
  openMeasureWindow, openSchedulesWindow, shareCopy, restoreLinks,
  useVersion: (vid) => ensureVersion(vid),
  sendToWindow: sendTo,
  focusInWindow: (m) => { openWindowIfClosed(); sendTo('measure', { type: 'focusDim', ...m }); },
  onTakeoffChanged: () => sendTo('schedules', { type: 'paneEvent', what: 'takeoff' }),
  onLinkedCell: () => {},
  windowExtra: () => ({ follow: CX.following() }),
});
function openWindowIfClosed() { if (!windowInit('measure')) openMeasureWindow(); }

// ================================================================== ribbon commands (shared runtime)
const RIBBON = {
  openMeasurements: () => selectTab('meas'),
  openMeasureWindow: () => openMeasureWindow(),
  openSchedules: () => openSchedulesWindow(),
  openProjects: () => selectTab('project'), refreshProject: () => refreshProject(),
  linkToCell: () => { selectTab('meas'); status('Choose a group or a dimension in the list (or in the measurement window), then press Link to selected cell.'); },
  followExcel: () => { CX.setFollow(!CX.following()); sendTo('measure', { type: 'paneEvent', what: 'follow', on: CX.following() }); status(`Follow Excel is ${CX.following() ? 'on' : 'off'}.`, 'ok'); },
  refreshLinks: async () => { await CX.loadTree(); await CX.broadcastLinks({ rescan: true }); status('Linked cells read again.', 'ok'); },
  shareCopy: () => shareCopy(), restoreLinks: () => restoreLinks(),
  openAdmin: () => { if (session.get()?.user?.role !== 'admin') status('Admin is for administrators only.', 'bad'); else selectTab('admin'); },
  openHelp: () => openHelp(),
};
function registerRibbon() {
  if (typeof Office === 'undefined' || !Office.actions?.associate) return;
  for (const [name, fn] of Object.entries(RIBBON)) {
    Office.actions.associate(name, async (event) => {
      try { await Office.addin?.showAsTaskpane?.(); } catch { /* older Office */ }
      try { if (!session.get()?.token && name !== 'openHelp') showSignIn('Sign in first.'); else await fn(); }
      catch (err) { status(err.message, 'bad'); }
      event.completed();
    });
  }
}
window.__ribbon = RIBBON;

// ================================================================== start
CX.registerFunctions();
initExcel(); initMeasurements();
initWinHost({ inExcel: false });
const officeReady = (typeof Office !== 'undefined') ? Office.onReady().catch(() => ({ host: null })) : Promise.resolve({ host: null });
officeReady.then(async (info) => {
  S.inExcel = typeof Office !== 'undefined' && info?.host === Office.HostType.Excel;
  initPaneHost({ inExcel: S.inExcel });
  if (S.inExcel) {
    Excel.run(async (ctx) => { ctx.workbook.worksheets.onSelectionChanged.add(onExcelSelect); await ctx.sync(); }).catch(() => {});
    registerRibbon();
    try { Office.context.document.addHandlerAsync?.(Office.EventType.OfficeThemeChanged, applyTheme); } catch { /* not supported */ }
  }
  applyTheme();
  try { $('siEmail').value = localStorage.getItem('dwfxEmail') || ''; } catch { /* storage blocked */ }
  const s = session.get();
  if (!s?.token) return showSignIn();
  try {
    const { user } = await api('GET', '/auth/me');
    session.set({ ...s, user }); showSignedIn(user); await startProjects();
  } catch (err) { if (err.status !== 401) showSignIn(err.message); }
});

window.__dwfx = { S, App, esc, CX, onExcelSelect };
