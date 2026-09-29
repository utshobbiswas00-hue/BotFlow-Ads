import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import type { ApiResponse, ApiSuccess } from '@botflow/shared';
import { getInitData } from './telegram';

/**
 * Absolute origin of the API.
 *
 * The Mini App is served BY the API service (backend/src/app.ts serves
 * frontend/dist), so in production the API sits on the same origin as the page
 * and there is nothing to configure. Deriving it from `window.location.origin`
 * rather than baking in a hostname also means the bundle keeps working if the
 * service is renamed or a custom domain is attached — no rebuild required.
 *
 * `VITE_API_URL` still wins when it is set: that is the split-origin
 * deployment (a static site calling a separate API service), where Vite inlines
 * the value at build time.
 *
 * In development Vite serves the SPA on :5173 while the API runs on :10000, so
 * fall back to the API port — using the Vite origin there would send every
 * request back to the dev server and 404.
 *
 * This is worth being precise about: falling back to a hardcoded localhost is
 * what produced "Network error — is the API running?" in production. An unset
 * variable meant the Mini App called a plain-HTTP localhost URL from an HTTPS
 * page; the browser refuses that before a response ever exists, which is why
 * the resulting error carries no HTTP status at all.
 */
const baseURL = (
  (import.meta.env.VITE_API_URL ?? '').trim() ||
  (import.meta.env.DEV
    ? 'http://localhost:10000'
    : typeof window !== 'undefined'
      ? window.location.origin
      : '')
).replace(/\/+$/, '');

const http = axios.create({
  baseURL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

/* Inject Telegram auth header on every request. */
http.interceptors.request.use((config) => {
  const initData = getInitData();
  if (initData) {
    config.headers.set('x-telegram-init-data', initData);
  }
  return config;
});

/** Typed error surfaced to UI. Carries the API `code` and HTTP status (when any). */
export class ApiError extends Error {
  code: string;
  status?: number;
  details?: unknown;

  constructor(message: string, code: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Unwrap the `{ ok, data | error }` envelope. On success, response.data is
 * replaced by the inner `data`, so callers get typed payloads directly.
 */
http.interceptors.response.use(
  (response) => {
    const body = response.data as ApiResponse<unknown> | undefined;
    if (body && typeof body === 'object' && 'ok' in body) {
      if (body.ok === true) {
        response.data = (body as ApiSuccess<unknown>).data;
        return response;
      }
      throw new ApiError(body.error.message, body.error.code, response.status, body.error.details);
    }
    return response;
  },
  (error: AxiosError<ApiResponse<unknown>>) => {
    const status = error.response?.status;
    const body = error.response?.data;
    if (body && typeof body === 'object' && 'ok' in body && !body.ok) {
      return Promise.reject(new ApiError(body.error.message, body.error.code, status, body.error.details));
    }
    if (status) {
      return Promise.reject(new ApiError(error.message || `Request failed (${status})`, 'HTTP_ERROR', status));
    }
    return Promise.reject(new ApiError('Network error — is the API running?', 'NETWORK_ERROR'));
  },
);

/**
 * The response interceptor replaces `response.data` with the unwrapped
 * envelope payload, so the cast to T below is the documented contract.
 */
async function request<T>(config: AxiosRequestConfig): Promise<T> {
  const res = await http.request(config);
  return res.data as T;
}

export const api = {
  get<T>(url: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return request<T>({ url, method: 'GET', params });
  },
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return request<T>({ url, method: 'POST', data, ...config });
  },
  patch<T>(url: string, data?: unknown): Promise<T> {
    return request<T>({ url, method: 'PATCH', data });
  },
  put<T>(url: string, data?: unknown): Promise<T> {
    return request<T>({ url, method: 'PUT', data });
  },
  delete<T>(url: string): Promise<T> {
    return request<T>({ url, method: 'DELETE' });
  },
};

/** Human-readable message for any thrown error (safe for toasts). */
export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong';
}

export { baseURL };
