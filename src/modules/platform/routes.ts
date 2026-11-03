import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { PlatformService } from './service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { UnauthorizedError } from '../../common/errors/app-error.js';
import type { ActorContext } from '../organization/types.js';

// Optional company profile fields collected at platform-creation time —
// format-checked only (validation ≠ proof of government registration).
const ProfileFields = {
  legalName: Type.String({ maxLength: 200 }),
  entityType: Type.Union([
    Type.Literal('PRIVATE_LIMITED'),
    Type.Literal('PUBLIC_LIMITED'),
    Type.Literal('LLP'),
    Type.Literal('PARTNERSHIP'),
    Type.Literal('PROPRIETORSHIP'),
    Type.Literal('OTHER'),
  ]),
  tradeName: Type.String({ maxLength: 200 }),
  formedOn: Type.String({ format: 'date' }),
  pan: Type.String({ pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', maxLength: 10 }),
  cin: Type.String({ minLength: 21, maxLength: 21 }),
  llpin: Type.String({ minLength: 7, maxLength: 7 }),
  regNumber: Type.String({ maxLength: 40 }),
  website: Type.String({ maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  regAddressLine1: Type.String({ maxLength: 200 }),
  regAddressLine2: Type.String({ maxLength: 200 }),
  regLocality: Type.String({ maxLength: 120 }),
  regCity: Type.String({ maxLength: 80 }),
  regDistrict: Type.String({ maxLength: 80 }),
  regStateUt: Type.String({ maxLength: 80 }),
  regPin: Type.String({ maxLength: 10 }),
  regCountry: Type.String({ maxLength: 2 }),
  corrAddressLine1: Type.String({ maxLength: 200 }),
  corrAddressLine2: Type.String({ maxLength: 200 }),
  corrLocality: Type.String({ maxLength: 120 }),
  corrCity: Type.String({ maxLength: 80 }),
  corrDistrict: Type.String({ maxLength: 80 }),
  corrStateUt: Type.String({ maxLength: 80 }),
  corrPin: Type.String({ maxLength: 10 }),
  corrCountry: Type.String({ maxLength: 2 }),
  contactName: Type.String({ maxLength: 120 }),
  contactDesignation: Type.String({ maxLength: 120 }),
  contactEmail: Type.String({ format: 'email', maxLength: 320 }),
  contactPhone: Type.String({ maxLength: 20 }),
} as const;
export const COMPANY_PROFILE_FIELDS = ProfileFields;

const CreateCompany = Type.Object({
  companyCode: Type.String({ minLength: 1, maxLength: 40 }),
  companyName: Type.String({ minLength: 1, maxLength: 200 }),
  adminLoginId: Type.String({ minLength: 3, maxLength: 320 }),
  adminDisplayName: Type.String({ minLength: 1, maxLength: 120 }),
  ...Object.fromEntries(Object.entries(ProfileFields).map(([k, v]) => [k, Type.Optional(v)])),
});

const ClaimBody = Type.Object({
  token: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 12 }),
});

const VerifyClaimQuery = Type.Object({
  token: Type.String({ minLength: 1 }),
});

const OnboardBody = Type.Object({
  token: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 12 }),
  loginId: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  company: Type.Optional(
    Type.Object(
      Object.fromEntries(Object.entries(ProfileFields).map(([k, v]) => [k, Type.Optional(v)])),
    ),
  ),
  headOffice: Type.Optional(
    Type.Object({
      code: Type.String({ minLength: 1, maxLength: 40 }),
      name: Type.String({ minLength: 1, maxLength: 200 }),
      isPrimary: Type.Optional(Type.Boolean()),
    }),
  ),
});

const ReissueParams = Type.Object({ companyId: Type.String({ format: 'uuid' }) });
const ReissueBody = Type.Object({ adminPrincipalId: Type.String({ format: 'uuid' }) });

const actorOf = (r: FastifyRequest): ActorContext => ({
  actorId: (r.principal as { actorId: string }).actorId,
  actorType: 'USER',
});

// Claim endpoint: the shared @fastify/rate-limit plugin — Redis-backed store
// in production (fails closed on Redis outage via error propagation).
const CLAIM_RATE_LIMIT = { max: 10, timeWindow: '5 minutes' } as const;

// Platform scope = the sentinel platform company — resolved via the injected
// resolver (DB or test hook), NEVER from x-company-id.
function platformScopeOf(
  resolvePlatformCompanyId: () => Promise<string | null>,
): (r: FastifyRequest) => Promise<ScopeTarget> {
  let cached: string | undefined;
  return async () => {
    cached ??= (await resolvePlatformCompanyId()) ?? '';
    return { companyId: cached, scopeType: 'COMPANY', scopeId: cached };
  };
}

export function platformRoutes(
  service: PlatformService,
  resolvePlatformCompanyId: () => Promise<string | null>,
) {
  return async function routes(app: FastifyInstance) {
    const scope = platformScopeOf(resolvePlatformCompanyId);
    // requirePermission's resolver is sync — wrap async resolution via a
    // preHandler that fetches once then checks.
    const guard =
      (key: string) =>
      async (request: FastifyRequest): Promise<void> => {
        await app.authenticate(request);
        if (!request.principal) throw new UnauthorizedError();
        const target = await scope(request);
        await app.requirePermission(key, () => target)(request);
      };

    app.post(
      '/platform/companies',
      { schema: { body: CreateCompany }, preHandler: guard('PLATFORM_COMPANY_CREATE') },
      async (req) => service.createCompanyWithAdmin(actorOf(req), req.body as never),
    );
    app.get('/platform/companies', { preHandler: guard('PLATFORM_COMPANY_READ') }, async () =>
      service.listCompanies(),
    );
    app.post(
      '/platform/companies/:companyId/claim-token',
      {
        schema: { params: ReissueParams, body: ReissueBody },
        preHandler: guard('PLATFORM_COMPANY_CREATE'),
      },
      async (req) => {
        const { companyId } = req.params as { companyId: string };
        const { adminPrincipalId } = req.body as { adminPrincipalId: string };
        return service.reissueClaim(actorOf(req), companyId, adminPrincipalId);
      },
    );

    // Verify an unconsumed claim token before starting onboarding.
    app.get(
      '/auth/claim/verify',
      { schema: { querystring: VerifyClaimQuery }, config: { rateLimit: CLAIM_RATE_LIMIT } },
      async (req) => {
        const { token } = req.query as { token: string };
        return service.verifyClaim(token);
      },
    );

    // Unauthenticated, rate-limited claim consumption — the new admin's
    // self-service activation. Raw code arrives once in the body.
    app.post(
      '/auth/claim',
      { schema: { body: ClaimBody }, config: { rateLimit: CLAIM_RATE_LIMIT } },
      async (req, reply) => {
        const { token, password } = req.body as { token: string; password: string };
        const result = await service.consumeClaim(token, password);
        return reply.send(result);
      },
    );

    // Unauthenticated, rate-limited all-in-one onboarding completion.
    app.post(
      '/auth/claim/onboard',
      { schema: { body: OnboardBody }, config: { rateLimit: CLAIM_RATE_LIMIT } },
      async (req, reply) => {
        const { token, ...input } = req.body as { token: string } & Parameters<
          typeof service.consumeClaimAndOnboard
        >[1];
        const result = await service.consumeClaimAndOnboard(token, input);
        return reply.send(result);
      },
    );
  };
}
