#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ArgsError,
  extractGlobalFlags,
  parseInvocation,
  type Ref,
  type TelemetryArgs,
} from './args.ts';
import type { Tool } from './tools.ts';
import { HandoffError } from './errors.ts';
import { setDebug, setVerbose, verbose } from './logger.ts';
import { branchName, worktreePath } from './branch.ts';
import { cleanup, type CleanupResult } from './cleanup.ts';
import {
  createDetachedWorktree,
  createWorktree,
  mainRepoRoot,
  removeWorktree,
  repoName,
} from './git.ts';
import {
  checkoutPullRequest,
  defaultBranch,
  fetchIssue,
  fetchPullRequest,
  type IssueDetails,
  type PullRequestDetails,
} from './github.ts';
import { renderPrompt } from './prompt.ts';
import { RunError } from './run.ts';
import { slugify } from './slug.ts';
import { openTerminal } from './terminal.ts';
import { HELP, VERSION } from './config.ts';
import { readState, STATE_VERSION, writeState, type RefRecord } from './workspace.ts';
import {
  bannerText,
  buildStatusReport,
  emit,
  eventCleanup,
  eventError,
  eventStart,
  formatStatusReport,
  loadConfig,
  markBannerSeen,
  newSessionId,
  readDebugLog,
  setEnabled,
  TelemetryConfigError,
  configPath,
  type CleanupOutcome,
} from './telemetry.ts';

async function main(rawArgv: readonly string[]): Promise<number> {
  // Use extractGlobalFlags rather than rawArgv.includes() so that a literal
  // `--verbose`/`--debug` token inside a free-form description (e.g.
  // `handoff claude fix the --verbose flag`) doesn't accidentally enable
  // verbose mode. extractGlobalFlags walks the same scanning-mode boundary
  // as parseInvocation and only counts flags seen before free-form starts.
  // Aliased as *Flag so the booleans don't shadow the imported `verbose()`
  // logger when this scope grows.
  const { verbose: verboseFlag, debug: debugFlag } = extractGlobalFlags(rawArgv);
  setVerbose(verboseFlag);
  setDebug(debugFlag);

  // Find the first non-global-flag token so that `--verbose --help` (and
  // similar) routes correctly instead of falling through to parseInvocation.
  let firstIdx = 0;
  while (
    firstIdx < rawArgv.length &&
    (rawArgv[firstIdx] === '--verbose' || rawArgv[firstIdx] === '--debug')
  ) {
    firstIdx++;
  }
  const firstToken = rawArgv[firstIdx];

  // Empty argv → show help (the friendly default). But `handoff --verbose`
  // (only global flags) is a usage error: route those through
  // parseInvocation so it raises ArgsError → exit 1, matching the
  // documented exit-code categories.
  if (rawArgv.length === 0 || firstToken === '--help' || firstToken === '-h') {
    console.log(HELP);
    return 0;
  }
  if (firstToken === '--version' || firstToken === '-v') {
    console.log(VERSION);
    return 0;
  }

  let invocation;
  try {
    invocation = parseInvocation(rawArgv);
  } catch (err) {
    if (err instanceof ArgsError) {
      console.error(`error: ${err.message}\n`);
      console.error(HELP);
      return 1;
    }
    throw err;
  }

  if ('command' in invocation) {
    if (invocation.command === 'telemetry') {
      return await runTelemetry(invocation);
    }
    showFirstRunBanner();
    return await runCleanup(invocation.branch, invocation.force);
  }

  showFirstRunBanner();
  return await runHandoffs(invocation.tool, invocation.refs, invocation.loop);
}

