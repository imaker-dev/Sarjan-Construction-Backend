import { randomInt, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MailService } from '../mail/service.js';
import { UnauthorizedError, AppError } from '../../common/errors/app-error.js';

export interface MfaTokenPayload {
  sub: string; // principalId
  loginId: string;
  email: string;
  jti: string;
  typ: string;
}

export interface MfaChallengeResult {
  mfaRequired: true;
  mfaToken: string;
  mfaType: 'EMAIL_OTP';
  maskedEmail: string;
  expiresInSeconds: number;
}

export interface MfaVerifyResult {
  principalId: string;
}

const OTP_TTL_SECONDS = 300; // 5 minutes
const MAX_ATTEMPTS = 3;

export function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) return email;
  const [local, domain] = parts as [string, string];
  if (local.length <= 2) {
    return `${local.charAt(0)}*@${domain}`;
  }
  return `${local.slice(0, 2)}***@${domain}`;
}

export class MfaService {
  constructor(
    private readonly redis: Redis,
    private readonly mailService?: MailService | undefined,
    private readonly signToken?: ((payload: MfaTokenPayload) => string) | undefined,
    private readonly verifyToken?: ((token: string) => MfaTokenPayload) | undefined,
  ) {}

  /**
   * Check if MFA is enabled for a given principal.
   */
  async isMfaEnabled(principalId: string): Promise<boolean> {
    const val = await this.redis.get(`mfa:enabled:${principalId}`);
    return val === '1' || val === 'EMAIL_OTP';
  }

  /**
   * Get MFA status for a principal.
   */
  async getStatus(principalId: string): Promise<{ mfaEnabled: boolean; mfaType: string | null }> {
    const val = await this.redis.get(`mfa:enabled:${principalId}`);
    const enabled = val === '1' || val === 'EMAIL_OTP';
    return {
      mfaEnabled: enabled,
      mfaType: enabled ? 'EMAIL_OTP' : null,
    };
  }

  /**
   * Enable MFA for a principal.
   */
  async enableMfa(principalId: string, mfaType: 'EMAIL_OTP' = 'EMAIL_OTP'): Promise<void> {
    await this.redis.set(`mfa:enabled:${principalId}`, mfaType);
  }

  /**
   * Disable MFA for a principal.
   */
  async disableMfa(principalId: string): Promise<void> {
    await this.redis.del(`mfa:enabled:${principalId}`);
  }

  /**
   * Initiate an MFA challenge: creates OTP, sends email, returns challenge token.
   */
  async createChallenge(principalId: string, email: string): Promise<MfaChallengeResult> {
    const code = String(randomInt(100000, 999999));
    const jti = randomUUID();

    // Store in Redis: code + attempts
    const otpKey = `mfa:otp:${jti}`;
    await this.redis.set(otpKey, JSON.stringify({ principalId, code, attempts: 0 }), 'EX', OTP_TTL_SECONDS);

    // Send Email OTP via MailService
    if (this.mailService) {
      await this.mailService.sendMail({
        to: email,
        subject: 'Your 2FA Verification Code — Sarjan Construction ERP',
        text: `Your two-factor authentication code is: ${code}. It expires in 5 minutes. Do not share this code with anyone.`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #1e3a8a; margin-top: 0;">Two-Factor Authentication</h2>
            <p>Your login verification code is:</p>
            <div style="text-align: center; margin: 24px 0;">
              <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1e3a8a; background-color: #f1f5f9; padding: 12px 24px; border-radius: 6px;">
                ${code}
              </span>
            </div>
            <p style="font-size: 13px; color: #64748b;">
              This code will expire in <strong>5 minutes</strong>. If you did not request this login, please contact your company administrator immediately.
            </p>
          </div>
        `,
      });
    }

    const mfaToken = this.signToken
      ? this.signToken({
          sub: principalId,
          loginId: email,
          email,
          jti,
          typ: 'MFA_CHALLENGE',
        })
      : jti;

    return {
      mfaRequired: true,
      mfaToken,
      mfaType: 'EMAIL_OTP',
      maskedEmail: maskEmail(email),
      expiresInSeconds: OTP_TTL_SECONDS,
    };
  }

  /**
   * Resend OTP for an existing MFA challenge token.
   */
  async resendOtp(mfaToken: string): Promise<MfaChallengeResult> {
    if (!this.verifyToken) {
      throw new AppError(400, 'MFA_NOT_CONFIGURED', 'MFA token verification not configured');
    }
    let payload: MfaTokenPayload;
    try {
      payload = this.verifyToken(mfaToken);
      if (payload.typ !== 'MFA_CHALLENGE') {
        throw new UnauthorizedError('INVALID_MFA_TOKEN');
      }
    } catch {
      throw new UnauthorizedError('INVALID_MFA_TOKEN');
    }
    await this.redis.del(`mfa:otp:${payload.jti}`);
    return this.createChallenge(payload.sub, payload.email);
  }

  /**
   * Verify the 6-digit code presented with the mfaToken.
   */
  async verifyChallenge(mfaToken: string, code: string): Promise<MfaVerifyResult> {
    let jti = mfaToken;
    let expectedPrincipalId: string | null = null;

    if (this.verifyToken) {
      try {
        const payload = this.verifyToken(mfaToken);
        if (payload.typ !== 'MFA_CHALLENGE') {
          throw new UnauthorizedError('INVALID_MFA_TOKEN');
        }
        jti = payload.jti;
        expectedPrincipalId = payload.sub;
      } catch {
        throw new UnauthorizedError('INVALID_MFA_TOKEN');
      }
    }

    const otpKey = `mfa:otp:${jti}`;
    const raw = await this.redis.get(otpKey);
    if (!raw) {
      throw new AppError(400, 'MFA_CODE_EXPIRED', 'Verification code expired or invalid');
    }

    const data = JSON.parse(raw) as { principalId: string; code: string; attempts: number };

    if (expectedPrincipalId && data.principalId !== expectedPrincipalId) {
      throw new UnauthorizedError('INVALID_MFA_TOKEN');
    }

    if (data.code !== code.trim()) {
      const nextAttempts = data.attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await this.redis.del(otpKey);
        throw new AppError(429, 'MFA_LOCKED', 'Too many failed attempts. Please request a new code.');
      }
      await this.redis.set(
        otpKey,
        JSON.stringify({ ...data, attempts: nextAttempts }),
        'KEEPTTL',
      );
      throw new AppError(400, 'INVALID_MFA_CODE', `Invalid code. ${String(MAX_ATTEMPTS - nextAttempts)} attempt(s) remaining.`);
    }

    // Success — consume OTP single-use
    await this.redis.del(otpKey);

    return {
      principalId: data.principalId,
    };
  }
}
