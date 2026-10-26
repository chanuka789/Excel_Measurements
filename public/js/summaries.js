// Excel summaries built only from formulas (no pasted numbers), so they follow every change in the take-off:
//   Quantities       one row per measured item, take-off group and level (or zone): SUMIFS over the Take-off sheet
//   Summary          pivot-style table: items down, levels (or zones) across, totals; SUMIFS over Quantities
//   custom sheets    built from a sheet definition (the AI writes these on request), formulas checked first
// Pure builders: they return a layout { name, rows, kinds, ... } that excel.js writes with the formatting standard.
import { unitFmt } from './engine.js';

export const QSHEET = 'Quantities', SUMMARY = 'Summary';
export const colL = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
const qt = (s) => '"' + String(s).replace(/"/g, '""') + '"';
/** SUMIFS criterion for an exact text match (wildcards escaped; "=" alone matches blank cells). */
export const crit = (v) => qt('=' + String(v ?? '').replace(/[~*?]/g, m => '~' + m));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
const sheetRef = (name) => `'${String(name).replace(/'/g, "''")}'`;
export const TAKEOFF = 'Take-off';

/** Formatting standard used by every sheet the add-in writes. */
export const STYLE = {
  font: 'Arial', size: 9, color: '#1d2730', grid: '#BFBFBF',
  title: { bold: true, size: 13, color: '#0a5082' }, note: { italic: true, color: '#5b6670' },
  head: { fill: '#0a5082', color: '#FFFFFF', bold: true }, section: { fill: '#D9E6F2', bold: true },
  group: { fill: '#0a5082', color: '#FFFFFF', bold: true },
  input: { fill: '#FFF2CC', color: '#0000FF' }, subtotal: { fill: '#F2F2F2', bold: true }, total: { fill: '#E2E8EE', bold: true },
};

const SECTION_ORDER = ['Piling', 'Concrete', 'Formwork', 'Reinforcement', 'Precast concrete', 'Structural steel', 'Waterproofing'];
const sectionRank = (s) => { const i = SECTION_ORDER.indexOf(s); return i < 0 ? 100 : i; };

/** A stable code for one measured item: its source, key and the column heading. */
export function itemCode(c) {
  const r = c.rule;
  return `${r?.set || 'X'}:${r?.key || ''}:${slug(`${c.label} ${c.unit}`)}`;
}

/** The columns of a take-off group that are measured items (not inputs that only feed a formula). */
export function registerColumns(g) {
  const m = g.meta?.method; if (!m) return [];
  const cols = [...(m.inputs || []), ...(m.formulas || [])];
  const fs = m.formulas || [];
  const used = (c) => fs.some(o => o !== c && String(o.expr).includes('{' + c.key + '}'));
  return cols.map((c, k) => ({ c, k })).filter(({ c }) => {
    if (c.rule) return true;
    if (fs.length) return fs.includes(c) && !used(c);
    return c.sum === true;
  }).map(({ c, k }) => ({ col: c, letter: colL((g.dataStart ?? 7) + k) }));
}

/**
 * Register rows. groups: from readGroups() (with meta, dataStart, levelCol, zoneCol, levels, zones).
 * by: 'level' | 'zone' | 'none'. Returns { layout, entries }.
 */
export function buildRegister(groups, { by = 'level' } = {}) {
  const T = sheetRef(TAKEOFF);
  const entries = [], skipped = [];
  for (const g of groups) {
    const picks = registerColumns(g);
    if (!picks.length) { skipped.push(g.ref); continue; }
    const bcol = by === 'level' ? g.levelCol : by === 'zone' ? g.zoneCol : -1;
    const values = bcol >= 0 ? [...(by === 'level' ? g.levels : g.zones || [])].sort() : [null];
    for (const { col, letter } of picks) {
      const r = col.rule || {};
      for (const v of values) {
        const base = `SUMIFS(${T}!$${letter}:$${letter},${T}!$A:$A,${qt(g.ref + '.*')}`;
        const f = v == null ? `=${base})` : `=${base},${T}!$${colL(bcol)}:$${colL(bcol)},${crit(v)})`;
        const label = v == null ? (by === 'none' ? '' : `(all ${by === 'zone' ? 'zones' : 'levels'})`) : (v || `(no ${by})`);
        entries.push({ code: itemCode(col), set: r.set || '', section: r.group || 'Other measured items', desc: col.label, ref: r.ref || '', nrm1: r.nrm1 || '',
          group: `${g.ref} ${g.name}`, level: by === 'level' ? label : '', zone: by === 'zone' ? label : '', unit: col.unit || '', confirm: Boolean(r.confirm), formula: f });
      }
    }
  }
  const head = ['Code', 'Source', 'Section', 'Description', 'Ref', 'Element', 'Take-off group', 'Level', 'Zone', 'Unit', 'Quantity', 'Check'];
  const rows = [['QUANTITIES REGISTER'], [`Every quantity is a SUMIFS formula over the ${TAKEOFF} sheet (rows of each group by ${by === 'none' ? 'group' : by}). Summary sheets read this register. Rebuild after adding tables.`], [], head];
  const kinds = ['title', 'note', 'blank', 'head'];
  entries.forEach(e => { rows.push([e.code, e.set, e.section, e.desc, e.ref, e.nrm1, e.group, e.level, e.zone, e.unit, e.formula, '']); kinds.push('item'); });
  if (!entries.length) { rows.push(['', '', '', 'No measured items yet: add take-off tables first.']); kinds.push('note'); }
  const units = entries.map(e => e.unit);
  return { entries, skipped, layout: { name: QSHEET, rows, kinds, headRow: 4, widths: [70, 50, 110, 260, 90, 55, 180, 90, 80, 40, 85, 160], hidden: [0],
    numFmt: (r, c) => (c === 10 && kinds[r] === 'item' ? unitFmt(units[r - 4]) : null) } };
}

/** Unique items in register order, grouped by work section. */
function itemsOf(entries, filter = () => true) {
  const map = new Map();
  entries.filter(filter).forEach(e => { if (!map.has(e.code)) map.set(e.code, { ...e }); });
  return [...map.values()].sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.section.localeCompare(b.section));
}
const QQ = `${sheetRef(QSHEET)}!$K:$K`, QA = `${sheetRef(QSHEET)}!$A:$A`;

