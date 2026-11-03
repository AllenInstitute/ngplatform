"""ngplatform's job runner: Python jobs on this computer that the web app starts and watches.

``python -m ngplatform_runner --root ~/data`` starts an HTTP server on
127.0.0.1 that runs zarr-vectors-tools work (convert, filter, density maps)
as subprocesses and serves files under the given roots to the viewer.
See runner/README.md.
"""

__version__ = "0.1.0"
