import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_VERSION,
  TelemetryConfigError,
  bannerText,
  buildStatusReport,
  configPath,
  debugLogPath,
  defaultConfig,
  emit,
  eventCleanup,
  eventError,
  eventStart,
  formatStatusReport,
  homeRoot,
  loadConfig,
  markBannerSeen,
  newSessionId,
  parseConfig,
  readDebugLog,
  saveConfig,
  serializeConfig,
  setEnabled,
  type Event,
} from '../src/telemetry.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'handoff-telemetry-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('paths', () => {
  it('places config and debug log under <home>/.handoff/', () => {
    expect(homeRoot(home)).toBe(join(home, '.handoff'));
    expect(configPath(home)).toBe(join(home, '.handoff', 'config.json'));
    expect(debugLogPath(home)).toBe(join(home, '.handoff', 'telemetry-debug.log'));
  });
});

describe('default config — opt-in invariant', () => {
  it('returns telemetry disabled by default', () => {
    const c = defaultConfig();
    expect(c.telemetry.enabled).toBe(false);
    expect(c.telemetry.endpoint).toBeNull();
    expect(c.firstRunBannerSeen).toBe(false);
  });

  it('loadConfig returns defaults when no file exists', () => {
    expect(loadConfig({ home })).toEqual(defaultConfig());
  });
});

describe('parseConfig schema-version guard', () => {
  it('round-trips through serialize/parse', () => {
    const c = defaultConfig();
    expect(parseConfig(JSON.parse(serializeConfig(c)))).toEqual(c);
  });

  it('throws on unsupported version', () => {
    expect(() => parseConfig({ version: 999, telemetry: {}, firstRunBannerSeen: false })).toThrow(
      TelemetryConfigError,
    );
  });

  it('throws when not an object', () => {
    expect(() => parseConfig('not an object')).toThrow(TelemetryConfigError);
  });

  it('coerces partial telemetry block to safe defaults', () => {
    const out = parseConfig({ version: CONFIG_VERSION, telemetry: {}, firstRunBannerSeen: true });
    expect(out.telemetry.enabled).toBe(false);
    expect(out.telemetry.endpoint).toBeNull();
    expect(out.firstRunBannerSeen).toBe(true);
  });

  it('coerces whitespace-only endpoint to null and trims surrounding whitespace', () => {
    const blank = parseConfig({
      version: CONFIG_VERSION,
      telemetry: { enabled: true, endpoint: '   ' },
      firstRunBannerSeen: false,
    });
    expect(blank.telemetry.endpoint).toBeNull();

    const padded = parseConfig({
      version: CONFIG_VERSION,
      telemetry: { enabled: true, endpoint: '  https://x.test/t  ' },
      firstRunBannerSeen: false,
    });
    expect(padded.telemetry.endpoint).toBe('https://x.test/t');
  });

  it('treats truthy non-boolean enabled as disabled', () => {
    const out = parseConfig({
      version: CONFIG_VERSION,
      telemetry: { enabled: 'yes' },
      firstRunBannerSeen: false,
    });
    expect(out.telemetry.enabled).toBe(false);
  });
});

describe('saveConfig / loadConfig', () => {
  it('round-trips a config through disk', () => {
    const c = defaultConfig();
    c.telemetry.enabled = true;
    c.telemetry.endpoint = 'https://example.test/telemetry';
    saveConfig(c, { home });

    const onDisk = JSON.parse(readFileSync(configPath(home), 'utf8'));
    expect(onDisk).toEqual(c);
    expect(loadConfig({ home })).toEqual(c);
  });

  it('creates ~/.handoff/ if it does not exist', () => {
    expect(existsSync(homeRoot(home))).toBe(false);
    saveConfig(defaultConfig(), { home });
    expect(existsSync(homeRoot(home))).toBe(true);
  });

  it('wraps JSON parse errors in TelemetryConfigError', () => {
    mkdirSync(homeRoot(home), { recursive: true });
    writeFileSync(configPath(home), '{not valid json', 'utf8');
    expect(() => loadConfig({ home })).toThrow(TelemetryConfigError);
  });

  it('augments parseConfig errors with the actual home-scoped file path', () => {
    // Regression: parseConfig is pure and doesn't know the file path; it
    // used to call configPath() with no args, which meant tests (and any
    // future caller with a non-default home) saw the wrong path in the
    // error. loadConfig should append the path it actually read from.
    mkdirSync(homeRoot(home), { recursive: true });
    writeFileSync(
      configPath(home),
      JSON.stringify({ version: 999, telemetry: {}, firstRunBannerSeen: false }),
      'utf8',
    );
    try {
      loadConfig({ home });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TelemetryConfigError);
      expect((err as Error).message).toContain(configPath(home));
      expect((err as Error).message).toContain('unsupported config version 999');
    }
  });
});

