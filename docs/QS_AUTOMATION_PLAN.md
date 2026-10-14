# Excel_Measurements — QS Automation and Standards Plan

**Version 2.0 | 14 October 2026 | Replaces the earlier baseline**

Repository: https://github.com/chanuka789/Excel_Measurements

## 1. Purpose, scope and source basis

Build a practical Excel QS add-in around **Select → Auto-Classify → Review → Export**. Keep three visible steps, with review inside step 2. Support structural, architectural, interior, mechanical, electrical, plumbing, fire protection and landscape work. Produce schedules, detailed take-offs, work-section BOQs and elemental cost plans from the same traceable records.

This is a development specification, not an implemented feature or a declaration that every rule in the standards has been encoded. The heading catalogues are checked against the supplied editions. Crosswalks are proposed QS mappings, not official RICS equivalence tables. Detailed rules need individual source references and validation before activation.

### Sources examined

1. **NRM 1**, third edition, October 2021: supplied `october_2021_nrm_1 (1).pdf`. Main group sections and Appendix B provide the elemental heading hierarchy.
2. **NRM 2**, second edition, October 2021: https://www.rics.org/content/dam/ricsglobal/documents/standards/october_2021_nrm_2.pdf. Contents provide all 41 work sections; work section 11 provides checked concrete/formwork examples.
3. **POMI**, first edition 1979, with the reprint history shown in the supplied link: https://www.katzconsultants.com/asset/img/download/principles-of-measurement-pomi-english.pdf. Contents provide GP and sections A–R, skipping I and O, and their numbered topics.
4. Repository `README.md` and `manifest.xml` inspected through GitHub on 14 October 2026. The README describes existing geometry quantities, take-off templates, revision updates, schedules, live Excel links and BOQ rebuilding. These are documented capabilities; they have not been tested in this planning task.

Use the exact editions above as versioned project choices. Review later corrigenda separately; do not change a running project's measurement basis silently. This plan contains heading indexes and implementation guidance, not copies of the standards' complete measurement tables.

## 2. Corrections to the original proposal

|Earlier proposal|Correction and required behavior|
|---|---|
|POMI GP = concrete, GQ = formwork, GT = masonry, GV = finishes, GX = mechanical|These are not the supplied POMI section references. Use C/C2 for poured concrete, C/C4 for shuttering, D for masonry, J for finishes, Q for mechanical and R for electrical. GP means General Principles.|
|POMI G = structural and architectural works|G covers thermal/moisture protection. A project can have its own structural bill, but its bill number must not be presented as a POMI code.|
|NRM 2 11.13 = slab soffits|Within work section 11, item 13 introduces formwork; item 16 addresses horizontal soffits. Store section and table item separately.|
|Every slab uses the proposed 150/300/500 mm standard bands|The checked NRM 2 concrete horizontal-work table separates ≤300 mm and >300 mm. Additional project bands are optional subdivisions, not official bands.|
|One opening threshold applies to all items|Thresholds and included work are item-specific. A project-wide threshold cannot replace the selected rule.|
|NRM 1 can supply detailed BOQ measurement rules interchangeably with NRM 2|NRM 1 supplies elemental cost-planning classifications and its own cost-plan measurement basis. A detailed BOQ under NRM 1 headings still needs an explicit detailed measurement basis.|
|A hybrid means freely mixing deductions from two standards|Hybrid presentation may combine headings. Each quantity stream has one selected governing rule set, with explicit project amendments.|
|Formwork equals every concrete geometry face|Only supported formed faces qualify. Earth contact, interfaces, permanent decking, casting sequence, openings and included work must be considered.|
|All geometry deductions are automatically BOQ deductions|Keep physical contact geometry and measured quantities separate; the selected measurement rules may retain some small voids.|

### Source numbering irregularities

The supplied NRM 2 work-section 11 table on printed p. 186 shows **23** for both attached-column sides and wall/vertical faces. This was checked in the rendered page. Do not silently renumber wall faces to 24: 24 is the opening extra-over row. Store the source label plus a distinct semantic ID, row label and page. A later verified correction can become another source version.

NRM 1 Appendix B labels group 12 differently from the main contents/group section. Use **12 Other project costs** as the main display label and retain the Appendix B wording as a source alias. Source inconsistencies must appear in the catalogue audit.

## 3. Standards architecture: three independent choices

Replace the original two dropdowns with:

|Choice|Options|Purpose|
|---|---|---|
|Output purpose|Detailed BOQ; Elemental cost plan; Custom schedule|Controls units, detail and presentation expectations|
|Primary heading structure|POMI; NRM 1; NRM 2; Office structure|Top-level grouping and numbering|
|Secondary classification|None; POMI; NRM 1; NRM 2; Office structure|Optional nested headings or cross-reference column|
|Quantity measurement basis|POMI; NRM 2; NRM 1 cost-plan basis; approved office rules|Controls units, deductions, inclusions and description requirements|
|Project amendments|Versioned named amendments|Changes to the selected rules, shown in the exported basis sheet|

A primary/secondary classification change must not change quantities. A measurement-basis change must recalculate affected quantities and produce a reconciliation. A schedule can use model quantities without claiming compliance with a measurement standard.

Recommended presets:

- **Elemental cost plan:** NRM 1 structure + NRM 1 cost-plan quantities; optional detailed take-off supporting the cost plan.
- **Detailed BOQ:** NRM 2 structure + NRM 2 quantities.
- **International BOQ:** POMI structure + POMI quantities.
- **Elemental BOQ:** NRM 1 structure + NRM 2 secondary + NRM 2 quantities, clearly labeled as an elemental BOQ rather than a pure NRM 1 cost plan.
- **POMI-presented detailed BOQ:** POMI structure + NRM 2 secondary + NRM 2 quantities, with the mixed presentation and measurement basis stated.

CESMM4 remains a future civil-engineering extension. Its source has not been supplied or checked in this task; do not ship an invented catalogue or mix it into the verified three-standard release.

## 4. All heading combinations

Let P = POMI, E = NRM 1 elemental classification and W = NRM 2 work-section classification. An arrow describes **display nesting**, not precedence between measurement rules.

### 4.1 All nine primary/secondary pairs

|Primary|Secondary|Treatment|Example path for suspended upper-floor concrete|
|---|---|---|---|
|P|P|Native hierarchy; collapse duplicate levels|C → C2 → measured item|
|P|E|Trade first, element second|C → C2 → 2 → 2.2 → 2.2.1 → measured item|
|P|W|Trade first, work section second|C → C2 → WS11 → table item 2 → measured item|
|E|P|Element first, trade second|2 → 2.2 → 2.2.1 → C → C2 → measured item|
|E|E|Native hierarchy; collapse duplicate levels|2 → 2.2 → 2.2.1 → measured item|
|E|W|Element first, work section second|2 → 2.2 → 2.2.1 → WS11 → table item 2 → measured item|
|W|P|Work section first, trade second|WS11 → C → C2 → table item 2 → measured item|
|W|E|Work section first, element second|WS11 → 2 → 2.2 → 2.2.1 → table item 2 → measured item|
|W|W|Native hierarchy; collapse duplicate levels|WS11 → table item 2 → measured item|

