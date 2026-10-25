// Shared request helpers for the API routers.
import express from 'express';
import { one } from './db.js';

export const json = express.json({ limit: '8mb' });
export const RANK = { viewer: 1, editor: 2, owner: 3 };
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const clean = (s, n = 200) => String(s ?? '').trim().slice(0, n);
export const safeName = (s) => clean(s, 160).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_') || 'file';
export const uuidOk = (s) => /^[0-9a-f-]{36}$/i.test(String(s));

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const fail = (status, msg) => { throw new HttpError(status, msg); };

export async function roleIn(user, projectId) {
  if (!uuidOk(projectId)) return null;
  if (user.role === 'admin') return (await one(`SELECT 1 FROM projects WHERE id=$1`, [projectId])) ? 'owner' : null;
  return (await one(`SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2`, [projectId, user.id]))?.role || null;
}
export async function need(req, projectId, min) {
  const r = await roleIn(req.user, projectId);
  if (!r) fail(404, 'Project not found, or you do not have access to it.');
  if (RANK[r] < RANK[min]) fail(403, `You need ${min} access to this project for that.`);
  return r;
}
export async function versionProject(versionId) {
  if (!uuidOk(versionId)) return null;
  return one(`SELECT v.*, m.project_id, m.name AS model_name FROM model_versions v JOIN models m ON m.id=v.model_id WHERE v.id=$1`, [versionId]);
}

/** Files kept on the users' computers (location 'local') have no copy on the server. */
export const LOCAL_MSG = 'This file is kept on the computers of the project team, not on the server. Open it in the add-in on a computer that has it.';
export function cloudOnly(row) { if (row?.location === 'local') fail(409, LOCAL_MSG); }
export const DRAWING_TYPES = /\.(pdf|dwfx|dwf|dwg|dxf|png|jpe?g|tiff?|xlsx|docx)$/i;
