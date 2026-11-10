/**
 * Errors nothing else caught (an `error` event, an unhandled rejection),
 * reported in Activity with their stack, and as a toast.  They stay in this
 * browser: Settings › Developer saves the log as a file.  Listening starts
 * with the page; what comes before the shell is built waits for it.
 */
import { type Admission, describeError, errorKey, ErrorThrottle, isIgnoredError, isStaleChunkError } from "../core/errors.js";

export interface ReportedError {
  message: string;
  stack?: string;
  source: string;
}

export class ErrorReporting {
  private readonly throttle = new ErrorThrottle();
  private sink: ((error: ReportedError) => void) | undefined;
  private waiting: ReportedError[] = [];

  /**
   * `staleChunk` is asked first about an error that is a script the page
   * could not load; true when it is reloading the page for it.
   */
  constructor(
    target: Window,
    private readonly staleChunk: (error: unknown) => boolean,
  ) {
    target.addEventListener("error", (e) => {
      // Only errors thrown by scripts: a failed image or script load is no ErrorEvent.
      if (!(e instanceof ErrorEvent)) return;
      const where = e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : undefined;
      this.caught(e.error ?? e.message, "Uncaught", where);
    });
    target.addEventListener("unhandledrejection", (e) => this.caught(e.reason, "Unhandled"));
    // Vite's preloader, for a chunk a dynamic import needs: prevented, it does not throw.
    target.addEventListener("vite:preloadError", (e) => {
      if (this.staleChunk((e as Event & { payload?: unknown }).payload)) e.preventDefault();
    });
  }

  /** Reports an error caught elsewhere, as one that was not. */
  caught(reason: unknown, source: string, where?: string): void {
    if (isStaleChunkError(reason) && this.staleChunk(reason)) return;
    const { message, stack } = describeError(reason);
    if (isIgnoredError(reason, message)) return;
    const admission = this.throttle.admit(errorKey(message, stack ?? where), Date.now());
    if (!admission.report) return;
    for (const error of reported(admission, { message, stack: stack ?? where, source })) this.deliver(error);
  }

  /** From now on errors go to `sink`; those that came before go first. */
  attach(sink: (error: ReportedError) => void): void {
    this.sink = sink;
    for (const error of this.waiting.splice(0)) sink(error);
  }

  private deliver(error: ReportedError): void {
    if (this.sink === undefined) {
      if (this.waiting.length < 50) this.waiting.push(error);
    } else this.sink(error);
  }
}

/** An admitted error as it is reported: with how often it repeated, after a line for those not reported. */
export function reported(admission: Admission, error: ReportedError): ReportedError[] {
  const lines: ReportedError[] = [];
  if (admission.dropped > 0) lines.push({ message: `${admission.dropped} more error${admission.dropped === 1 ? " was" : "s were"} not logged.`, source: error.source });
  lines.push(admission.repeats > 0 ? { ...error, message: `${error.message} (${admission.repeats} more time${admission.repeats === 1 ? "" : "s"} since)` } : error);
  return lines;
}
