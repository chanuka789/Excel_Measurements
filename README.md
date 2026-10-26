# DWFx Measure - Excel add-in

A **measurement app** for Excel. Measure 2D drawings (PDF, DWG, DXF, images, DWFx 2D sheets) and 3D models (DWFx)
in a separate window that works like **RIB CostX**, and link the measurements to workbook cells with **live formulas**.
DWFx quantity **schedules** are a separate tool in their own window. Drawings and models stay **on your computer** and
are processed there, with your computer's power; the server (Railway) stores only the projects, the team, the
measurements and saved take-offs, plus each file's name, size, fingerprint and the **paths** where each computer keeps it.

Live: https://dwfx-addin-production.up.railway.app (Railway project `excel-measurements`, deploys on every push to `main`).

## Using it
Excel shows a **DWFx Measure** tab on the ribbon:

| Group | Buttons |
|---|---|
| Measure | Measurements (task pane list), Measurement Window, Projects |
| Excel links | Link to Cell, Follow Excel (on/off), Refresh Links, Share Copy, Restore Links |
| DWFx schedules | DWFx Schedules (separate window) |

**Version 0.7 changes the manifest** (new buttons and the CX custom functions). Run `npm run manifest` and **add the
new `manifest.xml` to Excel once again** (remove the old add-in first), otherwise `=CX.QTY` shows `#NAME?`.

### 1. Task pane: Measurements
The pane shows the project's dimension folders and groups with live totals (and each group's dimensions). Buttons:
Open measurement window, DWFx Schedules, Link to selected cell, Show in drawing, Linked cells, **Follow Excel**, Refresh.
The **Projects** tab manages projects, models, drawings, the team and settings (Measure / Schedules buttons on each
model version, Open & measure on each drawing).

### 2. Measurement window (CostX style)
- **Ribbon** at the top: Home, Drawings, Dimensions, 3D View, Revisions, Workbooks (double-click a tab or Ctrl+F1
  collapses it). Commands include Add / Properties / Manager / Drawing Sets / Compare drawings; Working Area,
  Calibrate X and Y separately, Reset Calibration; Layers (All, Hide All, Invert, As Per File); Rotate 90/180/270,
  Zoom Extents / Area / In / Out; Display (Save View, Ghost, Wireframe / Shaded / Transparent, Text, Hatching, Line
  Weight, White, Monochrome, Markups); Dimension groups (Add, Properties, Copy, Export, Folder, Standard library,
  Delete); Dimensions (Manual, Measure, Properties, Copy / Paste, Change, Select In Area, Edit Controls, Positive /
  Negative / Both); BIM (Import, Model Maps, Schedule, Check BIM Objects, Show All); Type (Points, Faces, Object);
  Zones; Snap (Geometry, Angle); Rebar and Auto Count modes; Show (Overlaps, Measured, Legend, Labels, Properties on
  Add); 3D tools (views, section, plan, box select, x-ray, edges, colour, measure, saved views, picture); revision
  compare for drawings and models; Workbooks (Link to Cell, Workbook View, Follow Excel, Refresh Links).
- **Left pane**: Drawings / Layers / Model / Views on top; **Dimension Groups / Dimensions / Auto Count** below, with
  the "Current:" group and "Click to Filter". Folders and groups are created, renamed, moved (drag and drop) and
  deleted as in CostX. The pin hides the pane.
- **Centre**: drawing tabs, the 3D model tab and the **Workbook View** (every linked cell, Go to cell, Show, Remove link).
- **Status bar**: current group total, cursor position in drawing units, scale, snap, links.

### 3. Live links between Excel and measurements (both ways)
- Select a cell in Excel, then **drag** a group or a dimension onto the "Link to selected cell" bar (Excel does not
  accept a drop straight into a cell from an add-in), **double-click** it, or press **Link to Cell**. The cell gets a
  live formula: `=CX.QTY("1a2b3c4d")` (group total), `=CX.VALUE("1a2b3c4d","9f8e7d6c")` (one dimension),
  `=CX.QTY(ref,"Count")`, `=CX.NAME(ref)`, `=CX.UNIT(ref)`. The reference is the start of the group id, so renaming
  or moving the group keeps the link. Values update while you measure. Schedules made from dimension groups write
  their measured rows as live links too.
- **Excel → drawing**: with **Follow Excel** on, a click on a linked cell opens the drawing (or the 3D model) and
  highlights where it was measured. **Drawing → Excel**: selecting a group or a dimension selects its linked cells.
- Follow Excel can be switched off; the links always stay. They are listed in a very hidden `_cxlinks` sheet.
- **Sending the workbook to someone without the add-in**: people without it see `#NAME?` in linked cells. Press
  **Share Copy**: every CX formula becomes its current number (other formulas are not touched) and the formulas are
  kept in a very hidden `_cxshared` sheet. Then File › Save a Copy and send that copy, and press **Restore Links** to
  make the links live again (cells someone typed over are left as they are).

