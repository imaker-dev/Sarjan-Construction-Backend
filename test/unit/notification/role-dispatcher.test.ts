import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoleNotificationDispatcher } from '../../../src/modules/notification/role-dispatcher.js';
import type { PrismaClient } from '@prisma/client';
import type { NotificationPublisher } from '../../../src/modules/notification/types.js';
import type { MailService } from '../../../src/modules/mail/service.js';

describe('RoleNotificationDispatcher', () => {
  const companyId = 'c1';
  let createdNotifications: Record<string, unknown>[];
  let publishedMessages: { channel: string; message: string }[];
  let sentEmails: Record<string, unknown>[];

  let fakePrisma: PrismaClient;
  let fakePublisher: NotificationPublisher;
  let fakeMailService: MailService;
  let dispatcher: RoleNotificationDispatcher;

  beforeEach(() => {
    createdNotifications = [];
    publishedMessages = [];
    sentEmails = [];

    fakePrisma = {
      roleAssignment: {
        findMany: vi
          .fn()
          .mockImplementation(
            async ({ where }: { where: { role?: { key?: { in?: string[] } } } }) => {
              const keys = where.role?.key?.in ?? [];
              if (keys.includes('PROJECT_MANAGER')) {
                return [
                  {
                    principalId: 'p-pm-1',
                    principal: {
                      id: 'p-pm-1',
                      loginId: 'pm@example.com',
                      employees: [{ displayName: 'Site PM', contactEmail: 'pm@example.com' }],
                    },
                  },
                ];
              }
              if (keys.includes('HO_ADMIN')) {
                return [
                  {
                    principalId: 'p-ho-1',
                    principal: {
                      id: 'p-ho-1',
                      loginId: 'ho@example.com',
                      employees: [{ displayName: 'HO Admin', contactEmail: 'ho@example.com' }],
                    },
                  },
                ];
              }
              return [];
            },
          ),
      },
      principal: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          return {
            id: where.id,
            loginId: `${where.id}@example.com`,
            employees: [
              { displayName: `User ${where.id}`, contactEmail: `${where.id}@example.com` },
            ],
          };
        }),
      },
      notification: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `notif-${String(createdNotifications.length + 1)}`,
            createdAt: new Date(),
            ...data,
          };
          createdNotifications.push(row);
          return row;
        }),
      },
    } as unknown as PrismaClient;

    fakePublisher = {
      publish: vi.fn().mockImplementation(async (channel: string, message: string) => {
        publishedMessages.push({ channel, message });
      }),
    };

    fakeMailService = {
      sendMail: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        sentEmails.push(opts);
        return { success: true };
      }),
    } as unknown as MailService;

    dispatcher = new RoleNotificationDispatcher(fakePrisma, fakePublisher, fakeMailService);
  });

  it('resolves recipients by role keys', async () => {
    const recipients = await dispatcher.resolveRecipients(companyId, ['PROJECT_MANAGER']);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]?.principalId).toBe('p-pm-1');
    expect(recipients[0]?.displayName).toBe('Site PM');
    expect(recipients[0]?.contactEmail).toBe('pm@example.com');
  });

  it('notifies roles with in-app, websocket, and email channels', async () => {
    const count = await dispatcher.notifyRoles({
      companyId,
      roleKeys: ['PROJECT_MANAGER'],
      eventType: 'LEAVE_REQUEST_SUBMITTED',
      title: 'New Leave Request',
      body: 'Worker applied for 2 days leave',
      resourceType: 'LEAVE_REQUEST',
      resourceId: 'leave-123',
      email: {
        subject: 'Action Required: New Leave Request',
        text: 'Worker applied for leave',
      },
    });

    expect(count).toBe(1);
    expect(createdNotifications).toHaveLength(1);
    expect(createdNotifications[0]?.recipientPrincipalId).toBe('p-pm-1');
    expect(createdNotifications[0]?.eventType).toBe('LEAVE_REQUEST_SUBMITTED');

    // WebSocket push verified
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0]?.channel).toBe(`notif:${companyId}:p-pm-1`);

    // Email dispatch verified
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe('pm@example.com');
    expect(sentEmails[0]?.subject).toBe('Action Required: New Leave Request');
  });

  it('directly notifies a user with in-app and email', async () => {
    await dispatcher.notifyUser({
      companyId,
      recipientPrincipalId: 'p-emp-1',
      eventType: 'LEAVE_REQUEST_APPROVED',
      title: 'Your Leave was Approved',
      resourceType: 'LEAVE_REQUEST',
      resourceId: 'leave-123',
      email: {
        subject: 'Leave Approved',
        text: 'Your leave has been approved by your supervisor.',
      },
    });

    expect(createdNotifications).toHaveLength(1);
    expect(createdNotifications[0]?.recipientPrincipalId).toBe('p-emp-1');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe('p-emp-1@example.com');
    expect(sentEmails[0]?.subject).toBe('Leave Approved');
  });
});
