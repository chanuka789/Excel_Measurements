// Drawing viewer: PDFs (pdf.js), images and DWFx 2D sheets (converted to SVG on the server).
// Opens over the task pane, or side by side with the 3D model in the large 3D window.
import { $, esc, api } from './core.js';

let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  return pdfjs;
}

/**
 * Show a drawing. d: { id, name, content_type } from the project's drawings list.
 * host: the element to render into (defaults to the full-screen overlay).
 */
export async function openDrawing(d, host = null) {
  const overlay = !host;
  const box = host || $('drawingViewer');
  box.hidden = false;
  box.innerHTML = `<div class="dv-bar"><strong title="${esc(d.name)}">${esc(d.name)}</strong>
      <button class="btn small" data-z="-1" aria-label="Zoom out">−</button><span class="small" id="dvZoom">100%</span><button class="btn small" data-z="1" aria-label="Zoom in">+</button>
      <button class="btn small" data-z="0">Fit width</button>
      <span class="small" id="dvPages"></span>
      ${overlay ? '<button class="btn small" id="dvClose">Close</button>' : ''}</div>
    <div class="dv-body" id="dvBody" tabindex="0"><div class="loading">Loading drawing…</div></div>`;
  const body = box.querySelector('#dvBody');
  if (overlay) { box.querySelector('#dvClose').onclick = () => { box.hidden = true; box.innerHTML = ''; }; box.querySelector('#dvClose').focus(); }
  box.onkeydown = (e) => { if (e.key === 'Escape' && overlay) box.querySelector('#dvClose')?.click(); };
  let zoom = 1, render = null;
  const setZoom = (z) => { zoom = Math.min(Math.max(z, 0.1), 8); box.querySelector('#dvZoom').textContent = Math.round(zoom * 100) + '%'; render?.(); };
  box.querySelectorAll('[data-z]').forEach(b => b.onclick = () => {
    const k = +b.dataset.z; if (k === 0) fitWidth(); else setZoom(zoom * (k > 0 ? 1.25 : 0.8));
  });
  body.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
  let fitWidth = () => {};
  try {
    const res = await api('GET', d.kind === 'sheet' ? `/versions/${d.versionId}/sheets/${d.index}` : `/drawings/${d.id}/file`, null, { raw: true });
    const type = res.headers.get('content-type') || d.content_type || '';
    const name = d.name.toLowerCase();
    if (/pdf/.test(type) || name.endsWith('.pdf')) {
      const lib = await loadPdfJs();
      const doc = await lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
      box.querySelector('#dvPages').textContent = `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;
      const first = await doc.getPage(1); const base = first.getViewport({ scale: 1 });
      fitWidth = () => setZoom((body.clientWidth - 32) / base.width);
      let token = 0;
      render = async () => {
        const my = ++token; body.innerHTML = '';
        for (let i = 1; i <= Math.min(doc.numPages, 60); i++) {
          if (my !== token) return;
          const page = await doc.getPage(i), vp = page.getViewport({ scale: zoom * (window.devicePixelRatio || 1) });
          const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
          c.style.width = vp.width / (window.devicePixelRatio || 1) + 'px'; c.setAttribute('aria-label', `Page ${i}`);
          body.append(c);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }
        if (doc.numPages > 60) body.insertAdjacentHTML('beforeend', '<p class="hint">Only the first 60 pages are shown. Download the file for the rest.</p>');
      };
      fitWidth();
    } else if (/svg/.test(type)) {
      const text = await res.text();
      const holder = document.createElement('div'); holder.innerHTML = text;
      const el = holder.querySelector('svg'); el.removeAttribute('width'); el.removeAttribute('height');
      const vb = (el.getAttribute('viewBox') || '0 0 1000 700').split(/[ ,]+/).map(Number);
      fitWidth = () => setZoom((body.clientWidth - 32) / vb[2]);
      render = () => { body.innerHTML = ''; el.style.width = vb[2] * zoom + 'px'; el.style.height = vb[3] * zoom + 'px'; body.append(el); };
      fitWidth();
    } else if (/image\//.test(type) || /\.(png|jpe?g|gif|webp)$/.test(name)) {
      const url = URL.createObjectURL(await res.blob());
      const img = new Image(); img.alt = d.name; img.src = url; await img.decode();
      fitWidth = () => setZoom((body.clientWidth - 32) / img.naturalWidth);
      render = () => { body.innerHTML = ''; img.style.width = img.naturalWidth * zoom + 'px'; body.append(img); };
      fitWidth();
    } else {
      body.innerHTML = `<div class="empty">This file type cannot be shown here. Download it to open it in its own program.</div>`;
    }
  } catch (err) { body.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
}
export const canView = (name) => /\.(pdf|png|jpe?g|gif|webp|svg)$/i.test(name || '');
