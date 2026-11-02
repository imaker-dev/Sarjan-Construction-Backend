import { describe, it, expect } from 'vitest';
import { resolveTestDbUrl } from './test-db-url.js';

const BASE = 'postgresql://u:p@localhost:55432/erp_test';

describe('resolveTestDbUrl (fail-closed)', () => {
  it('accepts the exact dedicated target', () => {
    expect(resolveTestDbUrl(BASE)).toBe(BASE);
    expect(resolveTestDbUrl('postgresql://u:p@127.0.0.1:55432/erp_test')).toBeTruthy();
  });

  it('rejects a different database name', () => {
    expect(resolveTestDbUrl('postgresql://u:p@localhost:55432/erp_dev')).toBeNull();
    expect(resolveTestDbUrl('postgresql://u:p@localhost:55432/erp_test_rollback')).toBeNull();
    expect(resolveTestDbUrl('postgresql://u:p@localhost:55432/erp_test/extra')).toBeNull();
  });

  it('rejects a non-loopback host', () => {
    expect(resolveTestDbUrl('postgresql://u:p@db.internal:55432/erp_test')).toBeNull();
    expect(resolveTestDbUrl('postgresql://u:p@192.168.1.5:55432/erp_test')).toBeNull();
  });

  it('rejects a different port', () => {
    expect(resolveTestDbUrl('postgresql://u:p@localhost:5432/erp_test')).toBeNull();
    expect(resolveTestDbUrl('postgresql://u:p@localhost:5543/erp_test')).toBeNull();
  });

  it('rejects missing or malformed input without throwing', () => {
    expect(resolveTestDbUrl(undefined)).toBeNull();
    expect(resolveTestDbUrl('')).toBeNull();
    expect(resolveTestDbUrl('not-a-url')).toBeNull();
    expect(resolveTestDbUrl('postgres://u:p@localhost/erp_test')).toBeNull(); // missing port
  });
});
