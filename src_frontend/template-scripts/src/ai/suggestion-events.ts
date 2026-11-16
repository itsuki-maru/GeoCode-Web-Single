const EVENT = "geocode-ai-suggestions-changed";

/** 更新開始時のアカウントだけを通知する。フォーム値や候補文は送らない。 */
export function notifyAiSuggestionDataChanged(accountId: string): void {
  if (!accountId) return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { accountId } }));
}

/** 同じ画面の更新通知を受ける。他タブや外部更新には候補のTTLを使用する。 */
export function observeAiSuggestionDataChanges(
  getAccountId: () => string,
  onChanged: () => void,
): () => void {
  const changed = (event: Event) => {
    const detail = (event as CustomEvent<{ accountId?: unknown }>).detail;
    const currentAccount = getAccountId();
    if (
      currentAccount &&
      detail &&
      typeof detail.accountId === "string" &&
      detail.accountId === currentAccount
    )
      onChanged();
  };
  window.addEventListener(EVENT, changed);
  return () => window.removeEventListener(EVENT, changed);
}
