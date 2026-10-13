// Audit PDF: method, assumptions, element counts, totals and a 3D screenshot for every take-off group.
import PDFDocument from 'pdfkit';

const BLUE = '#0a5082', INK = '#242424', MUTED = '#616161', LINE = '#d1d1d1';

export function auditPdf({ project, model, user, groups, checks = [], generatedAt = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Take-off audit - ${project.name}`, Author: user.name, Creator: 'DWFx Measure' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 96;
    let page = 1;
    const footer = () => {
      // write inside the bottom margin without triggering a new page
      const keep = doc.page.margins.bottom, x = doc.x, y0 = doc.y;
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor(MUTED).text(`${project.name} · take-off audit · ${generatedAt.toISOString().slice(0, 10)} · page ${page++}`, 48, doc.page.height - 32, { width: W, lineBreak: false });
      doc.page.margins.bottom = keep; doc.x = x; doc.y = y0;
    };
    doc.on('pageAdded', footer);

    // cover
    doc.rect(0, 0, doc.page.width, 6).fill(BLUE);
    doc.fillColor(BLUE).fontSize(22).font('Helvetica-Bold').text('Take-off audit report', 48, 64);
    doc.moveDown(0.4).fillColor(INK).fontSize(13).font('Helvetica').text(project.name + (project.code ? `  (${project.code})` : ''));
    doc.moveDown(1).fontSize(10).fillColor(MUTED);
    const meta = [['Client', project.client || '-'], ['Model', model || '-'], ['Prepared by', `${user.name} (${user.email})`],
      ['Generated', generatedAt.toLocaleString('en-GB')], ['Take-off groups', String(groups.length)]];
    meta.forEach(([k, v]) => { doc.font('Helvetica-Bold').fillColor(INK).text(k + ': ', { continued: true }).font('Helvetica').fillColor(INK).text(v); });
    doc.moveDown(1).fontSize(9).fillColor(MUTED).text('Quantities are calculated by DWFx Measure from the model. Each group lists the method, the assumptions (yellow cells in Excel) and the totals written to the Take-off sheet. "Geo" quantities are measured from the 3D geometry; others are Revit values exported in the DWFx.', { width: W });

    // summary table
    doc.moveDown(1.2).fontSize(12).font('Helvetica-Bold').fillColor(BLUE).text('Summary');
    doc.moveDown(0.3);
    table(doc, ['Ref', 'Group', 'Elements', 'Main total'], groups.map((g, i) => [g.ref || `G${i + 1}`, g.name, String(g.count), mainTotal(g)]), [40, W - 220, 60, 120]);
    if (checks.length) {
      doc.moveDown(1).fontSize(12).font('Helvetica-Bold').fillColor(BLUE).text('Checks');
      doc.moveDown(0.3).fontSize(9).font('Helvetica').fillColor(INK);
      checks.forEach(c => doc.text(`• ${c}`, { width: W }));
    }
    footer();

    // one section per group
    groups.forEach((g, i) => {
      doc.addPage();
      doc.fillColor(BLUE).fontSize(14).font('Helvetica-Bold').text(`${g.ref || 'G' + (i + 1)}  ${g.name}`, { width: W });
      doc.moveDown(0.3).fontSize(9).font('Helvetica').fillColor(MUTED).text(`${g.count} element(s)${g.categories ? ' · ' + g.categories : ''}${g.by ? ' · sub-totals by ' + g.by : ''}`);
      if (g.note) { doc.moveDown(0.5).fillColor(INK).fontSize(10).font('Helvetica-Bold').text('Method'); doc.font('Helvetica').fontSize(9).text(g.note, { width: W }); }
      if (g.formulas?.length) {
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(10).text('Formulas');
        doc.font('Courier').fontSize(8.5).fillColor(INK);
        g.formulas.forEach(f => doc.text(`${f.label} (${f.unit}) = ${f.expr}`, { width: W }));
        doc.font('Helvetica');
      }
      if (g.constants?.length) {
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Assumptions');
        table(doc, ['Assumption', 'Value', 'Unit'], g.constants.map(c => [c.label, String(c.value), c.unit || '']), [W - 160, 90, 70], '#FFF2CC');
      }
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Totals');
      table(doc, ['Column', 'Total', 'Unit', 'Missing'], (g.totals || []).map(t => [t.label, t.value == null ? '' : fmt(t.value), t.unit || '', t.missing ? String(t.missing) : '']), [W - 230, 100, 60, 70]);
      if (g.image && /^data:image\/(png|jpeg);base64,/.test(g.image)) {
        try {
          const img = Buffer.from(g.image.split(',')[1], 'base64');
          if (doc.y > doc.page.height - 300) doc.addPage();
          doc.moveDown(0.6).image(img, { fit: [W, 260], align: 'center' });
          doc.moveDown(0.2).fontSize(8).fillColor(MUTED).text('Elements of this group highlighted in the model.', { align: 'center', width: W });
        } catch { /* bad image is skipped */ }
      }
    });
    doc.end();
  });
}

function mainTotal(g) {
  const f = (g.totals || []).filter(t => t.value != null);
  const pick = f.find(t => g.formulas?.some(x => x.label === t.label)) || f.find(t => t.unit && t.unit !== 'nr') || f[0];
  return pick ? `${fmt(pick.value)} ${pick.unit || ''}` : '';
}
const fmt = (v) => Number(v).toLocaleString('en-GB', { maximumFractionDigits: 3 });

function table(doc, head, rows, widths, fill) {
  const x0 = 48; let y = doc.y;
  const h = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const heights = cells.map((c, i) => doc.heightOfString(String(c), { width: widths[i] - 8 }));
    return Math.max(...heights) + 8;
  };
  const row = (cells, bold, bg) => {
    const rh = h(cells, bold);
    if (y + rh > doc.page.height - 60) { doc.addPage(); y = doc.y; }
    let x = x0;
    cells.forEach((c, i) => {
      const cellBg = bg || (fill && i === 1 ? fill : null);     // assumption values are yellow, as in Excel
      if (cellBg) doc.rect(x, y, widths[i], rh).fill(cellBg);
      doc.rect(x, y, widths[i], rh).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(String(c), x + 4, y + 4, { width: widths[i] - 8 });
      x += widths[i];
    });
    y += rh;
  };
  row(head, true, '#D9E6F2');
  rows.forEach(r => row(r, false, null));
  doc.y = y + 4; doc.x = x0;
}
