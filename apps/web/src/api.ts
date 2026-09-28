const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {}

export async function apiRequest<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new ApiError(data.error ?? "The request could not be completed.");
  return data;
}

export function socketUrl() {
  return import.meta.env.VITE_SOCKET_URL ?? apiUrl;
}
