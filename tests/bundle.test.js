import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildBundles } from '../src/bundle.js';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('the task pane and the 3D window are bundled, and the pages point at the bundles', async () => {
  const b = await buildBundles(pub, { log: () => {} });
  assert.ok(b, 'bundle built');
  const tp = b.pages.get('taskpane.html'), win = b.pages.get('viewer.html');
  const src = (h) => h.match(/<script type="module" src="(\/dist\/[^"]+)"/)?.[1];
  assert.ok(b.files.get(src(tp))?.immutable);
  assert.ok(b.files.get(src(win))?.immutable);
  // workers keep their names, next to the bundles, because the code finds them relative to itself
  assert.equal(b.files.get('/dist/procworker.js')?.immutable, false);
  assert.ok(b.files.get('/dist/acworker.js'));
});
