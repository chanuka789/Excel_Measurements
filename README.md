# DWFx Structural - Excel add-in

View a Revit DWFx structural model in 3D inside Excel, linked to the structural
Measurement sheet and BOQ (same format as the `dfwx-structurel` skill).

## What it does
- Open a `.dwfx` file in the Excel task pane. The server measures it and decodes the 3D model.
- **Create sheets in Excel** adds `Read Me`, `BOQ`, `Measurement` and `Rates` to the open workbook
  (all quantities are formulas, the same as the skill output).
- Click an element in 3D: it turns amber and the matching row is selected in the Measurement sheet.
- Select rows in the Measurement sheet: those elements are highlighted in 3D.
- Select a BOQ item: every element in that item (for example all 200 mm ground slabs) is highlighted.
- **Isolate** shows only the selected elements. **Show all** brings everything back.
- The colour legend is also a filter (click a type to show only that type). The level list filters by level.
- Claude in Excel can read the Measurement and BOQ sheets like any other sheets.

## Run locally
```bash
npm install
pip install openpyxl
npm start            # http://localhost:3000
```
Excel needs HTTPS for add-ins, so for Excel use Railway (below) or a local HTTPS dev certificate.

## Live deployment
- App: https://dwfx-addin-production.up.railway.app
- Railway project: `excel-measurements`, service `dwfx-addin` (deploys on every push to `main`).
- `manifest.xml` already points to the live address.

## Deploy on Railway (from scratch)
1. Put this folder in a private GitHub repository.
2. Railway > New Project > Deploy from GitHub repo. Railway uses the `Dockerfile` (Node + Python).
3. Settings > Networking > Generate domain. You get `https://<name>.up.railway.app`.
4. Optional but recommended for client models: add a variable `APP_TOKEN` (a password).
   Users type it in the "Access code" field.
5. In `manifest.xml`, replace every `https://YOUR-APP.up.railway.app` with your domain.

## Add it to Excel
- **Excel on the web:** Home > Add-ins > More add-ins > My Add-ins > Upload My Add-in > choose `manifest.xml`.
- **Excel desktop (Windows):** put `manifest.xml` in a shared network folder, add that folder in
  File > Options > Trust Center > Trust Center Settings > Trusted Add-in Catalogs, restart Excel,
  then Home > Add-ins > Shared Folder.
- **Company-wide:** your Microsoft 365 admin can deploy the manifest from the admin centre.

The button "DWFx 3D model" appears on the Home tab.

## Requirements and limits
- Excel API 1.9 for selection linking; 1.13 for "Create sheets in Excel"
  (older Excel: use "Download Excel file" and copy the sheets).
- Models are processed on the server and deleted straight after; nothing is stored.
- 3D geometry is decoded with the open-source `dwf-viewer` package (AGPL-3.0). That is fine for
  your own or internal use. If you sell or offer this as a service to other companies, the AGPL
  requires you to share the source code of the whole app - get advice first.
- Tested on one Revit 2023 structural DWFx: 435 of 438 measured elements shown in 3D
  (two hollow equipment bases and the LWC step have no decoded geometry).