Same-standard selections are supported for saved-profile compatibility, but the UI should display one native hierarchy. None yields the primary hierarchy alone. Office headings can wrap or subdivide any pair, but use an `OFFICE:` namespace and no claim of official numbering.

### 4.2 All six ordered three-standard presentations

|Order|Display path for the same upper-floor concrete|Typical use|
|---|---|---|
|P → E → W|C/C2 → 2.2.1 → WS11/item 2|Trade bill with element split and detailed work classification|
|P → W → E|C/C2 → WS11/item 2 → 2.2.1|Trade/work packages with elemental reporting|
|E → P → W|2.2.1 → C/C2 → WS11/item 2|Elemental bill with international trade headings|
|E → W → P|2.2.1 → WS11/item 2 → C/C2|Elemental bill with detailed work-section measurement|
|W → P → E|WS11/item 2 → C/C2 → 2.2.1|Work-section bill split by trade and element|
|W → E → P|WS11/item 2 → 2.2.1 → C/C2|Work-section bill with element allocation|

Provide these through an advanced heading-order control. Default to two displayed standards; retain all three classifications as metadata. Repeated standards at multiple levels add no information and are collapsed, so the six permutations cover all non-repeating three-standard orders.

### 4.3 All 27 pair/basis configurations

Each of the nine heading pairs can be combined with three measurement bases. This table defines all 27 behaviors; it does not claim 27 interchangeable measurement methods.

|Heading pair|POMI quantity basis|NRM 2 quantity basis|NRM 1 quantity basis|
|---|---|---|---|
|P/P|Native POMI BOQ|Mixed presentation BOQ|Cost-plan view only; resolve elemental allocation|
|P/E|POMI BOQ with element allocation|NRM 2 BOQ with trade/element headings|Cost-plan view with POMI cross-reference|
|P/W|POMI BOQ with NRM 2 classification|NRM 2 BOQ under POMI headings|Cost-plan view only; no implied detailed compliance|
|E/P|Elemental POMI BOQ|Elemental NRM 2 BOQ with POMI references|NRM 1 cost plan with POMI cross-reference|
|E/E|Elemental POMI BOQ|Elemental NRM 2 BOQ|Native NRM 1 cost plan|
|E/W|Elemental POMI BOQ with work references|Elemental NRM 2 BOQ|NRM 1 cost plan with work-section references|
|W/P|POMI BOQ under work-section headings|NRM 2 BOQ with POMI references|Cost-plan view only; aggregate by element separately|
|W/E|POMI BOQ with work/element headings|NRM 2 BOQ with elemental reporting|Cost-plan view under work headings; elemental summary required|
|W/W|POMI BOQ under work-section headings|Native NRM 2 BOQ|Cost-plan view only; no implied detailed compliance|

Disable “NRM 1 quantity basis” when output purpose is detailed BOQ. Retain it for a cost-plan output with optional alternative headings. NRM 1 elemental quantities cannot always be added across elements: their units and measurement bases differ. Aggregate money for the complete cost plan and retain quantities/rates at compatible element levels.

### 4.4 Heading and item-number rules

1. Preserve official reference strings and exact names in the catalogues. Store translated or simplified display aliases separately.
2. Use full namespaces: `POMI:C4`, `NRM1:2.2.1`, `NRM2:WS11`. An application display such as `WS11 / item 16` is clearer than implying `11.16` is a published clause number.
3. Keep **project Bill 02**, **standard reference**, **table item**, **description attribute** and **BOQ item A** in separate fields.
4. Natural-sort codes numerically: 5.9 before 5.10; POMI B9 before B10. Do not sort as decimal numbers.
5. Only display populated headings unless the user requests a blank complete template. Include a coverage list for omitted/unmeasured work.
6. Keep a canonical item ledger. Alternative heading combinations are views of that ledger, not new measured records.

## 5. Complete work-section crosswalk coverage

The following covers every NRM 2 work section. **These mappings are proposed and conditional**, not official equivalences. Lists identify possible routes; classify the actual scope and system before selecting a destination. References in Appendices A–C supply the authoritative heading labels.

|WS|Candidate POMI routes|Candidate NRM 1 destination|Decision or exception|
|---|---|---|---|
|1|A; GP6–GP10 where relevant|9; 10 where separately allocated|Separate contract information, preliminaries, nominated work, dayworks and contingencies; not one equivalent lump sum|
|2|N; relevant C/E/F/H/Q/R routes|6 or functional element|Complete units versus materials supplied off-site; avoid charging unit components twice|
|3|B5|0.2 or 7.1|Major demolition versus minor alterations|
|4|B5; relevant material/service section|7.2–7.6; 7.1 where alterations|Classify the repair material and existing-work function|
|5|B8/B9/B11/B12|1.1; 8.1; 8.2; 8.6|Foundation, site, paving or drainage purpose|
|6|B8/B12; declared specialist amendment where needed|0.1 or 0.4; 8.1 if ordinary preparation|Treatment method and contamination status|
|7|B13–B18; C3 for separate reinforcement|1.1.2; functional external structure where relevant|Pile supply, driving/boring, accessories and testing|
|8|B7; C/D routes for constituent work|1.1.2; 7.6; 8.8.3|Existing building underpinning versus site boundary walls|
|9|B9; C; E for sheet piling where applicable|1.1.2/1.1.5; 8.4.3|Wall material and permanent function|
|10|B; C/D/E as applicable; office amendment if no fit|8.4.3; 1.1.5 if building basement|Gabions, crib construction and reinforced-earth components|
|11|C2/C3/C4/C7|1.1; 2.1–2.5; 2.7; 8.2/8.4|Concrete, rebar and formwork inherit the host function|
|12|C5; C3; relevant steel/composite route|1.1; 2.1–2.5/2.7|Composite construction and scope of included components|
|13|C5|1.1; 2.1–2.5/2.7; 8|Product and location; not all precast is a frame|
|14|D|1.1.5; 2.5; 2.7; 8.4|External/internal/basement/site walls|
|15|E2|2.1.1/2.1.2; 2.2; 2.3.1; 2.4.1|Structural role and frame type|
|16|F2/F3/F4/F5|2.1.5; 2.2; 2.3.1; 2.7|Carpentry substrate/structure, not automatically decorative joinery|
|17|G2; E where sheet-metal specifics require|2.3.2; 2.5|Roof covering versus wall application|
|18|G2; J where appropriate|2.3.2; 2.5|Roof/wall location and assembly|
|19|G2/G3|1.1; 2.3.2; 3.1/3.2; 8|Waterproofing follows its functional assembly|
|20|K2; F/G as applicable|2.7; 3.1/3.3; 2.5 where external|Partition, lining and ceiling system distinctions|
|21|E3/F6/G2/J3 depending on material/system|2.5; 2.3; 3.1|External envelope versus internal applied finish|
|22|F6/F7/F8/F10; H where door scope applies|4.1; 2.8; 3; 2.4|Joinery function and inclusions|
|23|H2/H3/H6|2.6.1; 2.3.5; 2.7 where internal|“Lights” here are glazing/opening components, not electrical luminaires|
|24|H1/H4; E/F depending on accessory scope|2.6.2; 2.8.1; relevant roof/floor access element|External/internal and hatch location|
|25|C/E/F according to material|2.4; 2.7.2; 2.5.5; 8.4|Structure, finish and balustrade split|
|26|E3|2/4/8 by function|Non-structural metalwork must not default to frame|
|27|H5/H6|2.6.1; 2.5.1; 2.3.5; 2.7.1|Separate glazing only if excluded from complete assembly|
|28|J2/J3/J4; F3 for relevant timber flooring|3.1/3.2/3.3; 2.3.2; 2.4.2|Substrate, finish, orientation and inclusion rules|
|29|J6/J7|3; host element; 4.1.4 for relevant signage|Paint may form part of an assembly allowance; avoid duplicate cost|
|30|J5|3.3.2/3.3.3|False versus demountable ceilings|
|31|G4; Q7; applicable fire-protection material route|Host element; 5 where services insulation|Insulation and fire-stopping location; specialist office amendment if needed|
|32|L/M; F6 for built-in joinery; N where specialist|4.1; 5.2 if service equipment|Loose FF&E versus built-in or MEP equipment|
|33|Q2/Q4|5.3.1/5.3.2; 2.3.4 for roof drainage|Above-ground drainage system and purpose|
|34|B19|8.6; 1.1 where substructure-owned scope applies|External versus building drainage allocation|
|35|B4/B20; C/D/E/F/L by item|8.1/8.2/8.5/8.8|Site works are not all excavation|
|36|B21; E/F/D where applicable|8.4.1/8.4.4|Fence/barrier type and assembly|
|37|B22; Q for separately measured irrigation|8.3.1/8.3.2/8.3.3|Planting, soil, turf and irrigation scope separation|
|38|Q1–Q9|5.1–5.7; 5.9; 5.11; 5.13; 8.7|Assign by actual mechanical system, not category alone|
|39|R1–R10|5.8; 5.11.3; 5.12; 5.13.4; 8.7|Electrical, ELV, lightning and external systems|
|40|P1–P3|5.10|Lifts, escalators and other conveying systems|
|41|P3/Q9/R10; material routes for measured builder’s work|5.14.1; 8.7.11|Discipline responsibility and explicit included/excluded work|

