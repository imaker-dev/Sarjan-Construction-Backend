/**
 * Trusted claim-link construction.
 *
 * A claim URL must NEVER be built from an arbitrary request-supplied host.
 * The only origins allowed to appear in an emailed or API-returned claim
 * link are:
 *   1. A request-supplied origin (`x-frontend-url` / `Origin` header) that
 *      EXACTLY matches an entry in the configured `CLAIM_URL_ORIGINS`
 *      allowlist, or
 *   2. The configured `APP_BASE_URL` fallback.
 *
 * When neither resolves to a usable origin (or HTTPS is required and the
 * resolved origin is insecure), callers must return `null` and rely on the
 * one-time manual claim-code handoff instead.
 */

export type ClaimTokenPurposeValue = 'COMPANY_ONBOARD' | 'EMPLOYEE_INVITE';

export type ClaimDelivery = 'EMAIL_SENT' | 'EMAIL_FAILED' | 'NOT_ATTEMPTED';

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '');

export function resolveClaimOrigin(
  requestOrigin: string | undefined,
  allowlist: readonly string[],
  appBaseUrl: string,
  requireHttps: boolean,
): string | null {
  const allowed = new Set(allowlist.map(normalizeOrigin).filter((o) => o !== ''));
  const candidate = requestOrigin !== undefined ? normalizeOrigin(requestOrigin) : '';
  const origin =
    candidate !== '' && allowed.has(candidate)
      ? candidate
      : (() => {
          const base = normalizeOrigin(appBaseUrl);
          return base === '' ? null : base;
        })();
  if (origin === null) return null;
  if (requireHttps && !origin.toLowerCase().startsWith('https://')) return null;
  return origin;
}

/** Server-side claim path per token purpose — never caller-chosen. */
export function claimPathFor(purpose: ClaimTokenPurposeValue): string {
  return purpose === 'COMPANY_ONBOARD' ? '/onboard' : '/verify-employee';
}

/** Compose the full claim URL for a raw code, or null when untrusted. */
export function buildClaimUrl(
  purpose: ClaimTokenPurposeValue,
  raw: string,
  requestOrigin: string | undefined,
  allowlist: readonly string[],
  appBaseUrl: string,
  requireHttps: boolean,
): string | null {
  const origin = resolveClaimOrigin(requestOrigin, allowlist, appBaseUrl, requireHttps);
  return origin === null ? null : `${origin}${claimPathFor(purpose)}?token=${raw}`;
}