describe('event constructors — no-PII shape', () => {
  // The contract is "no issue titles, no branch names, no repo paths, no
  // usernames." The constructors take typed input so a misuse caller can't
  // pass those fields by accident, but verify the *shape* of the output to
  // catch any future drift.
  const ALLOWED_KEYS: Record<Event['name'], string[]> = {
    'handoff.start': ['tool', 'refType', 'fleet', 'loop', 'sessionId'],
    'handoff.cleanup': ['tool', 'outcome', 'durationMs'],
    'handoff.error': ['code', 'module', 'exitCode'],
  };

  it('handoff.start emits exactly the allowlisted keys', () => {
    const ev = eventStart({
      tool: 'claude',
      refType: 'issue',
      fleet: 3,
      loop: true,
      sessionId: 'abc',
    });
    expect(ev.name).toBe('handoff.start');
    expect(Object.keys(ev.payload).sort()).toEqual([...ALLOWED_KEYS['handoff.start']].sort());
  });

  it('handoff.start accepts the pr refType (#60) without reshaping the payload', () => {
    const ev = eventStart({
      tool: 'claude',
      refType: 'pr',
      fleet: 1,
      loop: false,
      sessionId: 'abc',
    });
    expect(ev.payload.refType).toBe('pr');
    expect(Object.keys(ev.payload).sort()).toEqual([...ALLOWED_KEYS['handoff.start']].sort());
  });

  it('handoff.cleanup emits exactly the allowlisted keys', () => {
    const ev = eventCleanup({ tool: 'codex', outcome: 'merged', durationMs: 12345 });
    expect(ev.name).toBe('handoff.cleanup');
    expect(Object.keys(ev.payload).sort()).toEqual([...ALLOWED_KEYS['handoff.cleanup']].sort());
  });

  it('handoff.error emits exactly the allowlisted keys', () => {
    const ev = eventError({ code: 'GhError', module: 'cleanup', exitCode: 1 });
    expect(ev.name).toBe('handoff.error');
    expect(Object.keys(ev.payload).sort()).toEqual([...ALLOWED_KEYS['handoff.error']].sort());
  });

  it('cleanup tool may be "unknown" when state.json was missing', () => {
    const ev = eventCleanup({ tool: 'unknown', outcome: 'failed', durationMs: 0 });
    expect(ev.payload.tool).toBe('unknown');
  });

  it('cleanup outcome accepts "forced" — distinct from "merged" for --force runs', () => {
    // Issue #54: --force-removed cleanups must be distinguishable from
    // merged-PR cleanups so analytics can track how often the safety
    // check is bypassed. A regression that drops 'forced' from the
    // CleanupOutcome union (or remaps it to 'merged') would silently
    // re-conflate the two — pin the type-level acceptance here.
    const ev = eventCleanup({ tool: 'claude', outcome: 'forced', durationMs: 100 });
    expect(ev.payload.outcome).toBe('forced');
    expect(Object.keys(ev.payload).sort()).toEqual([...ALLOWED_KEYS['handoff.cleanup']].sort());
  });

  it('newSessionId returns a UUID, not a user-derived value', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(newSessionId()).not.toBe(id);
  });
});

describe('emit — opt-in default-off invariant', () => {
  it('does not call fetch when no config exists (default off)', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;

    await emit(
      eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'x' }),
      {
        home,
        fetchImpl,
      },
    );
    expect(called).toBe(false);
  });

  it('does not call fetch when enabled but endpoint is null', async () => {
    saveConfig(
      { ...defaultConfig(), telemetry: { enabled: true, endpoint: null, lastSentAt: null } },
      { home },
    );
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response();
    }) as unknown as typeof fetch;

    await emit(
      eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'x' }),
      {
        home,
        fetchImpl,
      },
    );
    expect(called).toBe(false);
  });

  it('calls fetch with the event JSON when both enabled and endpoint set', async () => {
    saveConfig(
      {
        ...defaultConfig(),
        telemetry: { enabled: true, endpoint: 'https://example.test/t', lastSentAt: null },
      },
      { home },
    );

    let seenUrl: string | URL | Request | undefined;
    let seenBody: string | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = url;
      seenBody = init?.body as string | undefined;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const ev = eventStart({
      tool: 'claude',
      refType: 'freeform',
      fleet: 2,
      loop: false,
      sessionId: 'sid-1',
    });
    await emit(ev, { home, fetchImpl });
    expect(seenUrl).toBe('https://example.test/t');
    expect(JSON.parse(seenBody ?? '{}')).toEqual(ev);
  });

  it('drops silently when fetch rejects', async () => {
    saveConfig(
      {
        ...defaultConfig(),
        telemetry: { enabled: true, endpoint: 'https://example.test/t', lastSentAt: null },
      },
      { home },
    );
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    await expect(
      emit(
        eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'x' }),
        {
          home,
          fetchImpl,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('drops silently when fetch hangs past the timeout', async () => {
    saveConfig(
      {
        ...defaultConfig(),
        telemetry: { enabled: true, endpoint: 'https://example.test/t', lastSentAt: null },
      },
      { home },
    );
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Wire up the abort signal so the timeout actually fails the fetch.
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    await expect(
      emit(
        eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'x' }),
        { home, fetchImpl, timeoutMs: 5 },
      ),
    ).resolves.toBeUndefined();
  });

  it('updates lastSentAt on success', async () => {
    saveConfig(
      {
        ...defaultConfig(),
        telemetry: { enabled: true, endpoint: 'https://example.test/t', lastSentAt: null },
      },
      { home },
    );
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await emit(
      eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'x' }),
      { home, fetchImpl, now: () => '2026-04-28T15:00:00.000Z' },
    );
    const fresh = loadConfig({ home });
    expect(fresh.telemetry.lastSentAt).toBe('2026-04-28T15:00:00.000Z');
  });

  it('does NOT update lastSentAt when the endpoint returns 4xx/5xx', async () => {
    // fetch resolves on 500s — only `res.ok` distinguishes a real send from
    // a server reject. Stamping lastSentAt on a 500 would lie to the user.
    saveConfig(
      {
        ...defaultConfig(),
        telemetry: { enabled: true, endpoint: 'https://example.test/t', lastSentAt: null },
      },
      { home },
    );
    const fetchImpl = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await emit(
      eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'x' }),
      { home, fetchImpl, now: () => '2026-04-28T15:00:00.000Z' },
    );
    expect(loadConfig({ home }).telemetry.lastSentAt).toBeNull();
  });
});

