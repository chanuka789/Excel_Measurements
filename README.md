# DWFx Measure - Excel add-in

View any Revit DWFx model (architecture, structure, interiors, MEP) in 3D inside Excel, browse its elements
like CostX, and send measurements to a **Take-off** sheet with live formulas. Models, drawings and saved
take-offs are stored on the server per user and per project. An optional AI assistant works out QS
measurement methods; the add-in always calculates the numbers itself from the model.

Live: https://dwfx-addin-production.up.railway.app (Railway project `excel-measurements`, deploys on every push to `main`).

## Using it
1. After adding the add-in, Excel shows a **DWFx Measure** tab on the ribbon:
   Project (Projects, Refresh) · Model (Elements) · 3D view (Fit, Show all, Isolate, Clear selection) ·
   Measure (Measure, Select from Excel) · AI (Ask AI) · Admin.
2. **Sign in** with the email and password your administrator gave you.
3. **Project** tab: create a project, upload DWFx models (each upload with the same model name becomes a new
   version), upload drawings, add colleagues as Owner / Editor / Viewer, export everything as a ZIP.
   Uploaded models are processed on the server; press **Open** when the version shows *Ready*.
4. **Elements** tab: Category > Family > Type > element tree with counts, search and level filter.
   Tick elements or click them in 3D (Ctrl+click adds). **Isolate** shows only the selection.
   **Right-click** an element to see all its properties.
5. **Measure** tab: choose quantities, add your own formula columns, then **Add to Excel take-off**.
   Each group is added below the last one (G1, G2, ...) with SUBTOTAL formulas, and a copy is saved to the
   project (**Saved take-off groups** on the Project tab, with **Restore** into any workbook).
6. Selecting rows in the Take-off sheet highlights those elements in 3D (or use **Select from Excel** on the ribbon).
7. **AI** tab: e.g. "formwork to beams on Level 1". The AI returns the method, inputs, assumptions and formulas;
   assumptions go in yellow Excel cells, formula columns have green headers.

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

Storage layout: `projects/{project}/models/{model}/v{n}/source.dwfx` + `model.json.gz`,
`projects/{project}/drawings/...`, `backups/YYYY-MM-DD.json.gz` (database backup every day, last 30 kept).

## AI settings
| Variable | DeepSeek | Meta Muse Spark via OpenRouter |
|---|---|---|
| `AI_BASE_URL` | `https://api.deepseek.com` | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | DeepSeek model id | Muse Spark 1.3 model id shown on OpenRouter |
| `AI_API_KEY` | your DeepSeek key | your OpenRouter key |

Any OpenAI-compatible chat API works. Only a summary of the model (category/family/type names, counts, levels
and quantity names) is sent to the AI, never geometry.

## Add to Excel
- Excel on the web: Home > Add-ins > More add-ins > My Add-ins > Upload My Add-in > `manifest.xml`.
- Excel desktop (Windows): put `manifest.xml` in a shared folder, add the `\\PC\folder` path in
  Trust Center > Trusted Add-in Catalogs (tick Show in Menu), restart Excel, Home > Add-ins > Shared Folder.
- After a manifest change (new ribbon), remove the add-in and add it again, or clear the Office cache
  (`%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\`) and restart Excel.
- The ribbon needs Microsoft 365 Excel (shared runtime). Older Excel versions still open the task pane.

## Development
```
npm ci
pip install openpyxl==3.1.5
DATABASE_URL=postgres://... APP_USERS="..." npm start      # http://localhost:3000
npm test                                                    # needs TEST_DATABASE_URL (Postgres)
npm run icons                                               # redraw ribbon icons
```

## Units and accuracy
- Lengths are converted from mm to metres; areas m2, volumes m3.
- Revit exports areas/volumes rounded to the model's project-unit precision. For walls the add-in also gives
  **Face area (L x H)** from length x unconnected height.
- Elements without decoded 3D geometry can still be measured from the browser.

## Notes
- 3D geometry is decoded with the open-source `dwf-viewer` package (AGPL-3.0); fine for own/internal use.
- `py/dwfx_structural.py` is the structural measurement + BOQ generator (also available as a Claude skill).
- Never commit client DWFx files: this repository is public.
