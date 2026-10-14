// Compact binary mesh file shared by the decoder (server: decode.mjs, browser: procworker.js) and py/geometry.py:
//   b'MSH1' | uint32 header length H | H bytes JSON {meshes:[{s, nv, ni, c}]} padded to 4 | float32 xyz | uint32 indices
// Positions and indices of all meshes follow each other in header order (indices are local to their mesh).
// Binary instead of base64 JSON: a 20 MB DWFx no longer turns into gigabytes of text and Python numbers.

/** meshes: [{ s, positions: Float32Array|number[], indices: Uint32Array|number[], c }] -> Uint8Array */
export function encodeMeshes(meshes) {
  const list = meshes.map(m => ({ s: m.s ?? null, id: m.id ?? undefined, c: m.c ?? null,
    p: m.positions instanceof Float32Array ? m.positions : Float32Array.from(m.positions || []),
    i: m.indices instanceof Uint32Array ? m.indices : Uint32Array.from(m.indices || []) }));
  const head = { meshes: list.map(m => ({ s: m.s, ...(m.id !== undefined ? { id: m.id } : {}), nv: m.p.length / 3, ni: m.i.length, c: m.c })) };
  let hb = new TextEncoder().encode(JSON.stringify(head));
  const pad = (4 - (hb.length % 4)) % 4;
  if (pad) { const t = new Uint8Array(hb.length + pad); t.set(hb); t.fill(32, hb.length); hb = t; }
  const nP = list.reduce((s, m) => s + m.p.length, 0), nI = list.reduce((s, m) => s + m.i.length, 0);
  const out = new Uint8Array(8 + hb.length + nP * 4 + nI * 4);
  out.set([77, 83, 72, 49], 0);                                              // 'MSH1'
  new DataView(out.buffer).setUint32(4, hb.length, true);
  out.set(hb, 8);
  let off = 8 + hb.length;
  for (const m of list) { out.set(new Uint8Array(m.p.buffer, m.p.byteOffset, m.p.byteLength), off); off += m.p.byteLength; }
  for (const m of list) { out.set(new Uint8Array(m.i.buffer, m.i.byteOffset, m.i.byteLength), off); off += m.i.byteLength; }
  return out;
}

/** The meshes of the first 3D page of an opened dwf-viewer document. */
export async function meshesOf(doc) {
  for (const key of Object.keys(doc.pageData || {})) {
    let data = doc.pageData[key];
    if (typeof data === 'function') data = await data();
    if (data && typeof data.then === 'function') data = await data;
    if (!data || !data.model || !data.model.meshes) continue;
    return data.model.meshes.map(m => ({ s: m.sourceStart, positions: m.positions, indices: m.indices, c: m.color || null }));
  }
  return [];
}
