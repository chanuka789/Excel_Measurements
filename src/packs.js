// Built-in measurement templates ("discipline packs"). A template is a take-off spec with a filter
// instead of element IDs; applying it to a model selects the matching elements.
// "Geo ..." quantities are measured from the 3D geometry; others are Revit's exported values.
const I = {
  n: { key: 'n', label: 'Count', unit: 'nr', source: 'count', sum: true },
  vol: { key: 'V', label: 'Volume (Revit)', unit: 'm3', source: 'property', name: 'Volume', sum: true },
  gvol: { key: 'GV', label: 'Volume (geometry)', unit: 'm3', source: 'property', name: 'Geo volume', sum: true },
  area: { key: 'A', label: 'Area', unit: 'm2', source: 'property', name: 'Area', sum: true },
  len: { key: 'L', label: 'Length', unit: 'm', source: 'property', name: 'Length', sum: true },
  cut: { key: 'L', label: 'Cut length', unit: 'm', source: 'property', name: 'Cut Length', sum: true },
  b: { key: 'b', label: 'Width (type name)', unit: 'm', source: 'type_dim', index: 0 },
  h: { key: 'h', label: 'Depth (type name)', unit: 'm', source: 'type_dim', index: 1 },
  bot: { key: 'Abot', label: 'Bottom faces (geometry)', unit: 'm2', source: 'property', name: 'Geo bottom area', sum: true },
  top: { key: 'Atop', label: 'Top faces (geometry)', unit: 'm2', source: 'property', name: 'Geo top area', sum: true },
  side: { key: 'Aside', label: 'Vertical faces (geometry)', unit: 'm2', source: 'property', name: 'Geo side area', sum: true },
  open: { key: 'Aop', label: 'Openings to deduct', unit: 'm2', source: 'property', name: 'Openings to deduct', sum: true },
};
const t = (name, discipline, description, filter, inputs, constants, formulas, by = 'type') =>
  ({ name, discipline, description, spec: { name, filter, by, note: description, inputs, constants, formulas } });