async function runCleanup(branch: string, force: boolean): Promise<number> {
  const repoRoot = await mainRepoRoot();
  const path = worktreePath({ repoRoot, branch });
  const state = safeReadState(path);
  const startedAt = state?.createdAt ? Date.parse(state.createdAt) : NaN;

  // Move the bun process's cwd out of the worktree before cleanup runs.
  // The runner scripts launch us with cwd inside the worktree we're
  // about to remove; on Windows, `git worktree remove --force` then
  // fails with "Permission denied" because the OS won't delete a
  // directory that's another process's cwd. cleanup's `defaultDeps`
  // already binds *git* invocations to repoRoot — this releases the
  // bun-process cwd handle for the same reason. mainRepoRoot is the
  // closest stable directory we know exists.
  if (process.cwd() !== repoRoot) {
    try {
      process.chdir(repoRoot);
    } catch {
      /* best-effort — if chdir fails we keep going; cleanup will surface
         a clearer error than a process-state issue. */
    }
  }

  // A PR handoff checked the worktree out onto the PR's own head branch —
  // cleanup must remove the worktree but leave that branch for the PR. The
  // signal is `.handoff/state.json`; if it's missing/unreadable (safeReadState
  // returned null) we fall back to deleting, which is correct for the issue /
  // free-form worktrees that are the only ones a pre-#60 state could describe.
  const keepBranch = state?.ref.type === 'pr';

  verbose(
    `cleanup: branch = ${branch}, worktree = ${path}, force = ${force}, keepBranch = ${keepBranch}`,
  );
  const t0 = Date.now();
  const result = await cleanup(branch, { repoRoot, force, keepBranch });
  verbose(`cleanup: result = ${result.status}`);
  console.log(result.message);

  const durationMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Date.now() - t0;
  emitFireAndForget(
    eventCleanup({
      tool: state?.tool ?? 'unknown',
      outcome: cleanupOutcome(result, force),
      durationMs,
    }),
  );

  // 'unknown' from cleanup.ts means an operational step (gh pr-merged check,
  // worktree remove, branch delete) failed — that's exit code 2 per the
  // documented categories, not 1 (which is reserved for user errors).
  return result.status === 'unknown' ? 2 : 0;
}

function cleanupOutcome(result: CleanupResult, force: boolean): CleanupOutcome {
  switch (result.status) {
    case 'removed':
      // Distinguish forced from merged so analytics can track how often
      // the safety check is bypassed. The result message already carries
      // the same distinction in human-readable form ("forced — merge
      // check skipped" vs "PR merged"); telemetry mirrors that.
      return force ? 'forced' : 'merged';
    case 'retained':
      return 'retained';
    case 'unknown':
      return 'failed';
  }
}

function safeReadState(path: string) {
  try {
    return readState(path);
  } catch {
    return null;
  }
}

async function runTelemetry(invocation: TelemetryArgs): Promise<number> {
  try {
    return await runTelemetryInner(invocation);
  } catch (err) {
    if (err instanceof TelemetryConfigError) {
      console.error(`error: ${err.message}`);
      console.error(
        `       If the file is corrupt, remove ${configPath()} and re-run this command.`,
      );
      return 1;
    }
    throw err;
  }
}

async function runTelemetryInner(invocation: TelemetryArgs): Promise<number> {
  switch (invocation.sub) {
    case 'enable': {
      const patch = invocation.endpoint === undefined ? {} : { endpoint: invocation.endpoint };
      const config = setEnabled(true, patch);
      console.log('telemetry: enabled');
      console.log(
        `endpoint:  ${config.telemetry.endpoint ?? '(none — set with --endpoint <url>)'}`,
      );
      if (!config.telemetry.endpoint) {
        console.log(
          'note:      no endpoint configured, so events will be logged for debug only ' +
            '(set HANDOFF_TELEMETRY_DEBUG=1) until an endpoint is set.',
        );
      }
      return 0;
    }
    case 'disable': {
      setEnabled(false);
      console.log('telemetry: disabled');
      return 0;
    }
    case 'status': {
      console.log(formatStatusReport(buildStatusReport()));
      return 0;
    }
    case 'log': {
      const body = readDebugLog();
      if (body.length === 0) {
        console.log(
          '(no telemetry debug log entries yet — set HANDOFF_TELEMETRY_DEBUG=1 ' +
            'in your environment to start capturing events to disk).',
        );
        return 0;
      }
      process.stdout.write(body);
      return 0;
    }
  }
}

function showFirstRunBanner(): void {
  let config;
  try {
    config = loadConfig();
  } catch {
    return;
  }
  if (config.firstRunBannerSeen) return;
  console.error(bannerText());
  try {
    markBannerSeen();
  } catch {
    /* if we can't persist the flag, just don't crash; we'll show the banner again next time. */
  }
}

