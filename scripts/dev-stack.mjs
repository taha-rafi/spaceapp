#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDevStackState, assertDevStackStateOwner, readDevStackSecret, readDevStackSetupToken, resetDevStackState, devStackPaths } from './dev-stack-state.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const paths = devStackPaths(root);
const project = `spaceapp-dev-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
const controlPath = join(paths.root, 'control.sock');
const template = await readFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8');
function canonicalImage(service) {
  const image = template.match(new RegExp(`^  ${service}:\\n    image: (\\S+@sha256:[a-f0-9]{64})$`, 'm'))?.[1];
  if (!image) throw new Error(`Missing canonical ${service} image digest`);
  return image;
}
const images = { SPACE_DEV_POSTGRES_IMAGE: canonicalImage('postgres'), SPACE_DEV_TEMPORAL_IMAGE: canonicalImage('temporal') };
const composePath = join(root, 'scripts', 'dev-stack-services.yml');
const args = process.argv.slice(2);
let action = args[0] ?? 'up';
if (args.length > 1) throw new Error('Usage: npm run dev:stack [-- up|down|reset|rebuild]');
const apiPort = Number(process.env.SPACE_DEV_API_PORT ?? 4912);
const webPort = Number(process.env.SPACE_DEV_WEB_PORT ?? 4913);
const dbPort = Number(process.env.SPACE_DEV_DB_PORT ?? 55432);
const temporalPort = Number(process.env.SPACE_DEV_TEMPORAL_PORT ?? 57233);
for (const port of [apiPort, webPort, dbPort, temporalPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid dev-stack port');
}
if (new Set([apiPort, webPort, dbPort, temporalPort]).size !== 4) throw new Error('Dev-stack ports must differ');
const composeArgs = ['compose', '-p', project, '-f', composePath];

async function run(command, argv, options = {}) {
  if (stopping) throw new Error('Dev-stack startup cancelled');
  const handle = spawn(command, argv, { cwd: root, stdio: 'inherit', detached: true, ...options });
  children.add(handle);
  try {
    await new Promise((resolve, reject) => {
      handle.once('error', reject);
      handle.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
    });
  } finally { children.delete(handle); }
}
async function docker(...commands) {
  await run('docker', [...composeArgs, ...commands], {
    env: { ...process.env, ...images, SPACE_DEV_DB_PORT: String(dbPort), SPACE_DEV_TEMPORAL_PORT: String(temporalPort), SPACE_DEV_SECRETS_DIR: paths.secrets }
  });
}
function child(command, argv, environment, name) {
  if (stopping) throw new Error('Dev-stack startup cancelled');
  const processHandle = spawn(command, argv, { cwd: root, env: { ...process.env, ...environment, NODE_ENV: 'development' }, stdio: 'inherit', detached: true });
  processHandle.once('error', error => { console.error(error); void stop(1); });
  processHandle.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Dev-stack service exited: ${name} (${code ?? signal})`);
      void stop(1);
    }
  });
  children.add(processHandle);
  console.log(`Dev-stack service started: ${name} pid=${processHandle.pid}`);
  return processHandle;
}
let stopping = false;
const children = new Set();
let resolveShutdown;
const shutdown = new Promise(resolve => { resolveShutdown = resolve; });
let controlServer;
let shutdownTask;
function signalGroup(handle, signal) {
  if (!handle.pid) return;
  try { process.kill(-handle.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stop(code = 0) {
  if (shutdownTask) return shutdownTask;
  stopping = true;
  shutdownTask = (async () => {
    const handles = [...children];
    const exits = handles.map(handle => !handle.pid || handle.exitCode !== null || handle.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => handle.once('exit', resolve)));
    // Give watch wrappers one signal so they can forward it and reap their children.
    // Signalling both wrapper and child at once can trigger their force-exit path.
    for (const handle of handles) {
      if (handle.pid && handle.exitCode === null && handle.signalCode === null) handle.kill('SIGTERM');
    }
    await Promise.race([Promise.all(exits), delay(6000, undefined, { ref: false })]);
    // Bound shutdown and remove descendants left by a failed wrapper.
    for (const handle of handles) signalGroup(handle, 'SIGKILL');
    await Promise.all(exits);
    if (controlServer) controlServer.close();
    await unlink(controlPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    process.exitCode = code;
    resolveShutdown();
  })();
  return shutdownTask;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());

async function stopRunningStack() {
  try {
    const entry = await lstat(controlPath);
    if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error('Refusing unsafe dev-stack control socket');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let stale = false;
  await new Promise((resolve, reject) => {
    const socket = createConnection(controlPath);
    socket.setTimeout(15000, () => socket.destroy(new Error('Supervisor shutdown timed out')));
    socket.once('connect', () => socket.end('down'));
    socket.on('data', () => {});
    socket.once('close', () => resolve());
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') { stale = true; resolve(); }
      else if (error.code === 'ENOENT') resolve();
      else reject(error);
    });
  });
  if (stale) await unlink(controlPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function waitFor(url, predicate, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !stopping) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok && await predicate(response)) return;
    } catch { /* Services may not have opened their listeners yet. */ }
    await delay(500);
  }
  throw new Error(`Readiness failed: ${url}`);
}