### Mapping outside modeled building works

NRM 1 groups 10–14 are explicit commercial/cost-plan allowances. Do not fabricate BIM elements for fees, finance, risks or inflation. POMI GP is governing guidance, not a substitute building element. Some POMI civil topics such as railway and tunnel work have no direct NRM 2 building work-section equivalent; keep them source-classified and flag the missing crosswalk. Resolve those with an approved project rule or a separately verified civil standard.

Every catalogue node is available for manual allocation. Every automatic rule must have a predicate and exactly one final allocation or an explicit split. “Unknown”, “Outside selected scope” and “Needs QS review” are distinct states; never use zero quantity as a substitute for missing data.

## 6. UI and user workflow

### Five ribbon entry points

|Button|Contents|
|---|---|
|Project & Models|Project access, models/drawings, revisions, templates, standards and project settings; admin only for authorized roles|
|Launch Viewer|Large linked viewer, drawings and properties; fit/section/box/isolate/hide/show-all/colour/views in the viewer toolbar/context menu|
|Smart Takeoff|Selection filters, quantities, derived calculations, standard classification and QS review|
|BOQ & Schedules|Schedule presets, BOQ/cost plan, active-cell linking, revision updates and reconciliation|
|AI Audit|Missing properties, unclassified work, duplicate scope, unexpected changes, rule conflicts and review history|

The manifest is documented as generated by `scripts/make-manifest.py`: update its generator and regenerate `manifest.xml`, rather than editing only the generated output. Preserve existing command handlers during migration. Actual implementation paths require a full code review before changes; proposed new paths below are design choices.

### Three-step taskpane

1. **Filter & Select:** project/model/revision; Structural/Arch/ID/MEP/Landscape; building/zone/level/system; category/family/type; optional manual 2D items. Show selection counts and exclusions.
2. **Classify & Review:** output purpose and saved preset; heading order and measurement basis; approved derivations; grouped preview; missing-data queue; editable assumptions. Show source reference, quantity source and reason for classification.
3. **Export / Link:** itemized/grouped schedule, detailed BOQ, elemental cost plan or active-cell link; scope/basis sheets; preview totals; explicit update/replace behavior.

Keep an advanced panel for experts, not more top-level ribbon buttons. Save the current project and selection when moving between steps. Review only exceptions for repeat runs where the source revision and rules have not changed.

## 7. Canonical data model and rules

### 7.1 Element identity and quantities

Use `projectId + modelId + revisionId + stableElementGuid`. Numeric element IDs may collide between models. A derived item is a child of its source element(s), not a fake source BIM GUID. Keep model geometry, parameter quantities, manual measures and estimated quantities distinct.

Store normalized SI values, original values/units, geometry quality, model coordinates, local axes, host/system/room, role and provenance. Do not infer length from a world-aligned bounding box for rotated or curved objects. Reject non-watertight mesh volume as exact volume. Distinguish nominal pipe diameter from external diameter and nominal structural section size from its bounding box.

Each quantity record needs:

- Physical quantity, BOQ quantity and calculation expression.
- Element IDs and face/interface IDs where applicable.
- Rule pack, edition, semantic rule ID, source page/table/row and review status.
- Primary/secondary/tertiary classification references.
- Inclusion/deduction records, assumptions, user overrides and revision.
- Unit, precision, quantity status, scope ownership and grouping key.

### 7.2 Versioned catalogues and mapping layers

Proposed files:

```text
rules/catalogues/pomi-1979-reprint.json
rules/catalogues/nrm1-2021.json
rules/catalogues/nrm2-2021.json
rules/measurement/pomi.json
rules/measurement/nrm1-cost-plan.json
rules/measurement/nrm2.json
rules/crosswalks/pomi-nrm1-nrm2.json
rules/office/<approved-profile>.json
```

Keep heading catalogues, mapping predicates, calculations, measurement rules and output styles separate. One flat `pomi_nrm2_map.json` cannot safely represent the necessary many-to-many mappings and inclusions.

Example record, with app keys explicitly distinguished from published references:

```json
{
  "appRuleId": "slab-soffit-horizontal",
  "source": {
    "standard": "NRM2", "edition": "2021",
    "workSection": "11", "tableItem": "16", "printedPage": 186
  },
  "classification": {
    "pomi": ["C", "C4"],
    "nrm1": "2.2.1", "nrm2": "WS11"
  },
  "when": {"role": "upper-floor", "surface": "horizontal-soffit"},
  "quantityStream": "formed-soffit-area",
  "unit": "m2",
  "reviewStatus": "source-checked-example"
}
```

This example's NRM 1 allocation is conditional on upper-floor function. Roofs, ground floors, balconies and stair landings need different predicates. Rule priority: approved project amendment → governing standard rule → declared office fallback. A display crosswalk never overrides a governing quantity rule.

### 7.3 Grouping and banding

Group by scope/package → functional element/system → work type → material/specification → official measurement distinctions → dimensions/finish/fire/acoustic/performance → optional location. Preserve exact dimensions when pricing requires them; do not combine 200 and 250 mm slabs just because they share an official band.

Official bands and optional office subdivisions must have separate fields. Define non-overlapping intervals with explicit inclusive/exclusive boundaries. Sorting uses numeric dimensions, then deterministic tie-breakers. Do not combine different units, standards, provisional statuses, rates or revisions into one quantity total.

