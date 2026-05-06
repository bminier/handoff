# Test infra

Tests live next to `src/` in `tests/`. Pure modules (`args`, `slug`, `branch`,
`prompt`, `workspace`, parts of `terminal` and `telemetry`) are tested
directly with `bun:test`. I/O modules (`run`, `git`, `github`, `cleanup`,
`terminal` spawn) need a fixture — pick one of the three below.

## Picking a fixture

| You're testing…                                              | Use                      | Why                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`, `github.ts`                                        | **`scriptedSpawn`**      | The contract is the argv we hand to the subprocess. Fake the spawn, assert call shape and parsing of canned stdout.                                                                                                                                                           |
| `git.ts` (worktree create/remove, branch ops)                | **`tempRepo`**           | The contract is git's actual behaviour. Spinning up a real throwaway repo costs ~50 ms and catches divergence a hand-rolled fake would miss.                                                                                                                                  |
| A module with multiple I/O collaborators (e.g. `cleanup.ts`) | **dependency injection** | If a module depends on several I/O wrappers, give it an optional `deps?` param and pass plain in-memory fakes. See `src/cleanup.ts` + `tests/cleanup.test.ts`.                                                                                                                |
| `terminal.ts` spawn path                                     | **dependency injection** | `openTerminal` shells out via its own `spawnDetached` (not `run.ts`), so `scriptedSpawn` doesn't reach it. Pass a fake `spawn` through `openTerminalOn(plat, { ...input, spawn })` to record argv and exercise the per-platform fallback chain. See `tests/terminal.test.ts`. |

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
`error` event so an awaiting test fails fast. `uninstall()` also throws
if any call went unmatched — that catches the case where the code under
test catches the error and would otherwise let the unsanctioned spawn
slip through silently.

The seam itself is `__setSpawnForTesting` in `src/run.ts`. The `__` prefix
and `@internal` JSDoc tag are conventional markers — neither is enforced
(no `stripInternal`, source files are executed directly), so production
code _could_ import it. Don't. Tests go through `createScriptedSpawn()`;
the seam exists for that fixture, not for general use.

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

For per-module unit tests, `scriptedSpawn` and `tempRepo` should not be
installed together. `scriptedSpawn.install()` replaces the spawn `run()`
uses, and `tempRepo` needs the real one to drive `git`. If a single
module's test needs both, that's a sign the module is doing two different
I/O things — split it before reaching for a hybrid harness.

### Hybrid harness for CLI integration tests

CLI-level integration tests are the documented exception: `cli.ts` fans
out to `fetchIssue` (gh), `createWorktree` (git), and `openTerminal`
(internal spawn) in the same flow, so a happy-path test inherently needs
fake-`gh` + real-`git` + fake-terminal. `tests/cli.integration.test.ts`
wires this together using three opt-ins:

1. **`createScriptedSpawn({ passthrough })`** — predicate that decides
   which calls fall through to the _previous_ spawn impl active at
   `install()` time (typically the production `pipedNodeSpawn`). The CLI
   integration test passes `(cmd) => cmd === 'git'` so git operates on
   the tempRepo while gh stays faked. Pass-through calls are still
   recorded but don't count toward the unmatched-call teardown check.
2. **`__setTerminalSpawnForTesting`** in `src/terminal.ts` — the
   module-level seam paralleling `__setSpawnForTesting` in `run.ts`.
   `openTerminal` reads it instead of `node:child_process.spawn`, so the
   integration test can capture launches without the CLI threading a
   `spawn?` arg through.
3. **`HOME` / `USERPROFILE` redirection** — `showFirstRunBanner` and the
   telemetry config read `os.homedir()`, so the test points it at a
   mkdtemp dir to keep the developer's real `~/.handoff/` untouched.

Per-module tests should keep using the strict matcher — `passthrough` is
for integration tests where multiple I/O surfaces fan out from a single
entry point.

## Concurrency assumption

These fixtures lean on Bun running tests serially. `process.chdir` (in
the `tempRepo` pattern) and the module-level `spawnImpl` in `src/run.ts`
are both process-global, and a sibling test running concurrently would
observe the wrong cwd or the wrong spawn.

Bun is serial by default — a bare `bun test` with no `test.concurrent()`
markers and no `--concurrent` flag runs one test at a time. The risk is
forward-only: a contributor later adds `test.concurrent()` to a test that
happens to use `chdir` or `spawnImpl`, or someone passes `--concurrent`,
and Bun then schedules up to 20 in-flight tests (its default
`--max-concurrency` cap) that race the global state.

`package.json`'s `test` script pins the cap to 1
(`bun test --max-concurrency=1`), so even those future opt-ins still
serialize. CI invokes `bun run test` so the flag applies there too. **Run
`bun run test` locally rather than bare `bun test`** — bare doesn't pick
up the pin, and if any test in the suite gets marked concurrent, your
local run can hit a flake CI never sees.

If we ever want real concurrency, the fix is structural and not small:
add a `cwd` parameter to every `git.ts` function and thread it through
to the `run()` call (which already takes `cwd` at its boundary), update
every caller to pass it, and lift the spawn seam onto a per-fixture
context instead of a module global. Out of scope for this PR — flagged
here so the future flip isn't a silent-flake landmine.
