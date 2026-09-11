type Visibility = Record<string, boolean>;
type VisibilityStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createTileVisibilityStorage(
  accountId: string,
  getStorage: () => VisibilityStorage = () => window.localStorage,
) {
  const key = `geocode-web:tile-overlay-visibility:${accountId}`;
  let validIds = new Set<string>();
  const read = (): Visibility => {
    try {
      const value: unknown = JSON.parse(getStorage().getItem(key) || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          ([id, visible]) => validIds.has(id) && typeof visible === "boolean",
        ),
      );
    } catch {
      return {};
    }
  };
  const write = (value: Visibility): void => {
    try {
      if (Object.keys(value).length) getStorage().setItem(key, JSON.stringify(value));
      else getStorage().removeItem(key);
    } catch {
      // Storage may be disabled or full; the current map remains usable.
    }
  };
  return {
    reconcile(ids: string[]): Visibility {
      validIds = new Set(ids);
      const value = read();
      write(value);
      return value;
    },
    save(id: string, visible: boolean): void {
      if (!validIds.has(id)) return;
      write({ ...read(), [id]: visible });
    },
  };
}