describe('emit — debug log', () => {
  it('writes a debug line when debug=true even with telemetry disabled', async () => {
    const ev = eventStart({
      tool: 'claude',
      refType: 'issue',
      fleet: 1,
      loop: false,
      sessionId: 'sid',
    });
    await emit(ev, { home, debug: true, now: () => '2026-04-28T15:00:00.000Z' });

    const log = readDebugLog({ home });
    expect(log.trim().split('\n')).toHaveLength(1);
    const line = JSON.parse(log.trim());
    expect(line).toEqual({ ts: '2026-04-28T15:00:00.000Z', ...ev });
  });

  it('does not write a debug line when debug=false', async () => {
    await emit(
      eventStart({ tool: 'claude', refType: 'issue', fleet: 1, loop: false, sessionId: 'sid' }),
      { home, debug: false },
    );
    expect(readDebugLog({ home })).toBe('');
  });

  it('appends multiple lines without truncating prior entries', async () => {
    const ev1 = eventStart({
      tool: 'claude',
      refType: 'issue',
      fleet: 1,
      loop: false,
      sessionId: 'a',
    });
    const ev2 = eventCleanup({ tool: 'claude', outcome: 'merged', durationMs: 42 });
    await emit(ev1, { home, debug: true, now: () => '2026-04-28T15:00:00.000Z' });
    await emit(ev2, { home, debug: true, now: () => '2026-04-28T15:00:01.000Z' });
    const lines = readDebugLog({ home }).trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

describe('setEnabled / markBannerSeen', () => {
  it('flips telemetry on with an endpoint', () => {
    const c = setEnabled(true, { endpoint: 'https://example.test/x' }, { home });
    expect(c.telemetry.enabled).toBe(true);
    expect(c.telemetry.endpoint).toBe('https://example.test/x');
    expect(loadConfig({ home }).telemetry.enabled).toBe(true);
  });

  it('flips telemetry off without touching the endpoint', () => {
    setEnabled(true, { endpoint: 'https://example.test/x' }, { home });
    const c = setEnabled(false, {}, { home });
    expect(c.telemetry.enabled).toBe(false);
    expect(c.telemetry.endpoint).toBe('https://example.test/x');
  });

  it('trims whitespace from the endpoint and rejects whitespace-only input', () => {
    const padded = setEnabled(true, { endpoint: '  https://x.test/t  ' }, { home });
    expect(padded.telemetry.endpoint).toBe('https://x.test/t');

    const blank = setEnabled(true, { endpoint: '   ' }, { home });
    expect(blank.telemetry.endpoint).toBeNull();
  });

  it('markBannerSeen persists the flag', () => {
    expect(loadConfig({ home }).firstRunBannerSeen).toBe(false);
    markBannerSeen({ home });
    expect(loadConfig({ home }).firstRunBannerSeen).toBe(true);
    // idempotent
    markBannerSeen({ home });
    expect(loadConfig({ home }).firstRunBannerSeen).toBe(true);
  });
});

describe('status report', () => {
  it('includes the event shapes so the user can audit', () => {
    const text = formatStatusReport(buildStatusReport({ home }));
    expect(text).toContain('handoff.start');
    expect(text).toContain('handoff.cleanup');
    expect(text).toContain('handoff.error');
    expect(text).toContain('no PII');
  });

  it('reports enabled=false when no config exists', () => {
    const r = buildStatusReport({ home });
    expect(r.enabled).toBe(false);
    expect(r.endpoint).toBeNull();
  });
});

describe('banner text', () => {
  it('mentions the enable command and the status command', () => {
    const text = bannerText();
    expect(text).toContain('handoff telemetry enable');
    expect(text).toContain('handoff telemetry status');
  });
});
