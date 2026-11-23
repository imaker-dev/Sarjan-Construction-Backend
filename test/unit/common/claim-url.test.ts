import { describe, it, expect } from 'vitest';
import { buildClaimUrl, claimPathFor, resolveClaimOrigin } from '../../../src/common/claim-url.js';

const BASE = 'https://app.sarjan.test';
const ALLOW = ['https://app.sarjan.test', 'https://erp.sarjan.test'];

describe('resolveClaimOrigin', () => {
  it('uses a request origin only on EXACT allowlist match', () => {
    expect(resolveClaimOrigin('https://erp.sarjan.test', ALLOW, BASE, false)).toBe(
      'https://erp.sarjan.test',
    );
    // Trailing slashes normalize away, so the canonical origin still matches.
    expect(resolveClaimOrigin('https://erp.sarjan.test/', ALLOW, BASE, false)).toBe(
      'https://erp.sarjan.test',
    );
  });

  it('rejects hostile request origins and falls back to APP_BASE_URL', () => {
    for (const hostile of [
      'https://evil.example',
      'https://app.sarjan.test.evil.example',
      'https://app.sarjan.test@evil.example',
      'javascript:alert(1)',
      '//evil.example',
      'https://erp.sarjan.test.evil.example',
      'https://app.sarjan.test:8443', // different origin — no match
    ]) {
      expect(resolveClaimOrigin(hostile, ALLOW, BASE, false)).toBe(BASE);
    }
  });

  it('falls back to APP_BASE_URL when no request origin is supplied', () => {
    expect(resolveClaimOrigin(undefined, ALLOW, BASE, false)).toBe(BASE);
    expect(resolveClaimOrigin('', ALLOW, BASE, false)).toBe(BASE);
  });

  it('returns null when no usable origin exists', () => {
    expect(resolveClaimOrigin(undefined, [], '', false)).toBeNull();
    expect(resolveClaimOrigin('https://evil.example', ALLOW, '', false)).toBeNull();
  });

  it('enforces HTTPS when required — even for configured origins', () => {
    expect(resolveClaimOrigin(undefined, [], 'http://app.sarjan.test', true)).toBeNull();
    expect(resolveClaimOrigin('http://erp.sarjan.test', ALLOW, BASE, true)).toBe(BASE);
    expect(
      resolveClaimOrigin('http://erp.sarjan.test', ['http://erp.sarjan.test'], '', true),
    ).toBeNull();
    expect(resolveClaimOrigin(undefined, [], BASE, true)).toBe(BASE);
  });
});

describe('buildClaimUrl', () => {
  it('constructs the server-side path per purpose', () => {
    expect(claimPathFor('COMPANY_ONBOARD')).toBe('/onboard');
    expect(claimPathFor('EMPLOYEE_INVITE')).toBe('/verify-employee');
    const raw = 'ab'.repeat(32);
    expect(buildClaimUrl('EMPLOYEE_INVITE', raw, undefined, [], BASE, false)).toBe(
      `${BASE}/verify-employee?token=${raw}`,
    );
    expect(buildClaimUrl('COMPANY_ONBOARD', raw, undefined, [], BASE, false)).toBe(
      `${BASE}/onboard?token=${raw}`,
    );
  });

  it('never lets a hostile request origin reach the URL', () => {
    const raw = 'cd'.repeat(32);
    const url = buildClaimUrl(
      'EMPLOYEE_INVITE',
      raw,
      'https://evil.example/phish',
      ALLOW,
      BASE,
      false,
    );
    expect(url).toBe(`${BASE}/verify-employee?token=${raw}`);
    expect(url).not.toContain('evil.example');
  });
});
