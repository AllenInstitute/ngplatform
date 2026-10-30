import { describe, expect, it } from "vitest";
import { type Command, CommandRegistry, matchCommands } from "../src/core/commands.js";

const command = (id: string, title: string, group = "View"): Command => ({ id, title, group, run: () => {} });

describe("CommandRegistry", () => {
  it("runs available commands and skips unavailable ones", async () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    registry.register({ ...command("a", "A"), run: () => void ran.push("a") });
    registry.register({ ...command("b", "B"), isAvailable: () => false, run: () => void ran.push("b") });
    await registry.invoke("a");
    await registry.invoke("b");
    expect(ran).toEqual(["a"]);
    expect(() => registry.register(command("a", "again"))).toThrow(/already registered/);
  });

  it("ranks palette matches by where the words appear", () => {
    const list = [command("1", "Layout: 3D"), command("2", "Open example: 3D brain", "Examples"), command("3", "Undo", "Edit")];
    expect(matchCommands(list, "3d").map((c) => c.id)).toEqual(["1", "2"]);
    expect(matchCommands(list, "layout 3d").map((c) => c.id)).toEqual(["1"]);
    expect(matchCommands(list, "undo").map((c) => c.id)).toEqual(["3"]);
    expect(matchCommands(list, "").length).toBe(3);
  });
});
