import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = `
  const descriptors = await import('./src/cli-runtime-descriptors.ts');
  const parity = await import('./src/cli-parity.ts');
  console.log(JSON.stringify({ descriptor: descriptors.findCliRuntimeDescriptor('cli:opencode'), home: parity.codexDirectParityHome, cwd: parity.codexDirectParityCwd, tmp: parity.opencodeDirectParityTmp }));
`;
describe('source CLI state overrides', () => {
  it('keeps all provider paths inside the configured development home', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SPACE_CLI_HOME: '/tmp/dev-home', SPACE_CLI_DEFAULT_CWD: '/tmp/dev-workspaces' }
    });
    const result = JSON.parse(output);
    expect(result.home).toBe('/tmp/dev-home');
    expect(result.cwd).toBe('/tmp/dev-workspaces');
    expect(result.tmp).toBe('/tmp/dev-home/.codex/space-opencode/tmp');
    expect(result.descriptor.stateRoot).toBe('/tmp/dev-home/.codex/space-opencode');
    for (const value of Object.values(result.descriptor.environment)) expect(value).toMatch(/^\/tmp\/dev-home\//);
  });
  it('rejects relative provider homes before starting services', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SPACE_CLI_HOME: 'relative' }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be an absolute path');
  });
});