export const PACKS = [
  // ------------------------------------------------------------------ Structure
  t('Concrete to beams', 'Structure', 'Concrete volume of beams. Revit volume and the exact geometry volume side by side.',
    { category: ['Structural Framing'] }, [I.n, I.cut, I.vol, I.gvol], [], []),
  t('Formwork to beams (soffit + sides less slab)', 'Structure', 'Soffit = width x length; sides = 2 x (depth - slab) x length. Width and depth from the type name.',
    { category: ['Structural Framing'] }, [I.n, I.cut, I.b, I.h],
    [{ key: 'slab', label: 'Slab thickness deducted', value: 0.2, unit: 'm' }],
    [{ key: 'soffit', label: 'Soffit', unit: 'm2', expr: '{b} * {L}' },
     { key: 'sides', label: 'Sides', unit: 'm2', expr: '2 * MAX({h} - {slab}, 0) * {L}' },
     { key: 'FW', label: 'Formwork total', unit: 'm2', expr: '{soffit} + {sides}' }]),
  t('Formwork to beams (exact geometry)', 'Structure', 'Bottom + vertical faces measured from the 3D model. Faces already cut by slabs and columns in Revit are excluded automatically.',
    { category: ['Structural Framing'] }, [I.n, I.bot, I.side], [],
    [{ key: 'FW', label: 'Formwork', unit: 'm2', expr: '{Abot} + {Aside}' }]),
  t('Concrete and formwork to columns', 'Structure', 'Volume and vertical faces (formwork) of columns from the geometry.',
    { category: ['Structural Columns'] }, [I.n, I.vol, I.gvol, I.side], [],
    [{ key: 'FW', label: 'Formwork', unit: 'm2', expr: '{Aside}' }]),
  t('Concrete to slabs, soffit and edge formwork', 'Structure', 'Slab volume, soffit formwork (bottom faces) and edge formwork (vertical faces).',
    { category: ['Floors'] }, [I.n, I.area, I.vol, I.gvol, I.bot, I.side], [],
    [{ key: 'soffitFW', label: 'Soffit formwork', unit: 'm2', expr: '{Abot}' },
     { key: 'edgeFW', label: 'Edge formwork', unit: 'm2', expr: '{Aside}' }]),
  t('Concrete and formwork to walls', 'Structure', 'Wall volume; formwork to both faces and ends (vertical faces from the geometry).',
    { category: ['Walls'] }, [I.n, I.len, I.vol, I.gvol, I.side], [],
    [{ key: 'FW', label: 'Formwork both faces', unit: 'm2', expr: '{Aside}' }]),
  t('Foundations: concrete, blinding, formwork, waterproofing', 'Structure', 'Blinding = bottom area x thickness; formwork = vertical faces; waterproofing = bottom + vertical faces in contact with ground.',
    { category: ['Structural Foundations'] }, [I.n, I.vol, I.gvol, I.bot, I.side],
    [{ key: 'blind', label: 'Blinding thickness', value: 0.05, unit: 'm' }],
    [{ key: 'BL', label: 'Blinding', unit: 'm3', expr: '{Abot} * {blind}' },
     { key: 'FW', label: 'Formwork', unit: 'm2', expr: '{Aside}' },
     { key: 'WP', label: 'Waterproofing', unit: 'm2', expr: '{Abot} + {Aside}' }]),
  t('Reinforcement by ratio', 'Structure', 'Reinforcement = concrete volume x kg/m3 ratio. Change the ratio in Excel per element type.',
    { category: ['Structural Framing', 'Structural Columns', 'Floors', 'Walls', 'Structural Foundations'] }, [I.n, I.vol],
    [{ key: 'ratio', label: 'Reinforcement ratio', value: 120, unit: 'kg/m3' }],
    [{ key: 'kg', label: 'Reinforcement', unit: 'kg', expr: '{V} * {ratio}' },
     { key: 't', label: 'Reinforcement', unit: 't', expr: '{kg} / 1000' }]),
  t('Structural steel by section', 'Structure', 'Steel members (non-concrete framing) by section with length and count.',
    { category: ['Structural Framing'], type_contains: ['ukb', 'ukc', 'ub', 'uc', 'ipe', 'hea', 'heb', 'shs', 'rhs', 'chs', 'pfc', 'angle', 'steel'], type_excludes: ['cip', 'concrete', 'precast'] },
    [I.n, I.cut], [], []),

  // ------------------------------------------------------------------ Architecture
  t('Wall finishes both faces less openings', 'Architecture', 'Vertical faces of walls less openings over the deduction threshold on both faces.',
    { category: ['Walls'] }, [I.n, I.len, I.side, I.open], [{ key: 'faces', label: 'Faces with openings deducted', value: 2, unit: 'nr' }],
    [{ key: 'FIN', label: 'Finish area', unit: 'm2', expr: 'MAX({Aside} - {faces} * {Aop}, 0)' }]),
  t('Doors by type', 'Architecture', 'Count of doors by type.', { category: ['Doors'] }, [I.n], [], []),
  t('Windows by type', 'Architecture', 'Count of windows by type.', { category: ['Windows'] }, [I.n], [], []),
  t('Floor finishes', 'Architecture', 'Floor finish areas by type.', { category: ['Floors'] }, [I.n, I.area, I.top], [], []),
  t('Ceilings', 'Architecture', 'Ceiling areas by type.', { category: ['Ceilings'] }, [I.n, I.area], [], []),
  t('Roofs', 'Architecture', 'Roof areas (Revit area and top faces from the geometry).', { category: ['Roofs'] }, [I.n, I.area, I.top], [], []),
  t('Curtain walls and panels', 'Architecture', 'Curtain panels by type with area.', { category: ['Curtain Panels'] }, [I.n, I.area], [], []),
  t('Stairs and railings', 'Architecture', 'Stairs, runs and railings counted, railings with length.', { category: ['Stairs', 'Railings'] }, [I.n, I.len], [], []),

  // ------------------------------------------------------------------ Interiors
  t('Furniture and casework', 'Interiors', 'Loose furniture and casework counted by type.', { category: ['Furniture', 'Casework', 'Furniture Systems'] }, [I.n], [], []),
  t('Partitions one face', 'Interiors', 'Partition areas, one face, with the opening deduction for that face.',
    { category: ['Walls'] }, [I.n, I.len, I.area, I.open], [],
    [{ key: 'NET', label: 'Net area one face', unit: 'm2', expr: 'MAX({A} - {Aop}, 0)' }]),
  t('Ceilings by type and level', 'Interiors', 'Ceiling areas split by level.', { category: ['Ceilings'] }, [I.n, I.area], [], [], 'level'),
  t('Specialty equipment and fixtures', 'Interiors', 'Specialty equipment, generic models and plumbing fixtures counted.',
    { category: ['Specialty Equipment', 'Generic Models', 'Plumbing Fixtures'] }, [I.n], [], []),

  // ------------------------------------------------------------------ MEP
  t('Pipes by type and size', 'MEP', 'Pipe length by type; size is in the type or properties.', { category: ['Pipes'] }, [I.n, I.len], [], []),
  t('Ducts by type', 'MEP', 'Duct length by type.', { category: ['Ducts', 'Flex Ducts'] }, [I.n, I.len], [], []),
  t('Cable trays and conduits', 'MEP', 'Cable tray and conduit length by type.', { category: ['Cable Trays', 'Conduits'] }, [I.n, I.len], [], []),
  t('Fittings and accessories', 'MEP', 'Pipe and duct fittings and accessories counted by type.',
    { category: ['Pipe Fittings', 'Pipe Accessories', 'Duct Fittings', 'Duct Accessories', 'Cable Tray Fittings', 'Conduit Fittings'] }, [I.n], [], []),
  t('Equipment and fixtures', 'MEP', 'Mechanical, electrical and plumbing equipment, fixtures and devices counted by type.',
    { category: ['Mechanical Equipment', 'Electrical Equipment', 'Plumbing Fixtures', 'Lighting Fixtures', 'Electrical Fixtures', 'Air Terminals', 'Sprinklers', 'Fire Alarm Devices', 'Lighting Devices', 'Communication Devices', 'Data Devices'] }, [I.n], [], []),
];
