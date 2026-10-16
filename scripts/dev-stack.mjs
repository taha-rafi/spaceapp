#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDevStackState, readDevStackSetupToken, resetDevStackState, devStackPaths } from './dev-stack-state.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const paths = devStackPaths(root);
const project = 'spaceapp-contributor-dev';
const composePath = join(root, 'scripts', 'dev-stack-services.yml');
const args = process.argv.slice(2);
const action = args[0] ?? 'up';
const apiPort = Number(process.env.SPACE_DEV_API_PORT ?? 4912);
const webPort = Number(process.env.SPACE_DEV_WEB_PORT ?? 4913);
const dbPort = Number(process.env.SPACE_DEV_DB_PORT ?? 55432);
const temporalPort = Number(process.env.SPACE_DEV_TEMPORAL_PORT ?? 57233);
for (const port of [apiPort, webPort, dbPort, temporalPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid dev-stack port');
}
if (new Set([apiPort, webPort, dbPort, temporalPort]).size !== 4) throw new Error('Dev-stack ports must differ');
const composeArgs = ['compose', '-p', project, '-f', composePath];

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
function docker(...commands) {
  run('docker', [...composeArgs, ...commands], {
    env: { ...process.env, SPACE_DEV_DB_PORT: String(dbPort), SPACE_DEV_TEMPORAL_PORT: String(temporalPort), SPACE_DEV_SECRETS_DIR: paths.secrets }
  });
}
function child(command, argv, environment) {
  const processHandle = spawn(command, argv, { cwd: root, env: { ...process.env, ...environment }, stdio: 'inherit' });
  processHandle.once('error', error => { console.error(error); stop(); });
  processHandle.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Dev-stack service exited: ${command} ${argv.join(' ')} (${code ?? signal})`);
      stop();
    }
  });
  children.add(processHandle);
  return processHandle;
}
let stopping = false;
const children = new Set();
function stop() {
  if (stopping) return;
  stopping = true;
  for (const handle of children) if (!handle.killed) handle.kill('SIGTERM');
  // Compose data is deliberately retained by 'down', unlike 'reset'.
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);

async function main() {
  if (action === 'down') {
    docker('down', '--remove-orphans');
    console.log('Dev-stack containers stopped. Source processes stop when their dev:stack session exits.');
    return;
  }
  if (action === 'reset') {
    docker('down', '-v', '--remove-orphans');
    await resetDevStackState(root);
    console.log('Dev-stack containers, named volumes, and isolated state removed.');
    return;
  }
  if (action !== 'up') throw new Error('Usage: npm run dev:stack [-- down|reset]');
  await initializeDevStackState(root);
  const dbPassword = (await readFile(join(paths.secrets, 'postgres-password'), 'utf8')).trim();
  const sessionSecret = (await readFile(join(paths.secrets, 'session-secret'), 'utf8')).trim();
  const setupToken = await readDevStackSetupToken(root);
  if (!existsSync(join(root, 'node_modules'))) throw new Error('Run npm ci first');

  docker('up', '-d', '--wait');
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(dbPassword)}@127.0.0.1:${dbPort}/spaceapp`;
  const common = {
    SPACE_RUNTIME_STORE: 'postgres',
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_SESSION_SECRET: sessionSecret,
    SPACE_SETUP_TOKEN: setupToken,
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
  run('npm', ['run', 'build', '-w', '@space/contracts']);
  run('npm', ['run', 'build', '-w', '@space/runtime']);
  run('npm', ['run', 'build', '-w', '@space/db']);
  run('npm', ['run', 'db:migrate'], { env: { ...process.env, ...common } });
  // These workers depend on built internal workspace artifacts.
  run('npm', ['run', 'build'], { env: { ...process.env, ...common } });
  child('npm', ['run', 'dev', '-w', '@space/api'], common);
  child('npm', ['run', 'dev', '-w', '@space/web'], common);
  child('npm', ['run', 'dev', '-w', '@space/worker'], common);
  child('node', ['packages/cli-host/dist/main.js'], common);
  console.log(`SpaceApp source UI: http://127.0.0.1:${webPort}`);
  console.log(`Owner setup token: ${setupToken}`);
  console.log('Use Ctrl+C to stop source processes. Use npm run dev:stack -- down to stop database services.');
}
await main().catch(error => { console.error(error); process.exitCode = 1; });
