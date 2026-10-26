// Live links between workbook cells and measurements (task pane side).
//   =CX.QTY("ref", ["quantity"], ["dimension"])   total of a dimension group, or of one of its dimensions
//   =CX.NAME("ref")  =CX.UNIT("ref")             name and unit of the group
// ref is the start of the dimension group id (8 characters), so a link survives renames and moves. The values come
// from the project tree (measured dimensions) and from the measurement window (model objects, which need the model),
// and are streamed: linked cells change as soon as a measurement changes. A very hidden sheet, _cxlinks, lists the
// linked cells, so the measurement window can show where a group is used and select those cells.
import { App, api, status } from './core.js';
import { dimensions, dimQuantity, displayUnit } from './dims.js';
import { fmt } from './engine.js';

export const LINKS = '_cxlinks';
const REF_LEN = 8;
const X = {
  tree: null, pid: null,               // { folders, groups } of the open project
  bim: {},                             // gid -> { total, n, dims: { eid: qty } } reported by the measurement window
  subs: new Set(),                     // streaming invocations: { fn, args, inv }
  links: [],                           // [{ sheet, address, gid, mid, eid, quantity, value }]
  follow: true,
  quietUntil: 0,
};
try { X.follow = localStorage.getItem('dwfxFollowExcel') !== '0'; } catch { /* storage blocked */ }
let send = () => {};                   // (kind, msg) -> message to a window (set by the pane host)

export const shortRef = (id) => String(id || '').replace(/-/g, '').slice(0, REF_LEN).toLowerCase();
const groupOf = (ref) => {
  const r = String(ref || '').replace(/-/g, '').toLowerCase();
  if (r.length < 4) return null;
  return (X.tree?.groups || []).find(g => g.id.replace(/-/g, '').toLowerCase().startsWith(r)) || null;
};
const measuredOf = (g, ref) => { const r = String(ref || '').replace(/-/g, '').toLowerCase(); return (g.props?.measured || []).find(m => m.id.replace(/-/g, '').toLowerCase().startsWith(r)) || null; };
const EMPTY = new Map();

/** The value a link shows. qty: '' (total), 'Count', or for one measured dimension also 'Length' (its run). */
export function linkValue(g, quantity = '', dim = '') {
  const q = String(quantity || '').trim().toLowerCase();
  const bim = X.bim[g.id] || null;
  if (dim) {
    const m = measuredOf(g, dim);
    if (m) {
      if (q === 'count') return 1;
      if (q === 'base') return m.value;                      // the measured value before sign, multiplier and conversion
      if (q === 'length' && m.len != null) return m.len;
      return dimQuantity(g, m.value, m);
    }
    const eid = Number(dim);
    if (Number.isFinite(eid) && bim?.dims?.[eid] != null) return bim.dims[eid];
    return null;
  }
  const measured = dimensions({ ...g, items: [] }, EMPTY);
  if (q === 'count') return measured.length + (g.items || []).length;
  let total = measured.reduce((s, d) => s + (d.qty || 0), 0);
  if ((g.items || []).length) total += bim?.total || 0;
  return total;
}

// ================================================================== custom functions (shared runtime)
function cfError(msg) {
  if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error) return new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, msg);
  return '#N/A';
}
function compute(fn, args) {
  const [ref, a, b] = args;
  if (!X.tree) return cfError('Open the project in the DWFx Measure task pane.');
  const g = groupOf(ref);
  if (!g) return cfError('No dimension group with this reference in the open project.');
  if (fn === 'NAME') return g.name;
  if (fn === 'UNIT') return displayUnit(g);
  const v = fn === 'VALUE' ? linkValue(g, '', a) : linkValue(g, a, b);
  return v == null ? cfError(fn === 'VALUE' || b ? 'This dimension is not in the group, or its model is not open.' : 'No value yet.') : Math.round(v * 1e6) / 1e6;
}
function stream(fn) {
  return (...all) => {
    const inv = all.pop(), args = all.map(v => (v == null ? '' : v));
    const sub = { fn, args, inv };
    X.subs.add(sub);
    inv.onCanceled = () => X.subs.delete(sub);
    try { inv.setResult(compute(fn, args)); } catch { /* cell gone */ }
  };
}
/** Send the current values to every linked cell that Excel is showing. */
export function pushValues() {
  for (const s of X.subs) { try { s.inv.setResult(compute(s.fn, s.args)); } catch { X.subs.delete(s); } }
}
export function registerFunctions() {
  if (typeof CustomFunctions === 'undefined' || !CustomFunctions.associate) return false;
  for (const fn of ['QTY', 'VALUE', 'NAME', 'UNIT']) { try { CustomFunctions.associate(fn, stream(fn)); } catch { /* already associated */ } }
  return true;
}

