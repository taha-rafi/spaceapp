import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const FILES = Object.freeze({
  'postgres-password': () => randomBytes(36).toString('base64url'),
  'session-secret': () => randomBytes(48).toString('base64url'),
  'setup-token': () => randomBytes(32).toString('base64url'),
});

export function devStackPaths(repoRoot) {
  const root = resolve(repoRoot, '.dev-stack');
  return { root, secrets: join(root, 'secrets') };
}

async function assertSafeDirectory(path) {
  try {
    const item = await lstat(path);
    if (item.isSymbolicLink() || !item.isDirectory()) {
      throw new Error(`Refusing unsafe state directory: ${path}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function initializeDevStackState(repoRoot) {
  const { root, secrets } = devStackPaths(repoRoot);
  await assertSafeDirectory(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(secrets);
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(secrets, 0o700);

  const result = { root, secrets, created: [] };
  for (const [name, generate] of Object.entries(FILES)) {
    const file = join(secrets, name);
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(`${generate()}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      result.created.push(name);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const item = await lstat(file);
      if (!item.isFile() || item.isSymbolicLink()) {
        throw new Error(`Refusing unsafe secret file: ${file}`);
      }
    }
    await chmod(file, 0o600);
  }
  return result;
}

export async function readDevStackSetupToken(repoRoot) {
  const { secrets } = devStackPaths(repoRoot);
  return (await readFile(join(secrets, 'setup-token'), 'utf8')).trim();
}

export async function resetDevStackState(repoRoot) {
  const { root } = devStackPaths(repoRoot);
  await assertSafeDirectory(root);
  try {
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe state path');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await rm(root, { recursive: true, force: false });
}
