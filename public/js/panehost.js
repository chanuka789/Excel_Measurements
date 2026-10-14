// The task pane as a host for AI plans (actions.js), and the pane side of requests from the 3D / app window:
// only the pane can write to the workbook, so the window asks it to add tables, build summaries and sheets.
import { App, api, status } from './core.js';
import { S, snapshot } from './state.js';
import { selectIds, update, viewer, setColorMode, loadZones, followVersion } from './model.js';
import { checksText } from './actions.js';
import { PROTECTED_SHEETS } from './actdefs.js';

export const paneHost = {
  E: () => S.E, byId: () => S.byId, ticked: () => [...S.ticked], zoneOf: () => S.zoneOf,
  project: () => App.currentProject?.(), onProjectChanged: () => { App.renderQs?.(); App.sendToWindow?.({ type: 'paneEvent', what: 'project' }); },
  projectId: () => App.currentProjectId?.() || null, versionId: () => S.versionId,
  canEdit: () => ['owner', 'editor'].includes(App.currentProject?.()?.my_role), inExcel: () => S.inExcel,
  select: (ids, fit = true) => selectIds(ids, { fit }),
  isolate: (ids) => { snapshot(); S.ticked = new Set(ids); S.isolated = true; S.hidden.clear(); update(); viewer()?.fit(ids.filter(id => viewer().hasGeometry(id))); },
  hide: (ids) => { snapshot(); ids.forEach(id => { S.hidden.add(id); S.ticked.delete(id); }); update(); },
  showAll: () => { snapshot(); S.hidden.clear(); S.isolated = false; S.level = ''; update(); viewer()?.fit(); },
  setView: (v) => viewer()?.setView(v),
  colorBy: (mode) => setColorMode(mode),
  addSpec: (spec) => (S.inExcel ? App.addToExcel(spec) : App.addToList(spec).then(() => null)),
  excel: (cmd, d = {}) => excelCmd(cmd, d),
  refreshTree: () => App.sendToWindow?.({ type: 'paneEvent', what: 'tree' }),
  refreshZones: async () => { await loadZones(); App.sendToWindow?.({ type: 'paneEvent', what: 'zones' }); },
  checks: async (kind) => checksText(kind, S.E),
  status,
  saveTemplate: (spec) => api('POST', '/templates', { name: spec.name, discipline: discipline(spec), description: spec.note, scope: App.currentProjectId?.() ? 'project' : 'user', projectId: App.currentProjectId?.(),
    spec: { name: spec.name, filter: spec.filter, by: spec.by, note: spec.note, inputs: spec.inputs, constants: spec.constants, formulas: spec.formulas } }),
};

const discipline = (spec) => {
  const cats = spec.ids.slice(0, 50).map(id => S.byId.get(id)?.cat || '').join(' ');
  return /structural|foundation/i.test(cats) ? 'Structure' : /pipe|duct|cable|conduit|mechanical|electrical|plumbing/i.test(cats) ? 'MEP' : /furniture|casework/i.test(cats) ? 'Interiors' : 'Architecture';
};
async function excelCmd(cmd, d) {
  switch (cmd) {
    case 'workbook': return App.workbookState();
    case 'buildSummaries': return App.buildSummaries({ kinds: d.kinds, by: d.by, gifa: d.gifa });
    case 'customSheet': return App.buildCustomSheet(d.def);
    case 'deleteSheet':
      if (PROTECTED_SHEETS.some(n => n.toLowerCase() === String(d.name || '').toLowerCase())) throw new Error(`The ${d.name} sheet cannot be deleted from here.`);
      if (!S.inExcel) throw new Error('Open the add-in in Excel.');
      await App.deleteSheet(d.name); return { deleted: d.name };
    case 'buildBoq': return App.buildBoqDefault({ ai: Boolean(d.ai) });
    default: throw new Error('Unknown request ' + cmd);
  }
}

/** Requests from the window: { type: 'pane', id, cmd, ... } -> { type: 'paneReply', id, ok, result | error } */
export async function onWindowRequest(m, reply) {
  const answer = (ok, result, error) => reply({ type: 'paneReply', id: m.id, ok, result, error });
  try {
    if (m.versionId && m.versionId !== S.versionId && ['addSpecs', 'workbook', 'buildSummaries', 'customSheet', 'buildBoq', 'deleteSheet'].includes(m.cmd)) await followVersion(m.versionId, m.label || '');
    if (m.cmd === 'addSpecs') {
      const refs = [];
      for (const spec of (m.specs || []).slice(0, 50)) refs.push(await paneHost.addSpec(spec));
      return answer(true, { refs, inExcel: S.inExcel });
    }
    if (m.cmd === 'colorBy') { await setColorMode(String(m.mode || 'category')); return answer(true, {}); }
    if (m.cmd === 'showTab') { App.selectTab?.(m.tab || 'review'); return answer(true, {}); }
    answer(true, await excelCmd(m.cmd, m));
  } catch (err) { answer(false, null, err.message); }
}
export function initPaneHost() { App.onWindowRequest = onWindowRequest; App.paneHost = paneHost; }
