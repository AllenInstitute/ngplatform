/** The platform's built-in contributions: the examples. */
import type { Workbench } from "../ui/workbench.js";
import { EXAMPLES } from "./examples.js";

export function registerBuiltins(wb: Workbench): void {
  for (const example of EXAMPLES) wb.examples.add({ ...example, owner: "core" });
}
