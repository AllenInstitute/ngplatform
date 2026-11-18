"""The app's window: Chrome, Chromium or Edge in app mode (a window of its own, no tabs or address bar),
with a profile of its own (``~/.ngplatform/browser``) so the app's settings stay between runs and nothing
mixes with the user's own browsing; else the default browser, in a tab.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

#: Executables to look for on the PATH, in order.
NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"]
#: Where they are installed when not on the PATH.
PLACES = {
    "darwin": [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    "win32": [
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
        r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    ],
}


def find_browser(explicit: str | None = None) -> str | None:
    """A Chromium-based browser's executable: `explicit` (a path or a name on the PATH), else the first found."""
    if explicit:
        return shutil.which(explicit) or (explicit if Path(explicit).is_file() else None)
    for name in NAMES:
        found = shutil.which(name)
        if found:
            return found
    for place in PLACES.get(sys.platform, []):
        path = os.path.expandvars(place)
        if Path(path).is_file():
            return path
    return None


def app_window_args(browser: str, url: str, profile: Path) -> list[str]:
    """The command that opens `url` as an app window with its own `profile`."""
    return [
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,900",
    ]


def open_window(url: str, profile: Path, browser: str | None) -> subprocess.Popen | None:
    """Opens the app: an app window when a Chromium-based browser is found (its process returned), else a tab in
    the default browser (None)."""
    if browser:
        profile.mkdir(parents=True, exist_ok=True)
        return subprocess.Popen(app_window_args(browser, url, profile), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    webbrowser.open(url)
    return None
