import { expect, it, vi } from "vitest";
import {
  notifyAiSuggestionDataChanged,
  observeAiSuggestionDataChanges,
} from "../src/ai/suggestion-events";

it("notifies only the current account and detaches when its map is disposed", () => {
  let account = "first";
  const invalidate = vi.fn();
  const stop = observeAiSuggestionDataChanges(() => account, invalidate);
  notifyAiSuggestionDataChanged("first");
  expect(invalidate).toHaveBeenCalledTimes(1);
  account = "second";
  notifyAiSuggestionDataChanged("first");
  notifyAiSuggestionDataChanged("");
  window.dispatchEvent(new Event("geocode-ai-suggestions-changed"));
  window.dispatchEvent(
    new CustomEvent("geocode-ai-suggestions-changed", { detail: { accountId: 42 } }),
  );
  expect(invalidate).toHaveBeenCalledTimes(1);
  notifyAiSuggestionDataChanged("second");
  expect(invalidate).toHaveBeenCalledTimes(2);
  stop();
  notifyAiSuggestionDataChanged("second");
  expect(invalidate).toHaveBeenCalledTimes(2);
});
