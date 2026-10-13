// Admin tab: system status, users (from APP_USERS), password hash tool, backup, activity log.
import { $, esc, api, fmtBytes, fmtDate, status } from './core.js';

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
  } catch (err) { box.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
}
