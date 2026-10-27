// Several paths per drawing or model: where each computer keeps the file. A path is a local folder, a synced SharePoint
// or OneDrive folder (it works like a local folder), or a SharePoint link. The project remembers every path (the text
// only, never the file), and this computer remembers the file and folder handles it was given, so moving between
// computers works both ways: each computer uses its own path, and older paths are never removed when a new one is added.
import { api } from './core.js';
import { library, sha256 } from './localstore.js';

/** This computer: a random id kept in this browser profile and a name the user chooses (e.g. "Office PC"). */
export function computer() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem('dwfxComputer') || 'null'); } catch { /* storage blocked */ }
  if (!c?.id) {
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
    c = { id, name: guessName() };
    try { localStorage.setItem('dwfxComputer', JSON.stringify(c)); } catch { /* storage blocked */ }
  }
  return c;
}
export function setComputerName(name) {
  const c = { ...computer(), name: String(name || '').trim().slice(0, 80) || guessName() };
  try { localStorage.setItem('dwfxComputer', JSON.stringify(c)); } catch { /* storage blocked */ }
  return c;
}
function guessName() {
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  return /win/i.test(p) ? 'Windows computer' : /mac/i.test(p) ? 'Mac' : 'This computer';
}

/** Every path the project knows for this file (all computers). */
export async function pathsOf(fp) {
  try { return (await api('GET', `/paths/${fp}`)).paths || []; } catch { return []; }
}
export async function savePath(fp, { path, kind = 'local', label = null, projectId = null }) {
  const c = computer();
  return api('POST', '/paths', { sha256: fp, path, kind, label, projectId, computer: c });
}
export const removePath = (id) => api('DELETE', `/paths/${id}`);

const canHandles = () => typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
const canFolders = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
export const pickers = () => ({ files: canHandles(), folders: canFolders() });

async function permitted(handle, ask) {
  try {
    const opt = { mode: 'read' };
    if ((await handle.queryPermission?.(opt)) === 'granted') return true;
    return ask ? (await handle.requestPermission?.(opt)) === 'granted' : false;
  } catch { return false; }
}
/** Find a file by name (and size) inside a folder, a few levels deep. */
async function findIn(dir, name, size, depth = 4) {
  const want = name.toLowerCase(), subs = [];
  for await (const [n, h] of dir.entries()) {
    if (h.kind === 'file' && n.toLowerCase() === want) { const f = await h.getFile(); if (!size || f.size === Number(size)) return f; }
    else if (h.kind === 'directory' && depth > 0 && !n.startsWith('.')) subs.push(h);
  }
  for (const s of subs.slice(0, 200)) { const f = await findIn(s, name, size, depth - 1).catch(() => null); if (f) return f; }
  return null;
}
async function check(file, fp) { return file && (!fp || await sha256(file) === fp) ? file : null; }

/**
 * Try the places this computer remembers for the file: its own file handles, then the folders to search.
 * ask: may ask the browser for permission again (needs a click). Returns the File or null.
 */
export async function fromPlaces({ sha256: fp, name, size }, { ask = false } = {}) {
  for (const e of await library.getPlaces(fp).catch(() => [])) {
    if (!(await permitted(e.handle, ask))) continue;
    try {
      const f = e.kind === 'file' ? await e.handle.getFile() : await findIn(e.handle, name, size);
      if (await check(f, fp)) return { file: f, place: e };
    } catch { /* moved or deleted */ }
  }
  for (const e of await library.getPlaces('folders').catch(() => [])) {
    if (!(await permitted(e.handle, ask))) continue;
    try { const f = await findIn(e.handle, name, size); if (await check(f, fp)) return { file: f, place: e }; } catch { /* folder gone */ }
  }
  return null;
}
/** Choose the file with the system picker (keeps a handle, so this computer finds it again). */
export async function pickFile(name) {
  const [h] = await window.showOpenFilePicker({ multiple: false, id: 'dwfx-files', ...(name ? { suggestedName: name } : {}) });
  return { file: await h.getFile(), handle: h, kind: 'file' };
}
/** Choose a folder (local, or a synced SharePoint / OneDrive folder) and find the file in it. */
export async function pickFolder({ name, size }) {
  const h = await window.showDirectoryPicker({ id: 'dwfx-folders', mode: 'read' });
  const file = await findIn(h, name, size);
  return { file, handle: h, kind: 'dir' };
}
/** Remember where this computer found the file: locally (handle) and in the project (path text). */
export async function remember(fp, { handle, kind, path, label, projectId, linkKind = 'local', folderForAll = false }) {
  if (handle) {
    await library.addPlace(fp, { handle, kind, name: handle.name, path: path || handle.name }).catch(() => {});
    if (kind === 'dir' && folderForAll) await library.addPlace('folders', { handle, kind, name: handle.name, path: path || handle.name }).catch(() => {});
  }
  if (path) await savePath(fp, { path, kind: linkKind, label, projectId }).catch(() => {});
}
