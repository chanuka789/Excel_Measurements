// Decode W3D shell meshes from a DWFx using the open-source dwf-viewer parser (AGPL-3.0).
// Usage: node decode.mjs <model.dwfx> <out meshes.bin>   (format: public/js/meshbin.js; the browser uses the same code)
import { openDwfDocument } from 'dwf-viewer';
import fs from 'fs';
import { encodeMeshes, meshesOf } from './public/js/meshbin.js';

const [, , src, out] = process.argv;
const doc = await openDwfDocument(new Uint8Array(fs.readFileSync(src)), { fileName: 'model.dwfx' });
const meshes = await meshesOf(doc);
fs.writeFileSync(out, encodeMeshes(meshes));
console.log('decoded meshes', meshes.length);
