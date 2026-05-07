import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Tool } from './args.ts';
import { HandoffError } from './errors.ts';

export const HOME_DIRNAME = '.handoff';
export const CONFIG_FILENAME = 'config.json';
export const DEBUG_LOG_FILENAME = 'telemetry-debug.log';
export const CONFIG_VERSION = 1;
export const EMIT_TIMEOUT_MS = 1000;
export const DEBUG_ENV_VAR = 'HANDOFF_TELEMETRY_DEBUG';

export interface TelemetryConfig {
  version: typeof CONFIG_VERSION;
  telemetry: {
    enabled: boolean;
    endpoint: string | null;
    lastSentAt: string | null;
  };
  firstRunBannerSeen: boolean;
}

export class TelemetryConfigError extends HandoffError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'TelemetryConfigError';
  }
}

// ---------- pure: paths, defaults, parsing ----------

export function homeRoot(home: string = homedir()): string {
  return join(home, HOME_DIRNAME);
}

export function configPath(home: string = homedir()): string {
  return join(homeRoot(home), CONFIG_FILENAME);
}

export function debugLogPath(home: string = homedir()): string {
  return join(homeRoot(home), DEBUG_LOG_FILENAME);
}

export function defaultConfig(): TelemetryConfig {
  return {
    version: CONFIG_VERSION,
    telemetry: { enabled: false, endpoint: null, lastSentAt: null },
    firstRunBannerSeen: false,
  };
}

/**
 * Validates and normalizes parsed JSON into a TelemetryConfig. Missing fields
 * fall back to defaults so a half-written config from a future bug doesn't
 * brick the CLI; an unsupported `version` does throw, since silently reading
 * a v2 file as v1 would risk losing user-set fields.
 */
export function parseConfig(raw: unknown): TelemetryConfig {
  if (!raw || typeof raw !== 'object') {
    throw new TelemetryConfigError('config must be a JSON object');
  }
  const r = raw as { version?: unknown; telemetry?: unknown; firstRunBannerSeen?: unknown };
  if (r.version !== CONFIG_VERSION) {
    // Don't reference a file path here — `parseConfig` is pure and may be
    // called with arbitrary JSON. `loadConfig` knows the real `p` and
    // re-throws with that path appended (see below).
    throw new TelemetryConfigError(
      `unsupported config version ${JSON.stringify(r.version)} (expected ${CONFIG_VERSION})`,
    );
  }
  const t =
    r.telemetry && typeof r.telemetry === 'object'
      ? (r.telemetry as { enabled?: unknown; endpoint?: unknown; lastSentAt?: unknown })
      : {};
  // Whitespace-only endpoints would fail at send time and silently drop
  // every event — coerce to null so `status` is honest and the no-endpoint
  // short-circuit in `emit` kicks in.
  const trimmedEndpoint =
    typeof t.endpoint === 'string' && t.endpoint.trim().length > 0 ? t.endpoint.trim() : null;
  return {
    version: CONFIG_VERSION,
    telemetry: {
      enabled: t.enabled === true,
      endpoint: trimmedEndpoint,
      lastSentAt: typeof t.lastSentAt === 'string' ? t.lastSentAt : null,
    },
    firstRunBannerSeen: r.firstRunBannerSeen === true,
  };
}

export function serializeConfig(config: TelemetryConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

// ---------- pure: events ----------

export type RefType = 'issue' | 'freeform';
export type CleanupOutcome = 'merged' | 'retained' | 'failed';

export interface StartEvent {
  name: 'handoff.start';
  payload: {
    tool: Tool;
    refType: RefType;
    fleet: number;
    loop: boolean;
    sessionId: string;
  };
}

export interface CleanupEvent {
  name: 'handoff.cleanup';
  payload: {
    tool: Tool | 'unknown';
    outcome: CleanupOutcome;
    durationMs: number;
  };
}

export interface ErrorEvent {
  name: 'handoff.error';
  payload: {
    code: string;
    module: string;
    exitCode: number;
  };
}

export type Event = StartEvent | CleanupEvent | ErrorEvent;

export function newSessionId(): string {
  return randomUUID();
}

/**
 * Pure event constructors. Each accepts only the allowlisted fields; anything
 * else the caller might be holding (issue title, branch name, repo path, etc.)
 * has nowhere to land. The opt-in invariant lives in `emit`; the no-PII
 * invariant lives here.
 */
export function eventStart(input: {
  tool: Tool;
  refType: RefType;
  fleet: number;
  loop: boolean;
  sessionId: string;
}): StartEvent {
  return {
    name: 'handoff.start',
    payload: {
      tool: input.tool,
      refType: input.refType,
      fleet: input.fleet,
      loop: input.loop,
      sessionId: input.sessionId,
    },
  };
}

export function eventCleanup(input: {
  tool: Tool | 'unknown';
  outcome: CleanupOutcome;
  durationMs: number;
}): CleanupEvent {
  return {
    name: 'handoff.cleanup',
    payload: { tool: input.tool, outcome: input.outcome, durationMs: input.durationMs },
  };
}

export function eventError(input: { code: string; module: string; exitCode: number }): ErrorEvent {
  return {
    name: 'handoff.error',
    payload: { code: input.code, module: input.module, exitCode: input.exitCode },
  };
}

// ---------- I/O: config load/save ----------

export interface IoOptions {
  home?: string;
}

export function loadConfig(opts: IoOptions = {}): TelemetryConfig {
  const home = opts.home ?? homedir();
  const p = configPath(home);
  if (!existsSync(p)) return defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TelemetryConfigError(`failed to read ${p}: ${reason}`);
  }
  // Re-throw shape/version errors with the actual file path so the user
  // knows which file to fix. `parseConfig` is pure and intentionally
  // doesn't know `p`.
  try {
    return parseConfig(raw);
  } catch (err) {
    if (err instanceof TelemetryConfigError) {
      throw new TelemetryConfigError(
        `${err.message} (at ${p}). Upgrade handoff or delete the file.`,
      );
    }
    throw err;
  }
}

