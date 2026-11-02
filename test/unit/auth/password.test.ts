import { describe, it, expect } from 'vitest';
import { passwordService } from '../../../src/modules/identity/password.js';

describe('password service (Argon2id)', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await passwordService.hash('correct horse battery staple');
    expect(hash).toContain('$argon2id$');
    await expect(passwordService.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await passwordService.hash('right password');
    await expect(passwordService.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('returns false (not throw) for null/invalid stored hashes — dummy path', async () => {
    await expect(passwordService.verify(null, 'anything')).resolves.toBe(false);
    await expect(passwordService.verify('garbage-hash', 'anything')).resolves.toBe(false);
  });
});
