// Worker: reads a DXF on this computer and answers with the measurable SVG (the same code the server uses).
// DWG needs LibreDWG, which stays on the server (GPL), so DWG files are converted there for one request only.
import DxfParser from 'dxf-parser';
import { normalise, toSvg } from './cad2svg.js';

self.onmessage = ({ data: { buf } }) => {
  try {
    const db = new DxfParser().parseSync(new TextDecoder().decode(buf));
    const n = normalise(db, 'dxf');
    if (!n.paths.length && !n.texts.length) throw new Error('No drawing lines were found in this file (only model space is shown).');
    self.postMessage({ ok: true, svg: toSvg(n) });
  } catch (err) { self.postMessage({ ok: false, error: err?.message || String(err) }); }
};
