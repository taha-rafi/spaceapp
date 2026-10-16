import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const MARKER = 'spaceapp-contributor-dev-state-v1\n';
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
  const marker = join(root, 'owner');
  const entries = await readdir(root);
  if (!entries.includes('owner') && entries.some(entry => entry !== 'secrets')) {
    throw new Error('Refusing to adopt unrecognized dev-stack state');
  }
  await assertSafeDirectory(secrets);
  if (!entries.includes('owner') && entries.includes('secrets')) {
    if ((await readdir(secrets)).some(name => !Object.hasOwn(FILES, name))) {
      throw new Error('Refusing to adopt unrecognized dev-stack secrets');
    }
  }
  try {
    const handle = await open(marker, 'wx', 0o600);
    try { await handle.writeFile(MARKER); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readRegularFile(marker) !== MARKER) throw new Error('Unrecognized dev-stack ownership marker', { cause: error });
  }
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
      if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1) {
        throw new Error(`Refusing unsafe secret file: ${file}`, { cause: error });
      }
    }
    await chmod(file, 0o600);
  }
  return result;
}

async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error('Unsafe dev-stack file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export async function readDevStackSecret(repoRoot, name) {
  if (!Object.hasOwn(FILES, name)) throw new Error('Unknown dev-stack secret');
  const { root, secrets } = devStackPaths(repoRoot);
  await assertSafeDirectory(root);
  await assertSafeDirectory(secrets);
  const secret = (await readRegularFile(join(secrets, name))).trim();
  if (!secret || /[\0\r\n]/.test(secret)) throw new Error(`Invalid dev-stack secret: ${name}`);
  return secret;
}

export async function readDevStackSetupToken(repoRoot) {
  return readDevStackSecret(repoRoot, 'setup-token');
}

export async function assertDevStackStateOwner(repoRoot) {
  const { root } = devStackPaths(repoRoot);
  await assertSafeDirectory(root);
  try { await lstat(root); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (await readRegularFile(join(root, 'owner')) !== MARKER) throw new Error('Refusing unowned dev-stack state');
  return true;
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
  if (await readRegularFile(join(root, 'owner')) !== MARKER) throw new Error('Refusing unowned dev-stack state');
  await rm(root, { recursive: true, force: false });
}