// ================================================================== project tree and values
export function setSender(fn) { send = fn; }
export async function loadTree(pid = App.currentProjectId?.()) {
  if (!pid) { X.tree = null; X.pid = null; pushValues(); return null; }
  if (pid !== X.pid) { X.bim = loadBim(pid); X.pid = pid; }
  try { X.tree = await api('GET', `/projects/${pid}/tree`); } catch (err) { status('Could not read the measurements: ' + err.message, 'bad'); }
  pushValues();
  App.onMeasurements?.();
  return X.tree;
}
export const tree = () => X.tree;
/** Use a tree read elsewhere (the tests, or a window that already has it). */
export function setTree(t, pid = X.pid) { X.tree = t; X.pid = pid; pushValues(); }
/** Model-object totals from the measurement window (it has the model open). Kept on this computer per project. */
export function setBimTotals(groups) {
  if (!groups || typeof groups !== 'object') return;
  for (const [gid, v] of Object.entries(groups)) if (v && typeof v === 'object') X.bim[gid] = { total: Number(v.total) || 0, n: Number(v.n) || 0, dims: v.dims || {} };
  try { localStorage.setItem('dwfxBim:' + X.pid, JSON.stringify(X.bim)); } catch { /* too large or blocked */ }
  pushValues();
}
function loadBim(pid) { try { return JSON.parse(localStorage.getItem('dwfxBim:' + pid) || '{}') || {}; } catch { return {}; } }
export const following = () => X.follow;
export function setFollow(on) { X.follow = Boolean(on); try { localStorage.setItem('dwfxFollowExcel', on ? '1' : '0'); } catch { /* storage blocked */ } App.onMeasurements?.(); }

// ================================================================== formulas and the _cxlinks sheet
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
export function formulaFor({ gid, mid = null, eid = null, quantity = '' }) {
  const ref = shortRef(gid), dim = mid ? shortRef(mid) : eid != null ? String(eid) : '';
  const qty = quantity && !/^total$/i.test(quantity) ? quantity : '';
  if (dim && !qty) return `=CX.VALUE(${q(ref)},${q(dim)})`;
  if (dim) return `=CX.QTY(${q(ref)},${q(qty)},${q(dim)})`;
  return qty ? `=CX.QTY(${q(ref)},${q(qty)})` : `=CX.QTY(${q(ref)})`;
}
const CX_RE = /CX\.(QTY|VALUE|NAME|UNIT)\(\s*"([0-9a-f-]{4,36})"(?:\s*,\s*"([^"]*)")?(?:\s*,\s*"([^"]*)")?/gi;
/** The links in one formula: [{ gid, mid, eid, quantity }] (only references to groups of the open project). */
export function parseFormula(f) {
  const out = [];
  for (const m of String(f || '').matchAll(CX_RE)) {
    const g = groupOf(m[2]); if (!g) continue;
    const fn = m[1].toUpperCase(), dimRef = fn === 'VALUE' ? m[3] : m[4], quantity = fn === 'QTY' ? (m[3] || '') : '';
    const d = dimRef ? measuredOf(g, dimRef) : null;
    out.push({ gid: g.id, mid: d?.id || null, eid: !d && dimRef && /^\d+$/.test(dimRef) ? Number(dimRef) : null, quantity });
  }
  return out;
}
async function linksSheet(ctx, create) {
  let sh = ctx.workbook.worksheets.getItemOrNullObject(LINKS); await ctx.sync();
  if (sh.isNullObject) {
    if (!create) return null;
    sh = ctx.workbook.worksheets.add(LINKS);
    sh.getRange('A1:G1').values = [['Sheet', 'Cell', 'Group', 'Dimension', 'Object', 'Quantity', 'Linked']];
    sh.visibility = Excel.SheetVisibility.veryHidden;
  }
  return sh;
}
async function readRows(ctx) {
  const sh = await linksSheet(ctx, false); if (!sh) return [];
  const u = sh.getUsedRangeOrNullObject(true); u.load('values'); await ctx.sync();
  if (u.isNullObject) return [];
  return u.values.slice(1).map((v, i) => ({ row: i + 2, sheet: String(v[0]), address: String(v[1]), gid: String(v[2]), mid: v[3] ? String(v[3]) : null,
    eid: v[4] === '' || v[4] == null ? null : Number(v[4]), quantity: String(v[5] || '') })).filter(l => l.sheet && l.address && l.gid);
}
async function writeRows(ctx, rows) {
  const sh = await linksSheet(ctx, true);
  const u = sh.getUsedRangeOrNullObject(true); u.load('rowCount'); await ctx.sync();
  if (!u.isNullObject && u.rowCount > 1) sh.getRange(`A2:G${u.rowCount + 1}`).clear();
  if (rows.length) sh.getRange(`A2:G${rows.length + 1}`).values = rows.map(l => [l.sheet, l.address, l.gid, l.mid || '', l.eid ?? '', l.quantity || '', l.at || new Date().toISOString()]);
}

/** Write a live formula into the selected cell (several items: down the column) and record the links. */
export async function linkCell(items) {
  if (!App.inExcel?.()) throw new Error('Open the add-in in Excel to link cells.');
  if (!X.tree) await loadTree();
  const list = (Array.isArray(items) ? items : [items]).filter(i => i && groupOf(i.gid)).slice(0, 500);
  if (!list.length) throw new Error('That dimension group is not in the open project. Refresh the task pane.');
  let out = null;
  await Excel.run(async (ctx) => {
    const sel = ctx.workbook.getSelectedRange(); const ws = sel.worksheet;
    sel.load('rowIndex,columnIndex'); ws.load('name,id'); await ctx.sync();
    if (ws.name === LINKS) throw new Error('Select a cell on a normal sheet.');
    const rng = ws.getRangeByIndexes(sel.rowIndex, sel.columnIndex, list.length, 1);
    rng.formulas = list.map(i => [formulaFor(i)]);
    rng.load('address'); await ctx.sync();
    const rows = await readRows(ctx);
    const addr = (k) => colName(sel.columnIndex) + (sel.rowIndex + 1 + k);
    const keep = rows.filter(r => !(r.sheet === ws.name && list.some((_, k) => r.address === addr(k))));
    list.forEach((i, k) => keep.push({ sheet: ws.name, address: addr(k), gid: i.gid, mid: i.mid || null, eid: i.eid ?? null, quantity: i.quantity || '' }));
    await writeRows(ctx, keep);
    X.quietUntil = Date.now() + 1200;
    await ctx.sync();
    out = { address: `${ws.name}!${rng.address.split('!').pop()}`, count: list.length };
  });
  const g = groupOf(list[0].gid);
  const v = linkValue(g, list[0].quantity, list[0].mid ? shortRef(list[0].mid) : list[0].eid != null ? String(list[0].eid) : '');
  await broadcastLinks();
  return { ...out, text: list.length > 1 ? `${list.length} dimensions` : `${g.name}${v != null ? ' = ' + fmt(v, displayUnit(g)) + ' ' + displayUnit(g) : ''}` };
}
const colName = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };

