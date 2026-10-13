// Test helpers: a tiny synthetic DWFx (properties only, no geometry) so tests never need client models.
import archiver from 'archiver';
import fs from 'fs';

export function makeDwfx(file, elements = [
  { cat: 'Walls', fam: 'Basic Wall', type: 'Generic - 200', id: 1001, level: 'Level 1', props: { Length: '5000', 'Unconnected Height': '3000', Area: '15 m²', Volume: '3.00 m³' }, typeProps: { Width: '200' } },
  { cat: 'Walls', fam: 'Basic Wall', type: 'Generic - 200', id: 1002, level: 'Level 1', props: { Length: '2500', 'Unconnected Height': '3000', Area: '7 m²', Volume: '1.50 m³' }, typeProps: { Width: '200' } },
  { cat: 'Structural Framing', fam: 'Concrete-Rectangular Beam', type: 'B-300X600', id: 2001, level: 'Level 2', props: { 'Cut Length': '4000', Volume: '0.72 m³', 'Reference Level': 'Level 2' } },
]) {
  const prop = (k, v) => `<dwf:Property name="${k}" value="${v}"/>`;
  const groups = {};
  elements.forEach(e => { ((groups[e.cat] ||= {})[e.fam] ||= {})[e.type] ||= []; groups[e.cat][e.fam][e.type].push(e); });
  let objs = '', n = 0;
  for (const [cat, fams] of Object.entries(groups)) {
    objs += `<dwf:Object id="c${n++}" label="${cat} (1)">`;
    for (const [fam, types] of Object.entries(fams)) {
      objs += `<dwf:Object id="f${n++}" label="${fam} (1)">`;
      for (const [type, list] of Object.entries(types)) {
        objs += `<dwf:Object id="t${n++}" label="${type} (${list.length})">` + Object.entries(list[0].typeProps || {}).map(([k, v]) => prop(k, v)).join('');
        list.forEach(e => {
          objs += `<dwf:Object id="e${e.id}" label="${fam} [${e.id}]">` + prop('Id', e.id) + prop('Guid', 'g' + e.id) +
            (e.level ? prop('Level', e.level) : '') + Object.entries(e.props).map(([k, v]) => prop(k, v)).join('') + `</dwf:Object>`;
        });
        objs += `</dwf:Object>`;
      }
      objs += `</dwf:Object>`;
    }
    objs += `</dwf:Object>`;
  }
  const content = `<dwf:Content xmlns:dwf="DWF-Content:1.0" version="1.0"><dwf:Entities/><dwf:Objects>${objs}</dwf:Objects></dwf:Content>`;
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip');
    out.on('close', resolve); zip.on('error', reject);
    zip.pipe(out);
    zip.append(content, { name: 'dwf/documents/TEST/TEST.content.xml' });
    zip.append('<eModel:Space name="3D View" xmlns:eModel="DWF-eModel:1.0"><eModel:Properties><eModel:Property name="Creator" value="Autodesk Revit 2024 (test)"/></eModel:Properties></eModel:Space>', { name: 'dwf/documents/TEST/sections/s/descriptor.xml' });
    zip.finalize();
  });
}
