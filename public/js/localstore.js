// The library on this computer: the drawings and model files the user added, the processed models made from them,
// and converted CAD drawings. Kept in the browser's own database (IndexedDB) for the add-in's web address, so the task
// pane and the 3D window share it. Files are found by their SHA-256 fingerprint, which is also what the project on the
// server knows about them: the same file chosen on another computer has the same fingerprint.
const DB_NAME = 'dwfx-measure-library', DB_VER = 2;
// files:  { key: sha256 (or 'cloud:d:<id>' for a cached server copy), name, type, size, blob, added, used }
// models: { key: sha256 (or 'cloud:v:<versionId>'), payload: Blob(JSON), geometry: Blob | null, sheets: [{ index, name, width, height, svg: Blob }], at }
// cad:    { key: sha256 (or 'cloud:d:<id>'), svg: Blob, at }
// places: { key: sha256 | 'folders', entries: [{ handle: FileSystemFileHandle | FileSystemDirectoryHandle, kind: 'file'|'dir', name, path, at }] }
//         where this computer found a file (its paths); 'folders' are folders to search (local or synced SharePoint/OneDrive)
const STORES = ['files', 'models', 'cad'];
const ALL_STORES = [...STORES, 'places'];

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot keep files on the computer (no IndexedDB).')); return; }
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => { for (const s of ALL_STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'key' }); };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; resolve(r.result); };
    r.onerror = () => reject(new Error('The library on this computer could not be opened: ' + (r.error?.message || 'blocked')));
    r.onblocked = () => reject(new Error('Close the add-in in other Excel windows, then try again.'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(new Error(/quota/i.test(t.error?.name || '') ? 'There is not enough free space on this computer for the library. Remove files you no longer need (Project > On this computer).' : (t.error?.message || 'The library on this computer could not be changed.')));
  });
}
const get = (store, key) => run(store, 'readonly', s => s.get(key)).then(r => r || null);
const put = (store, rec) => run(store, 'readwrite', s => s.put(rec));
const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
const all = (store) => run(store, 'readonly', s => s.getAll()).then(r => r || []);

/** Every converted CAD drawing kept for a file (one per reader version: key, key:v2, ...). */
async function delCad(key) { for (const c of await all('cad')) if (c.key === key || c.key.startsWith(key + ':v')) await del('cad', c.key); }

let persisted = false;
/** Ask the browser not to clear the library when disk space runs low (best effort). */
async function persist() {
  if (persisted) return; persisted = true;
  try { await navigator.storage?.persist?.(); } catch { /* not offered */ }
}

/** SHA-256 of a Blob or ArrayBuffer, as 64 hex characters. */
export async function sha256(data) {
  const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const library = {
  /** Keep a file. Returns its fingerprint (or the given key). */
  async putFile(blob, { name, type, key } = {}) {
    await persist();
    const k = key || await sha256(blob);
    const old = await get('files', k);
    if (!old) await put('files', { key: k, name: name || blob.name || 'file', type: type || blob.type || '', size: blob.size, blob, added: Date.now(), used: Date.now() });
    return k;
  },
  async getFile(key) {
    const r = await get('files', key);
    if (r) put('files', { ...r, used: Date.now() }).catch(() => {});
    return r;
  },
  hasFile: async (key) => Boolean(await get('files', key)),
  async putModel(key, { payload, geometry, sheets = [] }) {
    await persist();
    await put('models', { key, payload: new Blob([JSON.stringify(payload)], { type: 'application/json' }), geometry: geometry ? new Blob([geometry]) : null,
      sheets: sheets.map(s => ({ index: s.index, name: s.name, width: s.width, height: s.height, svg: s.svg instanceof Blob ? s.svg : new Blob([s.svg], { type: 'image/svg+xml' }) })), at: Date.now() });
  },
  /** { payload, geometry: ArrayBuffer | null, sheets } or null. */
  async getModel(key) {
    const r = await get('models', key); if (!r) return null;
    return { payload: JSON.parse(await r.payload.text()), geometry: r.geometry ? await r.geometry.arrayBuffer() : null, sheets: r.sheets || [] };
  },
  async getSheet(key, index) {
    const r = await get('models', key);
    return r?.sheets?.find(s => s.index === index)?.svg || null;
  },
  hasModel: async (key) => Boolean(await get('models', key)),
  putCad: (key, svg) => put('cad', { key, svg: new Blob([svg], { type: 'image/svg+xml' }), at: Date.now() }),
  getCad: async (key) => (await get('cad', key))?.svg || null,
  /** Everything kept, newest first: [{ key, name, type, size, added, used, model: bytes, cad: bytes }] */
  async list() {
    const [files, models, cad] = await Promise.all([all('files'), all('models'), all('cad')]);
    const msize = new Map(models.map(m => [m.key, (m.payload?.size || 0) + (m.geometry?.size || 0) + (m.sheets || []).reduce((s, x) => s + (x.svg?.size || 0), 0)]));
    const csize = new Map(); cad.forEach(c => { const k = c.key.replace(/:v\d+$/, ''); csize.set(k, (csize.get(k) || 0) + (c.svg?.size || 0)); });     // CAD output is kept per reader version
    const out = files.map(({ blob, ...f }) => ({ ...f, model: msize.get(f.key) || 0, cad: csize.get(f.key) || 0 }));
    for (const m of models) if (!files.some(f => f.key === m.key)) out.push({ key: m.key, name: m.payload ? 'Processed model' : '', size: 0, model: msize.get(m.key), cad: 0, added: m.at });
    return out.sort((a, b) => (b.added || 0) - (a.added || 0));
  },
  /** Remove a file and everything made from it. */
  async remove(key) { await Promise.all([...STORES.map(s => del(s, key)), delCad(key)]); },
  /** Remove only what was made from the file (it is made again when needed). */
  async removeDerived(key) { await Promise.all([del('models', key), delCad(key)]); },
  /** Where this computer found files (file and folder handles) and the folders to search. */
  getPlaces: async (key) => (await get('places', key))?.entries || [],
  async addPlace(key, entry) {
    const list = (await get('places', key))?.entries || [];
    const same = (e) => e.path === entry.path && e.kind === entry.kind && e.name === entry.name;
    await put('places', { key, entries: [{ ...entry, at: Date.now() }, ...list.filter(e => !same(e))].slice(0, 20) });
  },
  async removePlace(key, path) { const list = (await get('places', key))?.entries || []; await put('places', { key, entries: list.filter(e => e.path !== path) }); },
  /** { used, quota } in bytes, when the browser says. */
  async usage() { try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return { used: 0, quota: 0 }; } },
};
