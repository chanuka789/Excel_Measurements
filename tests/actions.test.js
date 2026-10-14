// Unit tests: AI action definitions, plan clean-up and scoring of the action test cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanActions, actionKind, actionText, ACTIONS_TEXT } from '../public/js/actdefs.js';
import { normalizePlan } from '../src/ai.js';
import { scoreCase } from '../src/aieval.js';
import { matchFilter } from '../public/js/filter.js';

const conc = { 'Structural Material': 'Concrete 40' };
const E = [
  { id: 1, cat: 'Structural Columns', fam: 'C', type: 'C-300x300', level: 'L1', props: conc, q: {} },
  { id: 2, cat: 'Floors', fam: 'Floor', type: 'Slab 200', level: 'L1', props: conc, q: { 'Area on ground': [10, 'm2'] } },
  { id: 3, cat: 'Structural Framing', fam: 'UK Beams', type: 'UKB127x76x13', level: 'L2', props: { 'Structural Material': 'Steel S275' }, q: {} },
];
const data = { elements: E, byId: new Map(E.map(e => [e.id, e])) };

test('actions: unknown ones are dropped, the Take-off sheet cannot be deleted, kinds and texts', () => {
  const { actions, dropped } = cleanActions([{ do: 'select', filter: { category: ['Floors'] } }, { do: 'format_disk' }, { do: 'delete_sheet', name: 'Take-off' }, { do: 'delete_zone', name: 'A' }]);
  assert.deepEqual(actions.map(a => a.do), ['select', 'delete_zone']);
  assert.deepEqual(dropped, ['format_disk', 'delete_sheet Take-off']);
  assert.equal(actionKind({ do: 'select' }), 'view'); assert.equal(actionKind({ do: 'measure_item' }), 'write'); assert.equal(actionKind({ do: 'delete_zone' }), 'delete');
  assert.match(actionText({ do: 'create_zone', name: 'Villa', filter: { level: ['L1'] } }), /Villa.*level L1/);
  assert.match(ACTIONS_TEXT, /measure_item \(write\)/);
});

test('plan: a question removes write actions (ask first, act after the answer); rules used are kept', () => {
  const p = normalizePlan({ question: 'What is the ground level?', actions: [{ do: 'select', filter: {} }, { do: 'measure_item', item: 'st-walls' }], rules_used: [{ ref: 'NRM2 11.15', use: 'soffits' }, { use: 'no ref' }] });
  assert.deepEqual(p.actions.map(a => a.do), ['select']);
  assert.equal(p.rules_used.length, 1);
});

test('filter: material and QS element kind', () => {
  assert.deepEqual(matchFilter(E, { material: ['steel'] }).map(e => e.id), [3]);
  assert.deepEqual(matchFilter(E, { qsKind: ['column'] }).map(e => e.id), [1]);
  assert.deepEqual(matchFilter(E, { category: ['Floors', 'Structural Columns'], level: ['l1'] }).map(e => e.id), [1, 2]);
});

test('scoring of action cases: required actions, arguments, order, categories, no writes, citations', () => {
  const plan = { actions: [{ do: 'set_rules', rule_set: 'POMI' }, { do: 'measure_item', item: 'st-columns', rule: 'POMI C2' }, { do: 'isolate', filter: { category: ['Structural Columns'] } }] };
  assert.equal(scoreCase({ expect: { actions: [{ do: 'set_rules', rule_set: 'POMI' }, { do: 'measure_item', item: 'st-columns' }], order: ['set_rules', 'measure_item'], cite: true } }, plan, data).pass, true);
  assert.equal(scoreCase({ expect: { order: ['measure_item', 'set_rules'] } }, plan, data).pass, false);
  assert.equal(scoreCase({ expect: { actions: [{ do: 'isolate', categories: ['Structural Columns'] }] } }, plan, data).pass, true);
  assert.equal(scoreCase({ expect: { actions: [{ do: 'isolate', categories: ['Floors'] }] } }, plan, data).pass, false);
  assert.equal(scoreCase({ expect: { no_writes: true } }, plan, data).pass, false);
  assert.equal(scoreCase({ expect: { no_writes: true, ask: true } }, { question: 'Which ground level?', actions: [] }, data).pass, true);
  assert.equal(scoreCase({ expect: { items_any: ['st-beams'] } }, plan, data).pass, false);
});
