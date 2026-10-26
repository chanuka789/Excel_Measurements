// The task pane keeps the model data (no 3D view) of the version a window works on, so it can write schedules:
// the elements' quantities feed the Take-off tables and their live formulas. The 3D views are in the windows.
import { S } from './state.js';
import { loadVersion } from './localfiles.js';
import { enrichElementQs, deriveOpenings } from './rules.js';

let loading = null;
/** Load the elements of a model version (from the library on this computer), once. */
export async function ensureVersion(vid, label = '') {
  if (!vid) throw new Error('Open a model in the window first.');
  if (vid === S.versionId && S.data) return;
  if (loading?.vid === vid) return loading.p;
  const p = (async () => {
    const r = await loadVersion(vid);
    const data = r.data;
    S.data = data; S.E = data.elements || []; S.byId = new Map(S.E.map(e => [e.id, e]));
    S.versionId = vid; S.label = label || `${r.meta?.model_name || 'Model'} v${r.meta?.version || ''}`;
    S.rowsById = null; S.measured = null;
    S.E.forEach(enrichElementQs);
    deriveOpenings(S.E, data.up, S.settings.openingThreshold);
  })();
  loading = { vid, p };
  try { await p; } finally { loading = null; }
}
export function closeVersion() { S.data = null; S.E = []; S.byId = new Map(); S.versionId = null; S.label = ''; }
