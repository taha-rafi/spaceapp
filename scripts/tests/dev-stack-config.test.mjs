import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { initializeDevStackState } from '../dev-stack-state.mjs';

const root = resolve(import.meta.dirname, '../..');
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dev-stack-config-'));
  try {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await mkdir(join(dir, 'packages/run-spaceapp/templates'), { recursive: true });
    await mkdir(join(dir, 'tools'));
    for (const file of ['scripts/dev-stack.mjs', 'scripts/dev-stack-state.mjs', 'scripts/dev-stack-services.yml', 'packages/run-spaceapp/templates/compose.yml']) await copyFile(join(root, file), join(dir, file));
    // A fake Docker executable records calls; no containers are started in unit tests.
    await writeFile(join(dir, 'tools/docker'), '#!/bin/sh\nprintf "%s\\n" "$SPACE_DEV_POSTGRES_IMAGE" "$SPACE_DEV_TEMPORAL_IMAGE" "$@" > "$RECORD"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${join(dir, 'tools')}:${process.env.PATH}`, RECORD: join(dir, 'docker-call') };
    await fn(dir, env);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('down supplies image digests from the canonical template', async () => fixture(async (dir, env) => {
  const template = await readFile(join(dir, 'packages/run-spaceapp/templates/compose.yml'), 'utf8');
  execFileSync(process.execPath, [join(dir, 'scripts/dev-stack.mjs'), 'down'], { env });
  const recorded = await readFile(env.RECORD, 'utf8');
  for (const service of ['postgres', 'temporal']) {
    const image = template.match(new RegExp(`^  ${service}:\\n    image: (\\S+)`, 'm'))[1];
    assert.ok(recorded.includes(image));
  }
  assert.match(recorded, /spaceapp-dev-[a-f0-9]{12}/);
}));

test('reset refuses foreign state before invoking Docker', async () => fixture(async (dir, env) => {
  await mkdir(join(dir, '.dev-stack'));
  await writeFile(join(dir, '.dev-stack/important'), 'keep');
  const result = spawnSync(process.execPath, [join(dir, 'scripts/dev-stack.mjs'), 'reset'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(dir, '.dev-stack/important'), 'utf8'), 'keep');
  await assert.rejects(readFile(env.RECORD), { code: 'ENOENT' });
}));

test('invalid and colliding ports fail before invoking Docker', async () => fixture(async (dir, env) => {
  for (const value of ['0', '65536', '57233', 'abc', '4912.5']) {
    const result = spawnSync(process.execPath, [join(dir, 'scripts/dev-stack.mjs'), 'down'], { env: { ...env, SPACE_DEV_API_PORT: value }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `port ${value} must fail`);
    assert.match(result.stderr, /ports must differ|Invalid dev-stack port/);
  }
  await assert.rejects(readFile(env.RECORD), { code: 'ENOENT' });
}));


test('down cancels an in-progress setup command and terminates its process group', async () => fixture(async (dir, env) => {
  await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'Dockerfile'), 'RUN npm install opencode-ai@1.18.4\n');
  await writeFile(join(dir, 'tools/npm'), '#!/bin/sh\necho $$ > "$RECORD.npm-pid"\nexec sleep 60\n', { mode: 0o700 });
  const up = spawn(process.execPath, [join(dir, 'scripts/dev-stack.mjs')], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => up.once('exit', code => resolve(code)));
  try {
    let pid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(env.RECORD + '.npm-pid', 'utf8')); break; } catch { /* Wait for the fixture setup command to start. */ }
      await delay(50);
    }
    assert.ok(pid > 1, 'setup command started');
    execFileSync(process.execPath, [join(dir, 'scripts/dev-stack.mjs'), 'down'], { env, timeout: 15000 });
    assert.equal(await exited, 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  } finally {
    if (up.exitCode === null) up.kill('SIGTERM');
    await exited;
  }
}));


test('reset rejects a symlink control socket before invoking Docker', async () => fixture(async (dir, env) => {
  await initializeDevStackState(dir);
  const target = join(dir, 'unrelated');
  await writeFile(target, 'keep');
  await symlink(target, join(dir, '.dev-stack/control.sock'));
  const result = spawnSync(process.execPath, [join(dir, 'scripts/dev-stack.mjs'), 'reset'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe dev-stack control socket/);
  assert.equal(await readFile(target, 'utf8'), 'keep');
  await assert.rejects(readFile(env.RECORD), { code: 'ENOENT' });
}));
