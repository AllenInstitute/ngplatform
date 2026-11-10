// The DOM test environment for the UI modules (shell, docks, sheets,
// panels): jsdom, set up as Vitest's own "jsdom" environment does, with
// the few browser parts jsdom lacks that the shell uses.  A test file opts
// in with a first line of
//
//   // @vitest-environment dom
//
// (the name vitest.config.ts gives this file), so every other test keeps
// running in Node.  It is used rather than Vitest's built-in "jsdom"
// because that one imports jsdom from Vitest's own folder, which a linked
// node_modules (as in a worktree) need not have; this file imports it from
// the project's.
import { JSDOM } from "jsdom";
import { populateGlobal } from "vitest/environments";

export default {
  name: "ngplatform-dom",
  transformMode: "web",
  async setup(global) {
    const dom = new JSDOM("<!DOCTYPE html>", { url: "http://localhost:3000/", pretendToBeVisual: true });
    const { keys, originals } = populateGlobal(global, dom.window, { bindFunctions: true });
    // What jsdom does not do: media queries (always the wide layout),
    // scrolling into view and the pointer capture of a drag.
    global.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    });
    dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    dom.window.Element.prototype.setPointerCapture = function () {};
    return {
      teardown(global) {
        dom.window.close();
        delete global.matchMedia;
        keys.forEach((key) => delete global[key]);
        originals.forEach((v, k) => (global[k] = v));
      },
    };
  },
};
