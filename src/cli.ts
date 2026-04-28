#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import { ArgsError, parseInvocation, type Ref, type Tool } from './args.ts';
import { branchName, worktreePath } from './branch.ts';
import { cleanup } from './cleanup.ts';
import { createWorktree, mainRepoRoot, repoName } from './git.ts';
import { defaultBranch, fetchIssue, type IssueDetails } from './github.ts';
import { renderPrompt } from './prompt.ts';
import { slugify } from './slug.ts';
import { openTerminal } from './terminal.ts';
import { HELP, VERSION } from './config.ts';
import { STATE_VERSION, writeState, type RefRecord } from './workspace.ts';

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(VERSION);
    return 0;
  }

  let invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (err) {
    if (err instanceof ArgsError) {
      console.error(`error: ${err.message}\n`);
      console.error(HELP);
      return 64;
    }
    throw err;
  }

  if ('command' in invocation) {
    const repoRoot = await mainRepoRoot();
    const result = await cleanup(invocation.branch, { repoRoot });
    console.log(result.message);
    return result.status === 'unknown' ? 1 : 0;
  }

  return await runHandoffs(invocation.tool, invocation.refs, invocation.loop);
}

async function runHandoffs(tool: Tool, refs: Ref[], loop: boolean) {
  const repoRoot = await mainRepoRoot();
  const repo = await repoName();
  const parentBranch = await defaultBranch();
  const handoffRoot = resolveHandoffRoot();
  const runnerScript = resolveRunnerScript(handoffRoot);

  let failures = 0;
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
      });
      console.log(`[handoff] OK ${describeRef(ref)}`);
    } catch (err) {
      failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[handoff] FAILED for ${describeRef(ref)}: ${msg}`);
    }
  }
  if (refs.length > 1) {
    const ok = refs.length - failures;
    console.log(
      `[handoff] ${ok}/${refs.length} succeeded${failures ? `, ${failures} failed` : ''}`,
    );
  }
  return failures === 0 ? 0 : 1;
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
}

async function spawnHandoff(input: SpawnInput): Promise<void> {
  let issue: IssueDetails | undefined;
  let branch: string;
  if (input.ref.kind === 'issue') {
    issue = await fetchIssue(input.ref.number);
    branch = branchName({ tool: input.tool, issueNumber: issue.number });
  } else {
    const slug = slugify(input.ref.text, { maxLen: 20 });
    branch = branchName({ tool: input.tool, slug });
  }

  const path = worktreePath({ repoRoot: input.repoRoot, branch });

  console.log(`[handoff] ${input.tool} → ${branch}`);
  console.log(`           worktree: ${path}`);

  await createWorktree({ branch, path, base: input.parentBranch });

  const promptCtx = {
    tool: input.tool,
    repoName: input.repo,
    branch,
    parentBranch: input.parentBranch,
    worktreePath: path,
    loop: input.loop,
    ...(issue ? { issue } : {}),
    ...(input.ref.kind === 'freeform' ? { freeformDescription: input.ref.text } : {}),
  };
  const promptBody = renderPrompt(promptCtx);
  writeFileSync(join(path, 'PROMPT.md'), promptBody, 'utf8');

  const now = new Date().toISOString();
  writeState(path, {
    version: STATE_VERSION,
    tool: input.tool,
    ref: refRecord(input.ref, issue),
    branch,
    loop: input.loop,
    createdAt: now,
    updatedAt: now,
  });

  await openTerminal({
    cwd: path,
    scriptPath: input.runnerScript,
    args: [input.handoffRoot, input.tool, branch],
  });
  console.log(`[handoff] terminal launched for ${branch}`);
}

function resolveHandoffRoot(): string {
  // src/cli.ts → handoff-repo-root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveRunnerScript(handoffRoot: string): string {
  const isWin = platform() === 'win32';
  const script = join(handoffRoot, 'scripts', isWin ? 'handoff-runner.ps1' : 'handoff-runner.sh');
  if (!existsSync(script)) {
    throw new Error(
      `handoff: runner script not found at ${script}. ` +
        `The handoff CLI must be run from a checkout of the handoff repo (or an install that ships scripts/handoff-runner.{sh,ps1}).`,
    );
  }
  return script;
}

function describeRef(ref: Ref): string {
  return ref.kind === 'issue' ? `#${ref.number}` : `"${ref.text.slice(0, 40)}"`;
}

function refRecord(ref: Ref, issue: IssueDetails | undefined): RefRecord {
  if (ref.kind === 'issue') {
    return { type: 'issue', number: issue?.number ?? ref.number };
  }
  return { type: 'freeform', text: ref.text };
}

const code = await main(process.argv.slice(2));
process.exit(code);
