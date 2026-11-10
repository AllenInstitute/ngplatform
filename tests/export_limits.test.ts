/**
 * Large exports and long share links: outside Chrome and Edge a level is
 * downloaded, built whole in memory, so only levels up to DOWNLOAD_BYTES
 * are offered and a larger download is refused with the browsers that save
 * straight to disk named; a workspace link longer than chat tools keep is
 * shared as a file instead.
 */
import { describe, expect, it } from "vitest";
import { DOWNLOAD_BYTES, levelLimit, linkTooLong, SHARE_LINK_LIMIT, tooLargeToDownload, workspaceFile } from "../src/ui/export.js";

describe("exports in browsers that can only download", () => {
  it("offer levels up to DOWNLOAD_BYTES, and up to 2 GB with Chrome's or Edge's save dialogs", () => {
    const picker = async () => ({}) as never;
    expect(levelLimit({ showSaveFilePicker: picker, showDirectoryPicker: picker })).toBe(2 ** 31);
    expect(levelLimit({})).toBe(DOWNLOAD_BYTES);
    expect(levelLimit({ showSaveFilePicker: picker })).toBe(DOWNLOAD_BYTES);
  });

  it("refuse a download larger than DOWNLOAD_BYTES, naming Chrome and Edge", () => {
    // Views of one buffer: sizes without the memory.
    const buffer = new ArrayBuffer(16);
    const sized = (bytes: number) => ({ byteLength: bytes }) as Uint8Array;
    expect(tooLargeToDownload([new Uint8Array(buffer)], "small.nii.gz")).toBeUndefined();
    expect(tooLargeToDownload([sized(DOWNLOAD_BYTES / 2), sized(DOWNLOAD_BYTES / 2)], "edge.zip")).toBeUndefined();
    const refused = tooLargeToDownload([sized(DOWNLOAD_BYTES), sized(2 ** 29)], "brain.ome.zarr.zip");
    expect(refused).toBe(
      "brain.ome.zarr.zip is 1.5 GB, more than this browser can download (1.0 GB): it builds a download whole in memory. Use Chrome or Edge to save it straight to disk, or export a coarser level or a box.",
    );
  });
});

describe("share links", () => {
  it("are too long above SHARE_LINK_LIMIT characters, and the workspace is then saved as a file", async () => {
    expect(linkTooLong(`https://app/#!${"x".repeat(SHARE_LINK_LIMIT - 14)}`)).toBe(false);
    expect(linkTooLong(`https://app/#!${"x".repeat(SHARE_LINK_LIMIT)}`)).toBe(true);
    const file = workspaceFile('{"ng":{}}', "Brain: left/right");
    expect(file.name).toBe("Brain_left_right.workspace.json");
    expect(file.blob.type).toBe("application/json");
    expect(await file.blob.text()).toBe('{"ng":{}}');
    expect(workspaceFile("{}", "  ").name).toBe("workspace.workspace.json");
  });
});
