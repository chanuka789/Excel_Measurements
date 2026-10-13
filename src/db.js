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
];

export async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS schema_version (v INT NOT NULL)`);
  const cur = (await one(`SELECT max(v) AS v FROM schema_version`))?.v || 0;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    await tx(async (x) => { await x(MIGRATIONS[i]); await x(`INSERT INTO schema_version (v) VALUES ($1)`, [i + 1]); });
  }
}

export async function audit(userId, projectId, action, detail = null) {
  try { await q(`INSERT INTO audit (user_id, project_id, action, detail) VALUES ($1,$2,$3,$4)`, [userId, projectId, action, detail]); }
  catch (e) { console.error('audit failed', e.message); }
}