async function installOpenCode() {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const version = dockerfile.match(/opencode-ai@(\d+\.\d+\.\d+)/)?.[1];
  if (!version) throw new Error('Missing Dockerfile OpenCode pin');
  const prefix = join(paths.root, 'opencode');
  let installed;
  try { installed = JSON.parse(await readFile(join(prefix, 'node_modules/opencode-ai/package.json'), 'utf8')).version; } catch { /* A missing or incomplete installation is refreshed below. */ }
  const bin = join(paths.root, 'bin');
  const home = join(paths.root, 'providers');
  const providerRoot = join(home, '.codex', 'space-opencode');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const dir of ['data', 'cache', 'state', 'tmp']) await mkdir(join(providerRoot, dir), { recursive: true, mode: 0o700 });
  await mkdir(join(home, '.config'), { recursive: true, mode: 0o700 });
  const installEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(providerRoot, 'data'), XDG_CACHE_HOME: join(providerRoot, 'cache'), XDG_STATE_HOME: join(providerRoot, 'state'), TMPDIR: join(providerRoot, 'tmp') };
  if (installed !== version) await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--save-exact', `opencode-ai@${version}`], { env: installEnv });
  await run(join(prefix, 'node_modules/.bin/opencode'), ['--version'], { env: installEnv });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = `#!/bin/sh
set -eu
export HOME=${quote(home)}
export XDG_CONFIG_HOME=${quote(join(home, '.config'))}
export XDG_DATA_HOME=${quote(join(providerRoot, 'data'))}
export XDG_CACHE_HOME=${quote(join(providerRoot, 'cache'))}
export XDG_STATE_HOME=${quote(join(providerRoot, 'state'))}
export TMPDIR=${quote(join(providerRoot, 'tmp'))}
exec ${quote(join(prefix, 'node_modules/.bin/opencode'))} "$@"
`;
  await writeFile(join(bin, 'opencode-vscode-parity'), wrapper, { mode: 0o700 });
}

