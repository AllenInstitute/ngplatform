/**
 * Deadlines for requests to other computers: a runner, a host through an
 * SSH tunnel, a state file on the web.  A tunnel that is half open (the
 * computer at its far end gone) never answers and never fails, so every
 * such request gives up after a while, with an error that names the
 * computer.
 */

/** How long a runner's API request may take (ms). */
export const RUNNER_TIMEOUT = 20_000;
/** How long a host's service may take to start answering a request (ms); the answer itself may then take as long as it needs. */
export const SERVICE_TIMEOUT = 30_000;
/** How long reading a state from a URL may take (ms). */
export const REMOTE_STATE_TIMEOUT = 20_000;

/** A signal that aborts when the first of `signals` does, with its reason. */
export function eitherSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const given = signals.filter((s): s is AbortSignal => s !== undefined);
  if (given.length === 1) return given[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(given);
  // Browsers before AbortSignal.any (Safari 17.3 and older).
  const controller = new AbortController();
  for (const s of given) {
    if (s.aborted) controller.abort(s.reason);
    else s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** A signal that aborts after `ms`, or when `signal` (the caller's) does. */
export function withDeadline(ms: number, signal?: AbortSignal): AbortSignal {
  return eitherSignal(signal, AbortSignal.timeout(ms));
}

/** Whether a request failed because its deadline passed (not because the caller stopped it). */
export const timedOut = (e: unknown): boolean => (e as Error | undefined)?.name === "TimeoutError";

/** "12 s" for 12 000 ms. */
export const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** The computer a URL is on, as people name it: its host (and port). */
export function computerOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The JSON of a state at `url`, read within `ms`: an error naming the
 * computer when it does not answer in time, cannot be reached, or answers
 * with an error.
 */
export async function fetchRemoteState(url: string, ms = REMOTE_STATE_TIMEOUT, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<unknown> {
  const where = computerOf(url);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: withDeadline(ms) });
    if (!response.ok) throw new Error(`${where} answered ${response.status} ${response.statusText}`.trim() + ".");
    return await response.json();
  } catch (e) {
    if (timedOut(e)) throw new Error(`${where} did not answer in ${seconds(ms)}.`);
    if (e instanceof TypeError) throw new Error(`${where} could not be reached: ${e.message}.`);
    throw e;
  }
}
