// Admin tab: system status, users (from APP_USERS), password hash tool, backup, activity log.
import { $, esc, App, api, fmtBytes, fmtDate, status } from './core.js';
import { S } from './state.js';

export async function showAdmin() {
  const box = $('adminBody');
  box.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const [sys, users, audit] = await Promise.all([api('GET', '/admin/system'), api('GET', '/admin/users'), api('GET', '/admin/audit')]);
    const jobs = Object.fromEntries(sys.jobs.map(j => [j.status, j.n]));
    box.innerHTML = `
      <h2 class="h">Admin</h2>
      <section class="card">
        <h3>System</h3>
        <dl class="kv">
          <dt>File storage</dt><dd>${sys.storage === 'bucket' ? 'Railway bucket' : 'Local folder (development)'}</dd>
          <dt>Projects</dt><dd>${sys.totals.projects}</dd>
          <dt>Model versions</dt><dd>${sys.totals.versions}</dd>
          <dt>Drawings</dt><dd>${sys.totals.drawings}</dd>
          <dt>Stored files</dt><dd>${fmtBytes(Number(sys.totals.bytes))}</dd>
          <dt>Processing jobs</dt><dd>${jobs.running || 0} running, ${jobs.queued || 0} waiting, ${jobs.failed || 0} failed</dd>
          <dt>Last backup</dt><dd>${sys.last_backup ? esc(sys.last_backup.replace('backups/', '').replace('.json.gz', '')) : 'None yet'}</dd>
        </dl>
        <div class="actions left"><button class="btn" id="adBackup">Back up database now</button></div>
      </section>

      <section class="card">
        <h3>Users</h3>
        <p class="muted small">Users come from the <code>APP_USERS</code> variable in Railway (one per line: <code>email | full name | role | password hash</code>). After you change it, Railway restarts the app and this list updates. Removing a line disables the user; their projects stay.</p>
        <div class="tscroll"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Projects</th><th>Last sign-in</th></tr></thead><tbody>
        ${users.users.map(u => `<tr><td>${esc(u.name)}<br><span class="muted small">${esc(u.email)}</span></td><td>${u.role === 'admin' ? 'Admin' : 'User'}</td>
          <td><span class="pill ${u.active ? 'ok' : 'neutral'}">${u.active ? 'Active' : 'Disabled'}</span></td><td class="num">${u.projects}</td><td class="small">${u.last_login ? fmtDate(u.last_login) : 'Never'}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="actions left"><button class="btn" id="adSync">Reload users from APP_USERS</button></div>
      </section>

      <section class="card">
        <h3>Create a password hash</h3>
        <p class="muted small">Type the new user's password, then copy the line into <code>APP_USERS</code>. The password itself is never stored.</p>
        <form id="hashForm" class="form">
          <div class="two"><label class="field">Email<input class="input" id="hEmail" type="email" placeholder="name@company.com"></label>
          <label class="field">Full name<input class="input" id="hName" placeholder="Full name"></label></div>
          <div class="two"><label class="field">Role<select class="input" id="hRole"><option value="user">User</option><option value="admin">Admin</option></select></label>
          <label class="field">Password (8+ characters)<input class="input" id="hPw" type="password" autocomplete="new-password" minlength="8" required></label></div>
          <div class="actions left"><button class="btn primary">Create line</button></div>
        </form>
        <div id="hashOut"></div>
      </section>

      <section class="card" id="errAdmin"><h3>Errors</h3><div class="loading">Loading…</div></section>
      <section class="card" id="aiAdmin"><h3>AI assistant</h3><div class="loading">Loading…</div></section>
      <section class="card" id="kbAdmin"><h3>Company QS rules</h3><div class="loading">Loading…</div></section>

      <section class="card">
        <h3>Recent activity</h3>
        <div class="tscroll"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Project</th><th>Action</th></tr></thead><tbody>
        ${audit.audit.slice(0, 100).map(a => `<tr><td class="small">${fmtDate(a.at)}</td><td class="small">${esc(a.email || '')}</td><td class="small">${esc(a.project || '')}</td><td class="small">${esc(a.action)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>`;
    $('adBackup').onclick = async () => { try { const r = await api('POST', '/admin/backup'); status(`Backup saved: ${r.key}`, 'ok'); showAdmin(); } catch (e) { status(e.message, 'bad'); } };
    $('adSync').onclick = async () => { try { const r = await api('POST', '/admin/sync-users'); status(`${r.active} active users${r.problems.length ? `; check APP_USERS: ${r.problems.join('; ')}` : ''}.`, r.problems.length ? 'bad' : 'ok'); showAdmin(); } catch (e) { status(e.message, 'bad'); } };
    $('hashForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { hash } = await api('POST', '/admin/hash', { password: $('hPw').value });
        const line = `${$('hEmail').value || 'name@company.com'} | ${$('hName').value || 'Full Name'} | ${$('hRole').value} | ${hash}`;
        $('hPw').value = '';
        $('hashOut').innerHTML = `<label class="field">Line for APP_USERS<textarea class="input mono" id="hashLine" readonly rows="3">${esc(line)}</textarea></label>
          <div class="actions left"><button class="btn" id="hashCopy">Copy line</button></div>`;
        $('hashCopy').onclick = async () => {
          try { await navigator.clipboard.writeText(line); status('Copied. Paste it as a new line in APP_USERS in Railway.', 'ok'); }
          catch { $('hashLine').select(); status('Press Ctrl+C to copy the selected line.'); }
        };
      } catch (err) { status(err.message, 'bad'); }
    };
    renderErrors(); renderAIAdmin(); renderKBAdmin();
  } catch (err) { box.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
}

async function renderAIAdmin() {
  const box = $('aiAdmin'); if (!box) return;
  let a; try { a = await api('GET', '/admin/ai'); } catch (err) { box.innerHTML = `<h3>AI assistant</h3><div class="msg bad">${esc(err.message)}</div>`; return; }
  const ev = a.evaluation;
  box.innerHTML = `<h3>AI assistant</h3>
    ${a.providers.length ? `<form id="aiForm" class="form">
      <label class="row"><input type="checkbox" id="aiOn" ${a.enabled ? 'checked' : ''}> AI assistant on for everyone</label>
      <div class="two"><label class="field">Provider<select class="input" id="aiProv">${a.providers.map(p => `<option value="${esc(p.id)}" ${p.id === a.provider ? 'selected' : ''}>${esc(p.label)} (${esc(p.model)})</option>`).join('')}</select></label>
      <label class="field">Model name (optional override)<input class="input" id="aiModel" placeholder="as the provider names it" value=""></label></div>
      <label class="field">Requests per user per day<input class="input" type="number" id="aiLimit" min="1" max="100000" value="${a.dailyLimit}"></label>
      <div class="actions left"><button class="btn primary">Save AI settings</button></div></form>
      <p class="muted small">Providers come from Railway variables: <code>AI_API_KEY</code> (+ <code>AI_BASE_URL</code>, <code>AI_MODEL</code>), <code>DEEPSEEK_API_KEY</code>, <code>OPENROUTER_API_KEY</code> (+ <code>OPENROUTER_MODEL</code>, e.g. a Meta Muse Spark model id), or <code>AI_PROVIDERS</code> (JSON list). A project owner can switch the AI off for one project.</p>`
      : '<div class="msg bad">No AI provider is set up. Add AI_API_KEY (and AI_BASE_URL, AI_MODEL) in Railway.</div>'}
    <h4>QS test set</h4>
    <p class="muted small">Runs 150 real QS requests through the AI on a model and scores the plans and app actions (target 95%: 143 of 150). Run it after changing provider or model. It uses about 150 AI requests and can take half an hour.</p>
    <div class="actions left"><button class="btn" id="aiEval" ${S.versionId ? '' : 'disabled'}>Run the test set on the open model</button>${S.versionId ? '' : '<span class="muted small">Open a project model first (the structural sample is the reference).</span>'}</div>
    <div id="aiEvalOut">${ev ? evalHtml(ev) : ''}</div>
    ${a.usage.length ? `<h4>Use in the last 30 days</h4><table class="tbl"><thead><tr><th>User</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead><tbody>${a.usage.map(u => `<tr><td>${esc(u.name)}</td><td class="num">${u.requests}</td><td class="num">${u.tokens.toLocaleString()}</td></tr>`).join('')}</tbody></table>` : ''}`;
  $('aiForm') && ($('aiForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/admin/ai', { enabled: $('aiOn').checked, provider: $('aiProv').value, model: $('aiModel').value || null, dailyLimit: Number($('aiLimit').value) }); status('AI settings saved.', 'ok'); renderAIAdmin(); }
    catch (err) { status(err.message, 'bad'); }
  });
  $('aiEval').onclick = async () => {
    try { await api('POST', '/admin/ai/eval', { versionId: S.versionId }); status('The QS test set is running. This page updates as results come in.', 'ok'); pollEval(); }
    catch (err) { status(err.message, 'bad'); }
  };
  if (ev && ev.status !== 'done') pollEval();
}
let evalTimer = null;
function pollEval() {
  clearTimeout(evalTimer);
  evalTimer = setTimeout(async () => {
    try { const a = await api('GET', '/admin/ai'); const el = $('aiEvalOut'); if (!el) return; el.innerHTML = evalHtml(a.evaluation); if (a.evaluation?.status !== 'done') pollEval(); } catch { /* stop polling */ }
  }, 5000);
}
function evalHtml(ev) {
  if (!ev) return '';
  const fails = (ev.results || []).filter(r => !r.pass);
  return `<div class="kpis"><div class="kpi ${(ev.passed ?? 0) >= Math.ceil((ev.total || 150) * 0.95) ? 'add' : 'rem'}"><b>${ev.passed ?? 0}/${ev.total ?? 150}</b><span>passed</span></div><div class="kpi"><b>${ev.done ?? 0}</b><span>run</span></div></div>
    <p class="muted small">${esc(ev.status)} · ${esc(ev.provider || '')} ${esc(ev.aiModel || '')} · model ${esc(ev.model || '')}${ev.finishedAt ? ' · ' + fmtDate(ev.finishedAt) : ''}</p>
    ${fails.length ? `<details class="box"><summary>Requests that did not pass (${fails.length})</summary><ul class="check-list">${fails.map(r => `<li><span class="grow"><strong>${esc(r.request)}</strong><br><span class="muted small">${esc((r.reasons || []).join('; '))}</span></span></li>`).join('')}</ul></details>` : ''}`;
}

