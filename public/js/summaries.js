// Excel summaries built only from formulas (no pasted numbers), so they follow every change in the take-off:
//   Quantities       one row per measured item, take-off group and level (or zone): SUMIFS over the Take-off sheet
//   Summary          pivot-style table: items down, levels (or zones) across, totals; SUMIFS over Quantities
//   NRM2 / POMI ...  quantities by work section in rule order, with rates and amounts
//   NRM1 Elemental   elemental cost plan: items under NRM1 elements, rates, allowances, cost per m2 GIFA
//   custom sheets    built from a sheet definition (the AI writes these on request), formulas checked first
// Pure builders: they return a layout { name, rows, kinds, ... } that excel.js writes with the formatting standard.
import { RULE_SETS, NRM1, nrm1Name } from './rules.js';
import { unitFmt } from './engine.js';

export const QSHEET = 'Quantities', SUMMARY = 'Summary', NRM1SHEET = 'NRM1 Elemental';
export const setSheet = (set) => `${set} Summary`;
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

/** A stable code for one measured item: rule set, rule key and the column heading. */
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
  const head = ['Code', 'Rule set', 'Work section', 'Description', 'Rule ref', 'NRM1 element', 'Take-off group', 'Level', 'Zone', 'Unit', 'Quantity', 'Check'];
  const rows = [['QUANTITIES REGISTER'], [`Every quantity is a SUMIFS formula over the ${TAKEOFF} sheet (rows of each group by ${by === 'none' ? 'group' : by}). Summary sheets read this register. Rebuild after adding tables.`], [], head];
  const kinds = ['title', 'note', 'blank', 'head'];
  entries.forEach(e => { rows.push([e.code, e.set, e.section, e.desc, e.ref, e.nrm1, e.group, e.level, e.zone, e.unit, e.formula, e.confirm ? 'Confirm the rule against your RICS copy' : '']); kinds.push('item'); });
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
  const head = ['Code', 'Description', 'Rule ref', 'Unit', ...vals, 'Total'];
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

/** NRM2 or POMI summary: items by work section, with rates (kept between rebuilds) and amounts. */
export function buildRuleSummary(entries, set, { keep = new Map() } = {}) {
  const rows = [[`${set} QUANTITY SUMMARY`], [`${RULE_SETS[set]?.full || set}. Quantities link to the ${QSHEET} register. Yellow rates are yours; amounts are formulas.`], [],
    ['Code', 'Item', 'Description', 'Rule ref', 'Unit', 'Quantity', 'Rate', 'Amount', 'Note']];
  const kinds = ['title', 'note', 'blank', 'head'], units = [null, null, null, null], inputs = [], totals = [];
  const items = itemsOf(entries, e => e.set === set || !e.set || e.set === 'X');
  const sections = [...new Set(items.map(i => (i.set === set ? i.section : 'Other measured items')))];
  sections.forEach((sec, si) => {
    rows.push(['', `${si + 1}`, sec.toUpperCase()]); kinds.push('section'); units.push(null);
    const first = rows.length + 1; let n = 0;
    items.filter(i => (i.set === set ? i.section : 'Other measured items') === sec).forEach(it => {
      const r = rows.length + 1;
      rows.push([it.code, `${si + 1}.${++n}`, it.desc, it.ref, it.unit, `=SUMIFS(${QQ},${QA},$A${r})`, keep.get(it.code) ?? '', `=IF(G${r}="","",F${r}*G${r})`,
        it.confirm ? 'Confirm the rule against your RICS copy' : '']);
      kinds.push('item'); units.push(it.unit); inputs.push([r, 6]);
    });
    const last = rows.length;
    rows.push(['', '', `Total ${sec.toLowerCase()}`, '', '', '', '', `=SUM(H${first}:H${last})`]); kinds.push('subtotal'); units.push(null);
    totals.push(`H${rows.length}`);
  });
  rows.push(['', '', 'TOTAL', '', '', '', '', totals.length ? `=${totals.join('+')}` : 0]); kinds.push('total'); units.push(null);
  return { name: setSheet(set), rows, kinds, headRow: 4, hidden: [0], inputs, keepCol: 6, widths: [70, 40, 300, 90, 40, 85, 70, 95, 180],
    numFmt: (r, c) => (kinds[r] === 'item' && c === 5 ? unitFmt(units[r]) : (c === 6 || c === 7) && kinds[r] !== 'head' ? '#,##0.00' : null) };
}

