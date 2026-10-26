#!/usr/bin/env node
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { initConfig, loadConfig, makeHostPolicy } from './config.mjs';
import { ConnectorError, publicError } from '../contract.mjs';

const [command, rawFile, ...args] = process.argv.slice(2);
const configFile = rawFile && resolve(rawFile);
const usage = 'Usage: anybot-connector init <config.json> <state-directory> | check <config.json> | serve <config.json> [--stdio <principal>] | stop <config.json>';
async function listen(server, port) { server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections(); await closed;
}
async function serve(config) {
  const { createConnector } = await import('../core/index.mjs');
  const { createReferenceProvider } = await import('../providers/reference/index.mjs');
  const { createTeamBotProvider } = await import('../providers/teambot/index.mjs');
  const { createHttpServer } = await import('../transports/http/index.mjs');
  const { createKnocketHandler } = await import('../channels/knocket/index.mjs');
  const policy = makeHostPolicy(configFile, config), providers = [];
  let connector, server, control, mcp, stopping, markerOwned = false;
  const marker = join(config.stateDir, 'runtime-control.json');
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      await closeServer(server); await mcp?.close(); await connector?.close();
      for (const provider of providers) await provider.close?.();
      await closeServer(control);
      if (markerOwned) await unlink(marker).catch(() => {});
    })();
    return stopping;
  }
  try {
    const connections = [];
    for (const c of config.connections) {
      let provider;
      if (c.provider.type === 'reference') provider = await createReferenceProvider({ stateDir: join(config.stateDir, 'providers', c.id), delayMs: c.provider.delayMs });
      else {
        const token = process.env[c.provider.tokenEnv];
        if (!token) throw new ConnectorError('UNAUTHENTICATED');
        provider = createTeamBotProvider({ ...c.provider, publication: c.publication, token });
      }
      providers.push(provider); connections.push({ ...c, provider });
    }
    connector = await createConnector({ stateDir: join(config.stateDir, 'connector'), connections, authorize: policy.authorize });
    const knocket = config.knocket ? createKnocketHandler({ connector, models: config.knocket.models }) : undefined;
    server = createHttpServer({ connector, authenticate: policy.authenticate, knocket });
    const port = await listen(server, config.port);
    const controlToken = randomBytes(32).toString('hex');
    control = createServer((req, res) => {
      const supplied = req.headers.authorization;
      const valid = typeof supplied === 'string' && supplied.length === controlToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(controlToken));
      if (req.method !== 'POST' || req.url !== '/stop' || !valid) { res.writeHead(404); res.end(); return; }
      res.writeHead(202); res.end('stopping'); setImmediate(() => { stop().catch(() => { process.exitCode = 1; }); });
    });
    const controlPort = await listen(control, 0);
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(marker, JSON.stringify({ port: controlPort, token: controlToken }), { mode: 0o600 }); markerOwned = true;
    process.once('SIGINT', () => { stop().catch(() => { process.exitCode = 1; }); });
    process.once('SIGTERM', () => { stop().catch(() => { process.exitCode = 1; }); });
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--stdio') throw new ConnectorError('INVALID_ARGUMENT');
      const { createMcpServer } = await import('../transports/mcp/index.mjs');
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      mcp = createMcpServer({ connector, identity: await policy.stdioIdentity(args[1]) });
      await mcp.connect(new StdioServerTransport());
      process.stdin.once('end', () => { stop().catch(() => { process.exitCode = 1; }); });
    }
    process.stderr.write(`AnyBot-Connector listening on http://127.0.0.1:${port}\n`);
  } catch (error) { await stop(); throw error; }
}
try {
  if (!configFile) throw new ConnectorError('INVALID_ARGUMENT');
  if (command === 'init' && args.length === 1) {
    await initConfig(configFile, args[0]); process.stdout.write('Configuration created. Set ANYBOT_TOKEN to a random secret of at least 24 characters.\n');
  } else if (command === 'check' && !args.length) {
    const c = await loadConfig(configFile);
    for (const i of c.identities) if ((process.env[i.tokenEnv]?.length ?? 0) < 24) throw new ConnectorError('UNAUTHENTICATED');
    process.stdout.write('Configuration syntax and host token presence passed; no provider or enterprise ownership verified.\n');
  } else if (command === 'serve') await serve(await loadConfig(configFile));
  else if (command === 'stop' && !args.length) {
    const c = await loadConfig(configFile), text = await readFile(join(c.stateDir, 'runtime-control.json'), 'utf8');
    if (text.length > 1024) throw new ConnectorError('STATE_UNAVAILABLE');
    const marker = JSON.parse(text);
    if (!Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535 || !/^[a-f0-9]{64}$/.test(marker.token)) throw new ConnectorError('STATE_UNAVAILABLE');
    const response = await fetch(`http://127.0.0.1:${marker.port}/stop`, { method: 'POST', headers: { authorization: marker.token }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (response.status !== 202) throw new ConnectorError('STATE_UNAVAILABLE');
    process.stdout.write('Shutdown requested.\n');
  } else throw new ConnectorError('INVALID_ARGUMENT');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: publicError(error) }) + '\n');
  if (error?.code === 'INVALID_ARGUMENT') process.stderr.write(usage + '\n');
  process.exitCode = 1;
}
