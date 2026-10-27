import { session, openProject, openModel, open3D, box, browser } from './lib.mjs';
await session('06-dimension-groups', async (T) => {
  const { cap, p, wait, pane, dlg } = T; const D = () => dlg(), DF = '#dlgFrame';
  await T.top('#tabs [data-tab="DWFx Measure"]', 300); await T.top('#ribbon [data-fn=openProjects]', 800);
  await openProject(T); await openModel(T);
  await open3D(T);
  const dc = (sel, w = 700, o = {}) => T.click(sel, w, D, o);
  const dtype = async (sel, text) => { await dc(sel, 150); await D().fill(sel, ''); await D().type(sel, text, { delay: 40 }); };
  const pick = async (...path) => {
    for (let i = 0; i < path.length; i++) {
      const item = D().locator('.cmenu .cm-item:visible', { has: D().locator(':scope > .cm-label', { hasText: path[i] }) }).first();
      const bx = await item.boundingBox(); await p.mouse.move(bx.x + 40, bx.y + bx.height / 2, { steps: 8 }); await wait(350);
      if (i === path.length - 1) await item.click();
    }
    await wait(700);
  };
  const beam = async () => { const off = await p.locator(DF).boundingBox(); const r = await D().evaluate(() => {
    const { W, V } = window.__win; const r = V.renderer.domElement.getBoundingClientRect();
    for (const e of W.E.filter(x => x.cat === 'Structural Framing' && V.hasGeometry(x.id))) {
      const k = V.kOf.get(e.id), t = V.E.ts[k] * 3, P = V.pos, T = V.tri, Vec = V.camera.position.constructor;
      for (let j = 0; j < Math.min(V.E.tc[k], 40); j++) {
        const c = [0, 1, 2].map(a => (P[T[t + j * 3] * 3 + a] + P[T[t + j * 3 + 1] * 3 + a] + P[T[t + j * 3 + 2] * 3 + a]) / 3);
        const s = new Vec(...c).project(V.camera); const x = r.left + (s.x + 1) / 2 * r.width, y = r.top + (1 - s.y) / 2 * r.height;
        if (x < r.left + 40 || x > r.right - 300 || y < r.top + 60 || y > r.bottom - 160) continue;
        const h = V.hit({ clientX: x, clientY: y }); if (h && h.id === e.id) return { x, y };
      }
    }
    return null; }); return r && { x: r.x + off.x, y: r.y + off.y }; };
  const rclickBeam = async () => { const t = await beam(); await p.mouse.move(t.x, t.y, { steps: 10 }); await wait(300); await p.mouse.click(t.x, t.y, { button: 'right' }); await wait(600); };

  await cap('The 3D window is a full measuring workspace: the project tree on the left, the model in the middle. Drawings and properties open on the right.', 4200);
  await cap('Right-click the Dimension Groups area to make folders for stages and trades.', 2200);
  await dc('#dgTree .tr-body', 700, { button: 'right', position: { x: 80, y: 60 } }); await pick('New Folder...');
  await dtype('#dialog #askV', 'Structure'); await dc('#dialog .btn.primary', 900);
  await cap('The Model tab lists Category > Family > Type. Click Structural Framing to select every beam.', 2800);
  await dc('[data-lt=model]', 500); await dc('#topTree .tr-row:has-text("Structural Framing")', 1200);
  await cap('Right-click a beam for the object menu. Create Dimension Group makes a measured item for the selection.', 3000);
  await rclickBeam(); await wait(1200); await pick('Create Dimension Group');
  await dtype('#dialog #dgN', 'Concrete to beams'); await D().selectOption('#dialog #dgT', 'Volume'); await wait(400);
  await dtype('#dialog #dgF', 'Structure'); await wait(400);
  await cap('Measurement type Volume. The group remembers the folder, display, multiplier, sizes and colours.', 2600);
  await dc('#dialog .btn.primary', 1200);
  await cap('The group shows its total. Its objects are coloured in 3D. Now a second item for the same beams: formwork.', 3200);
  await dc('#dgTree .tr-row:has-text("Concrete to beams")', 900, { button: 'right' }); await pick('Add Dimension Group...');
  await dtype('#dialog #dgN', 'Formwork to beams'); await D().selectOption('#dialog #dgT', 'Length'); await wait(300);
  await dc('#dialog [data-dt=custom]', 600);
  await cap('Custom Quantities are formulas for every dimension, written to Excel as live formulas.', 2600);
  await dc('#dialog #dgAddC', 400);
  await dtype('#dialog tr[data-r="0"] [data-f=label]', 'Formwork'); await dc('#dialog tr[data-r="0"] [data-f=expr]', 300); await D().fill('#dialog tr[data-r="0"] [data-f=expr]', '{Geo_side_area} + {Geo_bottom_area}');
  await wait(600); await dc('#dialog .btn.primary', 1000);
  await cap('It is now the current group. Right-click a beam > Import Objects In > Current Selection adds the beams to it.', 3000);
  await rclickBeam(); await pick('Import Objects In', 'Current Selection'); await wait(1200);
  await cap('Show Only, Hide and Import work on the category, family, type or one object, the selection, a custom filter or an area.', 3400);
  await rclickBeam(); await pick('Show Only Objects In', 'Structural Framing ('); await wait(1200);
  await rclickBeam(); await pick('Show All Objects');
  await cap('The Dimensions tab lists every dimension. Right-click to delete one, change the multiplier or make it a deduction.', 3200);
  await dc('[data-bt=dims]', 900);
  await dc('#dgTree table.dims tbody tr:nth-child(2)', 800, { button: 'right' }); await pick('Make Negative (Deduction)');
  await wait(800); await dc('[data-bt=groups]', 600);
  await cap('Right-click a group or a folder to add it to Excel as a schedule, with the details you choose for each row.', 3000);
  await dc('#dgTree .tr-row:has-text("Structure")', 800, { button: 'right' }); await pick('Add Folder to Excel as Schedules...');
  await dc('#dialog [data-det=mark]', 500); await wait(800);
  await cap('Concrete and formwork measure the same beams, so Excel gets one table with both columns, not two tables.', 3400);
  await dc('#dialog .btn.primary', 300);
  await D().waitForFunction(() => /Added to Excel/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  await cap('Done: the schedule is on the Take-off sheet with live formulas, sub-totals and named totals for the BOQ.', 2600);
  await p.evaluate(() => window.__closeDialog()); await wait(500);
  await cap('Close the 3D window and look at your workbook: the schedule is there, ready for the BOQ.', 4200);
});
await browser.close();
