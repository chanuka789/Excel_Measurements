# DWFx Measure - Excel add-in

View any Revit DWFx model (architecture, structure, interiors, MEP) in 3D inside Excel, browse its elements
like CostX, and send measurements to a **Take-off** sheet. An optional AI assistant turns plain-English
requests into element selections; the add-in always calculates the numbers itself from the model.

Live: https://dwfx-addin-production.up.railway.app (Railway project `excel-measurements`, service `dwfx-addin`,
deploys on every push to `main`).

## Using it
1. Home tab > **DWFx 3D model** > enter the access code > open a `.dwfx`.
2. **Elements** tab: Category > Family > Type > element tree with counts. Tick boxes select elements
   (shown amber in 3D). Search by type, family or Revit ID; filter by level. Click a name to zoom to it.
3. Click elements in 3D (Ctrl+click to add). **Isolate** shows only ticked elements.
4. **Measure** tab: totals of every quantity found on the ticked elements (Count, Area, Length, Volume,
   Perimeter, ...). Tick the ones you need, name the group, choose sub-totals by Type or Level,
   then **Add to Excel take-off**. Each group is added below the last one (G1, G2, ...) with SUBTOTAL formulas.
5. Selecting rows in the Take-off sheet highlights those elements in 3D; selecting a G-title row highlights the group.
6. **AI** tab: e.g. "measure internal walls on the first floor, area and length by type". Review the proposed
   groups, then **Add to Excel**.

## Units and accuracy
- Lengths are converted from mm to metres; areas m2, volumes m3.
- Revit exports areas/volumes rounded to the model's project-unit precision (often whole m2). For walls the
  add-in also gives **Face area (L x H)** from length x unconnected height.
- Elements without decoded 3D geometry can still be measured from the browser.

## AI settings (Railway > service > Variables)
| Variable | DeepSeek | Meta Muse Spark via OpenRouter |
|---|---|---|
| `AI_BASE_URL` | `https://api.deepseek.com` | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | `deepseek-flash` | Muse Spark 1.3 model id shown on OpenRouter |
| `AI_API_KEY` | your DeepSeek key | your OpenRouter key |

Any OpenAI-compatible chat API works. Only a summary of the model (category/family/type names, counts, levels
and quantity names) is sent to the AI, never element values or geometry.

## Other settings
- `APP_TOKEN`: access code users type in the pane.

## Add to Excel
- Excel on the web: Home > Add-ins > More add-ins > My Add-ins > Upload My Add-in > `manifest.xml`.
- Excel desktop (Windows): put `manifest.xml` in a shared folder, add the `\\PC\folder` path in
  Trust Center > Trusted Add-in Catalogs (tick Show in Menu), restart Excel, Home > Add-ins > Shared Folder.

## Notes
- 3D geometry is decoded with the open-source `dwf-viewer` package (AGPL-3.0); fine for own/internal use.
- `py/dwfx_structural.py` is the structural measurement + BOQ generator (also available as a Claude skill).
