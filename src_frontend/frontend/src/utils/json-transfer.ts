import apiClient from "@/axiosClient";

export async function fetchJsonExport(url: string): Promise<Blob> {
  const response = await apiClient.get<string>(url, {
    responseType: "text",
    // 成功した JSON はバイト列やテキストのまま保持する。JavaScript で解析すると、
    // Number.MAX_SAFE_INTEGER を超える整数が丸められる。エラー応答のみを解析し、
    // 既存のトークン更新・再試行インターセプターが引き続き JSON を受け取れるようにする。
    transformResponse: [
      (data: string, _headers, status) => {
        if (status && status >= 400) {
          try {
            return JSON.parse(data);
          } catch {
            return { error: "JSONの出力に失敗しました。" };
          }
        }
        return data;
      },
    ],
  });
  return new Blob([response.data], { type: "application/json;charset=utf-8" });
}