/** Every linked cell, checked against the cells (a link whose formula was removed is dropped). */
export async function readLinks({ rescan = false } = {}) {
  if (!App.inExcel?.()) { X.links = []; return X.links; }
  if (!X.tree) await loadTree();
  await Excel.run(async (ctx) => {
    let rows = await readRows(ctx);
    if (rescan) rows = await scanWorkbook(ctx, rows);
    const ranges = rows.slice(0, 3000).map(l => { const r = ctx.workbook.worksheets.getItemOrNullObject(l.sheet); return { l, r }; });
    await ctx.sync();
    const cells = ranges.filter(x => !x.r.isNullObject).map(x => { const c = x.r.getRange(x.l.address); c.load('formulas,values'); return { ...x, c }; });
    await ctx.sync();
    const good = cells.filter(x => /CX\./i.test(String(x.c.formulas[0][0])) && parseFormula(x.c.formulas[0][0]).some(p => p.gid === x.l.gid));
    X.links = good.map(x => ({ ...x.l, value: typeof x.c.values[0][0] === 'number' ? Math.round(x.c.values[0][0] * 1000) / 1000 : String(x.c.values[0][0]) }));
    if (good.length !== rows.length || rescan) await writeRows(ctx, X.links);
    await ctx.sync();
  }).catch((err) => { status('Could not read the linked cells: ' + err.message, 'bad'); });
  return X.links;
}
/** Find CX formulas typed or copied by hand (not in _cxlinks yet). */
async function scanWorkbook(ctx, rows) {
  const sheets = ctx.workbook.worksheets; sheets.load('items/name,items/visibility'); await ctx.sync();
  const have = new Set(rows.map(r => `${r.sheet}!${r.address}`));
  for (const sh of sheets.items.filter(s => s.visibility === 'Visible')) {
    const u = sh.getUsedRangeOrNullObject(true); u.load('formulas,rowIndex,columnIndex,cellCount'); await ctx.sync();
    if (u.isNullObject || u.cellCount > 400000) continue;
    u.formulas.forEach((row, i) => row.forEach((f, j) => {
      if (typeof f !== 'string' || !/CX\./i.test(f)) return;
      const address = colName(u.columnIndex + j) + (u.rowIndex + i + 1);
      if (have.has(`${sh.name}!${address}`)) return;
      const p = parseFormula(f)[0]; if (!p) return;
      rows.push({ sheet: sh.name, address, ...p }); have.add(`${sh.name}!${address}`);
    }));
  }
  return rows;
}
export async function broadcastLinks(opts) {
  const list = await readLinks(opts);
  send('measure', { type: 'links', list });
  App.onMeasurements?.();
  return list;
}
export const links = () => X.links;

