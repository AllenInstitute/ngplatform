// The theme chosen in Settings › View (dark, light or as the system is),
// set on the page before it is first drawn so it never shows the other one
// first.  A file, not inline: the Content Security Policy runs no inline
// script.  src/ui/theme.ts keeps it from then on.
/* global localStorage, matchMedia */
(function () {
  var choice = "dark";
  try {
    choice = localStorage.getItem("ngplatform.theme") || "dark";
  } catch (e) {
    // Storage blocked: dark.
  }
  var light = choice === "light" || (choice === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches);
  var theme = light ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  var meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", theme);
})();
