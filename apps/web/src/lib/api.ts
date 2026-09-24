// Cliente HTTP da aplicação. Mesma origem (/api/v1); tokens ficam em cookies HttpOnly —
// nunca em localStorage/sessionStorage.

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

/** Single-flight: apenas uma rotação de refresh token por vez (evita falso positivo de reuso). */
async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } } = {};
  try {
    body = await res.json();
  } catch {
    /* corpo não-JSON */
  }
  return new ApiError(
    res.status,
    body.error?.code ?? 'HTTP_ERROR',
    body.error?.message ?? 'Não foi possível concluir a operação.',
    body.error?.request_id ?? res.headers.get('X-Request-ID'),
    body.error?.details,
  );
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Rotas de autenticação não tentam refresh automático. */
  noRefresh?: boolean;
}

export async function apiFetch(path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const doFetch = () => fetch(`${API_BASE}${path}`, { method: opts.method ?? 'GET', headers, body, credentials: 'same-origin' });
  let res = await doFetch();
  if (res.status === 401 && !opts.noRefresh) {
    if (await refreshSession()) res = await doFetch();
  }
  if (!res.ok) throw await toError(res);
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiFetch(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Baixa um arquivo autenticado e dispara o download no navegador. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(path);
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
