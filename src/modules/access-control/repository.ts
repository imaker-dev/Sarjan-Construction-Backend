import type { PrismaClient, RoleAssignment } from '@prisma/client';

// Fully-resolved ancestor chain of a scope target. Coverage check is
// membership in this set plus the target itself.
export interface ScopeChain {
  companyId: string;
  headOfficeId?: string;
  projectId?: string;
  siteId?: string;
}

export interface AssignmentWithPermissions extends RoleAssignment {
  role: { permissions: { permission: { key: string } }[] };
}

export interface AccessRepository {
  assignmentsForPrincipal(
    principalId: string,
    companyId: string,
    now: Date,
  ): Promise<AssignmentWithPermissions[]>;
  companyExists(companyId: string): Promise<boolean>;
  resolveSiteChain(companyId: string, siteId: string): Promise<ScopeChain | null>;
  resolveProjectChain(companyId: string, projectId: string): Promise<ScopeChain | null>;
  resolveHeadOfficeChain(companyId: string, headOfficeId: string): Promise<ScopeChain | null>;
}

export function makeAccessRepository(prisma: PrismaClient): AccessRepository {
  return {
    // Single batched query — no N+1.
    assignmentsForPrincipal: (principalId, companyId, now) =>
      prisma.roleAssignment.findMany({
        where: {
          principalId,
          companyId,
          revokedAt: null,
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
          AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
        },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      }),

    companyExists: async (companyId) =>
      (await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } })) !==
      null,

    resolveSiteChain: async (companyId, siteId) => {
      // Scoped lookups only — never load-then-filter.
      const site = await prisma.site.findFirst({
        where: { id: siteId, companyId },
        select: { id: true, projectId: true },
      });
      if (!site) return null;
      const project = await prisma.project.findFirst({
        where: { id: site.projectId, companyId },
        select: { id: true, headOfficeId: true },
      });
      if (!project) return null;
      return {
        companyId,
        siteId: site.id,
        projectId: project.id,
        headOfficeId: project.headOfficeId,
      };
    },

    resolveProjectChain: async (companyId, projectId) => {
      const project = await prisma.project.findFirst({
        where: { id: projectId, companyId },
        select: { id: true, headOfficeId: true },
      });
      if (!project) return null;
      return { companyId, projectId: project.id, headOfficeId: project.headOfficeId };
    },

    resolveHeadOfficeChain: async (companyId, headOfficeId) => {
      const ho = await prisma.headOffice.findFirst({
        where: { id: headOfficeId, companyId },
        select: { id: true },
      });
      if (!ho) return null;
      return { companyId, headOfficeId: ho.id };
    },
  };
}
