import { describe, expect, it } from 'bun:test';

import { run } from '../src/run.ts';

describe('run() default spawn (production path)', () => {
  it('shells out via the real node:child_process.spawn wrapper', async () => {
    // All the scriptedSpawn tests install a fake spawn in beforeEach, which
    // bypasses `spawnImpl = pipedNodeSpawn`. That's the wiring every CLI
    // caller actually uses, so a regression in the default — the wrapper
    // around node:child_process.spawn that narrows the nullable streams —
    // would ship unnoticed.
    //
    // `git --version` is the most portable real subprocess we have: git is
    // required by tempRepo (so it's already present everywhere this suite
    // runs), the output format is stable, and the call has no side effects
    // on the working tree.
    const result = await run('git', ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
    expect(result.stderr).toBe('');
  });
});