## 8. Structural quantities and formwork

### 8.1 Calculation sequence

1. Obtain reliable geometry/parameters and host relationships.
2. Identify element function, material, specification, construction arrangement and pour sequence.
3. Resolve overlap ownership for concrete solids and shared formed faces.
4. Calculate physical volumes and exposed/formed face areas.
5. Apply selected standard deductions and included-work rules to create measurement quantities.
6. Generate dependent quantities and classify them by the host function.
7. Preview disagreements, unsupported geometry and assumptions before export.

### 8.2 Geometry formulas as controlled fallbacks

All dimensions below are in metres. Formulas describe simple geometry; they are not complete standard measurement rules.

|Element|Fallback physical formed quantity|Conditions and adjustments|
|---|---|---|
|Rectangular footing|2(L+W)H for all four formed sides|Earth-cast faces excluded only when construction is confirmed; subtract actual interface area, not arbitrary beam depth|
|Rectangular column|2(B+D) × formed height|Use poured/formed extent; classify isolated/attached; no automatic subtraction around the entire perimeter for one intersecting beam|
|Circular column|πD × formed height|Keep diameter and curvature; do not assign a linear BOQ unit merely because diameter is known|
|Wall|Sum actual formed faces and separately treated returns|One/two-sided arrangement; openings, end conditions, batter and curved geometry|
|Slab soffit|Actual formed underside area|Resolve beam/slab ownership, drops, capitals, voids, ramps and permanent deck|
|Slab edge|Exposed edge length and actual depth; physical area = length × depth|Measured unit is chosen by the governing rule, not by the geometric area alone|
|Attached downstand beam|[b + 2(D−t)] × clear formed length|Only rectangular constant section with slab sharing the top zone; resolve beam/slab solids and node intersections|
|Isolated beam|(b+2D) × formed length|Top formwork only where required; end faces are construction-dependent|
|Upstand/steps/stairs|Classified face geometry|No single beam formula for every arrangement; risers, strings and soffits may use different units|

Geometry calculations must use the union of interfaces to avoid subtracting overlapping intersections twice. Deducting beam footprints from slab soffit while separately measuring full isolated-beam formwork can be wrong: classify the actual connected arrangement. Permit a reviewed manual face override where geometry or casting data is inadequate.

### 8.3 Verified rule corrections to encode first

**POMI source references:** GP3.2–GP3.3, C2.1–C2.3, C3 and C4. Keep the actual rule texts in the source documents and implement concise verified predicates.

- The POMI general area rule retains interior voids **smaller than 1.00 m²**, unless another rule applies; edge voids are treated differently. The earlier “deduct all openings” assumption is removed.
- POMI C4 uses contact-area shuttering, with edges treated by length under C4.2; keep finish, geometry and height descriptions.
- C4.8 links treatment of void-face shuttering to whether concrete volume was deducted; apply this with the relevant specific rule rather than blindly using one global threshold.
- POMI C2 identifies suspended slabs and beams below the slab separately; special-construction slabs can have a different quantity basis. Do not apply a universal m³ rule to every slab type.
- Provisional reinforcement ratios are estimates entered by the QS. They are not standard rates or model-measured bar quantities.

**NRM 2 checked work-section 11 examples:** printed pp. 181–188.

|Source location|Checked distinction|Implementation requirement|
|---|---|---|
|Item 2|Horizontal concrete thickness split at 300 mm|Keep exact thickness and official band separately|
|Item 5|Vertical concrete thickness split at 300 mm|Use vertical-work role; do not default all walls to office bands|
|Item 13 notes|Formwork voids ≤5 m² are not deducted|Use rule-specific retention and separately assess opening extra-over|
|Items 14/15|Foundation sides/horizontal edges split at 500 mm; m/m² shown|Read the unit/width distinction from the source table before activating; no blanket m² edge export|
|Items 16–18|Soffit concrete thickness ≤300, >300–450, >450 mm; propping ≤3, >3–4.5, then 1.5 m stages|Use these source bands; remove earlier 200 mm and 3.5 m defaults from standard mode|
|Items 19/20|Isolated/attached beam sides and soffits|Classify connected geometry; avoid treating all beams the same|
|Items 22/23|Isolated/attached column formwork|Keep shape and count information|
|Wall-face row, source label 23|Vertical/battered faces and single-sided description|Distinct semantic ID despite duplicated printed number|
|Item 24|Opening extra-over measured by count, with area ranges|Do not also add included opening reveals as duplicate area work|
|Items 33/34 and 37|Bar reinforcement by tonnes; mesh by area|Keep bar and fabric quantities separate|

These checked examples seed the engine. They are not a full transcription of section 11. Verify all remaining table distinctions, inclusions and boundary cases before marking that section's rule pack complete.

### 8.4 Reinforcement and structural steel

- Modeled reinforcement: material/grade/coating, diameter, bar form and rule-specific scope. Convert kg↔t explicitly.
- Unmodeled reinforcement: volume × approved kg/m³ ratio / 1000 for tonnes. Record ratio, volume basis, author and “provisional estimate”. Never add it to modeled steel for the same scope automatically.
- Mesh: fabric reference, area, lap treatment and bent/strip distinctions from governing rules.
- Steel: profile identity and verified section mass per length, with connection/plate allocation. Optional weight bands are office settings, not automatically NRM/POMI rules.
- Paint/fire protection: true exposed developed surface where available; section perimeter × length is a fallback and may exclude connection complexity, hidden interfaces and required treatment adjustments.

## 9. Architectural, ID, MEP and landscape automation

|Work family|Parameters and quantities to retain|QS classification controls|
|---|---|---|
|Masonry|Type, thickness, height, length/area, openings, reinforcement, insulation|External/internal/basement/site role; POMI D; NRM 2 WS14; element mapping by function|
|Drywall/linings|Studs, boards/layers, overall thickness, insulation, fire/acoustic rating|Partition versus lining versus ceiling; WS20/30 as appropriate; composite scope inclusion|
|Doors/shutters/hatches|Mark, location, material, opening size, leaf, frame, finish, ratings, hardware|H1/H4 and WS24 routes; internal/external/access function; hardware included versus separate|
|Windows/louvers/façades|System, material, dimensions, glazing buildup, mullions, finish, rating|Assembly versus component mode; WS21/23/27 routing is system-dependent; no duplicate glass|
|Roofing/waterproofing|System/layers, substrate, thickness, insulation, slope, boundaries|WS17/18/19/31 conditional; roof/basement/finish element; widths and included boundaries governed by rule|
|Floor/wall finishes|Material, size, thickness, backing, room, exposed area, height|WS28 versus WS29 decoration; substrate and finish inclusions; stairs treated by functional role|
|Skirting|Room boundary, interruptions, doors, cupboards, finish and girth|Perimeter minus doors is a fallback; review joinery interfaces, thresholds and rule treatment|
|Ceilings/bulkheads|System, board/panel, thickness, suspension, drop, plan/developed area|WS30 or applicable system section; linear bulkhead proposal requires approved measurement rule|
|Joinery/FF&E|Code, dimensions, carcass, countertop, accessories, count/length|Built-in assemblies versus loose FF&E; WS22/32; functional element 4.1 or host function|
|Ducts|System, shape, W/H or D, centre-line length, fittings, gauge, insulation|WS38/Q3; sheet area 2(W+H)L for straight rectangular runs only; fittings separate as required|
|Pipes/drainage|System, material, nominal diameter, actual geometry, insulation, fittings|Above/below-ground and purpose; WS33/34/38; Q2 or B19; fitting/support inclusion|
|HVAC/fire/plumbing equipment|Type/model, kW/TR, airflow/duty, rating, size, count|Mechanical system mapping to NRM 1 5.x; not all MEP equipment goes to 5.2|
|Containment/cables|Tray/trunking/conduit material/size, compartments, route length; cable cores/CSA/type|WS39/R; circuits, supports and accessories; avoid conflating cable and containment quantities|
|Electrical/ELV equipment|Ref, ways/current, wattage/IP, function, count|Power/lighting/security/communications/lightning distinctions; internal/external allocation|
|Hardscape|Layer material, thickness, area, kerbs, edges, accessibility and external structures|WS35 plus relevant concrete/masonry/finish sections; NRM 1 8.2/8.4/8.5|
|Softscape/irrigation|Species/code, size, count/area, soil depth/volume, turf, pipe/valve/equipment|WS37 plus system routes; NRM 1 8.3.1–8.3.3; avoid double-counting included soil/irrigation|

