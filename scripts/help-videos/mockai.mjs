import http from 'http';
const plan = { message: 'Beam formwork: soffit plus two sides less the slab, tested on the model.', groups: [{
  name: 'Formwork to concrete beams', filter: { category: ['Structural Framing'] }, group_by: 'type', note: 'Soffit = b x L; sides = 2 x (h - slab) x L',
  inputs: [{ key: 'n', label: 'Count', unit: 'nr', source: 'count', sum: true }, { key: 'L', label: 'Cut length', unit: 'm', source: 'property', name: 'Cut Length', sum: true },
    { key: 'b', label: 'Width', unit: 'm', source: 'type_dim', index: 0 }, { key: 'h', label: 'Depth', unit: 'm', source: 'type_dim', index: 1 }],
  constants: [{ key: 'slab', label: 'Slab thickness', value: 0.2, unit: 'm' }],
  formulas: [{ key: 'soffit', label: 'Soffit', unit: 'm2', expr: '{b} * {L}' }, { key: 'sides', label: 'Sides', unit: 'm2', expr: '2 * MAX({h} - {slab}, 0) * {L}' }, { key: 'FW', label: 'Formwork', unit: 'm2', expr: '{soffit} + {sides}' }] }] };
http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
  const body = JSON.parse(b || '{}'); const sys = body.messages?.[0]?.content || '';
  const hasTool = (body.messages || []).some(m => m.role === 'tool');
  res.setHeader('Content-Type', 'application/json');
  let message;
  const userText = (body.messages || []).filter(m => m.role === 'user').map(m => m.content).join(' ');
  if (/STRUCTPLAN/.test(userText)) {
    message = { content: JSON.stringify({ message: 'Structure measured into dimension groups by POMI sections.', rules_used: [{ ref: 'POMI C4', use: 'formwork to soffits and sides' }],
      actions: [{ do: 'create_structure_groups' }, { do: 'groups_to_excel', folder: 'Section C - Concrete works' }] }) };
  } else if (/ACTPLAN/.test(userText)) {
    if (body.tools && !hasTool) message = { role: 'assistant', content: '', tool_calls: [
      { id: 'a1', type: 'function', function: { name: 'test_item', arguments: JSON.stringify({ item: 'st-columns' }) } },
      { id: 'a2', type: 'function', function: { name: 'rule_info', arguments: JSON.stringify({ rule_set: 'NRM2', topic: 'formwork' }) } },
      { id: 'a3', type: 'function', function: { name: 'project_state', arguments: '{}' } }] };
    else message = { content: JSON.stringify({ message: 'Columns and slabs measured by NRM2, organised, zoned and summarised.',
      rules_used: [{ ref: 'NRM2 11.5', use: 'columns are vertical work, split at 300 mm thick' }, { ref: 'NRM2 11.15', use: 'slab soffits split by propping height' }],
      actions: [
        { do: 'set_rules', rule_set: 'NRM2', why: 'Bills of quantities' },
        { do: 'qs_setup', ground_level: 0, why: 'Ground level for waterproofing' },
        { do: 'create_folder', name: 'Structure AI' },
        { do: 'create_dim_group', name: 'Columns AI', folder: 'Structure AI', mtype: 'Volume', quantity: 'Volume', filter: { category: ['Structural Columns'] } },
        { do: 'create_zone', name: 'Ground AI', filter: { level: ['GROUND FLOOR'] } },
        { do: 'isolate', filter: { category: ['Structural Columns'] } },
        { do: 'measure_item', item: 'st-columns', rule: 'NRM2 11.5' },
        { do: 'measure_item', item: 'st-slabs', rule: 'NRM2 11.15' },
        { do: 'build_summaries', kinds: ['summary', 'NRM2', 'NRM1'], by: 'level', gifa: 500 },
        { do: 'new_sheet', sheet: { name: 'Concrete check', title: 'Concrete check', columns: [{ head: 'Item', width: 220 }, { head: 'm3', format: '#,##0.00' }],
          rows: [{ cells: ['Columns, vertical work not over 300 thick', '=QTYD("Vertical work, not exceeding 300 mm thick","m3")'] }, { style: 'total', cells: ['Total', '=SUM(B5:B5)'] }] } },
        { do: 'run_checks', check: 'missing' },
        { do: 'show_all' },
      ] }) };
  }
  else if (body.tools && !hasTool) message = { role: 'assistant', content: '', tool_calls: [
    { id: 't1', type: 'function', function: { name: 'find_elements', arguments: JSON.stringify({ filter: { category: ['Structural Framing'] } }) } },
    { id: 't2', type: 'function', function: { name: 'test_plan', arguments: JSON.stringify({ group: plan.groups[0] }) } }] };
  else if (/reviewing a take-off/.test(sys)) message = { content: JSON.stringify({ summary: 'Mostly complete.', findings: [{ severity: 'high', group: 'Formwork to concrete beams', issue: 'Concrete to beams is not measured.', suggestion: 'Add a concrete volume group for the same beams.' }, { severity: 'low', group: '', issue: 'Foundations are not measured.', suggestion: 'Apply the foundations template.' }] }) };
  else if (/bill of quantities item descriptions/.test(sys)) { const items = JSON.parse(body.messages[1].content).items; message = { content: JSON.stringify({ items: items.map(i => ({ ref: i.ref, heading: 'IN-SITU CONCRETE WORKS', description: `Formwork to soffits and sides of reinforced concrete beams [specification]; ${i.quantity}`, unit: i.unit })) }) }; }
  else message = { content: JSON.stringify(plan) };
  res.end(JSON.stringify({ model: 'mock', choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
}); }).listen(3099);
