// AI assistant: turns a plain-English request into a measurement plan (the add-in computes the numbers).
import express from 'express';
import { audit } from './db.js';

export const AI = {
  base: (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  key: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || 'deepseek-flash',
};

const SYSTEM = `You are a senior quantity surveyor working inside an Excel add-in that measures Revit DWFx models.
You get a SUMMARY of the model and a REQUEST. Think like a QS (NRM2 / POMI practice): decide which elements to
measure and HOW to calculate each quantity, then return a plan. The add-in reads the real element values, evaluates
your formulas for every element, and writes them to Excel as live formulas. You never invent numbers.

SUMMARY gives, per type: category, family, type, count, levels, "type_name_sizes_m" (sizes parsed from the type
name in metres, e.g. "B-200X750" -> [0.2, 0.75], usually width then depth/height), and "quantities"
(property name -> unit and a sample value). All units are metres, m2, m3.

Return ONLY this JSON:
{"message": "short plain-English summary of what you measured and any key assumption",
 "groups": [{
   "name": "take-off group name, e.g. 'Formwork to RC beams - First floor'",
   "filter": {"category": [], "family": [], "type": [], "type_contains": [], "type_excludes": [], "level": [], "use_ticked": false},
   "group_by": "type" | "level" | "",
   "inputs": [ {"key": "L", "label": "Cut length", "unit": "m", "source": "property", "name": "Cut Length"},
               {"key": "b", "label": "Width", "unit": "m", "source": "type_dim", "index": 0},
               {"key": "n", "label": "Count", "unit": "nr", "source": "count", "sum": true} ],
   "constants": [ {"key": "slab", "label": "Slab thickness deducted", "value": 0.2, "unit": "m"} ],
   "formulas": [ {"key": "FW", "label": "Formwork soffit + sides", "unit": "m2", "expr": "({b} + 2*MAX({h} - {slab}, 0)) * {L}"} ],
   "note": "method and assumptions the QS must check"
 }]}

Rules:
- input "source": "property" (name must be an exact quantity name from the summary), "type_dim" (index into
  type_name_sizes_m), "name_dim", or "count". Set "sum": true only for inputs that make sense to total (lengths,
  areas, volumes, counts), never for widths/depths/heights.
- "expr" uses {key} of inputs, constants or earlier formulas, numbers, + - * / ( ), and MAX, MIN, ABS, ROUND,
  SQRT, PI, IF(cond,a,b). No other text. Formula results are always totalled.
- Put every assumption (slab thickness, lap allowance, wastage %, number of faces, deductions) in "constants"
  so the QS can change it in Excel. Never hide assumptions inside numbers in a formula.
- Typical methods: beam formwork = soffit width + 2 sides x (depth - slab) x length (use Cut Length when present);
  ground beams usually no soffit; column formwork = perimeter x height (less beam/slab depth if asked);
  wall formwork = 2 faces x length x height; slab soffit = area, slab edges = perimeter x thickness;
  blinding = plan area x thickness; waterproofing = surfaces in contact with ground; finishes = face areas.
- Use "use_ticked": true when the user says "selected" / "ticked" elements.
- Use only category/family/type/level/quantity names that exist in the summary. If the needed data is missing,
  say so in "message" and suggest the closest method. If the request is unclear, return no groups and ask.`;

export function registerAI(router) {
router.post('/ai', express.json({ limit: '4mb' }), async (req, res) => {
  if (!AI.key) return res.status(503).json({ error: 'AI is not set up on the server. Add AI_API_KEY in Railway.' });
  const { request, summary, projectId } = req.body || {};
  if (projectId) audit(req.user.id, projectId, 'ai.request', { request: String(request || '').slice(0, 300) });
  if (!request || !summary) return res.status(400).json({ error: 'Missing request or model summary.' });
  try {
    const r = await fetch(AI.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.key },
      body: JSON.stringify({
        model: AI.model, temperature: 0.1, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM },
                   { role: 'user', content: 'SUMMARY:\n' + JSON.stringify(summary) + '\n\nREQUEST:\n' + String(request).slice(0, 2000) }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'AI provider error: ' + (body.error?.message || r.statusText) });
    const text = body.choices?.[0]?.message?.content || '{}';
    const plan = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
    res.json({ plan, model: AI.model });
  } catch (err) {
    res.status(502).json({ error: 'AI request failed: ' + err.message });
  }
});
}
