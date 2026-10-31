import axios from "axios";
import type {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import { useAuthStore } from "@/stores/auth";
import router from "@/router"; // 直接 router インスタンスをインポート
import { baseUrl } from "./setting";
import { refreshTokenUrl } from "./router/urls";

// カスタムAxiosインスタンス型
interface CustomAxiosInstance extends AxiosInstance {
  isAxiosError: (error: unknown) => error is AxiosError;
}

// Axiosインスタンス
const apiClient: CustomAxiosInstance = axios.create({
  baseURL: baseUrl,
  withCredentials: true,
}) as CustomAxiosInstance;

// `isAxiosError` を追加
apiClient.isAxiosError = (error: unknown): error is AxiosError => axios.isAxiosError(error);

// リフレッシュ処理制御用フラグ
let isRefreshing = false;
let refreshPromise: Promise<void> | null = null;

// `/api/refresh` でアクセストークンを更新
async function refreshToken(): Promise<void> {
  try {
    await apiClient.post(refreshTokenUrl);
  } catch (error) {
    throw new Error("Token refresh failed");
  }
}

interface TokenErrorResponse {
  error: string;
  user_id?: string;
}

// Axiosのリクエストインターセプタ―
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // FormDataを送信する場合は `Content-Type` を設定しない
    if (config.data instanceof FormData) {
      delete config.headers?.["Content-Type"];
    } else {
      config.headers["Content-Type"] = "application/json";
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// Axiosのレスポンスインターセプター
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response, // 成功時はそのまま返す
  async (error: AxiosError) => {
    const authStore = useAuthStore();

    if (error.response?.status === 401) {
      if (apiClient.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as TokenErrorResponse;

        if (errorData.error === "token_expired") {
          if (!isRefreshing) {
            isRefreshing = true;
            refreshPromise = refreshToken();
          }
          try {
            await refreshPromise;
            isRefreshing = false;
            refreshPromise = null;

            // トークン更新後、元のリクエストを再試行
            return apiClient.request(error.config as AxiosRequestConfig);
          } catch (refreshError) {
            isRefreshing = false;
            refreshPromise = null;
            authStore.logout();
            router.push("/account/login"); // ここで router を直接使用
            return Promise.reject(refreshError);
          }
        } else if (errorData.error === "refresh_token_expired") {
          authStore.logout();
          router.push("/account/login"); // ここで router を直接使用
          return Promise.reject(error);
        }
      }
      return Promise.reject(error);
    }
    return Promise.reject(error);
  },
);

export default apiClient;
