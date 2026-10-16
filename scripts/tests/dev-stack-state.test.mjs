import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, symlink, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDevStackState, readDevStackSetupToken, resetDevStackState } from '../dev-stack-state.mjs';

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
