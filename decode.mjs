// Decode W3D shell meshes from a DWFx using the open-source dwf-viewer parser (AGPL-3.0).
// Usage: node decode.mjs <model.dwfx> <out.json>
import { openDwfDocument } from 'dwf-viewer';
import fs from 'fs';

const [, , src, out] = process.argv;
const doc = await openDwfDocument(new Uint8Array(fs.readFileSync(src)), { fileName: 'model.dwfx' });
const meshes = [];
for (const key of Object.keys(doc.pageData || {})) {
  let data = doc.pageData[key];
  if (typeof data === 'function') data = await data();
  if (data && typeof data.then === 'function') data = await data;
  if (!data || !data.model || !data.model.meshes) continue;
  for (const m of data.model.meshes) {
    meshes.push({
      s: m.sourceStart,
      p: Buffer.from(new Float32Array(m.positions).buffer).toString('base64'),
      i: Buffer.from(new Uint32Array(m.indices).buffer).toString('base64'),
      c: m.color || null,
    });
  }
  break; // first 3D model page
}
fs.writeFileSync(out, JSON.stringify({ meshes }));
console.log('decoded meshes', meshes.length);
