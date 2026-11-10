// @vitest-environment dom
/**
 * Settings › View, Loading: the download limits and the movement-aware
 * downloads option are bound both ways to the viewer's chunk queue (the
 * Neuroglancer fork's `download.sizeLimit` and `enableMovementAwareDownloads`).
 */
import { describe, expect, it, vi } from "vitest";

// The chunk statistics' parts of Neuroglancer pull in WebGL; the settings
// do not use them.
vi.mock("../src/engine/neuroglancer.js", async () => ({
  RefCounted: (await import("neuroglancer/unstable/util/disposable.js")).RefCounted,
  WatchableVisibilityPriority: (await import("neuroglancer/unstable/visibility_priority/frontend.js")).WatchableVisibilityPriority,
  columnSpecifications: [],
  getChunkSourceIdentifier: () => "",
  getFormattedNames: () => [],
}));

import { mountViewSettings } from "../src/engine/view_settings.js";
import type { Viewer } from "../src/engine/neuroglancer.js";

/** A watchable value: what the settings read, write and listen to. */
function watch<T>(value: T) {
  const listeners = new Set<() => void>();
  return {
    get value() {
      return value;
    },
    set value(v: T) {
      value = v;
      listeners.forEach((l) => l());
    },
    changed: { add: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) },
  };
}

function fakeViewer() {
  const queue = {
    capacities: {
      gpuMemory: { sizeLimit: watch(1e9) },
      systemMemory: { sizeLimit: watch(2e9) },
      download: { itemLimit: watch(100), sizeLimit: watch(64 * 1024 * 1024) },
    },
    enablePrefetch: watch(true),
    enableMovementAwareDownloads: watch(true),
  };
  const viewer = {
    title: watch<string | undefined>(undefined),
    showAxisLines: watch(true),
    showScaleBar: watch(true),
    showPerspectiveSliceViews: watch(true),
    hideCrossSectionBackground3D: watch(false),
    showDefaultAnnotations: watch(true),
    wireFrame: watch(false),
    crossSectionBackgroundColor: watch([0.5, 0.5, 0.5]),
    perspectiveViewBackgroundColor: watch([0, 0, 0]),
    enableAdaptiveDownsampling: watch(true),
    chunkQueueManager: queue,
  };
  return { viewer: viewer as unknown as Viewer, queue };
}

const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!.querySelector("input")!;

describe("Settings › View, Loading", () => {
  it("shows and sets the bytes downloading at once", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const { viewer, queue } = fakeViewer();
    const dispose = mountViewSettings(host, viewer);
    const input = field(host, "Data downloading at once");
    expect(input.value).toBe("64 MB");
    input.value = "128 MB";
    input.dispatchEvent(new Event("change"));
    expect(queue.capacities.download.sizeLimit.value).toBe(128 * 1024 * 1024);
    dispose();
    host.remove();
  });

  it("turns movement-aware downloads off and on, and follows the viewer", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const { viewer, queue } = fakeViewer();
    const dispose = mountViewSettings(host, viewer);
    const box = field(host, "Download a coarser level while moving");
    expect(box.checked).toBe(true);
    box.click();
    expect(queue.enableMovementAwareDownloads.value).toBe(false);
    queue.enableMovementAwareDownloads.value = true;
    expect(box.checked).toBe(true);
    dispose();
    host.remove();
  });
});
