// Everything that touches the workbook: the Take-off sheet (live formulas, named totals), the hidden
// _dwfx sheet that links groups to the project, reading groups back, updating a group in place after a
// revision, the BOQ sheet, the change log, measured status and Excel <-> 3D selection.
import { App, api, status } from './core.js';
import { unitFmt } from './engine.js';
import { S } from './state.js';
import { evaluate } from './measure.js';
import { update } from './model.js';
import { DEFAULT_DETAILS, detailLabel, detailValue, sameElements, mergeSpecs } from './dims.js';

export const SHEET = 'Take-off', META = '_dwfx', BOQ = 'BOQ', LOG = 'Change log';
const colL = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
/** Text written to Excel must never turn into a formula (names, types and AI text can start with = + - @). */
export const safeText = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
const nameKey = (ref, key) => `TO_${ref}_${key}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 250);

// ================================================================== build one group block
function buildBlock(spec, ref, top, evRows) {
  const cols = [...spec.inputs, ...spec.formulas];
  const manual = spec.manual || [];
  let details = spec.details || DEFAULT_DETAILS;
  if (manual.length && !details.length) details = ['type'];             // somewhere to write the measured label
  const D = 2 + details.length;                                          // first quantity column (0-based)
  const colOf = {}; cols.forEach((c, i) => { colOf[c.key] = colL(D + i); });
  const width = D + cols.length, last = colL(Math.max(width - 1, D - 1));
  const blank = () => Array(width).fill('');
  const out = [], kinds = [];
  const push = (row, kind) => { const r = blank(); row.forEach((v, i) => { r[i] = v; }); out.push(r); kinds.push(kind); };
  const rowNo = () => top + out.length;
  push([ref, safeText(spec.name)], 'title');
  if (spec.note) push(['', safeText('Method: ' + spec.note)], 'note');
  const constCell = {};
  spec.constants.forEach(c => { constCell[c.key] = `$C$${rowNo()}`; push(['', safeText(c.label), Number(c.value) || 0, safeText(c.unit || '')], 'const'); });
  push(['Ref', 'Revit ID', ...details.map(d => safeText(detailLabel(d))), ...cols.map(c => safeText(`${c.label} (${c.unit})`))], 'head');
  const toXl = (expr, r) => '=' + String(expr).replace(/\{(\w+)\}/g, (m, k) => colOf[k] ? colOf[k] + r : (constCell[k] || '0'));
  const sumCols = cols.filter(c => c.sum !== false && (c.sum || spec.formulas.includes(c)));
  const key = (e) => spec.by === 'type' ? e.type : spec.by === 'level' ? (e.level || '(no level)') : spec.by === 'zone' ? (S.zoneOf.get(e.id) || '(no zone)')
    : spec.by === 'category' ? e.cat : '';
  const parts = new Map();
  evRows.forEach(x => { const k = key(x.e); if (!parts.has(k)) parts.set(k, []); parts.get(k).push(x); });
  const nParts = parts.size + (manual.length ? 1 : 0);
  const subtotal = (k, start) => {
    if (!spec.by || nParts < 2) return;
    const end = rowNo() - 1, r = blank();
    r[1] = safeText(`Sub-total ${k}`); sumCols.forEach(c => { r[D + cols.indexOf(c)] = `=SUBTOTAL(9,${colOf[c.key]}${start}:${colOf[c.key]}${end})`; });
    out.push(r); kinds.push('sub');
  };
  const firstData = rowNo(); let n = 0;
  for (const [k, list] of [...parts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const start = rowNo();
    list.sort((a, b) => (a.e.level || '').localeCompare(b.e.level || '') || a.e.id - b.e.id).forEach(({ e, v }) => {
      n++; const r = rowNo();
      push([`${ref}.${n}`, e.id, ...details.map(d => safeText(String(detailValue(e, d)))), ...spec.inputs.map(i => v[i.key] ?? ''), ...spec.formulas.map(f => toXl(f.expr, r))], 'data');
    });
    subtotal(k, start);
  }
  if (manual.length) {
    const start = rowNo(), at = Math.max(details.indexOf('type'), 0);
    manual.forEach(m => {
      n++; const r = rowNo();
      const det = details.map((d, i) => (i === at ? safeText(String(m.label || 'Measured dimension')) : ''));
      push([`${ref}.${n}`, '', ...det, ...spec.inputs.map(i => m.v?.[i.key] ?? ''), ...spec.formulas.map(f => toXl(f.expr, r))], 'data');
    });
    subtotal('measured dimensions', start);
  }
  const lastData = Math.max(rowNo() - 1, firstData), tr = blank();
  tr[1] = safeText(`Total ${spec.name}`); sumCols.forEach(c => { tr[D + cols.indexOf(c)] = `=SUBTOTAL(9,${colOf[c.key]}${firstData}:${colOf[c.key]}${lastData})`; });
  out.push(tr); kinds.push('total');
  const totalRow = top + out.length - 1;
  const names = sumCols.map(c => ({ name: nameKey(ref, c.key), address: `$${colOf[c.key]}$${totalRow}`, label: c.label, unit: c.unit }));
  return { out, kinds, cols, colOf, width, last, top, end: totalRow, names, headRow: top + kinds.indexOf('head'), D };
}

async function ensureSheet(ctx) {
  let sh = ctx.workbook.worksheets.getItemOrNullObject(SHEET); await ctx.sync();
  if (sh.isNullObject) {
    sh = ctx.workbook.worksheets.add(SHEET);
    sh.getRange('A1').values = [['TAKE-OFF']];
    sh.getRange('A1').format.font.set({ bold: true, size: 14, color: '#0a5082', name: 'Arial' });
    sh.getRange('A2').values = [[`Source: ${S.data?.fileName || ''}. Quantities in metres. Revit IDs in column B link rows to the 3D model. Yellow cells are assumptions you can change. Green headers are formula columns.`]];
    sh.getRange('A2').format.font.set({ italic: true, size: 9, name: 'Arial', color: '#5b6670' });
    ['A:A', 'B:B', 'C:C', 'D:D', 'E:E', 'F:F', 'G:G'].forEach((c, i) => { sh.getRange(c).format.columnWidth = [42, 70, 90, 110, 200, 85, 50][i]; });
  }
  return sh;
}
async function metaSheet(ctx) {
  let m = ctx.workbook.worksheets.getItemOrNullObject(META); await ctx.sync();
  if (m.isNullObject) {
    m = ctx.workbook.worksheets.add(META);
    m.getRange('A1:H1').values = [['Ref', 'Takeoff ID', 'Version ID', 'Name', 'Method (JSON)', 'Updated', 'Project ID', 'Model']];
    m.visibility = Excel.SheetVisibility.veryHidden;
  }
  return m;
}
async function writeMeta(ctx, ref, spec, takeoffId) {
  const m = await metaSheet(ctx);
  const used = m.getUsedRange(true); used.load('values'); await ctx.sync();
  const method = JSON.stringify({ name: spec.name, by: spec.by, note: spec.note, inputs: spec.inputs, constants: spec.constants, formulas: spec.formulas, filter: spec.filter,
    details: spec.details, manual: spec.manual, parts: spec.parts, base: spec.base, dimGroupId: spec.dimGroupId });
  if (method.length > 32000) throw new Error(`The method of "${spec.name}" is too large to link to the sheet (more than 32,000 characters).`);
  const row = [ref, takeoffId || '', S.versionId || '', safeText(spec.name), method, new Date().toISOString(), App.currentProjectId?.() || '', S.label || ''];
  let r = used.values.findIndex(v => v[0] === ref);
  r = r > 0 ? r + 1 : used.values.length + 1;
  m.getRange(`A${r}:H${r}`).values = [row];
}
async function readMeta(ctx) {
  const m = ctx.workbook.worksheets.getItemOrNullObject(META); await ctx.sync();
  if (m.isNullObject) return new Map();
  const used = m.getUsedRange(true); used.load('values'); await ctx.sync();
  const map = new Map();
  used.values.slice(1).forEach(v => { if (!v[0]) return; let method = null; try { method = JSON.parse(v[4]); } catch { /* corrupt */ } map.set(String(v[0]), { takeoffId: v[1], versionId: v[2], name: v[3], method, projectId: v[6] }); });
  return map;
}
function formatBlock(sh, b, spec) {
  const { top, end, kinds, cols, colOf, last, headRow } = b;
  const rng = sh.getRange(`A${top}:${colL(b.width - 1)}${end}`);
  rng.format.font.set({ name: 'Arial', size: 9, color: '#1d2730', bold: false, italic: false });
  rng.format.fill.clear();
  const B = Excel.BorderIndex;
  [B.edgeTop, B.edgeBottom, B.edgeLeft, B.edgeRight, B.insideHorizontal, B.insideVertical].forEach(ed => {
    const bd = sh.getRange(`A${headRow}:${last}${end}`).format.borders.getItem(ed); bd.style = 'Continuous'; bd.color = '#BFBFBF'; });
  cols.forEach(c => { sh.getRange(`${colOf[c.key]}${headRow + 1}:${colOf[c.key]}${end}`).numberFormat = [[unitFmt(c.unit)]]; });
  spec.formulas.forEach(f => { sh.getRange(`${colOf[f.key]}${headRow}`).format.fill.color = '#E2EFDA'; });
  kinds.forEach((k, i) => {
    const row = sh.getRange(`A${top + i}:${last}${top + i}`);
    if (k === 'title') { row.format.fill.color = '#0a5082'; row.format.font.set({ bold: true, color: '#FFFFFF', size: 10 }); }
    if (k === 'note') row.format.font.set({ italic: true, color: '#5b6670' });
    if (k === 'const') { const c = sh.getRange(`C${top + i}`); c.format.fill.color = '#FFF2CC'; c.format.font.color = '#0000FF'; }
    if (k === 'head') { row.format.fill.color = '#D9E6F2'; row.format.font.bold = true; row.format.wrapText = true; }
    if (k === 'sub') { row.format.fill.color = '#F2F2F2'; row.format.font.bold = true; }
    if (k === 'total') { row.format.fill.color = '#E2E8EE'; row.format.font.bold = true; }
  });
  sh.getRange(`B${top}:B${end}`).format.horizontalAlignment = 'Left';
}
async function setNames(ctx, sh, names) {
  // update the reference of an existing name (BOQ formulas keep working) or add a new one
  for (const n of names) {
    const old = ctx.workbook.names.getItemOrNullObject(n.name); await ctx.sync();
    if (!old.isNullObject) old.formula = `='${SHEET}'!${n.address}`;
    else ctx.workbook.names.add(n.name, sh.getRange(n.address), `${n.label} (${n.unit})`);
  }
}

// ================================================================== add a group
export async function addToExcel(spec, { save = true, takeoffId = null, merge = true } = {}) {
  if (!S.inExcel) throw new Error('Open this add-in inside Excel to write the take-off sheet.');
  const { rows: evRows } = evaluate(spec);                     // validates formulas before touching Excel
  // Same elements as a table already on the sheet (concrete, formwork, rebar, waterproofing... of the same
  // beams): add the new columns to that table instead of starting another one.
  if (merge && spec.ids?.length) {
    const groups = await readGroups();
    const g = groups.find(x => x.meta?.method && sameElements({ ids: x.ids }, spec));
    if (g) return mergeIntoGroup(g, spec, { save });
  }
  let id = takeoffId;
  if (save && !id) id = await saveTakeoff(spec, { quiet: true });
  let ref = '';
  try {
    await Excel.run(async (ctx) => {
      const sh = await ensureSheet(ctx);
      const used = sh.getUsedRangeOrNullObject(true); used.load('rowCount,rowIndex');
      const colA = sh.getRange('A1:A60000'); colA.load('values');
      await ctx.sync();
      const nums = colA.values.map(r => String(r[0])).filter(v => /^G\d+$/.test(v)).map(v => +v.slice(1));
      ref = 'G' + ((nums.length ? Math.max(...nums) : 0) + 1);
      const top = (used.isNullObject ? 2 : used.rowIndex + used.rowCount) + 2;
      const b = buildBlock(spec, ref, top, evRows);
      sh.getRange(`A${top}:${colL(b.width - 1)}${b.end}`).formulas = b.out;
      formatBlock(sh, b, spec);
      await setNames(ctx, sh, b.names);
      await writeMeta(ctx, ref, spec, id);
      sh.activate(); sh.getRange(`A${top}`).select();
      S.quiet = Date.now();
      await ctx.sync();
    });
    S.rowsById = null;
    status(`Added ${ref} "${spec.name}" to the ${SHEET} sheet${id ? ' and saved it to the project' : ''}.`, 'ok');
  } catch (err) { status('Excel error: ' + err.message, 'bad'); throw err; }
  if (S.colorBy === 'measured') App.setColorMode?.('measured');
  return ref;
}
async function mergeIntoGroup(g, spec, { save }) {
  const merged = mergeSpecs({ ...g.meta.method, name: g.meta.method.name || g.name, ids: spec.ids }, spec);
  evaluate(merged);
  let id = g.meta.takeoffId || null;
  const p = App.currentProject?.();
  if (id && p && ['owner', 'editor'].includes(p.my_role)) {
    try { await api('PATCH', `/takeoffs/${id}`, { spec: merged, versionId: S.versionId }); } catch (err) { status(`Saving to the project failed: ${err.message}`, 'bad'); }
  } else if (!id && save) id = await saveTakeoff(merged, { quiet: true });
  try { await updateGroupInPlace(g.ref, merged, { keepAssumptions: true, takeoffId: id }); }
  catch (err) { status('Excel error: ' + err.message, 'bad'); throw err; }
  const added = merged.formulas.length + merged.inputs.length - g.meta.method.formulas.length - g.meta.method.inputs.length;
  status(`"${spec.name}" uses the same ${spec.ids.length} elements as ${g.ref}, so it was added to that table (${added} new column${added === 1 ? '' : 's'}).`, 'ok');
  if (S.colorBy === 'measured') App.setColorMode?.('measured');
  return g.ref;
}
/** Outside Excel: the take-off list follows the same rule (one group for the same elements). */
export async function addToList(spec) {
  const i = S.takeoff.findIndex(x => sameElements(x, spec));
  if (i < 0) { S.takeoff.push(spec); spec.takeoffId = await saveTakeoff(spec, { quiet: true }); status(`Added "${spec.name}". ${S.takeoff.length} group(s) in the list.`, 'ok'); return; }
  const merged = mergeSpecs(S.takeoff[i], spec); evaluate(merged);
  merged.takeoffId = S.takeoff[i].takeoffId; S.takeoff[i] = merged;
  if (merged.takeoffId) { try { await api('PATCH', `/takeoffs/${merged.takeoffId}`, { spec: merged, versionId: S.versionId }); } catch (err) { status(err.message, 'bad'); return; } }
  status(`"${spec.name}" has the same elements as "${S.takeoff[i].parts?.[0] || S.takeoff[i].name}", so its columns were added to that group.`, 'ok');
}
/** Keep a server copy of the group (editors and owners of the open project). Returns the take-off id. */
export async function saveTakeoff(spec, { quiet = false } = {}) {
  const p = App.currentProject?.();
  if (!p || !S.versionId || !['owner', 'editor'].includes(p.my_role)) return null;
  try {
    const { takeoff } = await api('POST', `/projects/${p.project.id}/takeoffs`, { versionId: S.versionId, spec });
    if (!quiet) status(`Saved "${spec.name}" to ${p.project.name}.`, 'ok');
    return takeoff.id;
  } catch (err) { status(`Saving to the project failed: ${err.message}`, 'bad'); return null; }
}

// ================================================================== read groups back from the sheet
/** Returns [{ ref, name, top, end, headRow, totalRow, labels[], totals{label:value}, units{}, constants[], ids[], meta }] */
export async function readGroups() {
  if (!S.inExcel) return [];
  return Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItemOrNullObject(SHEET); await ctx.sync();
    if (sh.isNullObject) return [];
    const used = sh.getUsedRangeOrNullObject(false); used.load('rowCount,columnCount,rowIndex,columnIndex'); await ctx.sync();
    if (used.isNullObject) return [];
    const rng = sh.getRangeByIndexes(0, 0, used.rowIndex + used.rowCount, Math.max(used.columnIndex + used.columnCount, 8)); rng.load('values'); await ctx.sync();
    const meta = await readMeta(ctx);
    const V = rng.values, groups = [];
    for (let i = 0; i < V.length; i++) {
      if (!/^G\d+$/.test(String(V[i][0]))) continue;
      const g = { ref: String(V[i][0]), name: String(V[i][1]), top: i + 1, constants: [], ids: [], labels: [], totals: {}, units: {}, missing: {} };
      let j = i + 1;
      for (; j < V.length && !/^G\d+$/.test(String(V[j][0])); j++) {
        const a = String(V[j][0]), b = String(V[j][1]);
        if (a === 'Ref') {
          g.headRow = j + 1;
          const det = meta.get(g.ref)?.method?.details;
          g.dataStart = Array.isArray(det) ? 2 + (det.length || (meta.get(g.ref).method.manual?.length ? 1 : 0))
            : Math.max(2, V[j].findIndex((h, k) => k >= 2 && /\([^()]*\)$/.test(String(h))));
          if (g.dataStart < 2) g.dataStart = 7;
          g.labels = V[j].slice(g.dataStart).map(String).filter(Boolean);
        }
        else if (!a && !g.headRow && b && !b.startsWith('Method:')) g.constants.push({ label: b, value: V[j][2], unit: String(V[j][3] || ''), address: `C${j + 1}` });
        else if (a.startsWith(g.ref + '.') && typeof V[j][1] === 'number') g.ids.push(V[j][1]);
        else if (b.startsWith('Total ') && g.headRow) { g.totalRow = j + 1; g.labels.forEach((l, k) => { const v = V[j][g.dataStart + k]; if (v !== '' && v != null) g.totals[l] = v; }); }
        if (b.startsWith('Method:')) g.note = b.slice(8);
      }
      g.end = g.totalRow || j;
      g.labels.forEach(l => { const m = /^(.*) \(([^)]*)\)$/.exec(l); if (m) g.units[l] = m[2]; });
      g.meta = meta.get(g.ref) || null;
      groups.push(g);
      i = j - 1;
    }
    return groups;
  });
}

// ================================================================== update a group in place (new revision)
export async function updateGroupInPlace(ref, spec, { keepAssumptions = true, takeoffId = null } = {}) {
  const { rows: evRows } = evaluate(spec);
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItem(SHEET);
    const groups = await readGroups();
    const g = groups.find(x => x.ref === ref); if (!g) throw new Error(`${ref} was not found on the ${SHEET} sheet.`);
    if (keepAssumptions) spec.constants.forEach(c => { const old = g.constants.find(o => o.label === c.label); if (old && typeof old.value === 'number') c.value = old.value; });
    const b = buildBlock(spec, ref, g.top, evRows);
    const oldRows = g.end - g.top + 1, newRows = b.end - b.top + 1;
    if (newRows > oldRows) sh.getRange(`${g.end + 1}:${g.end + newRows - oldRows}`).insert(Excel.InsertShiftDirection.down);
    if (newRows < oldRows) sh.getRange(`${g.top + newRows}:${g.end}`).delete(Excel.DeleteShiftDirection.up);
    const clearTo = colL(Math.max(b.width, (g.dataStart || 7) + g.labels.length) + 2);
    sh.getRange(`A${g.top}:${clearTo}${b.end}`).clear(Excel.ClearApplyTo.all);
    sh.getRange(`A${g.top}:${colL(b.width - 1)}${b.end}`).formulas = b.out;
    formatBlock(sh, b, spec);
    await setNames(ctx, sh, b.names);
    await writeMeta(ctx, ref, spec, takeoffId);
    S.quiet = Date.now();
    await ctx.sync();
  });
  S.rowsById = null;
}

/** Append rows to the Change log sheet. rows: [[date, group, version, added, removed, changed, column, before, after, diff]] */
export async function writeChangeLog(rows) {
  if (!S.inExcel || !rows.length) return;
  await Excel.run(async (ctx) => {
    let sh = ctx.workbook.worksheets.getItemOrNullObject(LOG); await ctx.sync();
    if (sh.isNullObject) {
      sh = ctx.workbook.worksheets.add(LOG);
      sh.getRange('A1:J1').values = [['Date', 'Group', 'Updated to', 'Elements added', 'Elements removed', 'Elements changed', 'Column', 'Before', 'After', 'Difference']];
      sh.getRange('A1:J1').format.font.set({ bold: true, name: 'Arial', size: 9 }); sh.getRange('A1:J1').format.fill.color = '#D9E6F2';
    }
    const used = sh.getUsedRange(true); used.load('rowCount'); await ctx.sync();
    const r0 = used.rowCount + 1;
    const rng = sh.getRange(`A${r0}:J${r0 + rows.length - 1}`);
    rng.values = rows.map(r => r.map(safeText)); rng.format.font.set({ name: 'Arial', size: 9 });
    sh.getRange(`H${r0}:J${r0 + rows.length - 1}`).numberFormat = rows.map(() => ['#,##0.000', '#,##0.000', '+#,##0.000;-#,##0.000;0']);
    await ctx.sync();
  });
}

// ================================================================== BOQ sheet
/**
 * items: [{ ref, group, column, label, unit, nameKey, description, heading }]
 * Quantities link to the named totals of the Take-off groups, so the BOQ follows every change.
 * Rates already typed in an existing BOQ sheet are kept (matched by item number).
 */
export async function buildBOQ(items, { title = 'BILL OF QUANTITIES' } = {}) {
  await Excel.run(async (ctx) => {
    let sh = ctx.workbook.worksheets.getItemOrNullObject(BOQ); await ctx.sync();
    const rates = new Map();
    if (!sh.isNullObject) {
      const used = sh.getUsedRangeOrNullObject(true); used.load('values'); await ctx.sync();
      if (!used.isNullObject) used.values.forEach(v => { if (v[0] && typeof v[4] === 'number') rates.set(String(v[0]), v[4]); });
      sh.delete(); await ctx.sync();
    }
    sh = ctx.workbook.worksheets.add(BOQ);
    const rows = [[title, '', '', '', '', ''], [safeText(`${App.currentProject?.()?.project?.name || ''} · ${S.label || ''}`), '', '', '', '', ''], ['', '', '', '', '', ''],
      ['Item', 'Description', 'Unit', 'Quantity', 'Rate', 'Amount']];
    const kinds = ['title', 'sub', 'blank', 'head'];
    let lastHeading = null;
    items.forEach((it) => {
      if (it.heading && it.heading !== lastHeading) { rows.push(['', safeText(it.heading), '', '', '', '']); kinds.push('heading'); lastHeading = it.heading; }
      const r = rows.length + 1;
      rows.push([safeText(it.item), safeText(it.description), safeText(it.unit), `=${it.nameKey}`, rates.get(String(it.item)) ?? '', `=IF(E${r}="","",D${r}*E${r})`]);
      kinds.push('item');
    });
    const first = 5, lastItem = rows.length;
    rows.push(['', 'TOTAL CARRIED TO SUMMARY', '', '', '', `=SUM(F${first}:F${lastItem})`]); kinds.push('total');
    const end = rows.length;
    sh.getRange(`A1:F${end}`).formulas = rows;
    sh.getRange(`A1:F${end}`).format.font.set({ name: 'Arial', size: 9, color: '#1d2730' });
    ['A:A', 'B:B', 'C:C', 'D:D', 'E:E', 'F:F'].forEach((c, i) => { sh.getRange(c).format.columnWidth = [52, 330, 40, 75, 70, 90][i]; });
    sh.getRange(`B1:B${end}`).format.wrapText = true;
    sh.getRange(`D5:D${end}`).numberFormat = Array(end - 4).fill(['#,##0.00']);
    sh.getRange(`E5:F${end}`).numberFormat = Array(end - 4).fill(['#,##0.00', '#,##0.00']);
    kinds.forEach((k, i) => {
      const row = sh.getRange(`A${i + 1}:F${i + 1}`);
      if (k === 'title') row.format.font.set({ bold: true, size: 13, color: '#0a5082' });
      if (k === 'sub') row.format.font.set({ italic: true, color: '#5b6670' });
      if (k === 'head') { row.format.fill.color = '#0a5082'; row.format.font.set({ bold: true, color: '#FFFFFF' }); }
      if (k === 'heading') row.format.font.set({ bold: true, underline: Excel.RangeUnderlineStyle.single });
      if (k === 'item') { sh.getRange(`E${i + 1}`).format.fill.color = '#FFF2CC'; sh.getRange(`E${i + 1}`).format.font.color = '#0000FF'; }
      if (k === 'total') { row.format.font.bold = true; row.format.fill.color = '#E2E8EE'; }
    });
    const B = Excel.BorderIndex;
    [B.edgeTop, B.edgeBottom, B.edgeLeft, B.edgeRight, B.insideVertical, B.insideHorizontal].forEach(ed => { const bd = sh.getRange(`A4:F${end}`).format.borders.getItem(ed); bd.style = 'Continuous'; bd.color = '#BFBFBF'; });
    sh.getRange('A:A').format.verticalAlignment = 'Top'; sh.getRange('B:B').format.verticalAlignment = 'Top';
    sh.freezePanes.freezeRows(4);
    sh.activate(); sh.getRange('A5').select();
    await ctx.sync();
  });
}

// ================================================================== measured status and Excel <-> 3D
export async function rowsById() {
  if (S.rowsById) return S.rowsById;
  S.rowsById = new Map();
  if (!S.inExcel) return S.rowsById;
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItemOrNullObject(SHEET); await ctx.sync();
    if (sh.isNullObject) return;
    const used = sh.getUsedRangeOrNullObject(true); used.load('rowCount,rowIndex'); await ctx.sync();
    if (used.isNullObject) return;
    const r = sh.getRange(`A1:B${used.rowIndex + used.rowCount + 5}`); r.load('values'); await ctx.sync();
    r.values.forEach(([a, v], i) => { if (typeof v === 'number' && S.byId.has(v) && /^G\d+\.\d+$/.test(String(a))) { if (!S.rowsById.has(v)) S.rowsById.set(v, []); S.rowsById.get(v).push(i + 1); } });
  }).catch(() => {});
  return S.rowsById;
}
export async function loadMeasured() {
  if (!S.inExcel) {
    S.measured = new Map(); S.takeoff.forEach(g => g.ids.forEach(id => S.measured.set(id, (S.measured.get(id) || 0) + 1)));
    return S.measured;
  }
  S.rowsById = null;
  const m = await rowsById();
  S.measured = new Map([...m].map(([id, rows]) => [id, rows.length]));
  return S.measured;
}
export async function goToRows(ids) {
  const map = await rowsById();
  const rows = ids.flatMap(id => map.get(id) || []).slice(0, 80);
  if (!rows.length) return;
  S.quiet = Date.now();
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItem(SHEET); sh.activate();
    sh.getRanges(rows.map(r => `A${r}:G${r}`).join(',')).select(); await ctx.sync();
  }).catch(() => {});
}
export async function onExcelSelect(ev) {
  if (!S.data || Date.now() - S.quiet < 800) return;
  try {
    await Excel.run(async (ctx) => {
      const sh = ctx.workbook.worksheets.getItem(ev.worksheetId);
      sh.load('name'); const rng = sh.getRange(ev.address); rng.load('rowIndex,rowCount'); await ctx.sync();
      if (sh.name !== SHEET) return;
      const first = rng.rowIndex + 1, last = Math.min(rng.rowIndex + rng.rowCount, first + 5000);
      const v = sh.getRange(`A${first}:B${last}`); v.load('values'); await ctx.sync();
      const ids = new Set();
      v.values.forEach(([, b]) => { if (typeof b === 'number' && S.byId.has(b)) ids.add(b); });
      if (!ids.size && /^G\d+$/.test(String(v.values[0][0]))) {
        const blk = sh.getRange(`A${first}:B${first + 5000}`); blk.load('values'); await ctx.sync();
        for (const [a, b] of blk.values.slice(1)) {
          if (/^G\d+$/.test(String(a))) break;
          if (typeof b === 'number' && S.byId.has(b)) ids.add(b);
        }
      }
      if (!ids.size) return;
      S.ticked = ids; update(); App.viewer?.()?.fit([...ids].filter(id => App.viewer().hasGeometry(id)));
      status(`${ids.size} element${ids.size > 1 ? 's' : ''} highlighted from Excel.`);
    });
  } catch { /* other sheets are ignored */ }
}
export async function selectFromExcel() {
  if (!S.data) { status('Open a model first.', 'bad'); return; }
  await Excel.run(async (ctx) => {
    const r = ctx.workbook.getSelectedRange(); r.load('address'); const sh = ctx.workbook.worksheets.getActiveWorksheet(); sh.load('id');
    await ctx.sync();
    S.quiet = 0; await onExcelSelect({ worksheetId: sh.id, address: r.address.split('!').pop() });
  });
}

export function initExcel() {
  Object.assign(App, { addToExcel, addToList, saveTakeoff, goToRows, loadMeasured, readGroups, selectFromExcel });
}
