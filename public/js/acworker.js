// Auto Count search in a worker, so the page stays responsive while a whole drawing is searched.
import { findMatches } from './autocount.js';
self.onmessage = (e) => {
  try { const { img, tpl, opts } = e.data; self.postMessage({ ok: true, matches: findMatches(img, tpl, opts) }); }
  catch (err) { self.postMessage({ ok: false, error: err.message }); }
};