/** Pivot-style summary: items down, levels (or zones) across. order: preferred column order (levels by height). */
export function buildSummary(entries, { by = 'level', order = [] } = {}) {
  const key = by === 'zone' ? 'zone' : 'level', QB = `${sheetRef(QSHEET)}!$${by === 'zone' ? 'I' : 'H'}:$${by === 'zone' ? 'I' : 'H'}`;
  const vals = by === 'none' ? [] : [...new Set(entries.map(e => e[key]).filter(Boolean))];
  const rank = (v) => { const i = order.indexOf(v); return i < 0 ? (v.startsWith('(') ? 1e6 : 1e5) : i; };
  vals.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const head = ['Code', 'Description', 'Ref', 'Unit', ...vals, 'Total'];
  const H = 4, rows = [['QUANTITY SUMMARY'], [`Totals by ${by === 'none' ? 'item' : by}. Every cell is SUMIFS over the ${QSHEET} sheet, so it follows the take-off.`], [], head];
  const kinds = ['title', 'note', 'blank', 'head'], units = [];
  let section = null;
  for (const it of itemsOf(entries)) {
    if (it.section !== section) { section = it.section; rows.push(['', section]); kinds.push('section'); units.push(null); }
    const r = rows.length + 1;
    rows.push([it.code, it.desc, it.ref, it.unit, ...vals.map((v, i) => `=SUMIFS(${QQ},${QA},$A${r},${QB},${colL(4 + i)}$${H})`), `=SUMIFS(${QQ},${QA},$A${r})`]);
    kinds.push('item'); units.push(it.unit);
  }
  if (rows.length === 4) { rows.push(['', 'No measured items yet.']); kinds.push('note'); units.push(null); }
  return { name: SUMMARY, rows, kinds, headRow: H, hidden: [0], widths: [70, 280, 90, 40, ...vals.map(() => 80), 90],
    numFmt: (r, c) => (kinds[r] === 'item' && c >= 4 ? unitFmt(units[r - 4]) : null) };
}

