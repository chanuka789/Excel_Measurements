// Every command of the measurement window's ribbon, in one place (CostX tabs: Home, Drawings, Dimensions, 3D View,
// Revisions, Workbooks). Each runs code that already exists in the drawing take-off (takeoff2d.js / tkextras.js), the 3D
// view (viewer.js / vtools.js / takeoff3d.js) or the project tree (wtree.js); the right-click menus run the same code.
import * as G2 from './geom2d.js';

/** The ribbon layout: tabs → groups → items ('id' = large button, ['a', 'b', 'c'] = stack of small buttons). */
export const RIBBON_TABS = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Drawings', items: ['dwg.add', ['dwg.props', 'dwg.compare', 'dwg.manager']] },
    { label: 'View', items: [['lay.all', 'lay.invert', 'lay.file'], 'view.reset', ['view.rot90', 'view.ext', 'view.area']] },
    { label: 'Measuring', items: ['dg.add', ['dg.props', 'dg.export', 'dim.manual'], ['sign.pos', 'sign.neg', 'sign.both'], 'dim.measure'] },
    { label: 'Workbooks', items: ['xl.link', ['xl.follow', 'xl.links', 'xl.refresh']] },
    { label: 'Panes', items: [['pane.left', 'pane.side', 'pane.props']] },
  ] },
  { id: 'drawings', label: 'Drawings', groups: [
    { label: 'Drawing', items: ['dwg.add', 'dwg.props', ['dwg.manager', 'dwg.sets', 'dwg.pages']] },
    { label: 'Prepare', items: ['dwg.scale', 'prep.warea', ['cal.x', 'cal.y', 'cal.reset']] },
    { label: 'Layers', items: ['lay.panel', ['lay.hide', 'lay.invert', 'lay.file']] },
    { label: 'Position', items: [['pos.90', 'pos.180', 'pos.270'], 'view.reset', 'view.ext', ['view.area', 'view.in', 'view.out']] },
    { label: 'Display', items: ['disp.saveview', ['disp.text', 'disp.hatch', 'disp.weight'], ['disp.white', 'disp.mono', 'disp.markups']] },
    { label: 'Drawing Tools', items: ['tool.compare', 'tool.distance', 'tool.view3d', 'tool.cache', 'tool.picture'] },
  ] },
  { id: 'dims', label: 'Dimensions', groups: [
    { label: 'Dimension Group', items: ['dg.add', ['dg.props', 'dg.copy', 'dg.export'], ['dg.folder', 'dg.std', 'dg.delete']] },
    { label: 'BIM', items: ['bim.import', ['bim.maps', 'bim.check', 'bim.showall'], 'bim.schedule'] },
    { label: 'Dimension', items: ['dim.measure', ['dim.props', 'dim.copy', 'dim.paste'], ['dim.change', 'dim.selarea', 'dim.controls']] },
    { label: 'Type', items: ['type.points', 'type.faces', 'type.object'] },
    { label: 'Zones', items: ['zones.edit'] },
    { label: 'Snap', items: [['snap.geom', 'snap.angle']] },
    { label: 'Mode', items: ['mode.rebar', 'mode.autocount'] },
    { label: 'Show', items: [['show.overlaps', 'show.measured', 'show.all'], ['show.legend', 'show.labels', 'show.markups'], ['show.propsadd']] },
  ] },
  { id: '3d', label: '3D View', groups: [
    { label: 'View', items: ['3d.fit', '3d.views', ['3d.zoomarea', '3d.reset', '3d.ortho']] },
    { label: 'Objects', items: [['3d.isolate', '3d.hide', '3d.showall'], ['3d.box', '3d.clear', '3d.custom']] },
    { label: 'Cut', items: ['3d.section', '3d.plan'] },
    { label: 'Display', items: [['disp.shaded', 'disp.wire', 'disp.transparent'], ['disp.ghost', '3d.xray', '3d.edges'], '3d.colour'] },
    { label: 'Measure', items: ['3d.measure', ['type.points', 'type.faces', 'type.object']] },
    { label: 'Views', items: ['3d.saved', '3d.picture'] },
  ] },
  { id: 'rev', label: 'Revisions', groups: [
    { label: 'Compare', items: ['rev.drawings', 'rev.models', 'rev.off'] },
  ] },
  { id: 'xl', label: 'Workbooks', groups: [
    { label: 'Links', items: ['xl.link', ['xl.links', 'xl.refresh', 'xl.follow']] },
    { label: 'Schedules', items: ['dg.export', 'xl.folder'] },
    { label: 'DWFx quantities', items: ['xl.schedules'] },
  ] },
];

