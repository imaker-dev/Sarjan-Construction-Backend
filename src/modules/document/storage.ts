import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DocumentStorageError } from './errors.js';

/**
 * Storage boundary. The row is authority: callers pass a server-generated
 * storageKey; adapters never see client filenames. All I/O happens OUTSIDE
 * database transactions — consistency is reconciled, not atomic.
 */
export interface DocumentStorage {
  put(key: string, body: Buffer): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

/**
 * Development-only filesystem adapter. Production MUST NOT run with this —
 * it cannot serve multi-instance deployments and has no durability contract.
 */
export class LocalDiskStorage implements DocumentStorage {
  constructor(private readonly root: string) {
    const resolved = resolve(root);
    this.root = resolved;
  }

  private resolveKey(key: string): string {
    const p = resolve(join(this.root, key));
    if (p !== this.root && !p.startsWith(`${this.root}${sep}`)) {
      throw new DocumentStorageError('storage key escapes root');
    }
    return p;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await pipeline(async function* () {
      yield body;
    }, createWriteStream(path));
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolveKey(key)).catch(() => {
      /* absent object is fine — reconcile idempotent */
    });
  }
}

/** v1 adapter factory — refuses production (single-node FS has no durability contract). */
export function makeDocumentStorage(
  storageDir: string | undefined,
  nodeEnv: string,
): DocumentStorage | null {
  if (storageDir === undefined) return null;
  if (nodeEnv === 'production') {
    throw new DocumentStorageError(
      'local filesystem provider is not permitted in production — configure an object-store provider',
    );
  }
  return new LocalDiskStorage(storageDir);
}