/** NRM1 elemental cost plan. keep: Map(rowKey -> value) for rates, allowances and GIFA kept between rebuilds. */
export function buildNrm1(entries, { keep = new Map(), gifa = null } = {}) {
  const GIFA = '$E$4';
  const rows = [['ELEMENTAL SUMMARY (NRM1)'], ['RICS NRM1 3rd edition elements. Measured items link to the Quantities register. Yellow cells (GIFA, rates, allowances) are yours. Check element codes against your RICS copy.'], [],
    ['GIFA', '', 'Gross internal floor area (RICS Code of Measuring Practice)', 'm2', keep.get('GIFA') ?? gifa ?? ''], [],
    ['Code', 'NRM1', 'Element / item', 'Unit', 'Quantity', 'Rate', 'Total', 'Cost per m2 GIFA', '% of total']];
  const kinds = ['title', 'note', 'blank', 'gifa', 'blank', 'head'], units = Array(6).fill(null), inputs = [[4, 4]];
  const grand = [], pct = [];
  const per = (r) => `=IF(${GIFA}>0,G${r}/${GIFA},"")`;
  for (const grp of NRM1) {
    rows.push(['', grp.code, grp.name.toUpperCase()]); kinds.push('group'); units.push(null);
    const elements = grp.kids?.length ? grp.kids : [[grp.code, grp.name]];
    const elTotals = [];
    for (const [code, name] of elements) {
      if (grp.kids?.length) { rows.push(['', code, name]); kinds.push('section'); units.push(null); }
      const first = rows.length + 1;
      itemsOf(entries, e => e.nrm1 === code || e.nrm1.startsWith(code + '.')).forEach(it => {
        const r = rows.length + 1, k = `${it.code}@${code}`;
        rows.push([k, '', `${it.desc}${it.ref ? ` (${it.ref})` : ''}`, it.unit, `=SUMIFS(${QQ},${QA},${qt(it.code)},${sheetRef(QSHEET)}!$F:$F,${crit(code)})${entries.some(e => e.code === it.code && e.nrm1.startsWith(code + '.')) ? `+SUMIFS(${QQ},${QA},${qt(it.code)},${sheetRef(QSHEET)}!$F:$F,${qt(code + '.*')})` : ''}`, keep.get(k) ?? '',
          `=IF(F${r}="",0,E${r}*F${r})`, per(r)]);
        kinds.push('item'); units.push(it.unit); inputs.push([r, 5]); pct.push(r);
      });
      const ar = rows.length + 1, ak = `ALLOW@${code}`;
      rows.push([ak, '', 'Other items and allowances (not measured from the model)', 'item', '', '', keep.get(ak) ?? 0, per(ar)]);
      kinds.push('allow'); units.push(null); inputs.push([ar, 6]); pct.push(ar);
      const tr = rows.length + 1;
      rows.push(['', '', `Total ${code} ${name}`, '', '', '', `=SUM(G${first}:G${tr - 1})`, per(tr)]); kinds.push('subtotal'); units.push(null); pct.push(tr);
      elTotals.push(`G${tr}`);
    }
    if (grp.kids?.length) {
      const r = rows.length + 1;
      rows.push(['', '', `Total ${grp.code} ${grp.name}`, '', '', '', `=${elTotals.join('+')}`, per(r)]); kinds.push('subtotal'); units.push(null); pct.push(r);
      grand.push(`G${r}`);
    } else grand.push(...elTotals);
  }
  const gr = rows.length + 1;
  rows.push(['', '', 'TOTAL COST ESTIMATE', '', '', '', `=${grand.join('+')}`, per(gr), 1]); kinds.push('total'); units.push(null);
  pct.forEach(r => { rows[r - 1][8] = `=IF($G$${gr}=0,"",G${r}/$G$${gr})`; });
  return { name: NRM1SHEET, rows, kinds, headRow: 6, hidden: [0], inputs, widths: [70, 45, 330, 40, 85, 70, 100, 90, 60],
    numFmt: (r, c) => (kinds[r] === 'item' && c === 4 ? unitFmt(units[r]) : c >= 5 && c <= 7 && kinds[r] !== 'head' ? '#,##0.00' : c === 8 && kinds[r] !== 'head' ? '0.0%' : null) };
}
export const nrm1Label = (code) => `${code} ${nrm1Name(code)}`;

// ------------------------------------------------------------------ custom sheets (AI "new sheet")
const BLOCKED = /\b(WEBSERVICE|FILTERXML|HYPERLINK|CALL|REGISTER|EXEC|INDIRECT|RTD|IMPORTDATA|CUBE\w*|INFO)\s*\(|\[|\bDDE\b|^=\s*cmd/i;
const RESERVED = new Set([QSHEET, SUMMARY, NRM1SHEET, TAKEOFF, '_dwfx', 'BOQ', 'Change log'].map(s => s.toLowerCase()));
/**
 * def: { name, title, note, columns: [{ head, width, format }], rows: [{ style, cells: [] }] }
 * Formula helpers: QTY("item code" [, "level"]) and QTYD("description text" [, "unit"]) read the Quantities register;
 * TOTAL("G3", "FW") is the named total of a take-off column. Row 1 of "rows" is Excel row 5.
 */
export function buildCustom(def, { names = new Set() } = {}) {
  const name = String(def?.name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  if (!name) throw new Error('The new sheet needs a name.');
  if (RESERVED.has(name.toLowerCase()) || /^(NRM2|POMI) Summary$/i.test(name)) throw new Error(`"${name}" is a sheet the add-in manages. Choose another name.`);
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
