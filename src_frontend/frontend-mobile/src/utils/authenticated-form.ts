import apiClient from "@/axiosClient";

/** HTML 標準の画面遷移とストリーミングダウンロードを維持し、拒否された POST を一度だけ再試行する。 */
export function submitAuthenticatedForm(
  form: HTMLFormElement,
  frame: HTMLIFrameElement,
  onError: (message: string) => void,
): () => void {
  const action = new URL(form.action, window.location.href);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  action.searchParams.set("native_request_id", requestId);
  action.searchParams.set("native_parent_origin", window.location.origin);
  form.action = action.href;
  const controller = new AbortController();
  let active = true,
    recovering = false,
    retried = false;
  const dispose = () => {
    active = false;
    clearTimeout(timer);
    controller.abort();
    window.removeEventListener("message", onMessage);
  };
  const fail = () => {
    if (!active) return;
    dispose();
    onError("認証を更新して再送信できませんでした。ログイン状態を確認して再試行してください。");
  };
  const onMessage = async (event: MessageEvent) => {
    if (
      !active ||
      !frame.contentWindow ||
      event.source !== frame.contentWindow ||
      event.origin !== action.origin ||
      event.data?.type !== "native-form-auth-error" ||
      event.data.requestId !== requestId ||
      event.data.error !== "token_expired" ||
      recovering
    )
      return;
    if (retried) {
      fail();
      return;
    }
    recovering = true;
    retried = true;
    try {
      // /account/auth により、既存の apiClient の更新・再試行インターセプターが動作する。
      await apiClient.get("/account/auth", { signal: controller.signal });
      if (active) form.submit();
    } catch {
      fail();
    } finally {
      recovering = false;
    }
  };
  const timer = setTimeout(dispose, 120000);
  window.addEventListener("message", onMessage);
  try {
    form.submit();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
