// One bundled, minified file per page (task pane, measurement window, DWFx Schedules window) instead of ~45 separate modules, built in memory when the
// server starts. The bundles have content-hashed names, so Excel keeps them for a year and only downloads a new one
// after a deploy; the HTML pages are never cached, so they always point at the newest bundle.
// Workers (model processing, Auto Count) are built under their own names next to the bundles, because the code finds
// them with new URL('./procworker.js', import.meta.url). If the build fails, the plain files are served as before.
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';

const PAGES = { taskpane: { html: 'taskpane.html', entry: 'taskpane.js', tag: '<script type="module" src="taskpane.js"></script>' },
  window: { html: 'viewer.html', entry: 'js/window.js', tag: '<script type="module" src="js/window.js"></script>' },
  schedules: { html: 'schedules.html', entry: 'js/schedwin.js', tag: '<script type="module" src="js/schedwin.js"></script>' } };
const WORKERS = ['js/procworker.js', 'js/acworker.js', 'js/cadlocal.js'];

/** Build the bundles. Returns { files: Map(url → { body, type, immutable }), pages: Map(html name → rewritten html) } or null. */
export async function buildBundles(publicDir, { log = console.log } = {}) {
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { log('Bundling skipped: esbuild is not installed.'); return null; }
  const t0 = Date.now();
  const common = { absWorkingDir: publicDir, bundle: true, format: 'esm', minify: true, target: 'es2022', write: false, outdir: path.join(publicDir, 'dist'),
    external: ['/vendor/*', '/py/*'], logLevel: 'silent', legalComments: 'none', charset: 'utf8' };
  try {
    const [main, workers] = await Promise.all([
      esbuild.build({ ...common, entryPoints: Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, p.entry])), splitting: true, entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]' }),
      esbuild.build({ ...common, entryPoints: Object.fromEntries(WORKERS.map(w => [path.basename(w, '.js'), w])), entryNames: '[name]' }),
    ]);
    const files = new Map(), pages = new Map(), entry = {};
    for (const [out, immutable] of [[main, true], [workers, false]]) {
      for (const f of out.outputFiles) {
        const url = '/dist/' + path.basename(f.path);
        const body = Buffer.from(f.contents);
        files.set(url, { body, gz: zlib.gzipSync(body, { level: 9 }), type: 'text/javascript; charset=utf-8', immutable });
        const k = Object.keys(PAGES).find(n => path.basename(f.path).startsWith(n + '-'));
        if (k && immutable) entry[k] = url;
      }
    }
    for (const [k, p] of Object.entries(PAGES)) {
      const html = fs.readFileSync(path.join(publicDir, p.html), 'utf8');
      if (!entry[k] || !html.includes(p.tag)) throw new Error(`Could not place the bundle in ${p.html}.`);
      pages.set(p.html, html.replace(p.tag, `<script type="module" src="${entry[k]}"></script>`));
    }
    const kb = Math.round([...files.values()].reduce((s, f) => s + f.body.length, 0) / 1024);
    const gz = Math.round([...files.values()].reduce((s, f) => s + f.gz.length, 0) / 1024);
    log(`App bundled in ${Date.now() - t0} ms (${files.size} files, ${kb} KB, ${gz} KB gzipped).`);
    return { files, pages };
  } catch (err) {
    log('Bundling failed, serving the separate files: ' + (err.errors?.[0]?.text || err.message));
    return null;
  }
}

/** Express middleware: the bundled pages and files (call before express.static). */
export function serveBundles(b) {
  return (req, res, next) => {
    if (!b) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = req.path === '/' ? 'taskpane.html' : req.path.slice(1);
    if (b.pages.has(name)) { res.type('html').send(b.pages.get(name)); return; }
    const f = b.files.get(req.path);
    if (!f) return next();
    res.setHeader('Cache-Control', f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    res.type(f.type);
    if (req.acceptsEncodings('gzip')) { res.setHeader('Content-Encoding', 'gzip'); res.end(req.method === 'HEAD' ? undefined : f.gz); return; }   // gzipped once at start-up
    res.send(f.body);
  };
}