/** Select the linked cells of a group (or of one dimension). Returns how many cells. */
export async function selectLinked({ gid, mid = null, eid = null } = {}) {
  if (!App.inExcel?.()) return 0;
  if (!X.links.length) await readLinks();
  let hits = X.links.filter(l => l.gid === gid && (mid ? l.mid === mid : eid != null ? l.eid === eid : true));
  if (!hits.length && (mid || eid != null)) hits = X.links.filter(l => l.gid === gid && !l.mid && l.eid == null);   // the dimension is in a linked group total
  if (!hits.length) return 0;
  const sheet = hits[0].sheet, on = hits.filter(h => h.sheet === sheet).slice(0, 200);
  X.quietUntil = Date.now() + 1200;
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItem(sheet); sh.activate();
    sh.getRanges(on.map(h => h.address).join(',')).select(); await ctx.sync();
  });
  return hits.length;
}
export async function selectCell(l) {
  X.quietUntil = Date.now() + 1200;
  await Excel.run(async (ctx) => { const sh = ctx.workbook.worksheets.getItem(l.sheet); sh.activate(); sh.getRange(l.address).select(); await ctx.sync(); });
  return { address: `${l.sheet}!${l.address}` };
}
/** Remove a link: the cell keeps its last value as a plain number. */
export async function unlinkCell(l) {
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItemOrNullObject(l.sheet); await ctx.sync();
    if (!sh.isNullObject) { const c = sh.getRange(l.address); c.load('values'); await ctx.sync(); c.values = c.values; }
    const rows = (await readRows(ctx)).filter(r => !(r.sheet === l.sheet && r.address === l.address));
    await writeRows(ctx, rows); await ctx.sync();
  });
  await broadcastLinks();
  return { removed: `${l.sheet}!${l.address}` };
}

/** A selection in Excel: a cell with a CX formula shows its measurement in the window (when Follow Excel is on). */
export async function onSelection(ev) {
  if (Date.now() < X.quietUntil || !X.tree) return false;
  let found = [];
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItem(ev.worksheetId);
    const rng = sh.getRange(ev.address); rng.load('cellCount'); await ctx.sync();
    if (rng.cellCount > 400) return;
    rng.load('formulas'); await ctx.sync();
    rng.formulas.flat().forEach(f => { if (typeof f === 'string' && /CX\./i.test(f)) found.push(...parseFormula(f)); });
  }).catch(() => {});
  if (!found.length) return false;
  const first = found[0];
  App.onLinkedCell?.(first);
  if (X.follow) send('measure', { type: 'focusDim', ...first, ids: found.slice(0, 50) });
  return true;
}