async function renderKBAdmin() {
  const box = $('kbAdmin'); if (!box) return;
  let rules; try { rules = (await api('GET', '/kb')).rules.filter(r => r.scope === 'company'); } catch (err) { box.innerHTML = `<h3>Company QS rules</h3><div class="msg bad">${esc(err.message)}</div>`; return; }
  box.innerHTML = `<h3>Company QS rules</h3>
    <p class="muted small">Your measurement conventions. The AI reads the relevant rules for every request and check. Start rules marked "House rule" are defaults: check them against your standard (NRM2, POMI or your own) and edit.</p>
    <ul class="check-list">${rules.map(r => `<li><span class="grow"><strong>${esc(r.title)}</strong><br><span class="muted small">${esc(r.body)}</span></span><button class="btn small" data-kbe="${r.id}">Edit</button><button class="btn small subtle danger-text" data-kbx="${r.id}">Delete</button></li>`).join('')}</ul>
    <form id="kbAdd" class="form"><label class="field">Title<input class="input" id="kbT" maxlength="160" required></label>
      <label class="field">Rule<textarea class="input" id="kbB" maxlength="4000" required></textarea></label>
      <label class="field">Keywords (optional)<input class="input" id="kbK" maxlength="300" placeholder="formwork beams soffit"></label>
      <div class="actions left"><button class="btn">Add rule</button></div></form>`;
  box.querySelectorAll('[data-kbx]').forEach(b => b.onclick = async () => { try { await api('DELETE', `/kb/${b.dataset.kbx}`); renderKBAdmin(); } catch (err) { status(err.message, 'bad'); } });
  box.querySelectorAll('[data-kbe]').forEach(b => b.onclick = () => {
    const r = rules.find(x => x.id === b.dataset.kbe); $('kbT').value = r.title; $('kbB').value = r.body; $('kbK').value = r.tags || '';
    $('kbAdd').dataset.edit = r.id; $('kbAdd').querySelector('button').textContent = 'Save rule'; $('kbT').focus();
  });
  $('kbAdd').onsubmit = async (e) => {
    e.preventDefault();
    const body = { title: $('kbT').value, body: $('kbB').value, tags: $('kbK').value, scope: 'company' };
    try { if (e.target.dataset.edit) await api('PATCH', `/kb/${e.target.dataset.edit}`, body); else await api('POST', '/kb', body); status('Rule saved.', 'ok'); renderKBAdmin(); }
    catch (err) { status(err.message, 'bad'); }
  };
}

