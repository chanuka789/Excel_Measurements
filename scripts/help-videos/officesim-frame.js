// Minimal in-browser simulation of the Office.js Excel API used by the add-in (for automated tests).
// Cells hold values or formulas; formulas are evaluated on read (SUBTOTAL ignores nested SUBTOTALs),
// row insert/delete shifts cells and updates references and named ranges like Excel does.
(function () {
  const colN = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const colL = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
  let nextId = 1;
  const WB = { sheets: [], names: new Map(), active: null, selection: null, log: [], cache: new Map() };
  const dirty = () => WB.cache.clear();
  window.__wb = WB;
  const sheetByName = (n) => WB.sheets.find(s => s.name.toLowerCase() === String(n).toLowerCase());
  function newSheet(name) { WB.cache?.clear(); const s = { name, id: '{s' + nextId++ + '}', cells: new Map(), visibility: 'Visible', shapes: [] }; WB.sheets.push(s); if (!WB.active) WB.active = s; return s; }
  const key = (r, c) => r + ',' + c;
  function parseAddr(a) {
    a = String(a).replace(/\$/g, '').replace(/^'?[^'!]*'?!/, '');
    let m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a);
    if (m) return { r0: +m[2] - 1, c0: colN(m[1]), r1: +(m[4] || m[2]) - 1, c1: colN(m[3] || m[1]) };
    m = /^(\d+):(\d+)$/.exec(a); if (m) return { r0: +m[1] - 1, r1: +m[2] - 1, c0: 0, c1: 16383, rows: true };
    m = /^([A-Z]+):([A-Z]+)$/.exec(a); if (m) return { r0: 0, r1: 1048575, c0: colN(m[1]), c1: colN(m[2]), cols: true };
    throw new Error('bad address ' + a);
  }
  // ------------------------------------------------------------ formulas
  const REF = /(?:'([^']+)'|([A-Za-z_][\w.]*))?(!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?/g;
  function evalCell(sh, r, c, stack = new Set()) {
    const cell = sh.cells.get(key(r, c)); if (!cell) return '';
    if (cell.f == null) return cell.v ?? '';
    const k = sh.name + key(r, c); if (WB.cache.has(k)) return WB.cache.get(k); if (stack.has(k)) return '#CIRC'; stack.add(k);
    let v; try { v = evalFormula(sh, cell.f, stack); } catch (e) { v = '#ERR:' + e.message; } stack.delete(k); WB.cache.set(k, v); return v;
  }
  function evalFormula(sh, f, stack) {
    let src = String(f).replace(/^=/, '');
    // named ranges
    for (const [n, def] of WB.names) src = src.replace(new RegExp('\\b' + n + '\\b', 'g'), '(' + def.formula.replace(/^=/, '') + ')');
    const strs = []; src = src.replace(/"((?:[^"]|"")*)"/g, (m, s) => { strs.push(s.replace(/""/g, '"')); return `__S${strs.length - 1}__`; });
    const colSheets = [];
    // whole-column references ('Sheet'!$K:$K)
    src = src.replace(/(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!\$?([A-Z]{1,3}):\$?([A-Z]{1,3})\b/g, (m, q, bare, c1, c2) => {
      const target = sheetByName((q || bare).replace(/''/g, "'")); if (!target) return 'NaN';
      colSheets.push(target.name); return `COLR(${colSheets.length - 1},${colN(c1)})`;
    });
    src = src.replace(REF, (m, q, bare, bang, d1, c1, e1, r1, d2, c2, e2, r2) => {
      let sheetName = sh.name;
      if (bang) sheetName = q || bare; else if (bare) return m;              // a function or name, not a ref
      const target = sheetByName(sheetName); if (!target) return 'NaN';
      if (c2) return `R(${JSON.stringify(target.name)},${+r1 - 1},${colN(c1)},${+r2 - 1},${colN(c2)})`;
      return `C(${JSON.stringify(target.name)},${+r1 - 1},${colN(c1)})`;
    });
    src = src.replace(/<>/g, '!=').replace(/(?<![<>=!])=(?!=)/g, '==');
    src = src.replace(/\bSUBTOTAL\(\s*9\s*,/g, 'SUBTOTAL9(');
    const C = (n, r, c) => { const v = evalCell(sheetByName(n), r, c, stack); return v === '' ? '' : v; };
    const R = (n, r0, c0, r1, c1) => { const s = sheetByName(n), out = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const cell = s.cells.get(key(r, c)); out.push({ v: evalCell(s, r, c, stack), sub: /SUBTOTAL/i.test(cell?.f || '') }); } return out; };
    const COLR = (n, c) => { const s = sheetByName(colSheets[n]), u = used(s), out = []; if (!u) return out; for (let r = 0; r <= u.r1; r++) out.push({ v: evalCell(s, r, c, stack) }); return out; };
    const match = (v, cr) => {
      let c = cr, op = '=';
      if (typeof c === 'string') { const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c); op = m[1] || '='; c = m[2]; }
      if (op !== '=' && op !== '<>') { const a = Number(v), b = Number(c); return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b; }
      let ok;
      if (typeof c === 'number') ok = v === c;
      else if (c === '') ok = v === '' || v == null;
      else { const re = new RegExp('^' + String(c).replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (m, esc1, wild, sp) => esc1 ? '\\' + esc1 : wild ? (wild === '*' ? '[\\s\\S]*' : '.') : '\\' + sp) + '$', 'i'); ok = re.test(String(v)); }
      return op === '<>' ? !ok : ok;
    };
    const SUMIFS = (sum, ...pairs) => { let t = 0; for (let i = 0; i < sum.length; i++) { let ok = true; for (let k = 0; k < pairs.length; k += 2) { const cr = pairs[k + 1]; const crv = Array.isArray(cr) ? cr[0].v : cr; if (!match(pairs[k][i]?.v ?? '', crv)) { ok = false; break; } } if (ok && typeof sum[i].v === 'number') t += sum[i].v; } return t; };
    const flat = (a) => a.flatMap(x => Array.isArray(x) ? x.map(y => y.v) : [x]);
    const num = (v) => typeof v === 'number' ? v : 0;
    const F = {
      SUM: (...a) => flat(a).reduce((s, v) => s + num(v), 0),
      SUBTOTAL9: (arr) => arr.filter(x => !x.sub).reduce((s, x) => s + num(x.v), 0),
      MAX: (...a) => Math.max(...flat(a).map(num)), MIN: (...a) => Math.min(...flat(a).map(num)), ABS: Math.abs, SQRT: Math.sqrt, PI: () => Math.PI,
      ROUND: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n, IF: (c, a, b) => (c ? a : b), SUMIFS,
    };
    const js = src.replace(/\b(SUMIFS|SUM|SUBTOTAL9|MAX|MIN|ABS|SQRT|PI|ROUND|IF)\(/g, 'F.$1(').replace(/__S(\d+)__/g, (m, i) => JSON.stringify(strs[+i]));
    // eslint-disable-next-line no-new-func
    const v = new Function('C', 'R', 'F', 'COLR', '"use strict"; return (' + js + ');')(C, R, F, COLR);
    return typeof v === 'number' && !Number.isFinite(v) ? '#NUM' : v;
  }
  function shiftRefs(text, sheetName, at, n, isFormulaOnOther) {
    // shift row numbers >= at (0-based) by n; n < 0 deletes rows at..at-n-1
    return text.replace(REF, (m, q, bare, bang, d1, c1, e1, r1, d2, c2, e2, r2) => {
      if (!bang && bare) return m;
      const target = bang ? (q || bare) : null;
      if (bang ? String(target).toLowerCase() !== sheetName.toLowerCase() : isFormulaOnOther) return m;
      const fix = (r) => { r = +r; const z = r - 1; if (n > 0) return z >= at ? r + n : r; const delEnd = at - n - 1; if (z > delEnd) return r + n; if (z >= at) return '#REF'; return r; };
      const pre = bang ? (q ? `'${q}'!` : `${bare}!`) : '';
      return `${pre}${d1}${c1}${e1}${fix(r1)}${c2 ? `:${d2}${c2}${e2}${fix(r2)}` : ''}`;
    });
  }
  function moveRows(sh, at, n) {
    dirty();
    const cells = new Map();
    for (const [k, v] of sh.cells) {
      const [r, c] = k.split(',').map(Number);
      if (n < 0 && r >= at && r < at - n) continue;
      const nr = r >= at ? r + n : r;
      cells.set(key(nr, c), v);
    }
    sh.cells = cells;
    for (const s of WB.sheets) for (const cell of s.cells.values()) if (cell.f) cell.f = shiftRefs(cell.f, sh.name, at, n, s !== sh);
    for (const def of WB.names.values()) def.formula = shiftRefs(def.formula, sh.name, at, n, true);
  }
  // ------------------------------------------------------------ proxies for "anything else" (format, borders…)
  const any = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : any(), set: () => true, apply: () => any() });
  class Range {
    constructor(sh, a) { this.sh = sh; Object.assign(this, typeof a === 'string' ? parseAddr(a) : a); this.format = any(); }
    get address() { return `${this.sh.name}!${colL(this.c0)}${this.r0 + 1}:${colL(this.c1)}${this.r1 + 1}`; }
    get rowIndex() { return this.r0; } get columnIndex() { return this.c0; } get rowCount() { return this.r1 - this.r0 + 1; } get columnCount() { return this.c1 - this.c0 + 1; }
    get values() { const out = []; for (let r = this.r0; r <= this.r1; r++) { const row = []; for (let c = this.c0; c <= this.c1; c++) row.push(evalCell(this.sh, r, c)); out.push(row); } return out; }
    set values(v) { this.write(v, false); }
    get formulas() { const out = []; for (let r = this.r0; r <= this.r1; r++) { const row = []; for (let c = this.c0; c <= this.c1; c++) { const x = this.sh.cells.get(key(r, c)); row.push(x ? (x.f ?? x.v) : ''); } out.push(row); } return out; }
    set formulas(v) { this.write(v, true); }
    write(v, asFormula) {
      dirty();
      const rows = Array.isArray(v[0]) ? v : [[v]];
      if (rows.length !== this.rowCount || rows[0].length !== this.columnCount) throw new Error(`Range size ${this.rowCount}x${this.columnCount} does not match data ${rows.length}x${rows[0].length}`);
      rows.forEach((row, i) => row.forEach((x, j) => {
        const k = key(this.r0 + i, this.c0 + j);
        if (x === '' || x == null) this.sh.cells.delete(k);
        else if (typeof x === 'string' && x.startsWith("'")) this.sh.cells.set(k, { v: x.slice(1) });   // Excel text prefix
        else if (typeof x === 'string' && x.startsWith('=')) this.sh.cells.set(k, { f: x });
        else this.sh.cells.set(k, { v: x });
      }));
    }
    set numberFormat(v) { /* ignored */ } get numberFormat() { return [[]]; }
    load() { return this; } select() { WB.selection = this; WB.active = this.sh; }
    insert() { if (!this.rows) throw new Error('only row insert supported'); moveRows(this.sh, this.r0, this.rowCount); }
    delete() { if (!this.rows) throw new Error('only row delete supported'); moveRows(this.sh, this.r0, -this.rowCount); }
    clear() { dirty(); for (let r = this.r0; r <= Math.min(this.r1, 100000); r++) for (let c = this.c0; c <= Math.min(this.c1, 200); c++) this.sh.cells.delete(key(r, c)); }
  }
  function used(sh) {
    let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
    for (const k of sh.cells.keys()) { const [r, c] = k.split(',').map(Number); r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    return r1 < 0 ? null : new Range(sh, { r0, r1, c0, c1 });
  }
  const nullObj = { isNullObject: true, load() { return this; } };
  function wsApi(sh) {
    return {
      get name() { return sh.name; }, get id() { return sh.id; }, isNullObject: false,
      get visibility() { return sh.visibility; }, set visibility(v) { sh.visibility = v; },
      getRange: (a = 'A1') => new Range(sh, a),
      getRangeByIndexes: (r, c, rc, cc) => new Range(sh, { r0: r, c0: c, r1: r + rc - 1, c1: c + cc - 1 }),
      getRanges: (list) => ({ select() { WB.selection = list; WB.active = sh; } }),
      getUsedRange: () => used(sh) || new Range(sh, 'A1'),
      getUsedRangeOrNullObject: () => { const u = used(sh); return u ? Object.assign(u, { isNullObject: false }) : nullObj; },
      activate() { WB.active = sh; }, delete() { dirty(); WB.sheets.splice(WB.sheets.indexOf(sh), 1); if (WB.active === sh) WB.active = WB.sheets[0]; },
      load() { return this; },
      freezePanes: { freezeRows() {} },
      shapes: { addImage: (b64) => { const s = { b64: b64.length, width: 800, lockAspectRatio: true, name: '' }; sh.shapes.push(s); return s; } },
      onSelectionChanged: { add(h) { (WB.selHandlers ||= []).push(h); } },
    };
  }
  const ctx = {
    workbook: {
      worksheets: {
        add: (name) => wsApi(newSheet(name)),
        getItem: (n) => { const s = sheetByName(n) || WB.sheets.find(x => x.id === n); if (!s) throw new Error('no sheet ' + n); return wsApi(s); },
        getItemOrNullObject: (n) => { const s = sheetByName(n); return s ? wsApi(s) : nullObj; },
        getActiveWorksheet: () => wsApi(WB.active || newSheet('Sheet1')),
        onSelectionChanged: { add(h) { (WB.selHandlers ||= []).push(h); } },
        load() { return this; },
        get items() { return WB.sheets.map(wsApi); },
      },
      names: {
        load() { return this; },
        get items() { return [...WB.names.keys()].map(name => ({ name })); },
        add: (name, range, comment) => { dirty(); WB.names.set(name, { formula: `='${range.sh.name}'!$${colL(range.c0)}$${range.r0 + 1}`, comment }); },
        getItemOrNullObject: (n) => {
          const d = WB.names.get(n); if (!d) return nullObj;
          return { isNullObject: false, get formula() { return d.formula; }, set formula(v) { dirty(); d.formula = v; }, delete() { WB.names.delete(n); } };
        },
      },
      getSelectedRange: () => (WB.selection instanceof Range ? WB.selection : new Range(WB.active, 'A1')),
    },
    sync: async () => {},
  };
  window.Excel = {
    run: async (cb) => cb(ctx),
    BorderIndex: { edgeTop: 1, edgeBottom: 2, edgeLeft: 3, edgeRight: 4, insideHorizontal: 5, insideVertical: 6 },
    SheetVisibility: { veryHidden: 'VeryHidden' }, InsertShiftDirection: { down: 'Down' }, DeleteShiftDirection: { up: 'Up' },
    ClearApplyTo: { all: 'All' }, RangeUnderlineStyle: { single: 'Single' },
  };
  window.__assoc = {};
  // harness hook: the user clicks cells in the (drawn) worksheet -> select the range and tell the add-in, like Excel does
  window.__selectRange = async (address, sheetName) => {
    const sh = (sheetName && sheetByName(sheetName)) || WB.active; WB.active = sh; WB.selection = new Range(sh, address);
    for (const h of WB.selHandlers || []) await h({ worksheetId: sh.id, address });
  };
  // dialogs: the child opens without an opener (like an Office dialog) and talks through a BroadcastChannel
  const bc = new BroadcastChannel('officesim-dialog');
  const ui = {
    displayDialogAsync(url, opts, cb) {
      window.__lastDialog = { url, opts }; window.__dialogs = (window.__dialogs || 0) + 1;
      window.open(url, '_blank');      // like Excel on the web: the dialog has an opener (Excel), not the pane
      const handlers = {};
      bc.addEventListener('message', (ev) => { if (ev.data.to === 'parent' && ev.data.url === url) handlers.m?.({ message: ev.data.msg }); });
      cb({ status: 'succeeded', value: { addEventHandler: (t, h) => { handlers[t] = h; }, messageChild: (m) => bc.postMessage({ to: 'child', url, msg: m }), close: () => bc.postMessage({ to: 'child', url, close: true }) } });
    },
  };
  if (/viewer\.html/.test(location.pathname) && /dlg=/.test(location.search + location.hash)) {
    const me = location.href;
    ui.messageParent = (m) => bc.postMessage({ to: 'parent', url: me, msg: m });
    ui.addHandlerAsync = (t, h) => bc.addEventListener('message', (ev) => { if (ev.data.to !== 'child' || ev.data.url !== me) return; if (ev.data.close) window.close(); else h({ message: ev.data.msg }); });
  }
  window.Office = { HostType: { Excel: 'Excel' }, AsyncResultStatus: { Succeeded: 'succeeded' }, EventType: { OfficeThemeChanged: 'x', DialogMessageReceived: 'm', DialogEventReceived: 'e', DialogParentMessageReceived: 'p' }, onReady: () => Promise.resolve({ host: 'Excel' }),
    actions: { associate: (n, f) => { window.__assoc[n] = f; } }, addin: { showAsTaskpane: async () => {} },
    context: { officeTheme: { bodyBackgroundColor: '#ffffff' }, document: { addHandlerAsync: () => {} }, ui } };
  window.__sheet = (name) => { const s = sheetByName(name); if (!s) return null; const u = used(s); return u ? new Range(s, { r0: 0, c0: 0, r1: u.r1, c1: u.c1 }).values : []; };
})();
