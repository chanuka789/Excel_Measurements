// Keep browser heading indexes identical to the checked, versioned JSON catalogues.
import fs from 'node:fs';
const names = { POMI: 'pomi-1979-reprint', NRM1: 'nrm1-2021', NRM2: 'nrm2-2021' };
const data = Object.fromEntries(Object.entries(names).map(([id, name]) => [id, JSON.parse(fs.readFileSync(new URL(`../rules/catalogues/${name}.json`, import.meta.url)))]));
fs.writeFileSync(new URL('../public/js/standardsCatalogues.js', import.meta.url), '// Source-checked heading indexes. See docs/QS_AUTOMATION_PLAN.md, Appendices A-C.\n// Generated from rules/catalogues by scripts/build-standards.mjs.\nexport const CATALOGUES = ' + JSON.stringify(data) + ';\n');