// ------------------------------------------------------------------ custom sheets (AI "new sheet")
const BLOCKED = /\b(WEBSERVICE|FILTERXML|HYPERLINK|CALL|REGISTER|EXEC|INDIRECT|RTD|IMPORTDATA|CUBE\w*|INFO)\s*\(|\[|\bDDE\b|^=\s*cmd/i;
const RESERVED = new Set([QSHEET, SUMMARY, TAKEOFF, '_dwfx', '_cxlinks', 'BOQ', 'Change log'].map(s => s.toLowerCase()));
/**
 * def: { name, title, note, columns: [{ head, width, format }], rows: [{ style, cells: [] }] }
 * Formula helpers: QTY("item code" [, "level"]) and QTYD("description text" [, "unit"]) read the Quantities register;
 * TOTAL("G3", "FW") is the named total of a take-off column. Row 1 of "rows" is Excel row 5.
 */
export function buildCustom(def, { names = new Set() } = {}) {
  const name = String(def?.name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  if (!name) throw new Error('The new sheet needs a name.');
  if (RESERVED.has(name.toLowerCase())) throw new Error(`"${name}" is a sheet the add-in manages. Choose another name.`);
  const cols = (def.columns || []).slice(0, 30);
  if (!cols.length) throw new Error('The new sheet needs at least one column.');
  const rowsIn = (def.rows || []).slice(0, 2000);
  const fix = (v) => {
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    const s = String(v ?? '');
    if (!s.startsWith('=')) return /^[+\-@]/.test(s) ? "'" + s : s;
    if (BLOCKED.test(s)) throw new Error(`This formula is not allowed in a generated sheet: ${s.slice(0, 80)}`);
    return s.replace(/\bQTY\(\s*("(?:[^"]|"")*")\s*(?:,\s*("(?:[^"]|"")*"))?\s*\)/g, (m, code, lev) =>
      `SUMIFS(${QQ},${QA},${code}${lev ? `,${sheetRef(QSHEET)}!$H:$H,${lev}` : ''})`)
      .replace(/\bQTYD\(\s*("(?:[^"]|"")*")\s*(?:,\s*("(?:[^"]|"")*"))?\s*\)/g, (m, d, u) =>
        `SUMIFS(${QQ},${sheetRef(QSHEET)}!$D:$D,${d}${u ? `,${sheetRef(QSHEET)}!$J:$J,${u}` : ''})`)
      .replace(/\bTOTAL\(\s*"(G\d+)"\s*,\s*"(\w+)"\s*\)/g, (m, ref, key) => {
        const n = `TO_${ref}_${key}`.replace(/[^A-Za-z0-9_]/g, '_');
        if (names.size && !names.has(n)) throw new Error(`There is no take-off total ${ref} ${key}.`);
        return n;
      });
  };
  const rows = [[String(def.title || name).slice(0, 200)], [String(def.note || 'Built by the add-in from your request. Formulas link to the take-off.').slice(0, 500)], [], cols.map(c => String(c.head || ''))];
  const kinds = ['title', 'note', 'blank', 'head'], inputs = [];
  rowsIn.forEach((r) => {
    const style = ['section', 'item', 'input', 'subtotal', 'total', 'note', 'blank'].includes(r.style) ? r.style : 'item';
    const cells = (r.cells || []).slice(0, cols.length).map(fix);
    rows.push(cells); kinds.push(style === 'input' ? 'item' : style);
    if (style === 'input') cells.forEach((c, i) => { if (typeof c === 'number' || c === '') inputs.push([rows.length, i]); });
    (r.inputs || []).forEach(i => { if (Number.isInteger(i) && i >= 0 && i < cols.length) inputs.push([rows.length, i]); });
  });
  return { name, rows, kinds, headRow: 4, inputs, widths: cols.map(c => Math.max(30, Math.min(400, Number(c.width) || 90))),
    numFmt: (r, c) => (kinds[r] !== 'head' && kinds[r] !== 'title' && kinds[r] !== 'note' && cols[c]?.format ? String(cols[c].format).slice(0, 40) : null) };
}