async function runHandoffs(tool: Tool, refs: Ref[], loop: boolean) {
  const repoRoot = await mainRepoRoot();
  const repo = await repoName();
  const parentBranch = await defaultBranch();
  const handoffRoot = resolveHandoffRoot();
  const runnerScript = resolveRunnerScript(handoffRoot);

  let failures = 0;
  // Track the most-severe (highest) exit code seen across per-ref failures so
  // the documented exit-code categories (1=user, 2=operational, 3=internal)
  // surface even when refs fail independently. cliMain only sees this single
  // return value because the per-ref try/catch swallows the throw.
  let worstExitCode = 0;
  for (const ref of refs) {
    try {
      await spawnHandoff({
        tool,
        ref,
        repoRoot,
        repo,
        parentBranch,
        handoffRoot,
        runnerScript,
        loop,
        fleet: refs.length,
      });
      console.log(`[handoff] OK ${describeRef(ref)}`);
    } catch (err) {
      failures += 1;
      const exitCode = exitCodeFor(err);
      if (exitCode > worstExitCode) worstExitCode = exitCode;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[handoff] FAILED for ${describeRef(ref)}: ${msg}`);
      if (err instanceof HandoffError && err.hint) {
        console.error(`           hint: ${err.hint}`);
      }
      emitFireAndForget(eventError({ code: errorCode(err), module: 'cli.spawnHandoff', exitCode }));
    }
  }
  if (refs.length > 1) {
    const ok = refs.length - failures;
    console.log(
      `[handoff] ${ok}/${refs.length} succeeded${failures ? `, ${failures} failed` : ''}`,
    );
  }
  return failures === 0 ? 0 : worstExitCode;
}

interface SpawnInput {
  tool: Tool;
  ref: Ref;
  repoRoot: string;
  repo: string;
  parentBranch: string;
  handoffRoot: string;
  runnerScript: string;
  loop: boolean;
  fleet: number;
}

async function spawnHandoff(input: SpawnInput): Promise<void> {
  const ref = input.ref;
  let issue: IssueDetails | undefined;
  let pr: PullRequestDetails | undefined;
  let branch: string;
  // For issue / free-form refs this is the repo's default branch (the worktree
  // base). For a PR ref it's the PR's *base* branch — the worktree itself is
  // the PR's head branch, so the agent's pushes land on the PR.
  let parentBranch = input.parentBranch;

  if (ref.kind === 'issue') {
    verbose(`fetching issue #${ref.number}`);
    issue = await fetchIssue(ref.number);
    branch = branchName({ tool: input.tool, issueNumber: issue.number });
  } else if (ref.kind === 'pr') {
    verbose(`fetching PR #${ref.number}`);
    pr = await fetchPullRequest(ref.number);
    assertPrHandoffable(pr);
    branch = pr.headRefName;
    parentBranch = pr.baseRefName;
  } else {
    const slug = slugify(ref.text, { maxLen: 20 });
    branch = branchName({ tool: input.tool, slug });
  }
  verbose(`branch: ${branch}`);

  const path = worktreePath({ repoRoot: input.repoRoot, branch });

  console.log(`[handoff] ${input.tool} → ${branch}`);
  console.log(`           worktree: ${path}`);

  if (pr) {
    // A PR handoff checks out the PR's *existing* head branch — create the
    // worktree detached, then let `gh pr checkout` switch it onto that branch
    // (it also wires up push tracking so the agent's `git push` hits the PR).
    verbose(`creating detached worktree at ${path}`);
    await createDetachedWorktree(path);
    try {
      verbose(`checking out PR #${pr.number} into ${path}`);
      await checkoutPullRequest(pr.number, path);
    } catch (err) {
      // The checkout failed after the worktree was created — don't strand a
      // detached orphan with no branch and no state.json. Best-effort remove.
      verbose(`PR checkout failed; removing partial worktree ${path}`);
      await removeWorktree(path).catch(() => {});
      throw err;
    }
  } else {
    verbose(`creating worktree at ${path}`);
    await createWorktree({ branch, path, base: parentBranch });
  }

  const promptCtx = {
    tool: input.tool,
    repoName: input.repo,
    branch,
    parentBranch,
    worktreePath: path,
    loop: input.loop,
    ...(issue ? { issue } : {}),
    ...(pr
      ? {
          pr: {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            url: pr.url,
            headBranch: pr.headRefName,
            baseBranch: pr.baseRefName,
            isDraft: pr.isDraft,
          },
        }
      : {}),
    ...(ref.kind === 'freeform' ? { freeformDescription: ref.text } : {}),
  };
  const promptBody = renderPrompt(promptCtx);
  writeFileSync(join(path, 'PROMPT.md'), promptBody, 'utf8');

  const now = new Date().toISOString();
  writeState(path, {
    version: STATE_VERSION,
    tool: input.tool,
    ref: refRecord(ref, issue),
    branch,
    loop: input.loop,
    createdAt: now,
    updatedAt: now,
  });

  verbose(`launching terminal for ${branch}`);
  await openTerminal({
    cwd: path,
    scriptPath: input.runnerScript,
    args: [input.handoffRoot, input.tool, branch],
  });
  console.log(`[handoff] terminal launched for ${branch}`);

  emitFireAndForget(
    eventStart({
      tool: input.tool,
      refType: ref.kind,
      fleet: input.fleet,
      loop: input.loop,
      sessionId: newSessionId(),
    }),
  );
}

/**
 * Refuse PR refs handoff can't work on. A non-open PR has no live branch to
 * complete; a fork PR's head branch isn't reliably pushable (#60 scopes to
 * same-repo PRs). Both are user errors — the ref is wrong for a handoff.
 */
function assertPrHandoffable(pr: PullRequestDetails): void {
  if (pr.state !== 'OPEN') {
    throw new HandoffError(
      `PR #${pr.number} is ${pr.state}, not open — nothing to complete.`,
      1,
      pr.state === 'MERGED'
        ? 'This PR already merged; hand off a follow-up issue instead.'
        : 'Reopen the PR, or hand the work off as an issue or free-form task.',
    );
  }
  if (pr.isCrossRepository) {
    throw new HandoffError(
      `PR #${pr.number} is from a fork — cross-repo PR handoff isn't supported yet.`,
      1,
      "Check the PR's head branch out yourself, or hand the work off as an issue.",
    );
  }
}

function resolveHandoffRoot(): string {
  // src/cli.ts → handoff-repo-root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveRunnerScript(handoffRoot: string): string {
  const isWin = platform() === 'win32';
  const script = join(handoffRoot, 'scripts', isWin ? 'handoff-runner.ps1' : 'handoff-runner.sh');
  if (!existsSync(script)) {
    throw new HandoffError(
      `runner script not found at ${script}`,
      2,
      `Run handoff from its repo checkout, or re-run the installer (scripts/install.py).`,
    );
  }
  return script;
}

function describeRef(ref: Ref): string {
  switch (ref.kind) {
    case 'issue':
      return `#${ref.number}`;
    case 'pr':
      return `PR #${ref.number}`;
    case 'freeform':
      return `"${ref.text.slice(0, 40)}"`;
  }
}

function refRecord(ref: Ref, issue: IssueDetails | undefined): RefRecord {
  switch (ref.kind) {
    case 'issue':
      return { type: 'issue', number: issue?.number ?? ref.number };
    case 'pr':
      return { type: 'pr', number: ref.number };
    case 'freeform':
      return { type: 'freeform', text: ref.text };
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name;
  }
  return 'Error';
}

/**
 * Map an error to the exit-code category cliMain would use if the error
 * propagated out unchanged. Mirrors the cliMain catch ladder so per-ref
 * failures inside runHandoffs can report the same code on stderr/telemetry
 * that a single-ref run would.
 */
function exitCodeFor(err: unknown): number {
  if (err instanceof HandoffError) return err.exitCode;
  if (err instanceof RunError) return 2;
  return 3;
}

/**
 * Detach the network round-trip from the CLI's promise chain so a slow or
 * misconfigured endpoint never blocks the user. Errors are dropped — the
 * debug log (if enabled) is the audit trail.
 */
function emitFireAndForget(...args: Parameters<typeof emit>): void {
  void emit(...args).catch(() => {});
}

/**
 * Run the CLI with the given argv and return the exit code. Exported so
 * integration tests can drive the full pipeline in-process — see
 * `tests/cli.integration.test.ts` and `tests/README.md`. Production callers
 * should rely on the entry-point gate below.
 */
export async function cliMain(argv: readonly string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof HandoffError) {
      console.error(`error: ${err.message}`);
      if (err.hint) console.error(`hint:  ${err.hint}`);
      return err.exitCode;
    }
    if (err instanceof RunError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: unexpected error: ${msg}`);
    return 3;
  }
}

// Use process.exitCode (not process.exit) so any in-flight `emit` fetches get
// a chance to drain — they're already bounded by AbortController(EMIT_TIMEOUT_MS),
// so the worst-case extra wall time is one timeout window. process.exit would
// abort them immediately, which silently lost telemetry for users who'd opted in.
//
// Gate on `import.meta.main` so importing this file from a test doesn't
// auto-execute against the test's argv.
if (import.meta.main) {
  process.exitCode = await cliMain(process.argv.slice(2));
}
