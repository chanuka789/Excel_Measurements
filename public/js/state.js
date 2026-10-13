// Shared state of the open model, used by every task pane module.
export const S = {
  inExcel: false,
  data: null, E: [], byId: new Map(), versionId: null, label: '',
  ticked: new Set(), hidden: new Set(), isolated: false,
  search: '', level: '', open: new Set(), tree: null, catColor: new Map(),
  colorBy: 'category', colorMap: null, legend: [],
  zones: [], zoneOf: new Map(),
  measured: null,                 // Map id -> number of Take-off rows (measured status)
  compare: null,                  // last revision compare result
  takeoff: [], rowsById: null, quiet: 0, customF: [],
  history: [], future: [],
  levelZ: [],                     // [{ name, z }] world elevations for level plans
  settings: { openingThreshold: 0.5 },
};

// muted, distinguishable colours (assigned to categories in order of size)
export const PALETTE = ['#8a9aa6', '#c98a2b', '#2f6fa3', '#b5473a', '#6b5b8c', '#7a8a5a', '#3f8f8a', '#a8794f',
  '#5d6f8f', '#9a5d7a', '#6f8f3f', '#4f7fa8', '#b0905a', '#7d7d7d'];
export const STATUS_COLORS = { none: '#d13438', once: '#107c10', twice: '#8764b8' };
export const REV_COLORS = { added: '#107c10', changed: '#f7630c', same: '#b9bfc4', removed: '#d13438' };

export const idsOf = (v) => Array.isArray(v) ? v : [...v.values()].flatMap(idsOf);
export const count = (m) => [...m.values()].reduce((s, v) => s + (Array.isArray(v) ? v.length : count(v)), 0);

/** Visible in the 3D view and lists: not hidden, inside isolate, on the chosen level. */
export function isVisible(id) {
  if (S.hidden.has(id)) return false;
  if (S.isolated) return S.ticked.has(id);
  if (S.level) return S.byId.get(id)?.level === S.level;
  return true;
}

/** Undo / redo of selection, isolate and hide. */
export function snapshot() {
  S.history.push({ ticked: [...S.ticked], hidden: [...S.hidden], isolated: S.isolated });
  if (S.history.length > 60) S.history.shift();
  S.future = [];
}
export function undo() {
  const s = S.history.pop(); if (!s) return false;
  S.future.push({ ticked: [...S.ticked], hidden: [...S.hidden], isolated: S.isolated });
  restore(s); return true;
}
export function redo() {
  const s = S.future.pop(); if (!s) return false;
  S.history.push({ ticked: [...S.ticked], hidden: [...S.hidden], isolated: S.isolated });
  restore(s); return true;
}
function restore(s) { S.ticked = new Set(s.ticked); S.hidden = new Set(s.hidden); S.isolated = s.isolated; }