DW144/SMACNA gauge rules and the original duct size ranges have not been verified from supplied documents. Treat these as separate technical standards/configuration requiring their own source and approval, not as POMI/NRM section rules.

## 10. Custom schedule exporter

Scan properties across the full selected set, not only the first element. Preserve family/type versus instance properties, original parameter names and units. Distinguish absent, empty and zero values.

Column picker groups: location (building/level/zone/room), identity (category/family/type/mark/GUID), dimensions, quantity source, performance/specification, classifications and user calculations. Show sample values, availability percentage and incompatible types before export.

Modes:

- **Itemized:** one row per element, or a clearly described assembly/component choice.
- **Grouped:** user-defined key with type/mark plus essential specification differences; same mark alone must not merge different size/fire-rating records.
- **Quantity matrix:** shared element rows with concrete, formwork, rebar and waterproofing streams in separate columns, preserving the repository's documented existing approach.

Save column order, labels, units, grouping, sorting, source precedence and filters as versioned project/office presets. Examples: door/glazing/equipment schedules; concrete pours; finishes by room; MEP by system; landscape by species. Schedules remain usable independently of BOQ classification.

## 11. Excel outputs and two-way linking

### 11.1 Workbook structure

|Sheet|Purpose|
|---|---|
|Basis & Scope|Standard editions, heading order, quantity basis, amendments, selected models/revisions, exclusions and assumptions|
|Take-off|Traceable measurement rows and formulas; physical and measured quantities distinguished|
|Schedule|Selected BIM data with grouping/template metadata|
|BOQ|Headings, descriptions, unit, quantity, rate and amount|
|Cost Plan|NRM 1 hierarchy, compatible element quantities/rates and cost summaries|
|Review Queue|Unclassified, conflicting, unsupported and incomplete records|
|Change Log|Revision/rule/override differences with reasons|
|Link Registry|Stable row IDs, element GUIDs, sources and rule versions|

Do not put an unlimited JSON list of model IDs into one hidden Excel cell. Use a hidden registry table with one-to-many links and a short row key on the visible sheet. Warn about workbook limits and large exports; hidden data is not confidential storage.

### 11.2 Corrected export example

Preset: **POMI headings → NRM 2 secondary; NRM 2 quantity basis**. The project bill is separate from the source references. Quantities below are placeholders for demonstration, not measured project data.

|Display reference|Description|Unit|Qty|Rate|Amount|
|---|---|---|---|---|---|
|Project Bill 02|Structural works|||||
|POMI C|Concrete work|||||
|POMI C2|Poured concrete|||||
|NRM2 WS11 / item 2|Horizontal concrete; specification and location stated|||||
|A|C40 suspended upper-floor slab; 200 mm; source band ≤300 mm|m³|[calculated]|[input]|[formula]|
|B|C40 suspended upper-floor slab; 250 mm; source band ≤300 mm|m³|[calculated]|[input]|[formula]|
|POMI C4|Shuttering|||||
|NRM2 WS11 / item 16|Horizontal soffit formwork|||||
|C|200 mm slab; propping 2.8 m; approved finish; source bands applied|m²|[calculated]|[input]|[formula]|
|NRM2 WS11 / item 15|Edges of horizontal work|||||
|D|200 mm high edges; governing linear-unit rule verified|m|[calculated]|[input]|[formula]|

An elemental version of the same ledger allocates the upper-floor scope to `NRM1:2.2.1`, then nests POMI/NRM 2 references in the chosen order. Concrete, rebar and shuttering do not become three new NRM 1 group elements.

### 11.3 Rebuild and revision behavior

Use stable semantic item IDs, not description text, to preserve rates and overrides. Write Excel ranges in batches. Stage exports and recover from partial writes. Active-cell linking requires an explicit range destination and must detect conflicts with existing data.

Keep unchanged rates when items match. If size/specification or grouping changes, show a rate-transfer review rather than silently carrying a rate to a different item. Reconcile old/new quantity, classification, rate and value separately. Model revisions must not overwrite the old measurement audit trail.

## 12. AI Audit and QS control

AI can suggest classification, parameter aliases, descriptions and missing scope. Deterministic code calculates quantities and validates source references. No AI-generated standard number or deduction becomes an active rule without verification.

Audit checks: missing levels/system/specification/dimensions; model overlap; physical versus measured quantity mismatch; incomplete rules; duplicate inclusion across assemblies; provisional/modelled rebar duplication; unassigned BOQ scope; invalid code/edition; incompatible unit/rate; unexplained revisions; absent non-modeled work.

A full BOQ includes work that models often omit: preliminaries, earthworks assumptions, temporary works, protection, testing/commissioning, supports/fittings where separate, sealants/fire stopping, accessories, attendance and provisional work. Use a scope checklist linked to project specifications; absence from BIM is not proof that an item is unnecessary.

Permit schedule-only export with incomplete standards. Block a “verified standard BOQ” label where governing rules or mappings are unresolved. Permit a clearly marked draft with the review queue included.

## 13. Implementation roadmap and acceptance gates

The original four-week timeline is replaced by four **phases with acceptance gates**. Dates must follow a code and sample-model assessment; cross-discipline geometry and rule validation cannot responsibly be promised within four weeks from this plan alone.

|Phase|Implementation|Acceptance gate|
|---|---|---|
|1 — Standards foundation and UX|Import checked catalogues; namespace codes; source provenance; heading/basis selectors; generated ribbon cleanup; guided taskpane|Catalogues match sources; all nine pairs/six triple orders render; basis changes are separate from heading changes; existing workflows accessible|
|2 — Schedules and common ledger|Parameter inspector, presets, itemized/grouped/matrix export, identity/link registry, manual QS allocation|Multi-model IDs do not collide; missing data not zero; grouped totals reconcile; selection links work both directions|
|3 — Structural pilot|Concrete/formwork/rebar rules; physical/rule quantity separation; contact geometry; official/office bands; overrides|QS-reviewed benchmark set passes boundary, overlap, opening, unit and provisional tests for both POMI and NRM 2|
|4 — BOQ/cost plans and discipline expansion|Conditional crosswalks; formatted outputs; rule/version reconciliation; pricing preservation; Arch/ID/MEP/Landscape packs; AI Audit|No duplicated ledger costs; alternate heading totals reconcile; non-modeled scope visible; every active rule source-reviewed|

