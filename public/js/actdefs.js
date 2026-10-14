// The actions the AI can plan in the app. Shared by the server (to describe and check them) and the add-in
// (to show the plan as a checklist and run it). kind: view (changes only what you see), read (checks), write
// (creates or changes something), delete (removes something). Writes and deletes run only after the user's OK.
const s = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const filt = (f) => (f && typeof f === 'object' ? f : null);

export const ACTIONS = {
  select: { kind: 'view', args: '{"filter": {...}}', help: 'Select elements in the 3D model.', text: (a) => `Select ${desc(a.filter)}` },
  isolate: { kind: 'view', args: '{"filter": {...}}', help: 'Show only these elements.', text: (a) => `Show only ${desc(a.filter)}` },
  hide: { kind: 'view', args: '{"filter": {...}}', help: 'Hide elements.', text: (a) => `Hide ${desc(a.filter)}` },
  show_all: { kind: 'view', args: '{}', help: 'Show every element again.', text: () => 'Show all elements' },
  view: { kind: 'view', args: '{"view": "top|bottom|front|back|left|right|iso"}', help: 'Turn the 3D view.', text: (a) => `Turn the view to ${s(a.view, 20)}` },
  color_by: { kind: 'view', args: '{"mode": "category|level|zone|measured|type"}', help: 'Colour the model.', text: (a) => `Colour the model by ${s(a.mode, 30)}` },
  run_checks: { kind: 'read', args: '{"check": "missing|overlaps"}', help: 'Model checks: missing data, or overlapping elements (double counting).', text: (a) => (a.check === 'overlaps' ? 'Check for overlapping elements' : 'Check for missing model data') },
  set_rules: { kind: 'write', args: '{"rule_set": "NRM2|POMI|NRM1"}', help: 'Measurement rules for this project.', text: (a) => `Use ${s(a.rule_set, 10)} measurement rules for this project` },
  qs_setup: { kind: 'write', args: '{"ground_level": m|null, "wp_upturn": m, "roof_upturn": m, "wp_under_ground": bool, "wp_foundation_sides": bool, "wp_roof": bool, "earth_faced": bool, "rates": {"slab": kg/m3, ...}}',
    help: 'Project QS assumptions (only the fields you give change).', text: (a) => `Change the QS setup: ${Object.entries(a).filter(([k]) => !['do', 'why', 'rule'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}` },
  create_folder: { kind: 'write', args: '{"name": "...", "parent": "folder name or empty"}', help: 'A folder for dimension groups.', text: (a) => `Create folder "${s(a.name, 80)}"${a.parent ? ` in "${s(a.parent, 80)}"` : ''}` },
  create_dim_group: { kind: 'write', args: '{"name": "...", "folder": "folder name or empty", "mtype": "Count|Length|Area|Volume", "quantity": "model quantity name for the value, e.g. Area", "filter": {...}}',
    help: 'A dimension group, with the elements imported into it.', text: (a) => `Create dimension group "${s(a.name, 80)}" (${s(a.mtype || 'Count', 10)}${a.quantity && String(a.quantity).toLowerCase() !== String(a.mtype || '').toLowerCase() ? ` of ${s(a.quantity, 40)}` : ''})${a.folder ? ` in "${s(a.folder, 80)}"` : ''}${a.filter ? ` with ${desc(a.filter)}` : ''}` },
  import_objects: { kind: 'write', args: '{"group": "dimension group name", "filter": {...}}', help: 'Add elements to an existing dimension group.', text: (a) => `Add ${desc(a.filter)} to dimension group "${s(a.group, 80)}"` },
  create_zone: { kind: 'write', args: '{"name": "...", "filter": {...}, "color": "#rrggbb"}', help: 'A named zone (sub-totals and colours by zone).', text: (a) => `Create zone "${s(a.name, 80)}" from ${desc(a.filter)}` },
  create_structure_groups: { kind: 'write', args: '{"filter": {...} (optional, default all structural elements), "root": "optional top folder"}',
    help: 'THE way to measure structure into dimension groups: one group per element type (slabs and walls per thickness, named like "200 mm suspended slab") holding the concrete volume AND formwork, reinforcement, waterproofing (piles: number and length; steel: tonnes) as quantities of the same group, filed in folders "Section C - Concrete works\\Substructure | Frame | Superstructure | Roof" (steel in "Section E - Metal work"). Existing groups with the same name are updated, not duplicated.',
    text: (a) => `Create the structural dimension groups (volume, formwork, reinforcement, waterproofing in each group) in POMI section folders${a.filter ? ` for ${desc(a.filter)}` : ''}${a.root ? ` under "${s(a.root, 80)}"` : ''}` },
  groups_to_excel: { kind: 'write', args: '{"folder": "folder name, e.g. Section C - Concrete works (empty: all groups)"}',
    help: 'Add dimension groups to Excel: one table per group with all its quantities (volume, formwork, reinforcement, waterproofing).', text: (a) => `Add the dimension groups${a.folder ? ` in "${s(a.folder, 80)}"` : ''} to Excel (one table per group)` },
  measure_item: { kind: 'write', args: '{"item": "measure item id", "filter": {...} (optional, narrows the item), "name": "optional table name prefix"}',
    help: 'Measure a library item by the project rules and add it to the take-off (one table per element type; concrete, formwork, reinforcement and waterproofing of the same elements in one table).',
    text: (a) => `Measure "${s(a.itemName || a.item, 80)}"${a.filter ? ` for ${desc(a.filter)}` : ''} and add it to the take-off` },
  add_groups: { kind: 'write', args: '{}', help: 'Add the custom take-off groups of this plan ("groups") to the take-off.', text: () => 'Add the custom take-off tables of this plan' },
  build_summaries: { kind: 'write', args: '{"kinds": ["summary", "NRM2", "POMI", "NRM1"], "by": "level|zone|none", "gifa": m2 or null}',
    help: 'Summary sheets by formula (Quantities register with SUMIFS, pivot summary by level/zone, NRM2/POMI summary, NRM1 elemental summary with GIFA).', text: (a) => `Build summary sheets: ${(a.kinds || ['summary']).join(', ')}${a.by ? ` by ${s(a.by, 10)}` : ''}` },
  new_sheet: { kind: 'write', args: '{"sheet": {"name": "...", "title": "...", "note": "...", "columns": [{"head": "...", "width": 90, "format": "#,##0.00"}], "rows": [{"style": "section|item|input|subtotal|total|note", "cells": ["text", 12.5, "=formula"]}]}}',
    help: 'A new Excel sheet made with formulas. In formulas use QTY("item code") or QTYD("description", "unit") for register quantities, TOTAL("G3","KEY") for a take-off total, and normal cell references (rows[0] is Excel row 5). Inputs are yellow.',
    text: (a) => `Create the sheet "${s(a.sheet?.name, 31)}" (${(a.sheet?.rows || []).length} rows, formulas)` },
  build_boq: { kind: 'write', args: '{"ai_descriptions": bool}', help: 'BOQ sheet linked to the take-off totals.', text: (a) => `Build the BOQ sheet${a.ai_descriptions ? ' with AI descriptions' : ''}` },
  delete_folder: { kind: 'delete', args: '{"name": "..."}', help: 'Delete an empty dimension-group folder.', text: (a) => `Delete folder "${s(a.name, 80)}"` },
  delete_dim_group: { kind: 'delete', args: '{"name": "..."}', help: 'Delete a dimension group.', text: (a) => `Delete dimension group "${s(a.name, 80)}"` },
  delete_zone: { kind: 'delete', args: '{"name": "..."}', help: 'Delete a zone.', text: (a) => `Delete zone "${s(a.name, 80)}"` },
  delete_sheet: { kind: 'delete', args: '{"name": "..."}', help: 'Delete a summary or custom sheet (never the Take-off sheet).', text: (a) => `Delete the sheet "${s(a.name, 31)}"` },
};
export const PROTECTED_SHEETS = ['Take-off', '_dwfx', 'Change log'];

