// DWFx Measure task pane: start-up, sign-in, tabs, theme and the ribbon commands.
// The work is done in the modules under js/.
import { $, esc, App, api, session, status, confirmBox } from './js/core.js';
import { S } from './js/state.js';
import { showProjects, openProject, refreshProject, currentProject, resetProjects } from './js/project.js';
import { showAdmin } from './js/admin.js';
import { initModel, viewer, toolbar, update, openVersion, quickOpen, closeModel, setColorMode, selectIds } from './js/model.js';
import { initMeasure, renderTemplates } from './js/measure.js';
import { initExcel, onExcelSelect, addToExcel } from './js/excel.js';
import { initAI, refreshAIStatus } from './js/aiclient.js';
import { initReview, renderReview } from './js/review.js';

// ================================================================== tabs
const MODEL_TABS = ['elements', 'measure', 'ai', 'review'];
let currentTab = 'project';
function selectTab(name) {
  if (name === 'admin' && session.get()?.user?.role !== 'admin') name = 'project';
  currentTab = name;
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
  const showViewer = Boolean(S.data) && MODEL_TABS.includes(name);
  const was = !$('viewer').hidden;
  $('viewer').hidden = !showViewer;
  if (showViewer && !was) viewer()?.resize();
  document.querySelectorAll('.nomodel').forEach(el => { el.hidden = Boolean(S.data); });
  document.querySelectorAll('.withmodel').forEach(el => { el.hidden = !S.data; });
  if (name === 'measure' && S.data) App.renderMeasure();
  if (name === 'ai') refreshAIStatus();
  if (name === 'review') renderReview();
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
  viewer()?.resize();
}
function showSignIn(msg) {
  $('shell').hidden = true; $('signin').hidden = false; $('userMenu').hidden = true;
  $('siErr').hidden = !msg; $('siErr').textContent = msg || '';
  setTimeout(() => ($('siEmail').value ? $('siPw') : $('siEmail')).focus(), 0);
}
App.onSignedOut = () => { resetProjects(); closeModel(); showSignIn('Your session has ended. Please sign in again.'); };
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
  session.set(null); resetProjects(); closeModel(); showSignIn();
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
  <tr><td>1 – 7</td><td>Top, front, right, back, left, bottom, isometric (3D view focused)</td></tr>
  <tr><td>F</td><td>Fit the view</td></tr><tr><td>Arrows, + and −</td><td>Orbit and zoom</td></tr>
  <tr><td>Click / Ctrl+click</td><td>Select / add to the selection</td></tr><tr><td>Double-click</td><td>Zoom to an element</td></tr>
  <tr><td>Right-click</td><td>Element properties</td></tr><tr><td>Ctrl+Z / Ctrl+Y</td><td>Undo / redo selection, isolate and hide</td></tr>
  <tr><td>Esc</td><td>Stop measuring or box select, close panels</td></tr><tr><td>Ctrl+Enter</td><td>Send the AI request</td></tr></tbody></table>` });

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
  viewer()?.setTheme();
}
$('umTheme').onclick = () => {
  themePref = THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length];
  try { localStorage.setItem('dwfxTheme', themePref); } catch { /* storage blocked */ }
  applyTheme();
};

async function startProjects() {
  selectTab('project');
  let last = null; try { last = localStorage.getItem('dwfxLastProject:' + (session.get()?.user?.id || '')); } catch { /* storage blocked */ }
  if (last) await openProject(last, false, true); else await showProjects();
}

// ================================================================== App registry (used by the modules and the ribbon)
Object.assign(App, {
  selectTab, openVersion, quickOpen, closeModel, addToExcel, setColorMode, viewer, update, refreshProject,
  currentTab: () => currentTab,
  currentVersionId: () => S.versionId,
  currentProject, currentProjectId: () => currentProject()?.project?.id || null,
  isAdmin: () => session.get()?.user?.role === 'admin',
  setContext: (project) => { $('ctxProject').textContent = project ? project.name : 'DWFx Measure'; },
});

// ================================================================== ribbon commands (shared runtime)
const needModel = () => { if (!S.data) { selectTab('project'); status('Open a model from the Project tab first.', 'bad'); return false; } return true; };
const tool = (t) => () => { if (!needModel()) return; selectTab(MODEL_TABS.includes(currentTab) ? currentTab : 'elements'); const b = $('vbar').querySelector(`[data-t=${t}]`); b?.click(); };
const reviewSection = (key) => () => { if (!needModel()) return; selectTab('review'); setTimeout(() => { const b = document.querySelector(`[data-rsec=${key}]`); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); document.querySelector(`#rs-${key}`)?.scrollIntoView({ block: 'start' }); }, 50); };
const RIBBON = {
  openProjects: () => selectTab('project'), refreshProject: () => refreshProject(),
  openElements: () => { if (needModel()) selectTab('elements'); },
  openMeasure: () => { if (needModel()) selectTab('measure'); },
  openTemplates: () => { if (!needModel()) return; selectTab('measure'); $('tplBox').open = true; renderTemplates(); $('tplBox').scrollIntoView(); },
  openZones: () => { if (!needModel()) return; selectTab('elements'); $('zonesBox').open = true; $('zonesBox').scrollIntoView(); },
  openAI: () => { if (!needModel()) return; selectTab('ai'); $('aiAsk')?.focus(); },
  openReview: () => { if (needModel()) selectTab('review'); },
  openAdmin: () => { if (session.get()?.user?.role !== 'admin') status('Admin is for administrators only.', 'bad'); else selectTab('admin'); },
  viewFit: tool('fit'), viewShowAll: tool('showall'), viewIsolate: tool('isolate'), viewHide: tool('hide'),
  viewClear: () => { if (!needModel()) return; selectIds([], { fit: false }); },
  viewSection: tool('section'), viewPlan: tool('plan'), viewBoxSelect: tool('box'), viewMeasure: tool('measure'),
  viewColour: tool('color'), viewSaved: tool('saved'), view3DWindow: tool('window'), viewViews: tool('views'),
  selectFromExcel: () => App.selectFromExcel(),
  openHelp: () => openHelp(),
  measuredStatus: async () => { if (!needModel()) return; await setColorMode('measured'); selectTab('review'); },
  compareRevisions: reviewSection('revisions'), updateTakeoff: reviewSection('revisions'),
  aiCheck: reviewSection('aicheck'), buildBOQ: reviewSection('output'), auditPdf: reviewSection('output'), modelChecks: reviewSection('checks'),
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
initModel(); initMeasure(); initExcel(); initAI(); initReview();
const officeReady = (typeof Office !== 'undefined') ? Office.onReady().catch(() => ({ host: null })) : Promise.resolve({ host: null });
officeReady.then(async (info) => {
  S.inExcel = typeof Office !== 'undefined' && info?.host === Office.HostType.Excel;
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

window.__dwfx = { S, App, viewer, toolbar, esc };
