import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MfaService, maskEmail, type MfaTokenPayload } from '../../../src/modules/auth/mfa.js';
import type { MailService } from '../../../src/modules/mail/service.js';
import type { Redis } from 'ioredis';

describe('MfaService', () => {
  let redisStore: Map<string, string>;
  let mockRedis: Redis;
  let sendMailMock: ReturnType<typeof vi.fn>;
  let mockMailService: MailService;
  let mfaService: MfaService;

  beforeEach(() => {
    redisStore = new Map<string, string>();
    mockRedis = {
      get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => {
        redisStore.set(key, val);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        redisStore.delete(key);
        return 1;
      }),
    } as unknown as Redis;

    sendMailMock = vi.fn().mockResolvedValue({ accepted: ['admin@acme.com'], rejected: [], messageId: 'm1' });
    mockMailService = {
      sendMail: sendMailMock,
    } as unknown as MailService;

    mfaService = new MfaService(
      mockRedis,
      mockMailService,
      (payload) => JSON.stringify(payload),
      (token) => JSON.parse(token) as MfaTokenPayload,
    );
  });

  describe('maskEmail', () => {
    it('masks emails properly', () => {
      expect(maskEmail('admin@imaker.in')).toBe('ad***@imaker.in');
      expect(maskEmail('ab@imaker.in')).toBe('a*@imaker.in');
      expect(maskEmail('invalid-email')).toBe('invalid-email');
    });
  });

  describe('enable / disable / status', () => {
    it('enables and disables MFA', async () => {
      expect(await mfaService.isMfaEnabled('p1')).toBe(false);
      let status = await mfaService.getStatus('p1');
      expect(status.mfaEnabled).toBe(false);
      expect(status.mfaType).toBeNull();

      await mfaService.enableMfa('p1', 'EMAIL_OTP');
      expect(await mfaService.isMfaEnabled('p1')).toBe(true);
      status = await mfaService.getStatus('p1');
      expect(status.mfaEnabled).toBe(true);
      expect(status.mfaType).toBe('EMAIL_OTP');

      await mfaService.disableMfa('p1');
      expect(await mfaService.isMfaEnabled('p1')).toBe(false);
    });
  });

  describe('createChallenge and verifyChallenge', () => {
    it('creates challenge and sends email OTP', async () => {
      const challenge = await mfaService.createChallenge('p1', 'admin@imaker.in');
      expect(challenge.mfaRequired).toBe(true);
      expect(challenge.mfaType).toBe('EMAIL_OTP');
      expect(challenge.maskedEmail).toBe('ad***@imaker.in');
      expect(challenge.expiresInSeconds).toBe(300);
      expect(sendMailMock).toHaveBeenCalledTimes(1);

      // Verify OTP stored in redis
      expect(redisStore.size).toBe(1);
      const otpEntry = Array.from(redisStore.values())[0] ?? '{}';
      const parsed = JSON.parse(otpEntry) as { code: string; principalId: string };
      expect(parsed.principalId).toBe('p1');
      expect(parsed.code).toHaveLength(6);

      // Verify challenge with correct code
      const verified = await mfaService.verifyChallenge(challenge.mfaToken, parsed.code);
      expect(verified.principalId).toBe('p1');

      // OTP key consumed
      expect(redisStore.size).toBe(0);
    });

    it('rejects invalid OTP code and increments attempts', async () => {
      const challenge = await mfaService.createChallenge('p1', 'admin@imaker.in');
      await expect(mfaService.verifyChallenge(challenge.mfaToken, '000000')).rejects.toThrow(
        /Invalid code. 2 attempt\(s\) remaining/,
      );
    });

    it('locks out after 3 failed attempts', async () => {
      const challenge = await mfaService.createChallenge('p1', 'admin@imaker.in');
      await expect(mfaService.verifyChallenge(challenge.mfaToken, '000000')).rejects.toThrow();
      await expect(mfaService.verifyChallenge(challenge.mfaToken, '000001')).rejects.toThrow();
      await expect(mfaService.verifyChallenge(challenge.mfaToken, '000002')).rejects.toThrow(
        /Too many failed attempts/,
      );
      // Key deleted after lockout
      expect(redisStore.size).toBe(0);
    });

    it('resends OTP for active challenge', async () => {
      const challenge = await mfaService.createChallenge('p1', 'admin@imaker.in');
      expect(sendMailMock).toHaveBeenCalledTimes(1);

      const resent = await mfaService.resendOtp(challenge.mfaToken);
      expect(resent.mfaRequired).toBe(true);
      expect(sendMailMock).toHaveBeenCalledTimes(2);
    });
  });
});