### 4. DWFx Schedules window (separate from measuring)
Choose a model version, select elements (tree, 3D, search, zones), pick the **data columns** (category, family,
type, level, mark, zone) and the **quantities each element really has** (Revit, exact Geo / FW geometry, type-name
sizes, openings), then add **calculated columns in the same table**: Formwork (all free faces, no double counting),
Reinforcement (volume × rate, the rate is a yellow cell), tonnes, or any formula. Volume, formwork and reinforcement
of the same elements are always one table. **Export schedule to Excel** writes it with live formulas; Summary sheets
(Quantities register + pivot by level or zone) are built by formulas. The **AI** tab selects elements and builds
schedules on request; nothing is written until you press Run or Export. No NRM / POMI formats are used.

### 5. Several paths for the same file (more than one computer)
Each drawing or model can have many paths: a local folder, a **SharePoint or OneDrive folder synced to the computer**
(works like a local folder), or a **SharePoint link**. When a computer does not have a file, the add-in first tries
the places that computer remembers, then shows every saved path (all computers) with **Choose the file…** and
**Choose a folder…**. The new path is saved; older paths are never removed, so going back to a previous computer
uses its path again. Drawing Manager > **Paths** lists, adds and removes paths. Notes:
- A browser add-in cannot open a typed path by itself: the user picks the file or folder once per computer, and the
  browser may ask for permission again in a new session. The fingerprint must match.
- **SharePoint links** open in the browser (to download or sync); direct download through Microsoft Graph is not
  built in, because it needs an Azure app registration on your tenant. Syncing the SharePoint library with OneDrive
  is the recommended setup.

### 6. Speed
Everything is processed on the computer (models in a worker, CAD to SVG once, cached). The 3D view lowers its
resolution while you orbit and redraws sharp when you stop; PDFs show a quick preview first, render only the visible
page (and a sharp detail when zoomed), and keep the last pages in memory.

**DWG reading uses LibreDWG** (`@mlightcad/libredwg-web`, GPL-3.0) on the server only, in a worker thread; it is never
sent to browsers. DXF uses `dxf-parser` (MIT). Some DWG versions (for example 2000) cannot be read by this build: users
get a message to save the file as DWG 2013-2018, DXF or PDF. Check that the GPL licence fits how you distribute the app.

**One table for the same elements**: schedules of exactly the same elements (Schedules window, templates, AI or
dimension groups) are added as new columns to the existing table.

## Exact geometry quantities
Every element with 3D geometry gets quantities measured from its faces: **Geo volume** (closed solids only),
**Geo bottom area** (soffits, undersides), **Geo top area**, **Geo side area** (all vertical faces: formwork to
sides and edges), **Geo plan area**, **Geo surface area** and bounding-box length/width/height. Walls get **Openings
area / count / to deduct** from the doors and windows in them (openings up to the project threshold, default
0.5 m², are not deducted). On the structural sample, geometry volumes match Revit within 0.1% for slabs, walls,
foundations and columns.

## Users (development: no Microsoft sign-in)
Users are listed in the Railway variable **`APP_USERS`**, one per line:

```
email | full name | role | password hash
chanuka789@gmail.com | Chanuka Mudiyanselage | admin | scrypt$...
colleague@company.com | A Colleague | user | scrypt$...
```

- `role` is `admin` (sees the Admin tab and every project) or `user`.
- Make a password hash in the add-in (**Admin > Create a password hash**, copies the full line) or locally with
  `npm run hash-password -- "the password"`. Passwords are never stored, only the hash.
- Saving the variable restarts the app and updates users. Removing a line disables that user and signs them out;
  their projects stay. Microsoft sign-in is planned as an optional later step and is not configured.

## Files stay on your computer
- **Add DWFx** and **Add** (drawings) keep the files in the add-in's library on this computer (the browser's
  IndexedDB for the add-in's address, shared by the task pane and the 3D window). Models are processed here with this
  computer's power (Python in the browser, Pyodide), so nothing heavy runs on Railway and the model opens quickly next time.
- The project on the server gets only the name, size and **SHA-256 fingerprint** of each file, the model's summary
  numbers (elements, categories, sheets) and your measurements.
- **Teammates**: send them the file. When they open it, the add-in asks them to choose it (or they add it under
  **On this computer > Add files you received**). The fingerprint must match, so everybody measures the same file.
- **On this computer** (project page): what is kept here, the space used, *Clear processed* and *Remove*.
- DXF files are read on the computer. DWG files are converted on the server for that one request (LibreDWG is GPL and
  stays on the server); the server keeps nothing. Revision compare runs on the computer. The AI gets the elements with
  each request and keeps none. **Quick open** reads the file on this computer too.
- Files added before this change are still on the server and open as before (a copy is kept here after the first
  open). An owner can press **Keep on computers only**: the file is saved on this computer and the server copy deleted.
- The browser can clear site data when the disk is very full; the add-in asks it to keep the library
  (`navigator.storage.persist`). If a file is gone, the add-in asks for it again.

