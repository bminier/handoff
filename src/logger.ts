let _verbose = false;
let _debug = false;

export function setVerbose(on: boolean): void {
  _verbose = on;
}
export function setDebug(on: boolean): void {
  _debug = on;
}

/** Info-level trace — printed when --verbose or --debug is active. */
export function verbose(msg: string): void {
  if (_verbose || _debug) console.error(`[handoff:verbose] ${msg}`);
}

/** Debug-level trace — printed only when --debug is active. */
export function debug(msg: string): void {
  if (_debug) console.error(`[handoff:debug] ${msg}`);
}