async function renderErrors() {
  const box = $('errAdmin'); if (!box) return;
  let d; try { d = await api('GET', '/admin/errors'); } catch (err) { box.innerHTML = `<h3>Errors</h3><div class="msg bad">${esc(err.message)}</div>`; return; }
  box.innerHTML = `<h3>Errors</h3>
    <div class="kpis"><div class="kpi ${d.counts.day ? 'rem' : 'add'}"><b>${d.counts.day}</b><span>last 24 hours</span></div><div class="kpi"><b>${d.counts.week}</b><span>last 7 days</span></div><div class="kpi ${d.failedJobs.length ? 'chg' : ''}"><b>${d.failedJobs.length}</b><span>failed jobs</span></div></div>
    <p class="muted small">Server and add-in errors with their reference number (users see it in the error message). Kept for 90 days.</p>
    ${d.errors.length ? `<div class="tscroll"><table class="tbl"><thead><tr><th>When</th><th>Ref</th><th>Where</th><th>Error</th></tr></thead><tbody>${d.errors.slice(0, 60).map(e => `<tr><td class="small">${fmtDate(e.at)}</td><td class="small mono">${esc(e.ref || '')}</td><td class="small">${esc(e.source)}${e.email ? '<br>' + esc(e.email) : ''}</td>
      <td class="small wrap"><details><summary>${esc(e.message.slice(0, 160))}</summary><pre class="mono" style="white-space:pre-wrap">${esc((e.stack || '') + (e.url ? '\n' + e.url : ''))}</pre></details></td></tr>`).join('')}</tbody></table></div>
      <div class="actions left"><button class="btn subtle danger-text" id="errClear">Clear the error log</button></div>` : '<div class="msg ok">No errors recorded.</div>'}
    ${d.failedJobs.length ? `<h4>Failed processing jobs</h4><ul class="check-list">${d.failedJobs.map(j => `<li><span class="grow"><strong>${esc(j.kind)}</strong> · ${fmtDate(j.finished_at)} · ${j.attempts} attempt(s)<br><span class="muted small">${esc(j.error || '')}</span></span></li>`).join('')}</ul>` : ''}`;
  $('errClear') && ($('errClear').onclick = async () => { try { await api('DELETE', '/admin/errors'); renderErrors(); status('Error log cleared.', 'ok'); } catch (err) { status(err.message, 'bad'); } });
}
