// Postgres connection + schema migrations (run automatically at start-up).
import pg from 'pg';

const url = process.env.DATABASE_URL;
export const pool = url ? new pg.Pool({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL || 10),
}) : null;

export const q = async (sql, params = []) => {
  if (!pool) throw new Error('DATABASE_URL is not set.');
  return (await pool.query(sql, params)).rows;
};
export const one = async (sql, params) => (await q(sql, params))[0] || null;

export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn((s, p) => c.query(s, p).then(x => x.rows)); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

const MIGRATIONS = [
  // 1: core schema
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
     pw_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login TIMESTAMPTZ);
   CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, user_agent TEXT);
   CREATE TABLE IF NOT EXISTS projects (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, code TEXT, client TEXT, description TEXT,
     created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS project_members (
     project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')), added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (project_id, user_id));
   CREATE TABLE IF NOT EXISTS models (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, discipline TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (project_id, name));
   CREATE TABLE IF NOT EXISTS model_versions (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
     version INT NOT NULL, file_name TEXT NOT NULL, size BIGINT NOT NULL, storage_key TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued', progress TEXT, error TEXT, stats JSONB, note TEXT,
     uploaded_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
     UNIQUE (model_id, version));
   CREATE TABLE IF NOT EXISTS drawings (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, size BIGINT NOT NULL, content_type TEXT, storage_key TEXT NOT NULL,
     uploaded_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS takeoffs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     version_id UUID REFERENCES model_versions(id) ON DELETE SET NULL, name TEXT NOT NULL, spec JSONB NOT NULL,
     created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS jobs (
     id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
     attempts INT NOT NULL DEFAULT 0, run_after TIMESTAMPTZ NOT NULL DEFAULT now(), locked_at TIMESTAMPTZ, error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ);
   CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, run_after);
   CREATE TABLE IF NOT EXISTS audit (
     id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), user_id INT REFERENCES users(id) ON DELETE SET NULL,
     project_id UUID, action TEXT NOT NULL, detail JSONB);
   CREATE INDEX IF NOT EXISTS audit_project ON audit (project_id, at DESC);
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB);`,
  // 2: viewer, measurement, revisions, output and AI (phases 2-5)
  `CREATE TABLE IF NOT EXISTS views (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     version_id UUID REFERENCES model_versions(id) ON DELETE SET NULL, name TEXT NOT NULL, state JSONB NOT NULL,
     created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS templates (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scope TEXT NOT NULL DEFAULT 'user',
     project_id UUID REFERENCES projects(id) ON DELETE CASCADE, owner_id INT REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL, discipline TEXT, description TEXT, spec JSONB NOT NULL, builtin BOOLEAN NOT NULL DEFAULT false,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE UNIQUE INDEX IF NOT EXISTS templates_builtin ON templates (name) WHERE builtin;
   CREATE TABLE IF NOT EXISTS zones (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, color TEXT, ids JSONB NOT NULL DEFAULT '[]', created_by INT REFERENCES users(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (project_id, name));
   CREATE TABLE IF NOT EXISTS kb_rules (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scope TEXT NOT NULL DEFAULT 'company',
     project_id UUID REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT,
     created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS ai_usage (
     id BIGSERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE SET NULL, project_id UUID, kind TEXT NOT NULL,
     provider TEXT, model TEXT, tokens_in INT NOT NULL DEFAULT 0, tokens_out INT NOT NULL DEFAULT 0, ok BOOLEAN NOT NULL DEFAULT true,
     at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE INDEX IF NOT EXISTS ai_usage_user ON ai_usage (user_id, at DESC);
   CREATE TABLE IF NOT EXISTS exports (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL, name TEXT NOT NULL, size BIGINT NOT NULL DEFAULT 0, storage_key TEXT NOT NULL,
     created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_off BOOLEAN NOT NULL DEFAULT false;
   ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
   ALTER TABLE takeoffs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`,
  // 3: error monitoring (phase 6)
  `CREATE TABLE IF NOT EXISTS errors (
     id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), source TEXT NOT NULL, ref TEXT,
     user_id INT REFERENCES users(id) ON DELETE SET NULL, message TEXT NOT NULL, stack TEXT, url TEXT, detail JSONB);
   CREATE INDEX IF NOT EXISTS errors_at ON errors (at DESC);`,
  // 4: project tree: folders for drawings/models and for dimension groups, dimension groups and their dimensions
  `CREATE TABLE IF NOT EXISTS folders (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('drawing','dim')), parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
     name TEXT NOT NULL, sort INT NOT NULL DEFAULT 0, created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE INDEX IF NOT EXISTS folders_project ON folders (project_id, kind);
   ALTER TABLE models ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
   ALTER TABLE drawings ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
   CREATE TABLE IF NOT EXISTS dim_groups (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
     folder_id UUID REFERENCES folders(id) ON DELETE SET NULL, name TEXT NOT NULL, mtype TEXT NOT NULL DEFAULT 'Count',
     props JSONB NOT NULL DEFAULT '{}', standard BOOLEAN NOT NULL DEFAULT false, created_by INT REFERENCES users(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE INDEX IF NOT EXISTS dim_groups_project ON dim_groups (project_id);
   CREATE TABLE IF NOT EXISTS dim_items (
     id BIGSERIAL PRIMARY KEY, group_id UUID NOT NULL REFERENCES dim_groups(id) ON DELETE CASCADE, element_id BIGINT NOT NULL,
     version_id UUID REFERENCES model_versions(id) ON DELETE SET NULL, sign SMALLINT NOT NULL DEFAULT 1,
     multiplier DOUBLE PRECISION NOT NULL DEFAULT 1, added_by INT REFERENCES users(id), added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (group_id, element_id));`,
  // 5: models processed on the user's computer: last sign of life from that computer
  `ALTER TABLE model_versions ADD COLUMN IF NOT EXISTS local_seen TIMESTAMPTZ;`,
  // 6: on-screen take-off: per drawing scale (per page), drawing multiplier and markups
  `CREATE TABLE IF NOT EXISTS drawing_settings (
     project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, dkey TEXT NOT NULL, props JSONB NOT NULL DEFAULT '{}',
     updated_by INT REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, dkey));`,
  // 7: files kept on the users' computers: the server keeps only the name, size and SHA-256 fingerprint (location 'local')
  `ALTER TABLE model_versions ADD COLUMN IF NOT EXISTS sha256 TEXT;
   ALTER TABLE model_versions ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'cloud';
   ALTER TABLE drawings ADD COLUMN IF NOT EXISTS sha256 TEXT;
   ALTER TABLE drawings ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'cloud';`,
];

/** Apply new migrations once, even when the API and the worker start at the same time (advisory lock). */
export async function migrate() {
  await tx(async (x) => {
    await x(`SELECT pg_advisory_xact_lock(731001)`);
    await x(`CREATE TABLE IF NOT EXISTS schema_version (v INT NOT NULL)`);
    const cur = (await x(`SELECT max(v) AS v FROM schema_version`))[0]?.v || 0;
    for (let i = cur; i < MIGRATIONS.length; i++) {
      await x(MIGRATIONS[i]);
      await x(`INSERT INTO schema_version (v) VALUES ($1)`, [i + 1]);
    }
  });
}

export async function audit(userId, projectId, action, detail = null) {
  try { await q(`INSERT INTO audit (user_id, project_id, action, detail) VALUES ($1,$2,$3,$4)`, [userId, projectId, action, detail]); }
  catch (e) { console.error('audit failed', e.message); }
}
