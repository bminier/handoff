# Test infra

Tests live next to `src/` in `tests/`. Pure modules (`args`, `slug`, `branch`,
`prompt`, `workspace`, parts of `terminal` and `telemetry`) are tested
directly with `bun:test`. I/O modules (`run`, `git`, `github`, `cleanup`,
`terminal` spawn) need a fixture — pick one of the three below.

## Picking a fixture

| You're testing…                                              | Use                      | Why                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`, `github.ts`                                        | **`scriptedSpawn`**      | The contract is the argv we hand to the subprocess. Fake the spawn, assert call shape and parsing of canned stdout.                                                                                   |
| `git.ts` (worktree create/remove, branch ops)                | **`tempRepo`**           | The contract is git's actual behaviour. Spinning up a real throwaway repo costs ~50 ms and catches divergence a hand-rolled fake would miss.                                                          |
| A module with multiple I/O collaborators (e.g. `cleanup.ts`) | **dependency injection** | If a module depends on several I/O wrappers, give it an optional `deps?` param and pass plain in-memory fakes. See `src/cleanup.ts` + `tests/cleanup.test.ts`.                                        |
| `terminal.ts` spawn path                                     | **dependency injection** | `openTerminal` shells out via its own `spawnDetached` (not `run.ts`), so `scriptedSpawn` doesn't reach it. The terminal-test issue (#14) will add a `spawn?` param on `openTerminal` and pass a fake. |

Don't reach for `mock.module(...)` to fake `git.ts`/`github.ts`/`run.ts`. Bun's
`mock.module` is **process-global** for the whole `bun test` run, so any other
test file that imports the real module gets the mocked version too — there's
no test-scoped restore. Use one of the three patterns above instead.

## `tests/helpers/scriptedSpawn.ts`

Replaces the spawn used by `src/run.ts` with one that returns canned
stdout/stderr/exitCode keyed by exact `(command, argv)` pairs. Records every
call so tests can assert which subprocesses were spawned.

```ts
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { fetchIssue } from '../src/github.ts';
import { createScriptedSpawn, type ScriptedSpawn } from './helpers/scriptedSpawn.ts';

let spawn: ScriptedSpawn;
beforeEach(() => {
  spawn = createScriptedSpawn();
  spawn.install();
});
afterEach(() => spawn.uninstall());

it('parses an issue payload', async () => {
  spawn.expectGh(['issue', 'view', '7', '--json', 'number,title,body,labels,url'], {
    number: 7,
    title: 'x',
    body: '',
    url: 'https://example.test/7',
    labels: [],
  });
  const issue = await fetchIssue(7);
  expect(issue.number).toBe(7);
});
```

`expectGh(argv, jsonBody)` is shorthand for the common case of a `gh` call that
returns JSON on stdout. Use `expect({ command, argv, response })` for anything
else — non-zero exit codes (`response.exitCode = 1`) reject through `RunError`.

If a call doesn't match any registered expectation, the spawn emits an
`error` event so the test fails loudly rather than silently hanging.

The seam itself is `__setSpawnForTesting` in `src/run.ts`. The `__` prefix and
`@internal` JSDoc tag keep production code from reaching for it. Tests should
go through `createScriptedSpawn()`.

## `tests/helpers/tempRepo.ts`

Creates a real throwaway repo in `os.tmpdir()` and runs the real `git`. Cheap
enough to run in `beforeEach`, fast enough to stay in the regular test suite
(no env-var gating today; revisit if Windows CI gets slow).

```ts
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { branchExists } from '../src/git.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;
let originalCwd: string;

beforeEach(() => {
  repo = createTempRepo({
    branches: ['feature/x'],
    remotes: { origin: 'https://example.invalid/r.git' },
  });
  originalCwd = process.cwd();
});
afterEach(() => {
  process.chdir(originalCwd);
  repo.cleanup();
});

it('reports an existing branch', async () => {
  process.chdir(repo.path);
  expect(await branchExists('feature/x')).toBe(true);
});
```

Most of `git.ts` doesn't take a `cwd` — it shells out via `run()` which
defaults to `process.cwd()`. The `process.chdir` + restore pattern above is
the wiring the per-module tests should follow. Keep `originalCwd`
restoration in `afterEach` so a thrown test doesn't leak the cwd into later
files.

`tempRepo` defaults `initialBranch` to `'dev'` to match this repo's
convention. Override it for tests that care about HEAD on a different ref.
The helper uses `git symbolic-ref HEAD refs/heads/<name>` (works on `git ≥
2.20`, our documented minimum) rather than `git init -b` (which needs 2.28+).

## Mixing fixtures

`scriptedSpawn` and `tempRepo` should not be installed in the same test.
`scriptedSpawn.install()` replaces the spawn `run()` uses, and `tempRepo`
needs the real one to drive `git`. If a test needs both — for example,
fake-`gh` plus real-`git` — that's a sign the module under test is doing
two different I/O things; consider splitting it before reaching for a
hybrid harness.
