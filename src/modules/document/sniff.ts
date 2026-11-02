// Magic-bytes content sniffing for the v1 allowlist. The declared client
// type is recorded for audit but never trusted.
export type SniffedType = 'image/png' | 'image/jpeg' | 'application/pdf';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF-

export const ALLOWED_CONTENT_TYPES = new Set<SniffedType>([
  'image/png',
  'image/jpeg',
  'application/pdf',
]);

function startsWith(buf: Buffer, magic: number[]): boolean {
  return buf.length >= magic.length && magic.every((b, i) => buf[i] === b);
}

export function sniffContentType(buf: Buffer): SniffedType | null {
  if (startsWith(buf, PNG_MAGIC)) return 'image/png';
  if (startsWith(buf, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(buf, PDF_MAGIC)) return 'application/pdf';
  return null;
}
