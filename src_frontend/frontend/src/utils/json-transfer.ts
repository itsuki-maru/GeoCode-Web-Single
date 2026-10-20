import apiClient from "@/axiosClient";

export async function fetchJsonExport(url: string): Promise<Blob> {
  const response = await apiClient.get<string>(url, {
    responseType: "text",
    // Preserve successful JSON as bytes/text. Parsing it in JavaScript would
    // round integers beyond Number.MAX_SAFE_INTEGER. Parse only error responses
    // so the existing token refresh/retry interceptor still receives its JSON.
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
