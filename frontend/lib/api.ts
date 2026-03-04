const ENV_API_BASE = process.env.NEXT_PUBLIC_API_BASE;

function resolveApiBase(): string {
  if (ENV_API_BASE && ENV_API_BASE !== "auto") return ENV_API_BASE;
  return "/api";
}

export const API_BASE = resolveApiBase();

function serializeRequestBody(path: string, body: unknown): string | undefined {
  if (body === undefined) return undefined;
  try {
    return JSON.stringify(body);
  } catch (err) {
    const maybeUiEvent =
      !!body &&
      typeof body === "object" &&
      ("target" in (body as Record<string, unknown>) || "currentTarget" in (body as Record<string, unknown>));
    if (maybeUiEvent) {
      throw new Error(
        `Invalid request payload for ${path}: a UI event object was passed instead of data. Please retry the action.`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid request payload for ${path}: ${detail}`);
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }

  return res.json();
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "GET" });
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "POST",
    body: serializeRequestBody(path, body),
  });
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "PUT",
    body: serializeRequestBody(path, body),
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "DELETE" });
}
