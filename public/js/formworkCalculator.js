// Returns physical quantities and review messages. Standard measurement adjustments are a separate step.
const finite = n => Number.isFinite(n) && n >= 0;
export function calculateFormwork({ kind, length, width, depth, height, diameter, slabThickness, clearHeight, formedSides = 2, earthCast = false, intersectionArea = 0, interfaceReviewed = false }) {
  if (!finite(intersectionArea)) throw new Error('Intersection area must be non-negative.');
  if (clearHeight != null && !finite(clearHeight)) throw new Error('Clear formed height must be non-negative.');
  if (![1, 2].includes(formedSides)) throw new Error('Wall formwork must be one-sided or two-sided.');
  const issues = ['Confirm formed faces, casting sequence and union of shared interfaces.'];
  if (earthCast) return { area: 0, edgeLength: 0, issues: ['Earth-cast assumption: formed sides excluded.'], provisional: true };
  let area = null, edgeLength = null;
  if (['footing', 'column'].includes(kind) && [width, depth, height].every(finite)) { area = 2 * (width + depth) * (clearHeight ?? height); if (kind === 'footing') edgeLength = 2 * (width + depth); }
  else if (kind === 'circular-column' && [diameter, height].every(finite)) area = Math.PI * diameter * (clearHeight ?? height);
  else if (kind === 'wall' && [length, height, depth].every(finite)) area = formedSides * length * height + 2 * depth * height;
  else if (kind === 'slab' && [length, width, depth].every(finite)) { area = length * width; edgeLength = 2 * (length + width); }
  else if (['beam', 'attached-beam'].includes(kind) && [length, width, depth].every(finite)) {
    if (kind === 'attached-beam' && (!finite(slabThickness) || slabThickness > depth)) return { area: null, issues: ['Attached beam requires a valid slab thickness not greater than beam depth.'], provisional: true };
    area = (width + 2 * (depth - (kind === 'attached-beam' ? slabThickness : 0))) * length;
  }
  if (area == null) issues.push('Required dimensions missing or geometry unsupported.');
  if (area != null && intersectionArea > area) throw new Error('Intersection deduction exceeds the formed area.');
  if (intersectionArea && !interfaceReviewed) issues.push('Intersection deduction has not been reviewed.');
  return { area: area == null ? null : area - intersectionArea, edgeLength, issues, provisional: true };
}

/** Add back retained opening areas to a net physical area. Exact boundaries differ between the standards. */
export function measuredArea(physicalNet, openings, basis, stream) {
  if (!finite(physicalNet)) return null;
  if (!Array.isArray(openings)) return { quantity: physicalNet, issues: ['Opening topology unavailable; measured area needs QS review.'] };
  let quantity = physicalNet;
  for (const o of openings) {
    if (!finite(o.area)) throw new Error('Opening area must be non-negative.');
    const retain = basis === 'NRM2' && stream === 'formwork' ? o.area <= 5 : basis === 'POMI' ? !o.atEdge && o.area < 1 : false;
    if (retain) quantity += o.area * (o.faces ?? 1);
  }
  return { quantity, issues: [] };
}