async function main() {
  if (action === 'rebuild') {
    await assertDevStackStateOwner(root);
    await stopRunningStack();
    action = 'up';
  }
  if (action === 'down') {
    await assertDevStackStateOwner(root);
    await stopRunningStack();
    await docker('down', '--remove-orphans');
    console.log('Dev-stack source processes and containers stopped; data retained.');
    return;
  }
  if (action === 'reset') {
    await assertDevStackStateOwner(root);
    await stopRunningStack();
    await docker('down', '-v', '--remove-orphans');
    await resetDevStackState(root);
    console.log('Dev-stack containers, named volumes, and isolated state removed.');
    return;
  }
  if (action !== 'up') throw new Error('Usage: npm run dev:stack [-- down|reset|rebuild]');
  await initializeDevStackState(root);
  controlServer = createServer({ allowHalfOpen: true }, socket => {
    socket.once('data', data => {
      if (data.toString() !== 'down') { socket.end(); return; }
      void stop().then(() => socket.end('stopped'));
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(controlPath, resolve); });
  await chmod(controlPath, 0o600);
  const dbPassword = await readDevStackSecret(root, 'postgres-password');
  const sessionSecret = await readDevStackSecret(root, 'session-secret');
  const setupToken = await readDevStackSetupToken(root);
  if (!existsSync(join(root, 'node_modules'))) throw new Error('Run npm ci first');

  await docker('up', '-d', '--wait');
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(dbPassword)}@127.0.0.1:${dbPort}/spaceapp`;
  const common = {
    NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
    no_proxy: [process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
    SPACE_RUNTIME_STORE: 'postgres',
    SPACE_INSTANCE: 'dev',
    SPACE_INSTANCE_ENABLED_JOBS: '',
    SPACE_TEMPORAL_NAMESPACE: 'spaceapp-contributor',
    SPACE_TEMPORAL_TASK_QUEUE: 'spaceapp-contributor-turns',
    SPACE_CHESS_MOVE_SOCKET: 'disabled',
    SPACE_INSTALL_ROOT: root,
    SPACE_CLI_ROOT_ENABLED: 'false',
    SPACE_CLI_ADMIN_HOST_SOCKET: join(paths.root, 'admin-disabled.sock'),
    SPACE_CLI_DEFAULT_CWD: join(paths.root, 'workspaces'),
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_SESSION_SECRET: sessionSecret,
    SPACE_SETUP_TOKEN_FILE: join(paths.secrets, 'setup-token'),
    SPACE_CLI_ENABLED: 'true',
    SPACE_CLI_VPN_ENABLED: 'false',
    SPACE_BROWSER_SESSIONS_ENABLED: 'false',
    SPACE_CODEX_APP_SERVER_ENABLED: 'false',
    SPACE_ENABLE_DUMMY_TURNS: 'false',
    SPACE_CLI_HOME: join(paths.root, 'providers'),
    SPACE_OPENCODE_STATE_ROOT: join(paths.root, 'providers', '.codex', 'space-opencode', 'state'),
    SPACE_CODEX_APP_SERVER_HOME: join(paths.root, 'providers', '.codex'),
    SPACE_CLI_COMMAND_PATH: join(paths.root, 'bin'),
    SPACE_PUBLIC_DISTRIBUTION: 'true',
    SPACE_OPTIONAL_MODULES: 'none',
    SPACE_DEMO_PROJECTS_ENABLED: 'false',
    SPACE_FILES_HOST_MODE: 'disabled',
    SPACE_T3CODE_ENABLED: 'false',
    SPACE_APP_DIAGNOSTICS_ROOT: join(paths.root, 'diagnostics'),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(paths.root, 'maintenance', 'state.json'),
    SPACE_CODEX_GOALS_DB_PATH: join(paths.root, 'codex-goals.sqlite'),
    SPACE_TELEGRAM_SECRET_ROOT: join(paths.root, 'telegram'),
    SPACE_STREAMING_SECRET_ROOT: join(paths.root, 'streaming'),
    SPACE_PROJECTS_ROOT: join(paths.root, 'projects'),
    SPACE_MEMORY_GRAPH_ROOT: join(paths.root, 'memory-graph'),
    SPACE_DEV_LOGIN: 'false',
    SPACE_API_HOST: '127.0.0.1',
    SPACE_API_PORT: String(apiPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    SPACE_WEB_HOST: '127.0.0.1',
    SPACE_WEB_PORT: String(webPort),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${temporalPort}`,
    SPACEAPP_WORKFLOWS_ENABLED: 'true',
    SPACE_CLI_HOST_SOCKET: join(paths.root, 'cli-host.sock'),
    SPACE_CLI_WORKSPACE_ROOT: join(paths.root, 'workspaces'),
    SPACE_MEMORY_ROOT: join(paths.root, 'memory'),
    SPACE_ARTIFACT_ROOT: join(paths.root, 'artifacts')
  };
  await mkdir(common.SPACE_CLI_WORKSPACE_ROOT, { recursive: true });
  await mkdir(common.SPACE_MEMORY_ROOT, { recursive: true });
  await mkdir(common.SPACE_ARTIFACT_ROOT, { recursive: true });
  await installOpenCode();
  // These workers depend on built internal workspace artifacts.
  await run('npm', ['run', 'build'], { env: { ...process.env, ...common } });
  await run('npm', ['run', 'db:migrate'], { env: { ...process.env, ...common } });
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let setupRequired;
  try {
    const result = await client.query('SELECT owner_user_id FROM space_owner_setup WHERE singleton = true');
    setupRequired = !result.rows[0]?.owner_user_id;
  } finally { await client.end(); }
  if (setupRequired) {
    const { rotateOwnerSetupToken } = await import('./rotate-owner-setup-token.mjs');
    await rotateOwnerSetupToken({ env: common, stdin: Readable.from([setupToken]) });
  }
  // Do not call apps/api's dev script: it explicitly enables dev-login.
  // Owner creation in this stack must use the one-time setup token.
  child(process.execPath, ['packages/cli-host/dist/main.js'], common, 'cli-host');
  child(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'apps/api/src/server.ts'], common, 'api');
  child(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web', '--strictPort'], common, 'web');
  child(process.execPath, ['apps/worker/dist/worker.js'], common, 'worker');
  await waitFor(`http://127.0.0.1:${apiPort}/readyz`, async response => (await response.json()).ok === true);
  await waitFor(`http://127.0.0.1:${webPort}`, async response => (await response.text()).includes('src/main'));
  console.log(`SpaceApp source UI: http://127.0.0.1:${webPort}`);
  if (setupRequired) console.log(`Owner setup token: ${setupToken}`);
  else console.log('Owner already registered; sign in with your development owner credentials.');
  console.log('Use npm run dev:stack -- down to stop source processes and containers. Workspace package changes: npm run dev:stack -- rebuild.');
  // Remain alive to supervise all child processes; otherwise Ctrl+C cannot stop them.
  await shutdown;
}
await main().catch(async error => {
  console.error(error.message);
  if (shutdownTask) await shutdownTask;
  else if (controlServer?.listening) await stop(1);
  else process.exitCode = 1;
});
