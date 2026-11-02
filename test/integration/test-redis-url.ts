// Fail-closed guard for the disposable test Redis target — loopback only.
const ALLOWED_PORT = '56379';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function resolveTestRedisUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  if (parsed.port !== ALLOWED_PORT) return null;
  return raw;
}
