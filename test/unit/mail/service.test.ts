import { describe, it, expect, vi } from 'vitest';
import { MailService } from '../../../src/modules/mail/service.js';
import type { Transporter } from 'nodemailer';

describe('MailService', () => {
  it('initializes with the imaker.in mail server configuration', () => {
    const service = new MailService();
    const config = service.getConfig();

    expect(config.smtpHost).toBe('imaker.in');
    expect(config.smtpPort).toBe(465);
    expect(config.smtpSecure).toBe(true);
    expect(config.smtpUser).toBe('info@imaker.in');
    expect(config.fromEmail).toBe('info@imaker.in');
    expect(config.incomingHost).toBe('imaker.in');
    expect(config.imapPort).toBe(993);
    expect(config.pop3Port).toBe(995);
  });

  it('sends an email via transporter', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({
      messageId: '<test-msg-123@imaker.in>',
      accepted: ['recipient@example.com'],
      rejected: [],
    });

    const fakeTransporter = {
      sendMail: mockSendMail,
      verify: vi.fn().mockResolvedValue(true),
    } as unknown as Transporter;

    const service = new MailService({}, fakeTransporter);

    const result = await service.sendMail({
      to: 'recipient@example.com',
      subject: 'Test Subject',
      text: 'Hello world',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('<test-msg-123@imaker.in>');
    expect(result.accepted).toEqual(['recipient@example.com']);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Sarjan Construction ERP" <info@imaker.in>',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        text: 'Hello world',
      }),
    );
  });

  it('sends an employee invitation with claim code', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({
      messageId: '<invitation-123@imaker.in>',
      accepted: ['new.worker@example.com'],
      rejected: [],
    });

    const fakeTransporter = {
      sendMail: mockSendMail,
    } as unknown as Transporter;

    const service = new MailService({}, fakeTransporter);

    const result = await service.sendEmployeeInvitation({
      to: 'new.worker@example.com',
      employeeName: 'Ramesh Patel',
      companyName: 'iMaker Technology',
      claimCode: 'CLM-789012',
    });

    expect(result.success).toBe(true);
    expect(mockSendMail).toHaveBeenCalled();
    const calls = mockSendMail.mock.calls as [Record<string, unknown>][];
    const firstCall = calls[0]?.[0];
    expect(firstCall?.to).toBe('new.worker@example.com');
    expect(String(firstCall?.text)).toContain('CLM-789012');
    expect(String(firstCall?.html)).toContain('CLM-789012');
  });

  it('sends a leave status notification', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({
      messageId: '<leave-123@imaker.in>',
      accepted: ['worker@example.com'],
      rejected: [],
    });

    const fakeTransporter = {
      sendMail: mockSendMail,
    } as unknown as Transporter;

    const service = new MailService({}, fakeTransporter);

    const result = await service.sendLeaveStatusNotification({
      to: 'worker@example.com',
      employeeName: 'Ramesh Patel',
      leaveType: 'CASUAL',
      status: 'APPROVED',
      startDate: '2026-11-20',
      endDate: '2026-11-22',
      totalDays: 2,
      reviewerName: 'Sahil Admin',
    });

    expect(result.success).toBe(true);
    expect(mockSendMail).toHaveBeenCalled();
    const calls = mockSendMail.mock.calls as [Record<string, unknown>][];
    const firstCall = calls[0]?.[0];
    expect(firstCall?.to).toBe('worker@example.com');
    expect(String(firstCall?.html)).toContain('APPROVED');
  });

  it('handles sendMail errors gracefully', async () => {
    const mockSendMail = vi.fn().mockRejectedValue(new Error('SMTP connection timed out'));

    const fakeTransporter = {
      sendMail: mockSendMail,
    } as unknown as Transporter;

    const service = new MailService({}, fakeTransporter);

    const result = await service.sendMail({
      to: 'fail@example.com',
      subject: 'Fail Test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('SMTP connection timed out');
  });

  it('verifies SMTP connection', async () => {
    const mockVerify = vi.fn().mockResolvedValue(true);
    const fakeTransporter = {
      verify: mockVerify,
    } as unknown as Transporter;

    const service = new MailService({}, fakeTransporter);
    const isOk = await service.verifyConnection();
    expect(isOk).toBe(true);
    expect(mockVerify).toHaveBeenCalled();
  });
});
