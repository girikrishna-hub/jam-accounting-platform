/** Thin client for the server API. Every call sends the CSRF header; errors carry the server's message. */

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'x-jam-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('jam:signed-out'));
    throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  delete: <T>(url: string, body: unknown = {}) => request<T>('DELETE', url, body),
};

export interface Me {
  user: { id: string; email: string; displayName: string; isFirmAdmin: boolean; sessionRef: string };
  firmId: string;
  organisations: { id: string; name: string; role: 'accountant' | 'reviewer' | 'client_viewer'; status: string; currency: string }[];
}

export interface Money { amount: string; currency: string }

/** Minor units → "1,234.56" (2 dp). Never via floating point. */
export function formatMinor(minor: string | bigint): string {
  const value = typeof minor === 'string' ? BigInt(minor) : minor;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${digits.slice(-2)}`;
}
