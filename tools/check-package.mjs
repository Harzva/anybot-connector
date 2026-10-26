import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.private, true, 'npm publication remains disabled');
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))[0];
for (const { path } of pack.files) {
  assert.match(path, /^(src\/|spec\/|docs\/|examples\/|package\.json$|README\.md$|LICENSE$)/);
  assert.doesNotMatch(path, /(\.env|\.private|\.runtime|HANDOFF|node_modules|\.log$|\.jsonl$)/i);
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /\/(Users|Volumes)\//, `local path in ${path}`);
  assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,}/, `credential-shaped value in ${path}`);
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const licenses = new Map();
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path) continue;
  assert.match(item.resolved, /^https:\/\/registry\.npmjs\.org\//, 'public npm dependency only');
  assert.match(item.integrity, /^sha512-/);
  const pkg = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
  assert.ok(['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'BSD-2-Clause'].includes(pkg.license), `${pkg.name}: review license ${pkg.license}`);
  licenses.set(`${pkg.name}@${pkg.version}`, pkg.license);
}
console.log(JSON.stringify({ files: pack.files.length, unpackedSize: pack.unpackedSize, dependencies: Object.fromEntries([...licenses].sort()) }, null, 2));
