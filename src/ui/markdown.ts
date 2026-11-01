/**
 * A little Markdown, for plugin guides: ## headings, paragraphs, "- " lists,
 * ``` code blocks, `code`, **bold** and [links](https://…).  Builds DOM
 * nodes (never HTML strings), so a guide cannot inject markup.
 */
import { h } from "./dom.js";

function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(h("code", {}, m[1]));
    else if (m[2] !== undefined) out.push(h("strong", {}, m[2]));
    else out.push(h("a", { href: m[4], target: "_blank", rel: "noopener" }, m[3]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(source: string): HTMLElement {
  const root = h("div", { class: "md" });
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: HTMLElement | undefined;
  const flush = () => {
    if (paragraph.length) root.append(h("p", {}, ...inline(paragraph.join(" "))));
    paragraph = [];
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      root.append(h("pre", {}, h("code", {}, code.join("\n"))));
    } else if (/^#{1,4} /.test(line)) {
      flush();
      root.append(h("h4", {}, ...inline(line.replace(/^#+ /, ""))));
    } else if (/^\s*- /.test(line)) {
      if (paragraph.length) flush();
      if (list === undefined) root.append((list = h("ul", {})));
      list.append(h("li", {}, ...inline(line.replace(/^\s*- /, ""))));
    } else if (line.trim() === "") {
      flush();
    } else if (list !== undefined && /^\s+\S/.test(line)) {
      // A list item continued on the next line.
      list.lastElementChild?.append(" ", ...inline(line.trim()));
    } else {
      list = undefined;
      paragraph.push(line.trim());
    }
  }
  flush();
  return root;
}
