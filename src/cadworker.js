// Worker thread: reads one DWG (LibreDWG, WebAssembly) or DXF (dxf-parser) and answers with the SVG.
// It runs apart from the API so a damaged file cannot crash or block the server.
import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalise, toSvg } from '../public/js/cad2svg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const { buf, kind } = workerData;
  let db;
  if (kind === 'dwg') {
    const { Dwg_File_Type, LibreDwg } = await import('@mlightcad/libredwg-web');
    const lib = await LibreDwg.create(path.join(here, '../node_modules/@mlightcad/libredwg-web/wasm/'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const dwg = lib.dwg_read_data(ab, Dwg_File_Type.DWG);
    if (!dwg) throw new Error('This DWG file could not be read.');
    db = lib.convert(dwg); lib.dwg_free(dwg);
  } else {
    const DxfParser = (await import('dxf-parser')).default;
    db = new DxfParser().parseSync(Buffer.from(buf).toString('utf8'));
  }
  const n = normalise(db, kind);
  if (!n.paths.length && !n.texts.length) throw new Error('No drawing lines were found in this file (only model space is shown).');
  parentPort.postMessage({ ok: true, svg: toSvg(n), layers: n.layers.size, paths: n.paths.length, unitM: n.unitM });
} catch (err) {
  const msg = err?.message || String(err);
  parentPort.postMessage({ ok: false, error: /memory access|unreachable|out of bounds/i.test(msg) ? 'This DWG version or file could not be read. Save it as DWG 2013-2018, or export a DXF or PDF, and upload it again.' : msg });
}
