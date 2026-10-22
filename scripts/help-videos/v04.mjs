import { session, openProject, openModel, browser } from './lib.mjs';
await session('04-ai', async (T) => {
  const { cap, click, p, pane, wait } = T;
  await T.top('#tabs [data-tab="DWFx Measure"]', 300); await T.top('#ribbon [data-fn=openProjects]', 800);
  await openProject(T); await openModel(T);
  await cap('The AI tab: describe what to measure in your own words, or pick a common request.', 2600);
  await click('[data-tab=ai]', 800); await click('#aiChips button', 900);
  await cap('The AI searches the model, reads the real quantities and tests its formulas before it answers.', 2600);
  await click('#aiGo', 400); await pane().waitForSelector('.ai-card', { timeout: 60000 }); await wait(800);
  await click('#aiOut details summary', 1800);
  await cap('Check the method and the assumptions (they become yellow cells in Excel), then add it.', 2800);
  await p.mouse.move(1160, 520, { steps: 6 }); await p.mouse.wheel(0, 380); await wait(1200);
  await click('.ai-card [data-a=add]', 2500);
  await cap('The result is in your Take-off sheet with live formulas. Now Review > AI take-off check looks for missing items and double counting.', 3400);
  await click('[data-tab=review]', 600); await click('[data-rsec=aicheck]', 600); await click('#acRun', 400);
  await pane().waitForSelector('#acOut .finding, #acOut .msg', { timeout: 60000 }); await wait(2800);
});
await browser.close();
