# DWFx Measure - Excel add-in

View any Revit DWFx model (architecture, structure, interiors, MEP) in 3D inside Excel, browse its elements
like CostX, and send measurements to a **Take-off** sheet with live formulas. Models, drawings and saved
take-offs are stored on the server per user and per project. An optional AI assistant works out QS
measurement methods; the add-in always calculates the numbers itself from the model.

Live: https://dwfx-addin-production.up.railway.app (Railway project `excel-measurements`, deploys on every push to `main`).

## Using it
After adding the add-in, Excel shows a **DWFx Measure** tab on the ribbon:

| Group | Buttons |
|---|---|
| Project | Projects, Refresh |
| Model | Elements, Zones, 3D window |
| 3D view | Fit view, Views, Section box, Level plan, Saved views |
| Select | Isolate, Hide, Show all, Box select, Clear selection, Select from Excel |
| Measure | Measure, Templates, Distance and area, Colour by, Measured status |
| AI | Ask AI, Check take-off |
| Revisions | Compare revisions, Update take-off |
| Output | Build BOQ, Audit PDF, Model checks, Admin |
| Help | Help and training videos |

1. **Sign in** with the email and password your administrator gave you.
2. **Project** tab: create a project, upload DWFx models (the same model name makes a new version), drawings
   (PDF and images open in the built-in viewer; 2D sheets inside a DWFx are converted automatically), add
   colleagues as Owner / Editor / Viewer, project settings (AI off switch, opening deduction threshold, BOQ house
   style), project QS rules, export as ZIP.
3. **3D view** (toolbar above the tabs): view cube and standard views (keys 1-7), perspective or orthographic,
   section box, level plan (top view cut at a set height), box select (left-to-right inside, right-to-left
   crossing), distance and face-area measure with snapping, colour by category / level / type / material / zone /
   property / value / measured status / revision changes (click a legend row to select), x-ray, edges, saved views
   for the team, picture into the sheet, and the **3D window** (large window for a second screen, with drawings and
   properties side by side; selection stays linked).
4. **Elements** tab: Category > Family > Type > element tree, search, level filter, undo/redo (Ctrl+Z / Ctrl+Y),
   **zones** (named sets of elements: create from the selection, colour by zone, sub-total by zone).
   Right-click an element for its properties, including exact **Geo** quantities measured from the 3D faces.
5. **Measure** tab: choose quantities (Revit, geometry, type-name sizes, openings), add formula columns, sub-totals by
   type / level / zone / category, then **Add to Excel take-off**. **Templates and discipline packs**: ready methods
   for Structure, Architecture, Interiors and MEP plus your own saved methods; apply to any model.
6. **AI** tab: the AI searches the model, reads the real quantities, tests its formulas on the elements and checks
   the QS rules before it proposes a method. "How the AI worked it out" shows its steps. Save good methods as templates.
7. **Review** tab: missing-data report, overlapping concrete, measured status, **AI take-off check**, **revision
   compare** (added / removed / changed, quantity differences, colour in 3D), **update take-off** to a new
   revision (in place, keeps formulas and your assumption values, writes a Change log sheet), **BOQ sheet** (linked
   to named take-off totals; rates you type are kept when you rebuild; optional AI descriptions), **audit PDF**.

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

## Railway setup
| Service | What it is |
|---|---|
| `dwfx-addin` | This repo (`node server.js`). Serves the add-in and the API. |
| `Postgres` | Projects, users, versions, take-offs, audit log, job queue. |
| Bucket | Railway storage bucket for DWFx files, processed model data, drawings and daily backups. |
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

Storage layout: `projects/{project}/models/{model}/v{n}/source.dwfx` + `model.json.gz`,
`projects/{project}/drawings/...`, `backups/YYYY-MM-DD.json.gz` (database backup every day, last 30 kept).

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
