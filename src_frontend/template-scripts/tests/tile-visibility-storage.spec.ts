import { describe, expect, it, vi } from "vitest";
import { createTileVisibilityStorage } from "../src/map/common/tile-visibility-storage";

function storage(initial: string | null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
}

describe("tile visibility storage", () => {
  it("prunes missing IDs and invalid values, including the last removed tile", () => {
    const data = storage('{"a":false,"b":"false","deleted":true}');
    const state = createTileVisibilityStorage("user", () => data);
    expect(state.reconcile(["a", "b"])).toEqual({ a: false });
    expect(data.getItem()).toBe('{"a":false}');
    state.save("b", true);
    expect(state.reconcile(["a", "b"])).toEqual({ a: false, b: true });
    state.reconcile([]);
    expect(data.getItem()).toBeNull();
    state.save("deleted", true);
    expect(data.getItem()).toBeNull();
  });

  it.each(["invalid", "[]", "null", "false", '{"a":null}'])("cleans corrupt state: %s", (value) => {
    const data = storage(value);
    expect(createTileVisibilityStorage("user", () => data).reconcile(["a"])).toEqual({});
    expect(data.getItem()).toBeNull();
  });

  it("survives denied storage access and failed writes", () => {
    const denied = createTileVisibilityStorage("user", () => {
      throw new Error("denied");
    });
    expect(denied.reconcile(["a"])).toEqual({});
    expect(() => denied.save("a", false)).not.toThrow();
    const data = storage('{"a":false}');
    data.setItem = vi.fn(() => {
      throw new Error("quota");
    });
    const state = createTileVisibilityStorage("user", () => data);
    expect(state.reconcile(["a"])).toEqual({ a: false });
    expect(() => state.save("a", true)).not.toThrow();
  });
});