## Railway setup
| Service | What it is |
|---|---|
| `dwfx-addin` | This repo (`node server.js`). Serves the add-in and the API. |
| `Postgres` | Projects, users, versions, take-offs, audit log, job queue. |
| Bucket | Railway storage bucket for daily backups, audit PDFs and files added before they were kept on the computers. |
| `dwfx-worker` (optional) | Same repo, start command `node worker.js`; then set `WORKER_IN_API=0` on `dwfx-addin`. |

Variables on `dwfx-addin` (and the worker):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `APP_USERS` | see above |
| `BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`, `AWS_DEFAULT_REGION` | from the bucket's credentials (Railway can reference them). Without a bucket, files go to `LOCAL_STORAGE_DIR` (development only; lost on redeploy). |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | optional AI, see below |
| `WORKER_IN_API` | `1` (default) runs processing inside the web service; `0` when a separate worker runs |
| `SESSION_DAYS` | optional, default 30 |
| `CSP_MODE` | optional: `enforce` (default), `report` or `off` (Content Security Policy) |
| `RATE_LIMIT_PER_MIN` | optional API limit per user, default 600 |
| `LOGIN_LIMIT_PER_IP` | optional sign-in attempts per IP per 15 minutes, default 20 |

Storage layout: `backups/YYYY-MM-DD.json.gz` (database backup every day, last 30 kept), `projects/{project}/exports/...`
(audit PDFs) and, for files added before, `projects/{project}/models/{model}/v{n}/source.dwfx` + `model.json.gz` and
`projects/{project}/drawings/...`. New files are not stored (`location = 'local'`).

The app code is bundled and minified with esbuild when the server starts (one file per page, cached by the browser for
a year, a new name after each deploy); set `BUNDLE=0` to serve the separate files while developing.

## AI settings
| Variable | DeepSeek | Meta Muse Spark via OpenRouter |
|---|---|---|
| `AI_BASE_URL` | `https://api.deepseek.com` | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | DeepSeek model id | Muse Spark 1.3 model id shown on OpenRouter |
| `AI_API_KEY` | your DeepSeek key | your OpenRouter key |

More providers at once: `DEEPSEEK_API_KEY` (+ `DEEPSEEK_MODEL`), `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`) or
`AI_PROVIDERS` (JSON list of `{id, label, base, model, keyEnv}`). The admin picks the active provider, an optional
model override and the daily limit per user in **Admin > AI assistant**; a project owner can switch the AI off
for one project. Only names, counts, levels, quantity names and test totals are sent, never the file or geometry.

**QS test set**: Admin > AI assistant > *Run the test set on the open model* sends the 50 requests in
`tests/ai-eval.json` through the AI on the structural sample and scores the plans (target 45/50). Run it after
changing provider or model.

## Add to Excel
- Excel on the web: Home > Add-ins > More add-ins > My Add-ins > Upload My Add-in > `manifest.xml`.
- Excel desktop (Windows): put `manifest.xml` in a shared folder, add the `\\PC\folder` path in
  Trust Center > Trusted Add-in Catalogs (tick Show in Menu), restart Excel, Home > Add-ins > Shared Folder.
- After a manifest change (new ribbon), remove the add-in and add it again, or clear the Office cache
  (`%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\`) and restart Excel.
- The ribbon needs Microsoft 365 Excel (shared runtime). Older Excel versions still open the task pane.

## Help, security and IT
- User guide with 5 short training videos: `/help/` (Help button on the ribbon, the user menu and the sign-in screen).
- `docs/IT-deployment-pack.md`: install, network domains, data flow, privacy note. `docs/SECURITY.md`: security review and load test.
- Errors: users see a reference code; admins see the error log in **Admin > Errors** (kept 90 days).
- Worker health (separate service): `GET /health` on the worker's `PORT`.
- Load test: `BASE=https://... EMAIL=... PASSWORD=... USERS=50 SECONDS=60 node scripts/loadtest.mjs`.

## Development
```
npm ci
pip install openpyxl==3.1.5
DATABASE_URL=postgres://... APP_USERS="..." npm start      # http://localhost:3000
npm test                                                    # needs TEST_DATABASE_URL (Postgres)
npm run icons                                               # redraw ribbon icons
npm run manifest                                            # rebuild manifest.xml (ribbon)
```

## Units and accuracy
- Lengths are converted from mm to metres; areas m2, volumes m3.
- Revit exports areas/volumes rounded to the model's project-unit precision. For walls the add-in also gives
  **Face area (L x H)** from length x unconnected height.
- Elements without decoded 3D geometry can still be measured from the browser.

## Notes
- Known limitation: in some DWFx files a few elements that reuse one library shape (e.g. rooftop equipment bases) get
  the shape of a neighbouring instance; their Revit quantities are unaffected. 9 of 480 elements in the sample.
- 3D geometry is decoded with the open-source `dwf-viewer` package (AGPL-3.0); fine for own/internal use.
- `py/dwfx_structural.py` is the structural measurement + BOQ generator (also available as a Claude skill).
- Never commit client DWFx files: this repository is public.
