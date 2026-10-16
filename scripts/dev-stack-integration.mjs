#!/usr/bin/env node
// Destructive only to this checkout's owned dev-stack. Run on a disposable checkout.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, access, stat, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { stripVTControlCharacters } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const project = `spaceapp-dev-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
const origin = `http://127.0.0.1:${process.env.SPACE_DEV_API_PORT ?? 4912}`;
const npm = args => execFileSync('npm', ['run', 'dev:stack', '--', ...args], { cwd: root, stdio: 'pipe', timeout: 60000 });
// Refuse to consume an existing owner's dev database or reset unrelated contributor work.
await assert.rejects(access(`${root}/.dev-stack`), { code: 'ENOENT' });
let output = '';
let stack;
let exited;
function launch(args) {
  stack = spawn('npm', ['run', 'dev:stack', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [stack.stdout, stack.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-100000); });
  exited = new Promise(resolve => stack.once('exit', (code, signal) => resolve({ code, signal })));
}
launch([]);
const ownedPids = new Set();
function snapshotSourceProcesses() {
  const roots = new Set([...output.matchAll(/Dev-stack service started: \S+ pid=(\d+)/g)].map(match => Number(match[1])));
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  let added = true;
  while (added) {
    added = false;
    for (const [pid, parent] of rows) if (roots.has(parent) && !roots.has(pid)) { roots.add(pid); added = true; }
  }
  for (const pid of roots) ownedPids.add(pid);
}
function redact(text) {
  return text.replace(/^.*Owner setup token:.*$/gm, '[owner setup token redacted]').replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL redacted]');
}
let cookie;
let csrf;
async function request(path, body) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { [csrf.headerName]: csrf.csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000)
  });
  assert.equal(response.ok, true, `${path}: HTTP ${response.status}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (stack.exitCode !== null || stack.signalCode !== null) throw new Error('Dev stack exited before verification');
    try { const result = await fn(); if (result) return result; } catch { /* Retry during service initialization. */ }
    await delay(500);
  }
  throw new Error('Timed out waiting for functional readiness');
}
try {
  const ready = await until(async () => { const state = await request('/readyz'); return state.ok ? state : null; }, 600000);
  assert.equal(ready.dependencies.worker, 'RUNNING');
  assert.equal(ready.dependencies.store, 'postgres');
  assert.equal(ready.dependencies.cliHost, 'RUNNING');
  const bypass = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'space@space.local', password: 'space-dev' }), signal: AbortSignal.timeout(10000) });
  assert.equal(bypass.status, 401, 'Development-login shortcut must remain disabled');
  const status = await request('/api/setup/status');
  assert.equal(status.setupRequired, true);
  const token = (await readFile(`${root}/.dev-stack/secrets/setup-token`, 'utf8')).trim();
  const credentials = { email: 'dev-stack@example.test', password: randomBytes(24).toString('base64url') };
  const claimed = await request('/api/setup/claim', { token, ...credentials });
  assert.equal(claimed.isAuthenticated, true);
  assert.equal((await request('/api/setup/status')).setupRequired, false);
  // Explicitly log in with the password rather than retaining claim authentication.
  cookie = undefined;
  assert.equal((await request('/api/auth/login', credentials)).isAuthenticated, true);
  csrf = await request('/api/auth/csrf');
  const starter = await request('/api/setup/starter-room', {});
  assert.match(starter.room.name, /Getting Started/i);
  const panes = await request(`/api/rooms/${encodeURIComponent(starter.room.id)}/panes`, { panes: [{ mode: 'TERMINAL', terminalRuntimeId: 'cli:opencode' }] });
  const pane = panes.data.find(pane => pane.terminalRuntimeId === 'cli:opencode');
  assert.ok(pane, 'API created OpenCode pane');
  const session = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: 'cli:opencode' });
  assert.ok(['IDLE', 'RUNNING'].includes(session.session.status), 'Session is allocated; terminal attachment starts its PTY');
  assert.ok(session.websocket, 'Terminal ticket issued');
  const terminal = new WebSocket(`${origin.replace('http:', 'ws:')}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?${new URLSearchParams({ sessionId: session.session.sessionId, token: session.websocket.token, initialCols: '100', initialRows: '30' })}`, { headers: { cookie } });
  try {
    await new Promise((resolve, reject) => {
      let transcript = '';
      const timeout = setTimeout(() => reject(new Error(`OpenCode TUI output was not observed: ${transcript.slice(-2000)}`)), 60000);
      terminal.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'error') { clearTimeout(timeout); reject(new Error(`Terminal error: ${frame.code}`)); }
        if (frame.type === 'output') transcript += frame.data;
        if (/opencode|ask anything|ctrl\+p|what would you like/i.test(stripVTControlCharacters(transcript)) && transcript.includes(String.fromCharCode(27) + '[')) { clearTimeout(timeout); resolve(); }
      });
      terminal.once('error', error => { clearTimeout(timeout); reject(error); });
      terminal.once('close', () => { clearTimeout(timeout); reject(new Error('Terminal closed before TUI verification')); });
    });
  } finally { terminal.close(); }
  await until(async () => (await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`)).session.status === 'RUNNING');
  snapshotSourceProcesses();
  console.log('PASS: workflows readiness, owner registration, password login, Getting Started, API pane creation, running CLI session and OpenCode terminal output');
  const webOrigin = `http://127.0.0.1:${process.env.SPACE_DEV_WEB_PORT ?? 4913}`;
  assert.equal((await fetch(webOrigin + '/src/main.tsx')).ok, true);
  const hmr = new WebSocket(webOrigin.replace('http:', 'ws:'), 'vite-hmr');
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Vite HMR was not observed')), 15000);
      hmr.on('message', async data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'connected') {
          const file = `${root}/apps/web/src/main.tsx`;
          const info = await stat(file);
          await utimes(file, info.atime, new Date());
        }
        if (['update', 'full-reload'].includes(frame.type)) { clearTimeout(timeout); resolve(); }
      });
      hmr.once('error', error => { clearTimeout(timeout); reject(error); });
    });
  } finally { hmr.close(); }
  console.log('PASS: Vite emits a reload event after a frontend source change');
  const startedAt = (await request('/readyz')).apiStartedAt;
  const apiSource = `${root}/apps/api/src/server.ts`;
  const info = await stat(apiSource);
  await utimes(apiSource, info.atime, new Date());
  await until(async () => { const state = await request('/readyz'); return state.ok && state.apiStartedAt !== startedAt; });
  snapshotSourceProcesses();
  console.log('PASS: API watch restarts and recovers workflow readiness');
  if (process.argv.includes('--rebuild')) {
    const oldStartedAt = (await request('/readyz')).apiStartedAt;
    const packageArtifact = `${root}/packages/contracts/dist/index.js`;
    const before = (await stat(packageArtifact)).mtimeMs;
    const previousExit = exited;
    launch(['--', 'rebuild']);
    assert.equal((await previousExit).code, 0, 'Rebuild stops the old supervisor');
    await until(async () => { const state = await request('/readyz'); return state.ok && state.apiStartedAt !== oldStartedAt; }, 600000);
    assert.ok((await stat(packageArtifact)).mtimeMs > before, 'Workspace package output was rebuilt');
    assert.equal((await request('/api/setup/status')).setupRequired, false, 'Owner survives rebuild');
    cookie = undefined;
    csrf = undefined;
    assert.equal((await request('/api/auth/login', credentials)).isAuthenticated, true);
    csrf = await request('/api/auth/csrf');
    snapshotSourceProcesses();
    console.log('PASS: rebuild recompiles workspace packages, replaces the supervisor, restores workflow readiness and preserves owner login');
  }


  if (process.argv.includes('--worker-failure')) {
    const pid = Number(output.match(/Dev-stack service started: worker pid=(\d+)/)?.[1]);
    assert.ok(pid > 1);
    process.kill(pid, 'SIGTERM');
    const outcome = await Promise.race([exited, delay(15000).then(() => { throw new Error('Worker failure did not stop supervisor'); })]);
    assert.equal(outcome.code, 1);
    assert.match(output, /Dev-stack service exited: worker/);
    console.log('PASS: worker failure is reported and stops supervised source services');
    npm(['down']);
    console.log('PASS: down stops the retained containers after worker failure');
  } else {
    npm(['down']);
    const outcome = await exited;
    assert.equal(outcome.code, 0);
    console.log('PASS: down exits supervisor successfully');
  }
} catch (error) {
  console.error(redact(output));
  throw error;
} finally {
  if (process.env.SPACE_DEV_INTEGRATION_LOG) await writeFile(process.env.SPACE_DEV_INTEGRATION_LOG, redact(output), { mode: 0o600 });
  npm(['reset']);
  await Promise.race([exited, delay(15000).then(() => { throw new Error('Supervisor survived reset'); })]);
  await assert.rejects(access(`${root}/.dev-stack`), { code: 'ENOENT' });
  const containers = execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim();
  const volumes = execFileSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim();
  assert.equal(containers, '');
  assert.equal(volumes, '');
  const groups = [...output.matchAll(/Dev-stack service started: \S+ pid=(\d+)/g)].map(match => -Number(match[1]));
  const deadline = Date.now() + 5000;
  let remaining;
  do {
    remaining = [...ownedPids, ...groups].filter(pid => {
      try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    });
    if (!remaining.length) break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.deepEqual(remaining, [], 'Owned process tree and groups must be reaped; use a working init/subreaper in containers');
  for (const port of [process.env.SPACE_DEV_API_PORT ?? 4912, process.env.SPACE_DEV_WEB_PORT ?? 4913]) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));
  }
  console.log('PASS: reset removes owned state, containers and volumes; API and Vite listeners are gone');
}