export function saveConfig(config: TelemetryConfig, opts: IoOptions = {}): void {
  const home = opts.home ?? homedir();
  const p = configPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, serializeConfig(config), 'utf8');
}

// ---------- I/O: emit ----------

export interface EmitOptions extends IoOptions {
  fetchImpl?: typeof fetch;
  /** Override env-var debug detection. Used by tests. */
  debug?: boolean;
  /** Override the configured timeout (test hook). */
  timeoutMs?: number;
  /** Used in the debug log line; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Attempts to deliver one event. Resolves when the send attempt has finished,
 * been aborted by the timeout, or been short-circuited by config. Never
 * rejects — transport errors are swallowed.
 *
 * Detachment from the CLI is the *caller's* job: `cli.ts` invokes this via
 * `emitFireAndForget`, which discards the returned promise so a slow endpoint
 * doesn't gate the user-visible work.
 *
 * - Always writes a debug log line if `HANDOFF_TELEMETRY_DEBUG=1` (or the
 *   `debug` opt is true), even if telemetry is disabled — so the user can
 *   audit exactly what *would* be sent before flipping the switch.
 * - Sends to the endpoint only when both `enabled` and `endpoint` are set.
 * - Drops silently on transport failure, non-2xx, or timeout.
 */
export async function emit(event: Event, opts: EmitOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const debug = opts.debug ?? process.env[DEBUG_ENV_VAR] === '1';
  const now = opts.now ?? (() => new Date().toISOString());

  if (debug) {
    try {
      appendDebugLog(event, now(), home);
    } catch {
      // Debug log is best-effort. Never let it bubble.
    }
  }

  let config: TelemetryConfig;
  try {
    config = loadConfig({ home });
  } catch {
    // A corrupt config should not block the user's actual command.
    return;
  }

  if (!config.telemetry.enabled || !config.telemetry.endpoint) return;

  const endpoint = config.telemetry.endpoint;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EMIT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    // Only stamp lastSentAt on a 2xx. fetch resolves on 4xx/5xx too; an
    // endpoint rejecting our event is a dropped delivery, same as a network
    // error from the user's perspective.
    if (res.ok) {
      try {
        const fresh = loadConfig({ home });
        fresh.telemetry.lastSentAt = now();
        saveConfig(fresh, { home });
      } catch {
        /* noop */
      }
    }
  } catch {
    // Drop silently — the contract says we never block or surface transport
    // errors. The debug log already captured the event for the user to see.
  } finally {
    clearTimeout(timer);
  }
}

function appendDebugLog(event: Event, ts: string, home: string): void {
  const p = debugLogPath(home);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ ts, ...event }) + '\n', 'utf8');
}

// ---------- subcommand helpers ----------

export interface StatusReport {
  enabled: boolean;
  endpoint: string | null;
  lastSentAt: string | null;
  configPath: string;
  debugLogPath: string;
  debugLogExists: boolean;
}

export function buildStatusReport(opts: IoOptions = {}): StatusReport {
  const home = opts.home ?? homedir();
  const config = loadConfig({ home });
  const dlp = debugLogPath(home);
  return {
    enabled: config.telemetry.enabled,
    endpoint: config.telemetry.endpoint,
    lastSentAt: config.telemetry.lastSentAt,
    configPath: configPath(home),
    debugLogPath: dlp,
    debugLogExists: existsSync(dlp),
  };
}

export function formatStatusReport(report: StatusReport): string {
  const lines = [
    `enabled:        ${report.enabled ? 'yes' : 'no'}`,
    `endpoint:       ${report.endpoint ?? '(none)'}`,
    `last sent:      ${report.lastSentAt ?? '(never)'}`,
    `config:         ${report.configPath}`,
    `debug log:      ${report.debugLogPath}${report.debugLogExists ? '' : ' (no entries yet)'}`,
    '',
    'events that would be sent (when enabled + endpoint set):',
    '  handoff.start   { tool, refType, fleet, loop, sessionId }',
    '  handoff.cleanup { tool, outcome, durationMs }',
    '  handoff.error   { code, module, exitCode }',
    '',
    'no PII: no issue titles, branch names, repo paths, or usernames are ever transmitted.',
  ];
  return lines.join('\n');
}

export function readDebugLog(opts: IoOptions = {}): string {
  const home = opts.home ?? homedir();
  const p = debugLogPath(home);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

export function setEnabled(
  enabled: boolean,
  patch: { endpoint?: string | null } = {},
  opts: IoOptions = {},
): TelemetryConfig {
  const home = opts.home ?? homedir();
  const config = loadConfig({ home });
  config.telemetry.enabled = enabled;
  if ('endpoint' in patch && patch.endpoint !== undefined) {
    const trimmed = patch.endpoint === null ? null : patch.endpoint.trim();
    config.telemetry.endpoint = trimmed && trimmed.length > 0 ? trimmed : null;
  }
  saveConfig(config, { home });
  return config;
}

export function markBannerSeen(opts: IoOptions = {}): void {
  const home = opts.home ?? homedir();
  const config = loadConfig({ home });
  if (config.firstRunBannerSeen) return;
  config.firstRunBannerSeen = true;
  saveConfig(config, { home });
}

export function bannerText(): string {
  return [
    '[handoff] telemetry is opt-in. Run `handoff telemetry enable --endpoint <url>` to share',
    '[handoff] anonymous usage stats with your own aggregator. See `handoff telemetry status`',
    '[handoff] for the exact event shapes. This message is shown once.',
  ].join('\n');
}