function desc(f) {
  f = filt(f); if (!f) return 'the elements';
  if (f.use_ticked) return 'the selected elements';
  const parts = [];
  ['category', 'family', 'type', 'type_contains', 'level', 'material', 'qsKind'].forEach(k => { const v = f[k]; const a = Array.isArray(v) ? v : v ? [v] : []; if (a.length) parts.push(`${k.replace('_', ' ')} ${a.slice(0, 4).join(', ')}${a.length > 4 ? '…' : ''}`); });
  return parts.length ? parts.join('; ') : 'all elements';
}
export const describeFilter = desc;

/** Keep only known actions with sane arguments. Unknown ones are dropped (and reported). */
export function cleanActions(list) {
  const out = [], dropped = [];
  for (const a of Array.isArray(list) ? list.slice(0, 40) : []) {
    const d = a && ACTIONS[a.do];
    if (!d) { dropped.push(String(a?.do || '?')); continue; }
    const x = { ...a, do: a.do, why: s(a.why, 300), rule: s(a.rule, 120) };
    if ('filter' in a) x.filter = filt(a.filter);
    if (a.do === 'delete_sheet' && PROTECTED_SHEETS.some(n => n.toLowerCase() === s(a.name).toLowerCase())) { dropped.push('delete_sheet ' + a.name); continue; }
    out.push(x);
  }
  return { actions: out, dropped };
}
export const actionKind = (a) => ACTIONS[a?.do]?.kind || 'write';
export const actionText = (a) => { try { return ACTIONS[a.do].text(a); } catch { return a.do; } };
/** For the AI prompt. */
export const ACTIONS_TEXT = Object.entries(ACTIONS).map(([k, d]) => `- ${k} (${d.kind}): ${d.help} Arguments: ${d.args}`).join('\n');