### Required meaningful tests

1. Catalogue codes unique within namespace; full coverage of POMI GP/A–R section headings, POMI topic references, NRM 1 levels 1–3 and NRM 2 sections 1–41; valid parents and source references.
2. All nine heading pairs and six triple orders preserve ledger quantities/costs; natural sorting; no repeated same-standard headings.
3. Unit-sensitive cases: mm/m, kg/t, m/m²/m³, nominal versus outside diameter; reject incompatible sums.
4. Boundary cases: official thickness/propping splits, exact equality at thresholds, interior versus edge voids, standard amendment override; source ambiguity flagged.
5. Geometric cases: rotated column, stepped/curved/sloping surface, beam/slab overlap, column capital, single-sided wall, earth-cast foundation, permanent deck, multiple overlapping interfaces, open mesh.
6. Assembly/component exclusivity: glazed window versus separate glazing; complete door set versus hardware; ceiling system versus paint; unit pod versus its components.
7. Quantity provenance: geometry versus parameter disagreement, manual override, estimated rebar, unclassified elements and missing specification.
8. Excel/revision cases: duplicate element IDs across models, large link sets, changed grouping, rates/overrides preserved, deleted elements, partial-write recovery and repeat-run idempotency.
9. QS comparison: manually measured representative sample for each active work family; compare scope, quantities, descriptions, inclusions and mapping, not only arithmetic.

## 14. Delivery and maintenance requirements

Deliver checked catalogues, separate rule packs, conditional crosswalks, saved presentation presets, a scope checklist, benchmark models/manual calculations, migration notes and user guidance. Keep every rule's edition, author/reviewer and review date. Office amendments must be visible and exportable.

The complete heading catalogues follow. Coverage of a heading does not imply that every quantity rule beneath it has been implemented. New detailed table rules should be enabled gradually after source review, rather than producing plausible but incorrect automated quantities.


## Appendix A. POMI section catalogue

Source: POMI contents, PDF pages 4–5. Codes are reference labels; project bill numbers remain separate. GP governs measurement and is not a concrete bill. The source intentionally skips I and O.

|Code|Official section heading|
|---|---|
|GP|General Principles|
|A|General Requirements|
|B|Site Work|
|C|Concrete Work|
|D|Masonry|
|E|Metalwork|
|F|Woodwork|
|G|Thermal And Moisture Protection|
|H|Doors And Windows|
|J|Finishes|
|K|Accessories|
|L|Equipment|
|M|Furnishings|
|N|Special Construction|
|P|Conveying Systems|
|Q|Mechanical Engineering Installations|
|R|Electrical Engineering Installations|

### POMI numbered topic index

These are topic headings, not a reproduction of the measurement clauses. Use the source for clause wording and exceptions.

|Reference|Topic|
|---|---|
|GP1|Principles of measurement|
|GP2|Bills of quantities|
|GP3|Measurement|
|GP4|Items to be fully inclusive|
|GP5|Description of items|
|GP6|Work to be executed by a specialist nominated by the employer|
|GP7|Goods, materials or services to be provided by a merchant or tradesman nominated by the employer|
|GP8|Work to be executed by a government or public authority|
|GP9|Dayworks|
|GP10|Contingencies|
|A1|Conditions of contract|
|A2|Specification|
|A3|Restrictions|
|A4|Contractor's administrative arrangements|
|A5|Constructional plant|
|A6|Employer's facilities|
|A7|Contractor's facilities|
|A8|Temporary works|
|A9|Sundry items|
|B1|Site exploration generally|
|B2|Trial holes|
|B3|Boreholes (including pumping test wells)|
|B4|Site preparation|
|B5|Demolitions and alterations|
|B6|Shoring|
|B7|Underpinning|
|B8|Earthworks generally|
|B9|Excavation|
|B10|Dredging|
|B11|Disposal|
|B12|Filling|
|B13|Piling generally|
|B14|Driven piling|
|B15|Bored piling|
|B16|Sheet piling|
|B17|Performance designed piling|
|B18|Testing piling|
|B19|Underground drainage|
|B20|Paving and surfacing|
|B21|Fencing|
|B22|Landscaping|
|B23|Railway work|
|B24|Tunnel excavation|
|B25|Tunnel linings|
|B26|Tunnel support and stabilisation|
|C1|Generally|
|C2|Poured concrete|
|C3|Reinforcement|
|C4|Shuttering|
|C5|Precast concrete|
|C6|Prestressed concrete|
|C7|Sundries|
|D1|Generally|
|D2|Walls and piers|
|D3|Sills, etc|
|D4|Reinforcement|
|D5|Sundries|
|E1|Generally|
|E2|Structural metalwork|
|E3|Non structural metalwork|
|F1|Generally|
|F2|Structural timbers|
|F3|Boarding and flooring|
|F4|Grounds and battens|
|F5|Framework|
|F6|Finishings and fittings|
|F7|Composite items|
|F8|Sundry items|
|F9|Metalwork|
|F10|Ironmongery|
|G1|Generally|
|G2|Coverings and linings|
|G3|Damp-proof courses|
|G4|Insulation|
|H1|Doors|
|H2|Windows|
|H3|Screens|
|H4|Ironmongery|
|H5|Glass|
|H6|Patent glazing|
|J1|Generally|
|J2|Backgrounds|
|J3|Finishings|
|J4|Sundries|
|J5|Suspended ceilings|
|J6|Decorations|
|J7|Signwriting|
|K1|Generally|
|K2|Partitions|
|L1|Generally|
|M1|Generally|
|M2|Curtain track|
|N1|Generally|
|N2|Enclosures|
|N3|Installations|
|P1|Generally|
|P2|Sundries|
|P3|Work incidental to conveying systems|
|Q1|Generally|
|Q2|Pipework and gutterwork|
|Q3|Ductwork|
|Q4|Equipment|
|Q5|Automatic controls|
|Q6|Connections to supply mains|
|Q7|Insulation, including linings and protective coverings|
|Q8|Sundries|
|Q9|Work incidental to mechanical engineering installations|
|R1|Generally|
|R2|Main circuits|
|R3|Sub-main circuits|
|R4|Final sub-circuits and auxiliary installations|
|R5|Accessories|
|R6|Control gear|
|R7|Equipment|
|R8|Connections to supply mains|
|R9|Sundries|
|R10|Work incidental to electrical engineering installations|

## Appendix B. NRM 1 complete elemental heading hierarchy

Source: supplied NRM 1, third edition October 2021, group contents pp. 78–80 and Appendix B pp. 425–433. Level 1 = group; Level 2 = element; Level 3 = sub-element. No invented Level 3 entries are added to overheads/profit, risk or inflation.

The source Appendix B uses a different label for group 12; this catalogue uses **Other project costs**, as in the main group section and contents. Preserve the alternate source label in provenance rather than silently treating it as a new group.

