# QS workflow release 0.6 — implementation and validation

This release implements the standards/workflow foundation and a reviewable automation pilot from `QS_AUTOMATION_PLAN.md`. It does not declare that every detailed measurement rule in three complete standards is implemented.

## Available in the app

- Five generated ribbon controls; the prior handlers and advanced tabs remain accessible.
- Three guided steps: filters and selection; independent heading/basis choices and grouped review; exports and links.
- Checked catalogues: 17 POMI sections including GP, 117 POMI numbered topics, 279 NRM 1 nodes through level 3, and 41 NRM 2 work sections. Browser data is generated from the versioned JSON catalogues.
- All nine primary/secondary pairs, six non-repeating three-standard heading orders and a separate quantity basis. NRM 1 cannot be selected as a detailed BOQ measurement basis.
- Conditional classification across Structure, Architecture, Interiors, MEP and Landscape, plus manual allocation to every catalogue code. The 41-section crosswalk is a conditional QS mapping, not an official equivalence table.
- Schedule parameter discovery across the selected set; itemized and grouped outputs; essential specification/dimension distinctions retained even when those columns are not selected. Numeric dimensions are not summed; missing compatible quantities remain missing.
- Saved schedule/standards presets through the existing server template library. Current profile and manual allocations are cached per user/project/model revision on the browser; they are not yet shared project rule overrides.
- Source-backed quantity ledger, processed formed-face quantities, opt-in provisional dimension formulas and explicit provisional reinforcement ratios.
- Draft CSV/Excel exports, live formula quantities and amounts, source/basis/review sheets, NRM 1 component-cost aggregation and manual non-modeled allowances for groups 0–14.
- SHA-256 item identities, stable rates across presentation changes, replacement of the batched source ledger on repeat export, and a one-to-many sheet/model registry. Basis/specification changes deliberately create new item identities rather than silently reusing prices.
- Source numbering fixes in the existing structural rule dictionary; no invented renumbering of the duplicated NRM 2 wall-face row. Unknown propping height and thickness are no longer silently treated as the lowest band.
- Workbook writes stage content before updating an existing worksheet, retain its identity for formula links, back up existing content for copy failure and check Excel limits. Schedule writes at the active cell reject occupied ranges.

## Measurement and review limits

Every Smart BOQ remains a **draft**. Heading verification is separate from quantity verification. Model geometry may already be net of openings, and shared interfaces/casting sequence need QS confirmation. No blanket opening rule is applied to all trades. The checked POMI and NRM 2 opening predicates require explicit opening topology supplied per quantity stream; absent topology produces a review message.

Simple-shape formwork formulas use explicit dimensions, are optional and always provisional. They do not perform general Boolean solid intersection or prove casting arrangements. Existing processed geometry supplies contact/overlap information where available; fallbacks and unknown data are flagged. Complex shapes, sloping/waffled slabs, attached arrangements and opening reveals need the applicable detailed rules and benchmark review.

The NRM 1 output is component-cost supporting detail plus an elemental cost summary with explicit allowances. It does not automatically generate fully validated element unit quantities/rates, overhead percentages, fees, risk percentages or inflation. Different quantity units are never added to obtain an elemental quantity.

The existing AI review remains available. Deterministic standards checks and the new review queue do not depend on AI inventing clause numbers or calculating quantities. A complete automated audit of non-modeled scope and all detailed trade rules remains an acceptance gate in the plan.

CESMM4, DW144/SMACNA rules, fully shared rule amendments/allocations and a complete validated detailed rule pack for every work section remain outside the checked pilot. Their inclusion requires the appropriate sources and QS benchmark cases.

## Validation evidence

- Full repository JavaScript/API suite passed against isolated PostgreSQL (PGlite via its TCP wire protocol). The Python geometry/packing/sheet suite passed with Shapely 2.0.6, as declared by the Docker image. No production database was used.
- Additional tests cover complete catalogue counts/parents, browser/JSON equality, corrected source references, every heading pair and triple order, unit conversions, exact band/void boundaries, missing quantities, specification-sensitive grouping, provisional calculations, stable keys, formula-injection protection, live source-ledger formulas, rate identity and worksheet staging/rollback.
- Browser plugin unavailable; Playwright/Chromium used locally. Taskpane identity/content, selection, preset changes, advanced heading order, NRM 1 cost-plan restriction and grouped schedule CSV checked at 1280×900 and 360×800. No page runtime errors in the exercised flow. Screenshot layout inspected.
- Native Excel desktop/web, actual client BIM geometry, production Railway deployment and native workbook recalculation/selection events were not exercised in this environment. The Office writer contract was checked with a fixture; that is not a substitute for a native-host acceptance check.

## Using the release

Reload the web taskpane after deployment. Reload or sideload the updated `manifest.xml` to see the five ribbon controls. Open a model, select **Smart Takeoff**, and start with schedule export or a reviewed structural sample. Confirm the **Smart Basis** and **Smart Review** sheets before using a generated quantity for pricing or issue.

Re-export the current selection after a model/basis change. The source ledger is rebuilt; matching semantic item rates are preserved. Existing legacy revision/update workflows remain unchanged; automatic reconciliation of the new Smart ledger into a revision change log remains a further acceptance check.