// ================================================================== sharing a workbook with people who do not have the add-in
// Share copy: every CX formula in the workbook becomes its current value (a plain number that anyone can see); the
// formulas are kept in a very hidden sheet, _cxshared. Restore links puts them back (cells changed by hand are left).
export const SHARED = '_cxshared';
const CX_FN = /\bCX\.(QTY|VALUE|NAME|UNIT)\s*\(/i;
/** A real CX function call, not the same letters inside a text in quotes ("..." with "" for a quote). */
const callsCx = (f) => CX_FN.test(String(f).replace(/"(?:[^"]|"")*"/g, '""'));
const isError = (v) => typeof v === 'string' && /^#[A-Z0-9/!?]+[!?]?$/i.test(v.trim());

/** Turn the live links into values. Returns { cells, sheets, notReady }.
 * The formulas are saved first (one sync), and only then are the cells replaced, so a failure part way never loses one. */
export async function freezeLinks() {
  if (!App.inExcel?.()) throw new Error('Open the add-in in Excel first.');
  pushValues();
  const res = { cells: 0, sheets: 0, notReady: 0 };
  await Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets; ws.load('items/name,items/id'); await ctx.sync();
    const kept = await readShared(ctx);
    const have = new Map(kept.map(r => [`${r[4] || r[0]}!${r[1]}`, r]));
    const todo = [];                                           // { sh, addr, v }
    for (const sh of ws.items) {
      if (sh.name === LINKS || sh.name === SHARED) continue;
      const u = sh.getUsedRangeOrNullObject(true); u.load('formulas,values,rowIndex,columnIndex,cellCount'); await ctx.sync();
      if (u.isNullObject || u.cellCount > 2000000) continue;
      u.formulas.forEach((row, i) => row.forEach((f, j) => {
        if (typeof f !== 'string' || !callsCx(f)) return;
        const v = u.values[i][j];
        if (isError(v)) { res.notReady++; return; }                      // not calculated yet: keep the formula
        const addr = colName(u.columnIndex + j) + (u.rowIndex + i + 1);
        have.set(`${sh.id}!${addr}`, [sh.name, addr, f, v, sh.id]);
        todo.push({ sh, addr, v });
      }));
    }
    if (!todo.length) return;
    await writeShared(ctx, [...have.values()]);
    await ctx.sync();                                          // the formulas are safe before any cell changes
    const done = new Set();
    for (const t of todo) {
      t.sh.getRange(t.addr).values = [[t.v]];
      res.cells++; done.add(t.sh.id);
    }
    res.sheets = done.size;
    X.quietUntil = Date.now() + 1500;
    await ctx.sync();
  });
  return res;
}
/** Put the live formulas back. Returns { restored, changed, missing }. A sheet is found by its id, so a renamed sheet
 * still works; records whose sheet cannot be found (deleted, or not in this file) are kept, never thrown away. */
export async function restoreLinks() {
  if (!App.inExcel?.()) throw new Error('Open the add-in in Excel first.');
  const res = { restored: 0, changed: 0, missing: 0 };
  await Excel.run(async (ctx) => {
    const rows = await readShared(ctx);
    if (!rows.length) return;
    const ws = ctx.workbook.worksheets; ws.load('items/name,items/id'); await ctx.sync();
    const left = [], live = [];
    for (const r of rows) {
      const sh = ws.items.find(x => r[4] && x.id === r[4]) || ws.items.find(x => x.name === r[0]);
      if (!sh) { res.missing++; left.push(r); continue; }
      const c = sh.getRange(r[1]); c.load('formulas,values'); live.push({ r: [sh.name, r[1], r[2], r[3], sh.id], c });
    }
    await ctx.sync();
    for (const x of live) {
      const f = x.c.formulas[0][0], v = x.c.values[0][0];
      if (typeof f === 'string' && f.startsWith('=')) continue;                                 // already a formula
      if (String(v) !== String(x.r[3])) { res.changed++; left.push(x.r); continue; }            // typed over by hand: leave it
      x.c.formulas = [[x.r[2]]]; res.restored++;
    }
    await writeShared(ctx, left);
    X.quietUntil = Date.now() + 1500;
    await ctx.sync();
  });
  pushValues();
  await broadcastLinks().catch(() => {});
  return res;
}
export async function sharedCount() {
  if (!App.inExcel?.()) return 0;
  let n = 0;
  await Excel.run(async (ctx) => { n = (await readShared(ctx)).length; }).catch(() => {});
  return n;
}
async function readShared(ctx) {
  const sh = ctx.workbook.worksheets.getItemOrNullObject(SHARED); await ctx.sync();
  if (sh.isNullObject) return [];
  const u = sh.getUsedRangeOrNullObject(true); u.load('values,formulas'); await ctx.sync();
  if (u.isNullObject) return [];
  // formulas are stored as text with a marker, so they never calculate in the hidden sheet
  return u.values.slice(1).map(v => [String(v[0]), String(v[1]), String(v[2]).replace(/^CXF:/, ''), v[3], String(v[4] || '')]).filter(r => r[0] && r[1] && r[2].startsWith('='));
}
async function writeShared(ctx, rows) {
  let sh = ctx.workbook.worksheets.getItemOrNullObject(SHARED); await ctx.sync();
  if (sh.isNullObject) {
    if (!rows.length) return;
    sh = ctx.workbook.worksheets.add(SHARED);
    sh.visibility = Excel.SheetVisibility.veryHidden;
  }
  sh.getRange('A:E').clear();
  sh.getRange('A1:E1').values = [['Sheet', 'Cell', 'Formula', 'Value when shared', 'Sheet id']];
  if (rows.length) sh.getRange(`A2:E${rows.length + 1}`).values = rows.map(r => [r[0], r[1], 'CXF:' + r[2], r[3], r[4] || '']);
}