|Code|Level|Official heading|
|---|---|---|
|0|1|Facilitating works|
|0.1|2|Toxic/hazardous/contaminated material treatment|
|0.1.1|3|Toxic or hazardous material removal|
|0.1.2|3|Contaminated land|
|0.1.3|3|Eradication of plant growth|
|0.2|2|Major demolition works|
|0.2.1|3|Demolition works|
|0.2.2|3|Soft strip works|
|0.3|2|Temporary support for adjacent structures|
|0.3.1|3|Temporary support for adjacent structures|
|0.4|2|Specialist groundworks|
|0.4.1|3|Site dewatering and pumping|
|0.4.2|3|Soil stabilisation measures|
|0.4.3|3|Ground gas venting measures|
|0.5|2|Temporary diversion works|
|0.5.1|3|Temporary diversion works|
|0.6|2|Extraordinary site investigation works|
|0.6.1|3|Archaeological investigation|
|0.6.2|3|Reptile/wildlife harm mitigation measures|
|0.6.3|3|Other extraordinary site investigation works|
|1|1|Substructure|
|1.1|2|Substructure|
|1.1.1|3|Standard foundations|
|1.1.2|3|Specialist foundations|
|1.1.3|3|Lowest floor construction|
|1.1.4|3|Basement excavation|
|1.1.5|3|Basement retaining walls|
|2|1|Superstructure|
|2.1|2|Frame|
|2.1.1|3|Steel frames|
|2.1.2|3|Space frames/decks|
|2.1.3|3|Concrete casings for steel frames|
|2.1.4|3|Concrete frames|
|2.1.5|3|Timber frames|
|2.1.6|3|Specialist frames|
|2.2|2|Upper floors|
|2.2.1|3|Floors|
|2.2.2|3|Balconies|
|2.2.3|3|Drainage for balconies|
|2.3|2|Roof|
|2.3.1|3|Roof structure|
|2.3.2|3|Roof coverings|
|2.3.3|3|Specialist roof systems|
|2.3.4|3|Roof drainage|
|2.3.5|3|Rooflights, skylights and openings|
|2.3.6|3|Roof features|
|2.4|2|Stairs and ramps|
|2.4.1|3|Stair/ramp structures|
|2.4.2|3|Stair/ramp finishes|
|2.4.3|3|Stair/ramp balustrades and handrails|
|2.4.4|3|Ladders/chutes/slides|
|2.5|2|External walls|
|2.5.1|3|External enclosing walls above ground level|
|2.5.2|3|External enclosing walls below ground level|
|2.5.3|3|Solar/rain screening|
|2.5.4|3|External soffits|
|2.5.5|3|Subsidiary walls, balustrades and proprietary balconies|
|2.5.6|3|Facade access/cleaning systems|
|2.6|2|Windows and external doors|
|2.6.1|3|External windows|
|2.6.2|3|External doors|
|2.7|2|Internal walls and partitions|
|2.7.1|3|Walls and partitions|
|2.7.2|3|Balustrades and handrails|
|2.7.3|3|Moveable room dividers|
|2.7.4|3|Cubicles|
|2.8|2|Internal doors|
|2.8.1|3|Internal doors|
|3|1|Internal finishes|
|3.1|2|Wall finishes|
|3.1.1|3|Wall finishes|
|3.2|2|Floor finishes|
|3.2.1|3|Finishes to floors|
|3.2.2|3|Raised access floors|
|3.3|2|Ceiling finishes|
|3.3.1|3|Finishes to ceilings|
|3.3.2|3|False ceilings|
|3.3.3|3|Demountable suspended ceilings|
|4|1|Fittings, furnishings and equipment|
|4.1|2|Fittings, furnishings and equipment|
|4.1.1|3|General fittings, furnishings and equipment|
|4.1.2|3|Domestic kitchen fittings and equipment|
|4.1.3|3|Special-purpose fittings, furnishings and equipment|
|4.1.4|3|Signs/notices|
|4.1.5|3|Works of art|
|4.1.6|3|Non-mechanical and non-electrical equipment|
|4.1.7|3|Internal planting|
|4.1.8|3|Bird and vermin control|
|5|1|Services|
|5.1|2|Sanitary installations|
|5.1.1|3|Sanitary appliances|
|5.1.2|3|Sanitary ancillaries|
|5.2|2|Services equipment|
|5.2.1|3|Services equipment|
|5.3|2|Disposal installations|
|5.3.1|3|Foul drainage above ground|
|5.3.2|3|Chemical, toxic and industrial liquid waste drainage|
|5.3.3|3|Refuse disposal|
|5.4|2|Water installations|
|5.4.1|3|Mains water supply|
|5.4.2|3|Cold water distribution|
|5.4.3|3|Hot water distribution|
|5.4.4|3|Local hot water distribution|
|5.4.5|3|Steam and condensate distribution|
|5.5|2|Heat source|
|5.5.1|3|Heat source|
|5.6|2|Space heating and air conditioning systems|
|5.6.1|3|Central heating systems|
|5.6.2|3|Local heating systems|
|5.6.3|3|Central cooling systems|
|5.6.4|3|Local cooling systems|
|5.6.5|3|Central heating and cooling systems|
|5.6.6|3|Local heating and cooling systems|
|5.6.7|3|Central air conditioning systems|
|5.6.8|3|Local air conditioning systems|
|5.7|2|Ventilation systems|
|5.7.1|3|Central ventilation systems|
|5.7.2|3|Local and special ventilation systems|
|5.7.3|3|Smoke extraction/control systems|
|5.8|2|Electrical installations|
|5.8.1|3|Electrical mains and sub-mains distribution|
|5.8.2|3|Power installations|
|5.8.3|3|Lighting installations|
|5.8.4|3|Specialist lighting installations|
|5.8.5|3|Local electricity generation systems|
|5.8.6|3|Earthing and bonding systems|
|5.9|2|Fuel installations|
|5.9.1|3|Fuel storage|
|5.9.2|3|Fuel distribution systems|
|5.10|2|Lift and conveyor installations|
|5.10.1|3|Lifts and enclosed hoists|
|5.10.2|3|Escalators|
|5.10.3|3|Moving pavements|
|5.10.4|3|Powered stairlifts|
|5.10.5|3|Conveyors|
|5.10.6|3|Dock levellers and scissor lifts|
|5.10.7|3|Cranes and unenclosed hoists|
|5.10.8|3|Car lifts, car stacking systems, turntables, etc.|
|5.10.9|3|Document handling systems|
|5.10.10|3|Other lift and conveyor installations|
|5.11|2|Fire and lightning protection|
|5.11.1|3|Firefighting systems|
|5.11.2|3|Fire suppression systems|
|5.11.3|3|Lightning protection|
|5.12|2|Communication, security and control systems|
|5.12.1|3|Communication systems|
|5.12.2|3|Security systems|
|5.12.3|3|Central control/building management systems|
|5.13|2|Specialist installations|
|5.13.1|3|Specialist piped supply installations|
|5.13.2|3|Specialist refrigeration systems|
|5.13.3|3|Specialist mechanical installations|
|5.13.4|3|Specialist electrical/electronic installations|
|5.13.5|3|Water features|
|5.14|2|Builder’s work in connection with services|
|5.14.1|3|Builder’s work in connection with services|
|6|1|Prefabricated buildings and building units|
|6.1|2|Prefabricated buildings and building units|
|6.1.1|3|Complete buildings|
|6.1.2|3|Building units|
|6.1.3|3|Pods|
|7|1|Work to existing buildings|
|7.1|2|Minor demolition and alteration works|
|7.1.1|3|Minor demolition and alteration works|
|7.2|2|Repairs to existing services|
|7.2.1|3|Repairs to existing services|
|7.3|2|Damp-proof courses/fungus and beetle eradication|
|7.3.1|3|Damp-proof courses|
|7.3.2|3|Fungus/beetle eradication|
|7.4|2|Facade retention|
|7.4.1|3|Facade retention|
|7.5|2|Cleaning existing surfaces|
|7.5.1|3|Cleaning|
|7.5.2|3|Protective coatings|
|7.6|2|Renovation works|
|7.6.1|3|Masonry repairs|
|7.6.2|3|Concrete repairs|
|7.6.3|3|Metal repairs|
|7.6.4|3|Timber repairs|
|7.6.5|3|Plastics repairs|
|8|1|External works|
|8.1|2|Site preparation works|
|8.1.1|3|Site clearance|
|8.1.2|3|Preparatory groundworks|
|8.2|2|Roads, paths, pavings and surfacings|
|8.2.1|3|Roads, paths and pavings|
|8.2.2|3|Special surfacings and pavings|
|8.3|2|Soft landscaping, planting and irrigation systems|
|8.3.1|3|Seeding and turfing|
|8.3.2|3|External planting|
|8.3.3|3|Irrigation systems|
|8.4|2|Fencing, railings and walls|
|8.4.1|3|Fencing and railings|
|8.4.2|3|Walls and screens|
|8.4.3|3|Retaining walls|
|8.4.4|3|Barriers and guardrails|
|8.5|2|External fixtures|
|8.5.1|3|Site/street furniture and equipment|
|8.5.2|3|Ornamental features|
|8.6|2|External drainage|
|8.6.1|3|Surface water and foul water drainage|
|8.6.2|3|Ancillary drainage systems|
|8.6.3|3|External chemical, toxic and industrial liquid waste drainage|
|8.6.4|3|Land drainage|
|8.7|2|External services|
|8.7.1|3|Water mains supply|
|8.7.2|3|Electricity mains supply|
|8.7.3|3|External transformation devices|
|8.7.4|3|Electricity distribution to external plant and equipment|
|8.7.5|3|Gas mains supply|
|8.7.6|3|Telecommunications and other communication system connections|
|8.7.7|3|External fuel storage and piped distribution systems|
|8.7.8|3|External security systems|
|8.7.9|3|External street lighting systems|
|8.7.10|3|Local/district heating installations|
|8.7.11|3|Builders work in connection with external services|
|8.8|2|Minor building works and ancillary buildings|
|8.8.1|3|Minor building works|
|8.8.2|3|Ancillary buildings and structures|
|8.8.3|3|Underpinning for external site boundary walls|
|9|1|Main contractor’s preliminaries|
|9.1|2|Employer’s requirements|
|9.1.1|3|Site accommodation|
|9.1.2|3|Site records|
|9.1.3|3|Completion and post-completion requirements|
|9.2|2|Main contractor’s cost items|
|9.2.1|3|Management and staff|
|9.2.2|3|Site establishment|
|9.2.3|3|Temporary utilities|
|9.2.4|3|Security|
|9.2.5|3|Safety and environmental protection|
|9.2.6|3|Control and protection|
|9.2.7|3|Mechanical plant|
|9.2.8|3|Temporary works|
|9.2.9|3|Site records|
|9.2.10|3|Completion and post-completion requirements|
|9.2.11|3|Cleaning|
|9.2.12|3|Fees and charges|
|9.2.13|3|Site services|
|9.2.14|3|Insurance, bonds, guarantees and warranties|
|10|1|Main contractor’s overheads and profit|
|10.1|2|Main contractor’s overheads|
|10.2|2|Main contractor’s profit|
|11|1|Project and design team fees|
|11.1|2|Consultants’ fees|
|11.1.1|3|Project and design team consultants’ fees|
|11.1.2|3|Other consultants’ fees|
|11.1.3|3|Site investigation fees|
|11.1.4|3|Specialist support consultants’ fees|
|11.2|2|Main contractor’s pre-construction fees|
|11.2.1|3|Management and staff fees|
|11.2.2|3|Specialist support services fees|
|11.2.3|3|Temporary accommodation, services and facilities charges|
|11.2.4|3|Main contractor’s overheads and profit|
|11.3|2|Main contractor’s design fees|
|11.3.1|3|Fees for main contractor’s design consultants|
|12|1|Other project costs|
|12.1|2|Other project costs|
|12.1.1|3|Land acquisition costs|
|12.1.2|3|Employer finance costs|
|12.1.3|3|Fees|
|12.1.4|3|Charges|
|12.1.5|3|Planning contributions|
|12.1.6|3|Insurances|
|12.1.7|3|Archaeological fieldwork|
|12.1.8|3|Other specialist fieldwork|
|12.1.9|3|Decanting and relocation costs|
|12.1.10|3|Fittings, furnishings and equipment|
|12.1.11|3|Tenant’s costs/contributions|
|12.1.12|3|Marketing costs|
|12.1.13|3|Other employer costs|
|13|1|Risks|
|13.1|2|Design development risks|
|13.2|2|Construction risks|
|13.3|2|Employer change risks|
|13.4|2|Employer other risks|
|14|1|Inflation|
|14.1|2|Tender inflation|
|14.2|2|Construction inflation|

