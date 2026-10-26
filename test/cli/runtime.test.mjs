import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { initConfig } from '../../src/cli/config.mjs';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));

test('real CLI process: MCP stdio and HTTP share task, live revoke, stop and restart recovery', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anybot-cli-')), file = join(dir, 'config.json');
  const env = { ...process.env, ANYBOT_TOKEN: randomBytes(24).toString('hex') };
  await initConfig(file, join(dir, 'state'));
  const config = JSON.parse(await readFile(file)); config.port = 0; config.connections[0].provider.delayMs = 0;
  await writeFile(file, JSON.stringify(config));
  let client, transport;
  async function start() {
    transport = new StdioClientTransport({ command: process.execPath, args: ['src/cli/index.mjs', 'serve', file, '--stdio', 'demo'], cwd: repo, env, stderr: 'pipe' });
    let stderr = '';
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI startup timeout: ${stderr}`)), 5000);
      transport.stderr.on('data', chunk => { stderr += chunk.toString(); const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    client = new Client({ name: 'cli-acceptance', version: '1.0.0' });
    await client.connect(transport); return ready;
  }
  try {
    const port = await start();
    const headers = { authorization: `Bearer ${env.ANYBOT_TOKEN}`, 'content-type': 'application/json' };
    const submitted = await fetch(`http://127.0.0.1:${port}/v1/connections/demo/tasks`, { method: 'POST', headers, body: JSON.stringify({ requestKey: 'restart-key', input: { type: 'text', text: 'public fixture' } }) });
    assert.equal(submitted.status, 200); const snapshot = await submitted.json(); assert.equal(snapshot.state, 'succeeded');
    const response = await client.callTool({ name: 'connector_get', arguments: { handle: snapshot.handle } });
    assert.equal(JSON.parse(response.content[0].text).handle, snapshot.handle);
    config.identities[0].operations = ['describe']; await writeFile(file, JSON.stringify(config));
    const denied = await client.callTool({ name: 'connector_get', arguments: { handle: snapshot.handle } });
    assert.equal(denied.isError, true); assert.equal(JSON.parse(denied.content[0].text).error.code, 'FORBIDDEN');
    const stopped = await exec(process.execPath, ['src/cli/index.mjs', 'stop', file], { cwd: repo, env }); assert.match(stopped.stdout, /Shutdown requested/);
    await client.close(); await transport.close();
    // Successful process shutdown releases both state owners; no manual lock deletion.
    config.identities[0].operations = ['describe', 'submit', 'get', 'cancel']; await writeFile(file, JSON.stringify(config));
    await start();
    const retry = await client.callTool({ name: 'connector_submit', arguments: { connectionId: 'demo', requestKey: 'restart-key', input: { type: 'text', text: 'public fixture' } } });
    assert.equal(retry.isError, undefined); const result = JSON.parse(retry.content[0].text);
    assert.equal(result.handle, snapshot.handle); assert.equal(result.result.text, '[reference] public fixture');
    await client.close(); await transport.close();
  } finally { await client?.close().catch(() => {}); await transport?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
