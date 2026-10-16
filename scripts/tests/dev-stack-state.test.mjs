import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, readFile, symlink, link, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDevStackState, readDevStackSetupToken, readDevStackSecret, resetDevStackState } from '../dev-stack-state.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-dev-state-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('creates secure secrets and reuses them on subsequent starts', async () => fixture(async (root) => {
  const first = await initializeDevStackState(root);
  assert.deepEqual(first.created.sort(), ['postgres-password', 'session-secret', 'setup-token']);
  const token = await readDevStackSetupToken(root);
  assert.ok(token.length >= 32);
  const second = await initializeDevStackState(root);
  assert.deepEqual(second.created, []);
  assert.equal(await readDevStackSetupToken(root), token);
  if (process.platform !== 'win32') {
    for (const name of first.created) {
      const item = await lstat(join(first.secrets, name));
      assert.equal(item.mode & 0o777, 0o600);
    }
  }
  await resetDevStackState(root);
  await assert.rejects(lstat(first.root), { code: 'ENOENT' });
}));

test('rejects symlink state directory', async () => fixture(async (root) => {
  const outside = await mkdtemp(join(tmpdir(), 'spaceapp-outside-'));
  try {
    await symlink(outside, join(root, '.dev-stack'), 'dir');
    await assert.rejects(initializeDevStackState(root), /unsafe state directory/);
    await assert.rejects(resetDevStackState(root), /unsafe state directory/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('does not overwrite existing secrets', async () => fixture(async (root) => {
  const location = join(root, '.dev-stack', 'secrets');
  await mkdir(location, { recursive: true });
  await writeFile(join(location, 'session-secret'), 'existing-secret\n');
  await initializeDevStackState(root);
  assert.equal(await readFile(join(location, 'session-secret'), 'utf8'), 'existing-secret\n');
}));


test('reset refuses an unrelated state directory', async () => fixture(async root => {
  await mkdir(join(root, '.dev-stack'));
  const file = join(root, '.dev-stack', 'important');
  await writeFile(file, 'keep');
  await assert.rejects(resetDevStackState(root));
  await assert.rejects(initializeDevStackState(root), /unrecognized/);
  assert.equal(await readFile(file, 'utf8'), 'keep');
}));

test('rejects symlink secrets without changing their targets', async () => fixture(async root => {
  const location = join(root, '.dev-stack', 'secrets');
  await mkdir(location, { recursive: true });
  const target = join(root, 'private');
  await writeFile(target, 'keep', { mode: 0o640 });
  await chmod(target, 0o640);
  await symlink(target, join(location, 'postgres-password'));
  await assert.rejects(initializeDevStackState(root), /unsafe secret/);
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
  assert.equal(await readFile(target, 'utf8'), 'keep');
}));

test('rejects hardlinked secrets and setup-token read through symlink parent', async () => fixture(async root => {
  const state = await initializeDevStackState(root);
  await rm(join(state.secrets, 'postgres-password'));
  const target = join(root, 'private');
  await writeFile(target, 'keep', { mode: 0o640 });
  await chmod(target, 0o640);
  await link(target, join(state.secrets, 'postgres-password'));
  await assert.rejects(initializeDevStackState(root), /unsafe secret/);
  await assert.rejects(readDevStackSecret(root, 'postgres-password'), /Unsafe/);
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
  await rm(state.secrets, { recursive: true });
  await symlink(root, state.secrets, 'dir');
  await assert.rejects(readDevStackSetupToken(root), /unsafe state/);
}));
