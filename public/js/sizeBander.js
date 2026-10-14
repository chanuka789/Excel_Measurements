// Explicit boundaries: no overlapping bands and no office subdivisions presented as standard rules.
export function bandOf(value, limits) {
  if (!Number.isFinite(value) || value < 0) return null;
  const i = limits.findIndex(n => value <= n + 1e-9);
  const upper = i < 0 ? null : limits[i], lower = i < 0 ? limits.at(-1) : i === 0 ? 0 : limits[i - 1];
  return { lower, upper, index: i < 0 ? limits.length : i };
}
export function proppingBand(height) {
  if (!Number.isFinite(height) || height < 0) return null;
  const limits = [3, 4.5];
  for (let n = 6; n < height + 1.5; n += 1.5) limits.push(n);
  return bandOf(height, limits);
}
export function bandLabel(b, unit = 'mm', scale = 1000) {
  if (!b) return 'dimension missing';
  return b.upper == null ? `>${b.lower * scale} ${unit}` : b.lower === 0 ? `≤${b.upper * scale} ${unit}` : `>${b.lower * scale}–${b.upper * scale} ${unit}`;
}
export function quantityBand(stream, basis, dims = {}) {
  if (basis !== 'NRM2') return '';
  if (stream === 'concrete') return bandLabel(bandOf(dims.thickness, [0.3]));
  if (stream === 'soffit') return `${bandLabel(bandOf(dims.thickness, [0.3, 0.45]))}; propping ${bandLabel(proppingBand(dims.propping), 'm', 1)}`;
  return '';
}