## Appendix C. NRM 2 complete work-section catalogue

Source: NRM 2 second edition October 2021, contents pp. iv–vi. These are work sections, not NRM 1 elemental codes. Table item numbers must be stored separately from the work-section number.

|Work section|Official heading|
|---|---|
|1|Preliminaries|
|2|Off-site manufactured materials, components or buildings|
|3|Demolitions|
|4|Alterations, repairs and conservation|
|5|Excavating and filling|
|6|Ground remediation and soil stabilisation|
|7|Piling|
|8|Underpinning|
|9|Diaphragm walls and embedded retaining walls|
|10|Crib walls, gabions and reinforced earth|
|11|In-situ concrete works|
|12|Precast/composite concrete|
|13|Precast concrete|
|14|Masonry|
|15|Structural metalwork|
|16|Carpentry|
|17|Sheet roof coverings|
|18|Tile and slate roof and wall coverings|
|19|Waterproofing|
|20|Proprietary walls, linings and partitions|
|21|Cladding and covering|
|22|General joinery|
|23|Windows, screens and lights|
|24|Doors, shutters and hatches|
|25|Stairs, walkways and balustrades|
|26|Metalwork|
|27|Glazing|
|28|Floor, wall, ceiling and roof finishings|
|29|Decoration|
|30|Suspended ceilings|
|31|Insulation, fire stopping and fire protection|
|32|Furniture, fittings and equipment|
|33|Drainage above ground|
|34|Drainage below ground|
|35|Site works|
|36|Fencing|
|37|Soft landscaping|
|38|Mechanical services|
|39|Electrical services|
|40|Transportation systems|
|41|Builder’s work in connection with mechanical, electrical and transportation installations|
