// Display-name sanitization — a document's original filename is never used
// as a storage path; this produces a safe `Content-Disposition` name.
const UNSAFE_CHARS = /[^\w.\- ]+/g;

function isPrintable(c: string): boolean {
  const n = c.codePointAt(0) ?? 0;
  return n > 0x1f && n !== 0x7f && !(n >= 0x80 && n <= 0x9f);
}

export function sanitizeFileName(input: string): string {
  // Strip any path segments regardless of separator, then control chars.
  const base = input.split(/[\\/]/).pop() ?? '';
  const printable = Array.from(base).filter(isPrintable).join('');
  const cleaned = printable.replace(UNSAFE_CHARS, '_').trim();
  return cleaned.length === 0 ? 'file' : cleaned.slice(0, 120);
}
