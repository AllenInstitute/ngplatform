/**
 * Errors kept in this browser (no remote reporter): which ones are
 * reported, how often, and the log as a file.  Also the stale chunk after a
 * redeploy, when a page loaded before it asks for a file the new build
 * replaced, and the one reload that fixes it.
 */

// ------------------------------------------------------------ stale chunks

/**
 * Whether an error is a script the page asked for and could not load: a
 * file of an older build, gone after a redeploy.  Chrome, Firefox and
 * Safari word it differently; Vite's preloader says "Unable to preload".
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i.test(message);
}

/** Where the reload remembers the build it was made for. */
export const STALE_RELOAD_KEY = "ngplatform.staleReload";

/**
 * Reloads the page once for a stale chunk, and says whether it did.  The
 * build that asked (its main script's address, which changes with every
 * build) is kept in the tab's storage: a page of the same build that fails
 * again does not reload again, so a file that is missing for good cannot
 * loop.  Without storage it never reloads.
 */
export function reloadOnceForStaleChunk(storage: Pick<Storage, "getItem" | "setItem"> | undefined, build: string, reload: () => void): boolean {
  try {
    if (storage === undefined || storage.getItem(STALE_RELOAD_KEY) === build) return false;
    storage.setItem(STALE_RELOAD_KEY, build);
  } catch {
    return false;
  }
  reload();
  return true;
}

// -------------------------------------------------------------- throttling

/** What `ErrorThrottle.admit` decided. */
export interface Admission {
  report: boolean;
  /** Times this error came again, unreported, since it was last reported. */
  repeats: number;
  /** Other errors left unreported since the last report, past the rate limit. */
  dropped: number;
}

/**
 * Keeps one error that repeats (a draw loop that throws every frame) from
 * flooding the log: the same error is reported at most once per `repeatMs`,
 * with how often it came in between; and at most `max` errors are reported
 * per `windowMs`, the rest counted.
 */
export class ErrorThrottle {
  private readonly last = new Map<string, { at: number; repeats: number }>();
  private recent: number[] = [];
  private dropped = 0;

  constructor(private readonly options: { repeatMs?: number; max?: number; windowMs?: number } = {}) {}

  admit(key: string, now: number): Admission {
    const repeatMs = this.options.repeatMs ?? 30_000;
    const max = this.options.max ?? 5;
    const windowMs = this.options.windowMs ?? 10_000;
    const seen = this.last.get(key);
    if (seen !== undefined && now - seen.at < repeatMs) {
      seen.repeats++;
      return { report: false, repeats: seen.repeats, dropped: this.dropped };
    }
    this.recent = this.recent.filter((t) => now - t < windowMs);
    if (this.recent.length >= max) {
      this.dropped++;
      return { report: false, repeats: 0, dropped: this.dropped };
    }
    this.recent.push(now);
    const admission = { report: true, repeats: seen?.repeats ?? 0, dropped: this.dropped };
    this.dropped = 0;
    // Kept small: the oldest error forgotten first.
    this.last.delete(key);
    this.last.set(key, { at: now, repeats: 0 });
    if (this.last.size > 200) this.last.delete(this.last.keys().next().value!);
    return admission;
  }
}

/** The same error, wherever it is thrown from twice: its message and where it was thrown. */
export function errorKey(message: string, stack?: string): string {
  const frame = stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") || line.includes("@"));
  return `${message}\n${frame ?? ""}`;
}

/** What an error event or a rejection carries, as a message and a stack. */
export function describeError(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    const message = reason.message || reason.name || "Error";
    return { message: reason.name && reason.name !== "Error" && !message.startsWith(reason.name) ? `${reason.name}: ${message}` : message, stack: reason.stack };
  }
  if (typeof reason === "string") return { message: reason };
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}

/**
 * Errors that are not faults: a request cancelled on purpose, and the
 * browser's note that a resize observer had more to do in one frame.
 */
export function isIgnoredError(reason: unknown, message: string): boolean {
  if (reason instanceof Error && reason.name === "AbortError") return true;
  return /^ResizeObserver loop/.test(message);
}

// --------------------------------------------------------------- the log

export type LogLevel = "info" | "ok" | "error";

/** One line of the Activity log, as kept for saving. */
export interface LogEntry {
  time: Date;
  level: LogLevel;
  source?: string;
  message: string;
  stack?: string;
}

/** The log as text, oldest first: time, level, source and message on a line, the stack indented below. */
export function logText(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const head = [e.time.toISOString(), e.level.padEnd(5), e.source ?? "-", e.message].join("  ");
      const stack = e.stack?.trim();
      return stack ? `${head}\n${stack.split("\n").map((line) => `    ${line.trim()}`).join("\n")}` : head;
    })
    .join("\n")
    .concat(entries.length ? "\n" : "");
}

/** A file name for the log saved at `time`: ngplatform-log-20261109-2015.txt. */
export function logFileName(time: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `ngplatform-log-${time.getFullYear()}${two(time.getMonth() + 1)}${two(time.getDate())}-${two(time.getHours())}${two(time.getMinutes())}.txt`;
}
