import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NotificationPublisher } from './types.js';
import { channelFor, realtimeMessage } from './service.js';
import type { MailService } from '../mail/service.js';

export interface ScopeFilter {
  scopeType?: 'COMPANY' | 'HEAD_OFFICE' | 'PROJECT' | 'SITE' | undefined;
  scopeId?: string | undefined;
}

export interface ResolvedRecipient {
  principalId: string;
  loginId: string | null;
  displayName: string | null;
  contactEmail: string | null;
}

export interface NotifyRoleInput {
  companyId: string;
  roleKeys: string[];
  scope?: ScopeFilter | undefined;
  eventType: string;
  title: string;
  body?: string | undefined;
  resourceType: string;
  resourceId: string;
  email?:
    | {
        subject: string;
        text?: string | undefined;
        html?: string | undefined;
      }
    | undefined;
}

export interface NotifyUserInput {
  companyId: string;
  recipientPrincipalId: string;
  eventType: string;
  title: string;
  body?: string | undefined;
  resourceType: string;
  resourceId: string;
  email?:
    | {
        to?: string | undefined;
        subject: string;
        text?: string | undefined;
        html?: string | undefined;
      }
    | undefined;
}

export class RoleNotificationDispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher?: NotificationPublisher | undefined,
    private readonly mailService?: MailService | undefined,
  ) {}

  /**
   * Resolve all active principals holding any of the specified roles within a scope.
   */
  async resolveRecipients(
    companyId: string,
    roleKeys: string[],
    scope?: ScopeFilter,
  ): Promise<ResolvedRecipient[]> {
    if (roleKeys.length === 0) return [];

    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        companyId,
        role: { key: { in: roleKeys } },
        revokedAt: null,
        ...(scope?.scopeType === 'HEAD_OFFICE' && scope.scopeId
          ? { headOfficeId: scope.scopeId }
          : {}),
        ...(scope?.scopeType === 'PROJECT' && scope.scopeId ? { projectId: scope.scopeId } : {}),
        ...(scope?.scopeType === 'SITE' && scope.scopeId ? { siteId: scope.scopeId } : {}),
      },
      select: {
        principalId: true,
        principal: {
          select: {
            id: true,
            loginId: true,
            employees: {
              where: { companyId },
              select: { displayName: true, contactEmail: true },
              take: 1,
            },
          },
        },
      },
    });

    const uniqueMap = new Map<string, ResolvedRecipient>();
    for (const a of assignments) {
      if (!uniqueMap.has(a.principalId)) {
        const emp = a.principal.employees[0];
        uniqueMap.set(a.principalId, {
          principalId: a.principalId,
          loginId: a.principal.loginId,
          displayName: emp?.displayName ?? null,
          contactEmail: emp?.contactEmail ?? null,
        });
      }
    }

    return [...uniqueMap.values()];
  }

  /**
   * Notify all users holding any of the target roles (In-App + Realtime WS + Email).
   */
  async notifyRoles(input: NotifyRoleInput): Promise<number> {
    const recipients = await this.resolveRecipients(input.companyId, input.roleKeys, input.scope);
    if (recipients.length === 0) return 0;

    let deliveredCount = 0;

    for (const recipient of recipients) {
      await this.deliverToPrincipal(input.companyId, recipient, {
        eventType: input.eventType,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ...(input.email !== undefined ? { email: input.email } : {}),
      });
      deliveredCount++;
    }

    return deliveredCount;
  }

  /**
   * Directly notify a specific user (In-App + Realtime WS + Email).
   */
  async notifyUser(input: NotifyUserInput): Promise<void> {
    const principal = await this.prisma.principal.findUnique({
      where: { id: input.recipientPrincipalId },
      select: {
        id: true,
        loginId: true,
        employees: {
          where: { companyId: input.companyId },
          select: { displayName: true, contactEmail: true },
          take: 1,
        },
      },
    });

    const emp = principal?.employees[0];
    const recipient: ResolvedRecipient = {
      principalId: input.recipientPrincipalId,
      loginId: principal?.loginId ?? null,
      displayName: emp?.displayName ?? null,
      contactEmail: emp?.contactEmail ?? null,
    };

    await this.deliverToPrincipal(input.companyId, recipient, {
      eventType: input.eventType,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.email !== undefined ? { email: input.email } : {}),
    });
  }

  private async deliverToPrincipal(
    companyId: string,
    recipient: ResolvedRecipient,
    data: {
      eventType: string;
      title: string;
      body?: string | undefined;
      resourceType: string;
      resourceId: string;
      email?:
        | {
            to?: string | undefined;
            subject: string;
            text?: string | undefined;
            html?: string | undefined;
          }
        | undefined;
    },
  ): Promise<void> {
    const eventKey = randomUUID();
    const now = new Date();

    // 1. Create durable in-app notification row
    const notification = await this.prisma.notification.create({
      data: {
        companyId,
        recipientPrincipalId: recipient.principalId,
        eventType: data.eventType,
        title: data.title,
        body: data.body ?? null,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        eventKey,
        publishedAt: this.publisher ? now : null,
      },
    });

    // 2. Publish to Redis WebSocket channel for live browser push
    if (this.publisher) {
      try {
        const channel = channelFor(companyId, recipient.principalId);
        await this.publisher.publish(channel, realtimeMessage(notification));
      } catch {
        // Non-blocking: WS failure does not break core business transactions
      }
    }

    // 3. Dispatch Email if email options provided and mailService is configured
    if (this.mailService && data.email) {
      const emailTo = data.email.to ?? recipient.contactEmail ?? recipient.loginId;
      if (emailTo) {
        try {
          await this.mailService.sendMail({
            to: emailTo,
            subject: data.email.subject,
            ...(data.email.text !== undefined ? { text: data.email.text } : {}),
            ...(data.email.html !== undefined ? { html: data.email.html } : {}),
          });
        } catch {
          // Non-blocking: email sending is best-effort
        }
      }
    }
  }
}
