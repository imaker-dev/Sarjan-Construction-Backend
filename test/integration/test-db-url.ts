// Fail-closed guard for the disposable test database URL.
// Exact target only: loopback host, port 55432, database "erp_test".
// Never logs credentials or the raw URL.
const ALLOWED_DB = 'erp_test';
const ALLOWED_PORT = '55432';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function resolveTestDbUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  if (parsed.port !== ALLOWED_PORT) return null;
  // pathname is "/erp_test" — exact match required, no substrings.
  if (parsed.pathname !== `/${ALLOWED_DB}`) return null;
  return raw;
}
