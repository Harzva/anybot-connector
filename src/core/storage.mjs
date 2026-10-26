import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectorError } from '../contract.mjs';

const unavailable = () => new ConnectorError('STATE_UNAVAILABLE');
async function readJson(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw unavailable();
  return JSON.parse(await readFile(path, 'utf8'));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; return true; }
}
async function acquire(dir) {
  const path = join(dir, 'lock.json'), nonce = randomUUID();
  async function claim() {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.sync(); }
    finally { await file.close(); }
  }
  try { await claim(); } catch (e) {
    if (e.code !== 'EEXIST') throw unavailable();
    const previous = await readJson(path, 1024).catch(() => { throw unavailable(); });
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.nonce !== 'string' || alive(previous.pid)) throw unavailable();
    // Serialize stale-owner recovery; never delete a lock with a live or unknown owner.
    let guard;
    try {
      guard = await open(join(dir, 'recovery.lock'), 'wx', 0o600);
      const current = await readJson(path, 1024);
      if (JSON.stringify(current) !== JSON.stringify(previous) || alive(current.pid)) throw unavailable();
      await unlink(path); await claim();
    } catch { throw unavailable(); }
    finally { if (guard) { await guard.close(); await unlink(join(dir, 'recovery.lock')); } }
  }
  return async () => {
    const current = await readJson(path, 1024);
    if (current.nonce !== nonce || current.pid !== process.pid) throw unavailable();
    await unlink(path);
  };
}
export async function openStore(dir, initial, validate, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let release;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw unavailable();
    release = await acquire(dir);
    const path = join(dir, 'state.json');
    let state;
    try { state = await readJson(path, maxBytes); } catch (e) { if (e.code === 'ENOENT') state = structuredClone(initial); else throw e; }
    validate(state);
    let queue = Promise.resolve(), closed = false, poisoned = false;
    async function write(next) {
      const json = JSON.stringify(next);
      if (Buffer.byteLength(json) > maxBytes) throw unavailable();
      const tmp = join(dir, `${randomUUID()}.tmp`);
      try {
        const file = await open(tmp, 'wx', 0o600);
        try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
        await rename(tmp, path);
        const directory = await open(dir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { poisoned = true; throw unavailable(); }
      finally { await unlink(tmp).catch(() => {}); }
    }
    return {
      read() { if (closed || poisoned) throw unavailable(); return structuredClone(state); },
      transaction(fn) {
        if (closed || poisoned) return Promise.reject(unavailable());
        const next = queue.then(async () => {
          if (poisoned) throw unavailable();
          const draft = structuredClone(state), result = await fn(draft);
          validate(draft); await write(draft); state = draft; return result;
        });
        queue = next.catch(() => {}); return next;
      },
      async close() { if (closed) return; closed = true; await queue; await release(); }
    };
  } catch { if (release) await release().catch(() => {}); throw unavailable(); }
}
