// Measurement window, right pane: Zones (named sets of model objects). The schedule tools (AI, checks, summary
// sheets) are in the DWFx Schedules window.
import { esc, api, status } from './core.js';

let C = null;            // { W, send, setIds, paint }
const ZONE_COLORS = ['#0078d4', '#e3008c', '#00b7c3', '#ca5010', '#498205', '#8764b8', '#986f0b', '#c239b3', '#038387', '#bf0077'];
const canEdit = () => ['owner', 'editor'].includes(C.W.project?.my_role);

export function initPanel(ctx) { C = ctx; }

export async function loadZones() {
  const W = C.W; W.zones = []; W.zoneOf = new Map();
  if (W.projectId) { try { W.zones = (await api('GET', `/projects/${W.projectId}/zones`)).zones; } catch { /* optional */ } }
  W.zones.forEach(z => (z.ids || []).forEach(id => { if (!W.zoneOf.has(id)) W.zoneOf.set(id, z.name); }));
  W.E.forEach(e => { e.zone = W.zoneOf.get(e.id) || ''; });
  if (W.side === 'zones') renderPanel();
}
export function zoneColors(on) {
  const W = C.W;
  if (!on) { W.colorMap = null; C.paint(); return; }
  const col = new Map(W.zones.map((z, i) => [z.name, z.color || ZONE_COLORS[i % ZONE_COLORS.length]]));
  W.colorMap = new Map(W.E.map(e => [e.id, col.get(W.zoneOf.get(e.id)) || '#c8cdd2'])); C.paint();
}

/** Draw the Zones tab into the side panel body. */
export function renderPanel() {
  const W = C.W, body = document.getElementById('wbody'), edit = canEdit();
  if (!W.projectId) { body.innerHTML = '<p class="hint">Zones belong to a project.</p>'; return; }
  if (!W.E.length) { body.innerHTML = '<p class="hint">Open a 3D model to make zones: a zone is a named set of model objects (for example Villa, Annex, Block A).</p>'; return; }
  body.innerHTML = `<p class="hint">A zone is a named set of objects (for example Villa, Annex, Block A). Dimension groups can be given a zone, schedules can sub-total by zone and the model can be coloured by zone.</p>
    <div class="row"><button class="btn small" id="zCol">${W.colorMap && W.zoneColored ? 'Normal colours' : 'Colour by zone'}</button></div>
    ${W.zones.map((z, i) => `<div class="zone-row"><span class="sw" style="background:${esc(z.color || ZONE_COLORS[i % ZONE_COLORS.length])}"></span><span class="grow">${esc(z.name)}</span><span class="muted small">${(z.ids || []).length}</span>
      <button class="btn small" data-zs="${i}">Select</button>${edit ? `<button class="btn small" data-zu="${i}" title="Replace with the current selection">Update</button><button class="btn small subtle danger-text" data-zd="${i}">Delete</button>` : ''}</div>`).join('') || '<p class="hint">No zones yet.</p>'}
    ${edit ? `<form class="inline-form" id="zForm"><input class="input" id="zName" placeholder="New zone name" maxlength="80" required aria-label="New zone name"><button class="btn">Create from selection (${W.ticked.size})</button></form>` : ''}`;
  body.querySelector('#zCol').onclick = () => { W.zoneColored = !(W.colorMap && W.zoneColored); zoneColors(W.zoneColored); renderPanel(); };
  body.querySelectorAll('[data-zs]').forEach(b => b.onclick = () => C.setIds(W.zones[+b.dataset.zs].ids.filter(id => W.byId.has(id)), true));
  const save = async (name, color) => {
    if (!W.ticked.size) { status('Select the objects of the zone first.', 'bad'); return; }
    try { await api('POST', `/projects/${W.projectId}/zones`, { name, color, ids: [...W.ticked] }); await loadZones(); C.send({ type: 'zonesChanged' }); status(`Zone "${name}" saved.`, 'ok'); renderPanel(); }
    catch (err) { status(err.message, 'bad'); }
  };
  body.querySelectorAll('[data-zu]').forEach(b => b.onclick = () => { const z = W.zones[+b.dataset.zu]; save(z.name, z.color); });
  body.querySelectorAll('[data-zd]').forEach(b => b.onclick = async () => {
    try { await api('DELETE', `/zones/${W.zones[+b.dataset.zd].id}`); await loadZones(); C.send({ type: 'zonesChanged' }); renderPanel(); status('Zone deleted.', 'ok'); } catch (err) { status(err.message, 'bad'); }
  });
  const f = body.querySelector('#zForm'); if (f) f.onsubmit = (e) => { e.preventDefault(); save(f.querySelector('#zName').value.trim(), ZONE_COLORS[W.zones.length % ZONE_COLORS.length]); };
}
