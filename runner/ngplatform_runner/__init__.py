"""ngplatform's job runner: Python jobs on this computer that the web app starts and watches.

``python -m ngplatform_runner --root ~/data`` starts an HTTP server on
127.0.0.1 that runs zarr-vectors-tools work (convert, filter, density maps)
as subprocesses and serves files under the given roots to the viewer.
See runner/README.md.
"""

__version__ = "0.2.0"

#: The runner's API, as the app's build says it needs it (build.json "runnerApi", src/platform/runner.ts
#: RUNNER_API): raised when the app comes to rely on something new the runner does, so a local app
#: (ngplatform_local) does not switch to a deployed app that needs a newer runner than this one.
RUNNER_API = 1

#: The app's address, for pairing links.
DEFAULT_APP = "https://alleninstitute.github.io/ngplatform/"
