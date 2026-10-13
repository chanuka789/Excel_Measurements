// File storage: Railway bucket (S3-compatible) in production, a local folder in development/tests.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

const E = process.env;
const bucket = E.BUCKET || E.S3_BUCKET || E.AWS_S3_BUCKET_NAME;
const useS3 = Boolean(bucket && (E.AWS_ACCESS_KEY_ID || E.S3_ACCESS_KEY_ID));
const s3 = useS3 ? new S3Client({
  region: E.AWS_DEFAULT_REGION || E.S3_REGION || 'auto',
  endpoint: E.AWS_ENDPOINT_URL || E.S3_ENDPOINT,
  forcePathStyle: (E.S3_FORCE_PATH_STYLE || 'false') === 'true',
  credentials: { accessKeyId: E.AWS_ACCESS_KEY_ID || E.S3_ACCESS_KEY_ID, secretAccessKey: E.AWS_SECRET_ACCESS_KEY || E.S3_SECRET_ACCESS_KEY },
}) : null;
const LOCAL = path.resolve(E.LOCAL_STORAGE_DIR || './.data/storage');
const safe = (key) => { const p = path.resolve(LOCAL, key); if (!p.startsWith(LOCAL + path.sep)) throw new Error('Bad storage key'); return p; };

export const storageKind = useS3 ? `bucket:${bucket}` : `local:${LOCAL}`;

export async function putFile(key, filePath, contentType = 'application/octet-stream') {
  if (s3) {
    const size = (await fsp.stat(filePath)).size;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: size, ContentType: contentType }));
    return;
  }
  await fsp.mkdir(path.dirname(safe(key)), { recursive: true });
  await fsp.copyFile(filePath, safe(key));
}
export async function putBuffer(key, buf, contentType = 'application/octet-stream', extra = {}) {
  if (s3) { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType, ...extra })); return; }
  await fsp.mkdir(path.dirname(safe(key)), { recursive: true });
  await fsp.writeFile(safe(key), buf);
}
export async function getStream(key) {
  if (s3) { const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return r.Body instanceof Readable ? r.Body : Readable.fromWeb(r.Body); }
  return fs.createReadStream(safe(key));
}
export async function getBuffer(key) {
  const chunks = []; for await (const c of await getStream(key)) chunks.push(c); return Buffer.concat(chunks);
}
export async function download(key, toPath) { await pipeline(await getStream(key), fs.createWriteStream(toPath)); }
export async function exists(key) {
  if (s3) { try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; } catch { return false; } }
  return fs.existsSync(safe(key));
}
export async function list(prefix) {
  if (s3) {
    const out = []; let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      (r.Contents || []).forEach(o => out.push({ key: o.Key, size: o.Size })); token = r.IsTruncated ? r.NextContinuationToken : null;
    } while (token);
    return out;
  }
  const base = safe(prefix.replace(/\/$/, '') + '/x').slice(0, -2);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = async (d) => { for (const f of await fsp.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) await walk(p); else out.push({ key: path.relative(LOCAL, p).split(path.sep).join('/'), size: (await fsp.stat(p)).size }); } };
  await walk(base); return out;
}
export async function removePrefix(prefix) {
  if (!prefix || prefix.split('/').filter(Boolean).length < 2) throw new Error('Refusing to delete a top-level prefix');
  if (s3) {
    const keys = (await list(prefix)).map(o => ({ Key: o.key }));
    for (let i = 0; i < keys.length; i += 1000) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000) } }));
    return keys.length;
  }
  const base = safe(prefix.replace(/\/$/, '') + '/x').slice(0, -2);
  const n = (await list(prefix)).length;
  await fsp.rm(base, { recursive: true, force: true });
  return n;
}
export async function removeKey(key) {
  if (s3) { await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: key }] } })); return; }
  await fsp.rm(safe(key), { force: true });
}
