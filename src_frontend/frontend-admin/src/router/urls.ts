import { baseUrl } from "@/setting";

export const getTokenUrl = baseUrl + "/account/token";
export const getUsersUrl = baseUrl + "/admin/users";
export const resetUserPasswordUrl = baseUrl + "/admin/user/password-reset/";
export const unlockUserAccountUrl = baseUrl + "/admin/user/unlock/";
export const getUserUrl = baseUrl + "/account/auth";
export const refreshTokenUrl = baseUrl + "/account/refresh";
export const createUserUrl = baseUrl + "/admin/user/create";
export const getAppIniturl = baseUrl + "/app-init";
