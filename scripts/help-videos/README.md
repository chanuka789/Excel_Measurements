# Help videos (recorded inside a mock Excel window)

The videos in `public/help/media` are recorded with Playwright in a 16:9 Excel-like window
(`excel-frame.html`: ribbon with the real DWFx Measure buttons, live worksheet, task pane, floating 3D window).
Names are neutral: project "Project XXXXX", user "QS User", demo DWFx `Project-XXXXX-Structure.dwfx`
(never commit a client DWFx; make an anonymised copy first).

1. Start a demo server on an empty database (`recserver.sh`) and the mock AI (`mockai.mjs`, port 3099).
2. Edit `SP` / paths at the top of `lib.mjs` and `enc.sh` for your machine; `officesim-frame.js` is the Office.js simulator.
3. Run `node v01.mjs` ... `v07.mjs` in order (v05 last), then `enc.sh` (VP9, 1280x720).
