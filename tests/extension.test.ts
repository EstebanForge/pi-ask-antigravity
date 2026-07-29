import { describe, expect, it } from "vitest";
import factory from "../extensions/index.js";

describe("pi-ask-antigravity extension entry", () => {
  // This factory stays silent (registers nothing) when pi-antigravity-bridge
  // owns the AskAntigravity tool, which it detects by scanning install paths.
  // That detection is environment-dependent, so the publish gate asserts the
  // module loads, exports a callable factory, and invoking it never throws —
  // whether it registers or gracefully defers to the bridge.
  it("exposes a callable async factory that runs without throwing", async () => {
    expect(typeof factory).toBe("function");

    const tools: string[] = [];
    const commands: string[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void tools.push(def?.name),
        registerCommand: (name: string) => void commands.push(name),
        getFlag: () => undefined,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );

    await expect(factory(pi)).resolves.toBeUndefined();
  });
});