/** The File menu (left of the tabs). */
export function fileMenu(A) {
  return [{ label: 'Add Drawings...', disabled: !A.canEdit(), run: () => A.tree.addDrawings() },
    { label: 'Drawing Manager...', run: () => A.drawingManager() }, '-',
    { label: 'Open the DWFx Schedules window', run: () => A.openSchedules() },
    { label: 'Workbook View (linked cells)', run: () => A.showCTab('book') }, '-',
    { label: 'Help', run: () => window.open(new URL('help/index.html', location.href).href, '_blank') }, '-', { label: 'Close Menu' }];
}

/** A: the window's actions (see window.js). Returns the command registry. */
export function buildCommands(A) {
  const tk = () => A.tk();
  const has2d = () => Boolean(tk()?.W);
  const has3d = () => A.curTab() === '3d' && Boolean(A.V?.loaded);
  const view = () => has2d() || has3d();
  const ed = () => A.canEdit();
  const g = () => A.currentGroup();
  const need2d = (msg = 'Open a drawing first (double-click it in the Drawings tree).') => { if (!has2d()) { A.status(msg, 'warn'); return false; } return true; };
  const need3d = () => { if (!A.V?.loaded) { A.status('Open a 3D model first: double-click a model version in the Drawings tree.', 'warn'); return false; } A.showCTab('3d'); return true; };
  const pop = (k) => (btn) => { if (!need3d()) return; A.TB.act(k, btn || document.body); };
  const disp = (k) => ({ enabled: () => has2d() && (k === 'white' || tk().vector), checked: () => has2d() && Boolean(tk().disp[k]), run: () => tk().setDisplay(k) });
  const C = {};
  const def = (id, label, icon, run, more = {}) => { C[id] = { label, icon, run, ...more }; };

  // ---------------------------------------------------------------- drawings
  def('dwg.add', 'Add', 'add', () => A.tree.addDrawings(), { title: 'Add drawings (PDF, DWG, DXF, images…). They stay on this computer.', enabled: ed });
  def('dwg.props', 'Properties', 'props', () => tk().drawingProps(), { title: 'Drawing properties: scale and drawing multiplier', enabled: has2d });
  def('dwg.compare', 'Compare', 'compare', () => (tk().cmp ? tk().closeCompare() : tk().compareWith()), { title: 'Compare with another drawing as an overlay', enabled: has2d, checked: () => Boolean(tk()?.cmp) });
  def('dwg.manager', 'Manager', 'manager', () => A.drawingManager(), { title: 'Every drawing with its scale, multiplier, dimensions and where its file is' });
  def('dwg.sets', 'Drawing Sets', 'sets', () => A.drawingSets(), { title: 'Named lists of drawings: open them all at once' });
  def('dwg.pages', 'Page', 'pages', null, { title: 'Go to a page of this drawing', enabled: () => has2d() && tk().pages > 1,
    menu: () => Array.from({ length: Math.min(tk().pages, 60) }, (_, i) => ({ label: `Page ${i + 1}`, checked: tk().page === i + 1, run: () => tk().showPage(i + 1) })) });
  def('dwg.scale', 'Scale', 'scale', null, { title: 'Scale of this page: 1:N, Calibrate, or custom', enabled: () => has2d() && ed(),
    menu: () => { const t = tk(); return [...(t.paperMm ? G2.RATIOS.map(r => ({ label: `1:${r}`, checked: t.settings.pages[t.page]?.ratio === r, run: () => t.scaleChoice(String(r)) })) : []), '-',
      { label: 'Calibrate...', run: () => t.scaleChoice('cal') }, ...(t.paperMm ? [{ label: 'Custom 1:…', run: () => t.scaleChoice('custom') }] : [])]; } });
  def('prep.warea', 'Working Area', 'warea', null, { title: 'Show, snap and search only part of the drawing', enabled: has2d,
    menu: () => [{ label: 'Set Working Area', run: () => tk().setTool('warea') }, { label: 'Reset Working Area', disabled: !tk().areaHere(), run: () => tk().resetWorkingArea() }] });
  def('cal.x', 'Calibrate X Axis', 'calX', () => tk().calibrateAxis('x'), { title: 'Calibrate with a known horizontal length', enabled: () => has2d() && ed() });
  def('cal.y', 'Calibrate Y Axis', 'calY', () => tk().calibrateAxis('y'), { title: 'Calibrate Y separately (for a drawing stretched more one way)', enabled: () => has2d() && ed() && Boolean(tk().scale) });
  def('cal.reset', 'Reset Calibration', 'calReset', () => tk().resetCalibration(), { enabled: () => has2d() && ed() && Boolean(A.STORE.scaleOf(tk().dkey, tk().page)) });

  // ---------------------------------------------------------------- layers (drawing layers, or 3D categories)
  def('lay.panel', 'Layers', 'layers', () => A.tree.setTop('layers'), { title: 'Show the layers in the left pane', enabled: view });
  const layers = (f) => () => { f(); A.tree.setTop('layers'); };          // do it, then show the Layers tab with the result
  const src = () => { const t = tk(); if (t) return { all: (on) => { t.layerList().forEach(l => t.setLayer(l.id, on)); t.kind === 'cad' ? t.svgVectors(t.svgEl) : t.rerender(); }, inv: () => { t.layerList().forEach(l => t.setLayer(l.id, !l.on)); t.kind === 'cad' ? t.svgVectors(t.svgEl) : t.rerender(); } }; return null; };
  def('lay.all', 'All Layers', 'showAll', layers(() => (src() ? src().all(true) : A.showAll())), { enabled: view });
  def('lay.hide', 'Hide All', 'hideAll', layers(() => src()?.all(false)), { enabled: () => has2d() && tk().layerList().length > 0 });
  def('lay.invert', 'Invert', 'invert', layers(() => src()?.inv()), { enabled: () => has2d() && tk().layerList().length > 0 });
  def('lay.file', 'As Per File', 'filelayers', () => { A.status('Reading the layers as saved in the file…'); const t = tk(); const d = t.d; A.closeCTab(t.dkey); A.openDrawingCentre(d); }, { title: 'Layers on and off as in the drawing file', enabled: has2d });

  // ---------------------------------------------------------------- position and view
  const rot = (d) => () => tk().rotate(d);
  def('pos.90', '90°', 'rotate', rot(90), { enabled: has2d }); def('pos.180', '180°', 'rotate', rot(180), { enabled: has2d }); def('pos.270', '270°', 'rotate', rot(270), { enabled: has2d });
  def('view.rot90', 'Rotate 90°', 'rotate', rot(90), { enabled: has2d });
  def('view.reset', 'Reset View', 'reset', () => (has2d() ? (tk().rot = 0, tk().fit()) : A.V.setView('iso', false)), { enabled: view });
  def('view.ext', 'Zoom Extents', 'zoomExt', () => (has2d() ? tk().fit() : A.V.fit()), { enabled: view });
  def('view.area', 'Zoom Area', 'zoomArea', () => (has2d() ? tk().setTool('zarea') : A.zoomArea3d()), { enabled: view });
  def('view.in', 'Zoom In', 'zoomIn', () => tk().act('zin'), { enabled: has2d });
  def('view.out', 'Zoom Out', 'zoomOut', () => tk().act('zout'), { enabled: has2d });

  // ---------------------------------------------------------------- display
  def('disp.saveview', 'Save View', 'saveView', () => (has2d() ? A.saveView2d(tk()) : A.TB.act('saved', document.body)), { title: 'Save the zoom and position (drawing) or the camera (3D)', enabled: view });
  C['disp.text'] = { label: 'Text', icon: 'text', title: 'Show or hide the text of CAD drawings', ...disp('text'), checked: () => has2d() && tk().disp.text };
  C['disp.hatch'] = { label: 'Hatching', icon: 'hatch', title: 'Show or hide hatching and solid fills of CAD drawings', ...disp('hatch'), checked: () => has2d() && tk().disp.hatch };
  C['disp.weight'] = { label: 'Line Weight', icon: 'lineWeight', title: 'Line weights as in the file, or thin lines', ...disp('weight'), checked: () => has2d() && tk().disp.weight };
  C['disp.white'] = { label: 'White', icon: 'white', title: 'White background behind the drawing', ...disp('white') };
  def('disp.mono', 'Monochrome', 'mono', () => tk().act('mono'), { enabled: has2d, checked: () => has2d() && tk().mono });
  def('disp.markups', 'Markups', 'markups', () => tk().act('markups'), { enabled: has2d, checked: () => has2d() && tk().markupsOn });
  def('disp.shaded', 'Shaded', 'shaded', () => { if (need3d()) A.V.setDisplay('shaded'); }, { enabled: () => Boolean(A.V?.loaded), checked: () => A.V?.display === 'shaded' });
  def('disp.wire', 'Wireframe', 'wire', () => { if (need3d()) A.V.setDisplay('wire'); }, { enabled: () => Boolean(A.V?.loaded), checked: () => A.V?.display === 'wire' });
  def('disp.transparent', 'Transparent', 'transparent', () => { if (need3d()) A.V.setDisplay('transparent'); }, { enabled: () => Boolean(A.V?.loaded), checked: () => A.V?.display === 'transparent' });
  def('disp.ghost', 'Ghost View', 'ghost', () => { if (need3d()) A.V.setGhostView(!A.V.ghostView); }, { title: 'Hidden objects stay visible as faint ghosts', enabled: () => Boolean(A.V?.loaded), checked: () => Boolean(A.V?.ghostView) });

  // ---------------------------------------------------------------- drawing tools
  def('tool.compare', 'Compare', 'compare', () => (tk().cmp ? tk().closeCompare() : tk().compareWith()), { title: 'Compare two drawings as an overlay', enabled: has2d, checked: () => Boolean(tk()?.cmp) });
  def('tool.distance', 'Measure Distance', 'distance', () => tk().act('distance'), { title: 'Measure a distance (M). Nothing is saved.', enabled: has2d, checked: () => tk()?.tool === 'distance' });
  def('tool.view3d', 'View in 3D', 'view3d', () => need3d(), { title: 'Show the 3D model', enabled: () => Boolean(A.V?.loaded) });
  def('tool.cache', 'Drawing Cache', 'cache', () => A.drawingCache(), { title: 'Drawings and models kept on this computer' });
  def('tool.picture', 'Picture', 'picture', () => (has2d() ? tk().picture() : A.TB.act('shot', document.body)), { title: 'Picture of the drawing or the 3D view', enabled: view });

  // ---------------------------------------------------------------- dimension groups
  def('dg.add', 'Add', 'group', () => A.tree.addGroup(), { title: 'Add a dimension group', enabled: ed });
  def('dg.props', 'Properties', 'props', () => A.tree.groupProps(), { title: 'Properties of the current dimension group', enabled: () => Boolean(g()) });
  def('dg.copy', 'Copy', 'copy', () => A.tree.copyGroup(), { enabled: () => ed() && Boolean(g()) });
  def('dg.export', 'Export', 'export', () => A.tree.exportGroups(), { title: 'Add the dimension group to Excel as a schedule', enabled: () => Boolean(g()) });
  def('dg.folder', 'New Folder', 'folder', () => A.tree.newFolder('dim'), { enabled: ed });
  def('dg.std', 'From Standard', 'import', () => A.tree.fromStandard(), { title: 'Add a dimension group from the company standard groups', enabled: ed });
  def('dg.delete', 'Delete', 'delete', () => A.tree.deleteGroup(), { enabled: () => ed() && Boolean(g()) });
  def('dim.manual', 'Add Manual', 'manual', () => A.tree.addMeasured(), { title: 'Add a dimension by typing its value', enabled: () => ed() && Boolean(g()) });
  def('dim.measure', 'Measure', 'point', () => (has2d() ? tk().act('measure') : need3d() && A.PT.start({ face: false })), { title: 'Measure into the current group (click points; Enter finishes)', enabled: () => view() && ed(), checked: () => tk()?.tool === 'measure' || A.V?.mode === 'points' });
  def('dim.props', 'Properties', 'props', () => { const t = tk(); const s = t.selected(); if (s.length === 1) t.editDim(s[0]); else A.status('Select one dimension on the drawing first.', 'warn'); }, { enabled: () => has2d() && tk().sel.size === 1 });
  def('dim.copy', 'Copy', 'copy', () => tk().copySel(), { enabled: () => has2d() && tk().sel.size > 0 });
  def('dim.paste', 'Paste', 'paste', () => tk().paste(), { enabled: () => has2d() && ed() });
  def('dim.change', 'Change', 'change', null, { enabled: () => has2d() && ed() && tk().sel.size > 0, menu: () => { const t = tk(); return [
    { label: 'Move to Another Dimension Group...', run: () => t.moveToGroup() },
    { label: 'Make Negative', run: () => t.updateSel(m => ({ ...m, sign: -1 }), 'Made negative.') }, { label: 'Make Positive', run: () => t.updateSel(m => ({ ...m, sign: 1 }), 'Made positive.') },
    { label: 'Convert to Cutout', run: () => t.convertToCutout() }, '-',
    { label: 'Rotate 90°', run: () => t.transformSel('rot') }, { label: 'Mirror Left-Right', run: () => t.transformSel('x') }, { label: 'Mirror Up-Down', run: () => t.transformSel('y') }, '-',
    { label: 'Delete', run: () => t.deleteSel() }]; } });
  def('dim.selarea', 'Select In Area', 'selArea', () => tk().setTool('selarea'), { title: 'Drag a box to select the dimensions inside it', enabled: has2d });
  def('dim.controls', 'Edit Controls', 'controls', () => { tk().setTool('select'); A.status('Select one dimension, then drag its corner handles to edit it.'); }, { title: 'Edit the points of a dimension', enabled: has2d });
  def('sign.pos', 'Positive', 'positive', () => { if (has2d()) { tk().sign = 1; tk().renderBar(); } if (A.PT) A.PT.sign = 1; }, { title: 'New dimensions are positive', checked: () => (has2d() ? tk().sign > 0 : (A.PT?.sign ?? 1) > 0) });
  def('sign.neg', 'Negative', 'negative', () => { if (has2d()) { tk().sign = -1; tk().renderBar(); } if (A.PT) A.PT.sign = -1; }, { title: 'New dimensions are negative (deductions)', checked: () => (has2d() ? tk().sign < 0 : (A.PT?.sign ?? 1) < 0) });
  def('sign.both', 'Show Both', 'both', null, { title: 'Show positive, negative or both kinds of dimension', enabled: has2d,
    menu: () => [[0, 'Both'], [1, 'Positive only'], [-1, 'Negative only']].map(([v, l]) => ({ label: l, checked: tk().signShow === v, run: () => { tk().signShow = v; tk().drawDims(); } })) });

  // ---------------------------------------------------------------- BIM, type, zones, snap, mode, show
  def('bim.import', 'Import', 'import', () => { if (!need3d()) return; if (!A.W.ticked.size) return A.status('Select objects in 3D first (click, Ctrl+click or Box Select).', 'warn'); A.importObjects([...A.W.ticked]); }, { title: 'Import the selected objects into the current group', enabled: () => ed() && Boolean(A.V?.loaded) });
  def('bim.maps', 'Model Maps', 'maps', () => { if (need3d()) A.colourMeasured('maps'); }, { title: 'Colour objects in their dimension group\'s colour', enabled: () => Boolean(A.V?.loaded) });
  def('bim.check', 'Check BIM Objects', 'check', () => A.checkBim(), { title: 'Select the objects that are in no dimension group', enabled: () => Boolean(A.V?.loaded) });
  def('bim.showall', 'Show All Objects', 'showAll', () => { if (need3d()) A.showAll(); }, { enabled: () => Boolean(A.V?.loaded) });
  def('bim.schedule', 'Schedule', 'schedule', () => A.openSchedules(), { title: 'DWFx quantity schedules (separate window)' });
  def('type.points', 'Points', 'point', () => (has2d() ? tk().act('measure') : need3d() && A.PT.start({ face: false })), { title: 'Measure by clicking points (drawing or 3D model)', enabled: () => view() && ed() });
  def('type.faces', 'Faces', 'shaded', () => { if (need3d()) A.PT.start({ face: true }); }, { title: '3D: one click takes a whole flat face (Area group)', enabled: () => ed() && Boolean(A.V?.loaded) });
  def('type.object', 'Object', 'object', () => { if (!need3d()) return; A.W.objectMode = !A.W.objectMode; A.status(A.W.objectMode ? `Object mode: click objects to add them to "${g()?.name || 'a new group'}". Esc stops.` : 'Object mode off.'); }, { title: '3D: click objects to add them to the current group', enabled: () => ed() && Boolean(A.V?.loaded), checked: () => A.W.objectMode });
  def('zones.edit', 'Edit Zones', 'zones', () => A.showSidePanel('zones'), { enabled: () => Boolean(A.V?.loaded) });
  def('snap.geom', 'Geometry', 'snap', () => tk().act('snap'), { title: 'Snap to drawing lines (hold B to stop for a moment)', enabled: has2d, checked: () => has2d() && tk().snapOn });
  def('snap.angle', 'Angle', 'angle', () => tk().act('angle'), { title: 'Angle snap in 15° steps (A)', enabled: has2d, checked: () => has2d() && tk().angle });
  def('mode.rebar', 'Rebar', 'rebar', () => tk().act('rebar'), { title: 'Rebar mode: spacing line, then one bar (Length group)', enabled: () => has2d() && ed(), checked: () => tk()?.tool === 'rebar' });
  def('mode.autocount', 'Auto Count', 'autocount', () => { A.tree.setBottom('auto'); tk().act('autocount'); }, { title: 'Find every copy of a symbol (Count group)', enabled: () => has2d() && ed(), checked: () => Boolean(tk()?.ac) });
  def('show.overlaps', 'Overlaps', 'overlaps', () => { if (need3d()) A.colourMeasured('overlaps'); }, { title: 'Objects in more than one dimension group', enabled: () => Boolean(A.V?.loaded) });
  def('show.measured', 'Measured', 'measured', () => { if (need3d()) A.colourMeasured('measured'); }, { title: 'Colour objects: not measured, measured once, more than once', enabled: () => Boolean(A.V?.loaded) });
  def('show.all', 'All Groups', 'dims', () => tk().act('all'), { title: 'Show every dimension group on the drawing (off: only the current one)', enabled: has2d, checked: () => has2d() && tk().showAll });
  def('show.legend', 'Legend', 'legend', () => tk().act('legend'), { enabled: has2d, checked: () => has2d() && tk().legend });
  def('show.labels', 'Labels', 'labels', () => tk().act('labels'), { enabled: has2d, checked: () => has2d() && tk().labels });
  def('show.markups', 'Markups', 'markups', () => tk().act('markups'), { enabled: has2d, checked: () => has2d() && tk().markupsOn });
  def('show.propsadd', 'Properties on Add', 'propsOnAdd', () => A.setPropsOnAdd(!A.propsOnAdd()), { title: 'Open the dimension properties after each new dimension', checked: () => A.propsOnAdd() });

  // ---------------------------------------------------------------- 3D view
  def('3d.fit', 'Fit', 'fit', () => { if (need3d()) A.V.fit(); }, { enabled: () => Boolean(A.V?.loaded) });
  def('3d.views', 'Views', 'views', pop('views'), { title: 'Standard views and orthographic', enabled: () => Boolean(A.V?.loaded) });
  def('3d.zoomarea', 'Zoom Area', 'zoomArea', () => { if (need3d()) A.zoomArea3d(); }, { enabled: () => Boolean(A.V?.loaded) });
  def('3d.reset', 'Reset View', 'reset', () => { if (need3d()) A.V.setView('iso', false); }, { enabled: () => Boolean(A.V?.loaded) });
  def('3d.ortho', 'Orthographic', 'plan', () => { if (need3d()) A.V.setOrtho(!A.V.isOrtho); }, { enabled: () => Boolean(A.V?.loaded), checked: () => Boolean(A.V?.isOrtho) });
  def('3d.isolate', 'Isolate', 'isolate', () => { if (need3d()) A.TB.act('isolate'); }, { enabled: () => Boolean(A.V?.loaded) && (A.W.ticked.size > 0 || A.W.isolated), checked: () => A.W.isolated });
  def('3d.hide', 'Hide', 'hide', () => { if (need3d()) A.TB.act('hide'); }, { enabled: () => Boolean(A.V?.loaded) && A.W.ticked.size > 0 });
  def('3d.showall', 'Show All', 'showAll', () => { if (need3d()) A.TB.act('showall'); }, { enabled: () => Boolean(A.V?.loaded) });
  def('3d.box', 'Box Select', 'box', () => { if (need3d()) A.TB.act('box'); }, { enabled: () => Boolean(A.V?.loaded), checked: () => A.V?.mode === 'box' });
  def('3d.clear', 'Clear Selection', 'select', () => A.setIds([]), { enabled: () => A.W.ticked.size > 0 });
  def('3d.custom', 'Select Custom', 'selArea', () => { if (need3d()) A.customSet((ids) => A.setIds(ids, true)); }, { title: 'Select objects by category, family, type, level or property', enabled: () => Boolean(A.V?.loaded) });
  def('3d.section', 'Section', 'section', pop('section'), { title: 'Section box', enabled: () => Boolean(A.V?.loaded), checked: () => Boolean(A.V?.sectionOn) });
  def('3d.plan', 'Level Plan', 'plan', pop('plan'), { enabled: () => Boolean(A.V?.loaded), checked: () => Boolean(A.TB?.inPlan) });
  def('3d.xray', 'X-ray', 'xray', () => { if (need3d()) A.TB.act('xray'); }, { enabled: () => Boolean(A.V?.loaded), checked: () => Boolean(A.V?.state.xray) });
  def('3d.edges', 'Edges', 'edges', () => { if (need3d()) A.TB.act('edges'); }, { enabled: () => Boolean(A.V?.loaded), checked: () => Boolean(A.V?.edgesWanted) });
  def('3d.colour', 'Colour', 'colour', pop('color'), { title: 'Colour by category, measured status, group colours or overlaps', enabled: () => Boolean(A.V?.loaded) });
  def('3d.measure', 'Measure', 'measure3d', pop('measure'), { title: 'Distance, face area, or take-off by points into the current group', enabled: () => Boolean(A.V?.loaded) });
  def('3d.saved', 'Saved Views', 'saveView', pop('saved'), { enabled: () => Boolean(A.V?.loaded) });
  def('3d.picture', 'Picture', 'picture', () => { if (need3d()) A.TB.act('shot'); }, { enabled: () => Boolean(A.V?.loaded) });

  // ---------------------------------------------------------------- revisions
  def('rev.drawings', 'Compare Drawings', 'compare', () => (tk().cmp ? tk().closeCompare() : tk().compareWith()), { title: 'Overlay another drawing or revision on the open drawing', enabled: has2d, checked: () => Boolean(tk()?.cmp) });
  def('rev.models', 'Compare Models', 'view3d', () => { if (need3d()) A.compareModel(); }, { title: 'Colour what changed since another version of the model', enabled: () => Boolean(A.V?.loaded) });
  def('rev.off', 'Normal Colours', 'colour', () => { if (has2d() && tk().cmp) tk().closeCompare(); A.colourMeasured('off'); }, { enabled: () => Boolean(A.W.colorMap || tk()?.cmp) });

  // ---------------------------------------------------------------- workbooks (Excel links)
  def('xl.link', 'Link to Cell', 'link', () => A.linkCell(null), { title: 'Select a cell in Excel, then press this: the cell gets a live formula with the current group\'s total. You can also drag a group or a dimension onto the drop bar.', enabled: () => Boolean(g()) && A.W.inExcel });
  def('xl.links', 'Workbook View', 'workbook', () => A.showCTab('book'), { title: 'Every cell linked to a measurement' });
  def('xl.refresh', 'Refresh Links', 'recalc', () => { A.send({ type: 'linksPlease', recalc: true }); A.status('Links refreshed.'); }, { title: 'Recalculate the linked cells' });
  def('xl.follow', 'Follow Excel', 'follow', () => A.setFollow(!A.follow()), { title: 'On: clicking a linked cell in Excel shows where it was measured. The links stay either way.', checked: () => A.follow() });
  def('xl.folder', 'Folder to Excel', 'export', () => A.tree.exportGroups(A.allGroups().filter(x => x.folder_id === g()?.folder_id).map(x => x.id)), { title: 'Every group in the current group\'s folder as schedules', enabled: () => Boolean(g()) });
  def('xl.schedules', 'DWFx Schedules', 'schedule', () => A.openSchedules(), { title: 'Quantity schedules from the DWFx model data (separate window)' });

  // ---------------------------------------------------------------- panes
  def('pane.left', 'Drawings Pane', 'manager', () => A.toggleLeft(), { checked: () => A.leftShown() });
  def('pane.side', 'Side by Side', 'compare', () => (A.sideShown() ? A.hideSidePanel() : A.showSidePanel('drawings')), { title: 'A second drawing on the right', checked: () => A.sideShown() });
  def('pane.props', 'Object Properties', 'props', () => A.showSidePanel('props'), { enabled: () => Boolean(A.V?.loaded) });
  return C;
}
