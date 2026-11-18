/**
 * The runner API this app needs: raised (with the runner's RUNNER_API in
 * runner/ngplatform_runner/__init__.py, which tests/runner_api.test.ts
 * keeps equal) when the app comes to rely on something new the runner does.
 * The build writes it into build.json, so a local app (runner/ngplatform_local)
 * does not switch to a deployed app that its runner is too old for.
 */
export const RUNNER_API = 1;
