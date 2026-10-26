// The task pane as the host of the two app windows. Only the pane can use the Excel API, so the windows ask it:
//   measurement window: link cells (live CX formulas), show linked cells, Follow Excel, add dimension groups as schedules
//   DWFx Schedules window: add schedule tables, summary and custom sheets, measured status, Take-off rows <-> objects
import { App, api, status } from './core.js';
import { S } from './state.js';
import { fmt } from './engine.js';
import { groupToSpec, groupTotal } from './dims.js';
import { PROTECTED_SHEETS } from './actdefs.js';
import { onWindow, sendTo, openWindow, setInExcel } from './winhost.js';
import { ensureVersion } from './panemodel.js';
import * as CX from './cxlinks.js';

/** Load the model the window works on (no 3D here) and the project's zones, before writing a schedule. */
async function useVersion(vid, label) {
  if (!vid) return;
  await ensureVersion(vid, label);
  const pid = App.currentProjectId?.();
  S.zones = []; S.zoneOf = new Map();
  if (pid) { try { S.zones = (await api('GET', `/projects/${pid}/zones`)).zones; } catch { /* zones are optional */ } }
  S.zones.forEach(z => (z.ids || []).forEach(id => { if (!S.zoneOf.has(id)) S.zoneOf.set(id, z.name); }));
  S.E.forEach(e => { e.zone = S.zoneOf.get(e.id) || ''; });
}
const addSpec = (spec) => (S.inExcel ? App.addToExcel(spec) : App.addToList(spec).then(() => spec.name));

async function excelCmd(cmd, d) {
  switch (cmd) {
    case 'workbook': return App.workbookState();
    case 'buildSummaries': return App.buildSummaries({ kinds: ['summary'], by: d.by });
    case 'customSheet': return App.buildCustomSheet(d.def);
    case 'deleteSheet':
      if (PROTECTED_SHEETS.some(n => n.toLowerCase() === String(d.name || '').toLowerCase())) throw new Error(`The ${d.name} sheet cannot be deleted from here.`);
      if (!S.inExcel) throw new Error('Open the add-in in Excel.');
      await App.deleteSheet(d.name); return { deleted: d.name };
    default: throw new Error('Unknown request ' + cmd);
  }
}

/** Requests from a window: { type: 'pane', id, cmd, ... } -> { type: 'paneReply', id, ok, result | error } */
async function onRequest(kind, m) {
  const answer = (ok, result, error) => sendTo(kind, { type: 'paneReply', id: m.id, ok, result, error });
  try {
    switch (m.cmd) {
      case 'linkCell': return answer(true, await CX.linkCell(m.items || { gid: m.gid, mid: m.mid, eid: m.eid, quantity: m.quantity }));
      case 'selectCell': return answer(true, await CX.selectCell(m));
      case 'unlinkCell': return answer(true, await CX.unlinkCell(m));
      case 'addSpecs': {
        await useVersion(m.versionId, m.label);
        const refs = [];
        for (const spec of (m.specs || []).slice(0, 50)) refs.push(await addSpec(spec));
        return answer(true, { refs, inExcel: S.inExcel });
      }
      case 'measured': {
        await useVersion(m.versionId, m.label);
        const map = await App.loadMeasured();
        return answer(true, { measured: [...map] });
      }
      default: await useVersion(m.versionId, m.label); return answer(true, await excelCmd(m.cmd, m));
    }
  } catch (err) { answer(false, null, err.message); }
}

/** The measurement window asks for dimension groups as Excel schedules. */
async function addSchedules(kind, m) {
  const reply = (ok, message) => sendTo(kind, { type: 'scheduleDone', ok, message });
  try {
    const pid = App.currentProjectId?.(); if (!pid) throw new Error('Open the project in the task pane first.');
    if (m.versionId) await useVersion(m.versionId, m.label);
    const byId = m.versionId ? S.byId : new Map();
    const t = await CX.loadTree(pid);
    const groups = (m.groupIds || []).map(id => t?.groups.find(g => g.id === id)).filter(Boolean);
    if (!groups.length) throw new Error('Those dimension groups were not found.');
    const refs = [];
    for (const g of groups) {
      const spec = groupToSpec(g, byId, m.opts || {});
      if (!spec.ids.length && !spec.manual.length) continue;
      refs.push(await addSpec(spec));
    }
    if (!refs.length) throw new Error('None of the groups has dimensions to schedule.');
    const tot = groups.map(g => { const x = groupTotal(g, byId); return `${g.name} ${fmt(x.total, x.unit === 'nr' ? '' : x.unit)} ${x.unit}`; }).join('; ');
    reply(true, S.inExcel ? `Added to Excel: ${[...new Set(refs)].join(', ')} (${tot}). Measured dimensions are live links.` : `Added to the take-off list (${tot}). Open the add-in in Excel to write the sheet.`);
    CX.broadcastLinks().catch(() => {});
  } catch (err) { reply(false, err.message); }
}

/** A selection in Excel: linked cells show their measurement; Take-off rows select their objects in the Schedules window. */
export async function onExcelSelect(ev) {
  if (await CX.onSelection(ev).catch(() => false)) return;
  const ids = await App.idsFromSelection?.(ev);
  if (ids?.length) sendTo('schedules', { type: 'select', ids });
}

export function initPaneHost({ inExcel }) {
  setInExcel(inExcel);
  CX.setSender(sendTo);
  onWindow('pane', onRequest);
  onWindow('addSchedule', addSchedules);
  onWindow('pick', (kind, m) => { if (S.inExcel && m.ids?.length) App.goToRows?.(m.ids); });
  onWindow('showLinks', async (kind, m) => {
    if (!CX.following() && !m.force) return;
    const n = await CX.selectLinked(m).catch(() => 0);
    if (m.force && !n) sendTo(kind, { type: 'paneEvent', what: 'noLinks' });
  });
  onWindow('linksPlease', (kind, m) => CX.broadcastLinks({ rescan: Boolean(m.rescan) }));
  onWindow('follow', (kind, m) => CX.setFollow(m.on));
  onWindow('treeChanged', async (kind, m) => { if (m.totals) CX.setBimTotals(m.totals); await CX.loadTree(); });
  onWindow('openSchedules', (kind, m) => openWindow('schedules', 'normal', { versionId: m.versionId || null }));
  onWindow('openMeasure', (kind, m) => openWindow('measure', 'normal', { versionId: m.versionId || null }));
  onWindow('projectChanged', () => Promise.resolve(App.refreshProject?.()).catch(() => {}));
  onWindow('zonesChanged', () => { sendTo('measure', { type: 'paneEvent', what: 'zones' }); sendTo('schedules', { type: 'paneEvent', what: 'zones' }); });
}
