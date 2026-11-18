import nodemailer, { type Transporter } from 'nodemailer';
import type {
  MailConfig,
  SendMailOptions,
  SendMailResult,
  EmployeeInvitationMailOptions,
  LeaveStatusMailOptions,
} from './types.js';

export function resolveDefaultMailConfig(): MailConfig {
  return {
    smtpHost: process.env.SMTP_HOST ?? 'imaker.in',
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465,
    smtpSecure: process.env.SMTP_SECURE !== undefined ? process.env.SMTP_SECURE === 'true' : true,
    smtpUser: process.env.SMTP_USER ?? 'info@imaker.in',
    smtpPass: process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD ?? '',
    fromName: process.env.MAIL_FROM_NAME ?? 'Sarjan Construction ERP',
    fromEmail: process.env.MAIL_FROM_EMAIL ?? 'info@imaker.in',

    // Incoming servers configuration
    incomingHost: process.env.INCOMING_MAIL_HOST ?? 'imaker.in',
    imapPort: 993,
    pop3Port: 995,
  };
}

export const DEFAULT_MAIL_CONFIG: MailConfig = resolveDefaultMailConfig();

export class MailService {
  private readonly config: MailConfig;
  private transporter: Transporter | null = null;

  constructor(customConfig?: Partial<MailConfig>, customTransporter?: Transporter) {
    this.config = {
      ...resolveDefaultMailConfig(),
      ...customConfig,
    };

    if (customTransporter) {
      this.transporter = customTransporter;
    } else {
      this.initTransporter();
    }
  }

  private initTransporter(): void {
    // When the domain is behind Cloudflare proxy, direct mail traffic routes to the mail server IP
    const host =
      this.config.smtpHost === 'imaker.in' || this.config.smtpHost === 'mail.imaker.in'
        ? '103.180.163.66'
        : this.config.smtpHost;

    this.transporter = nodemailer.createTransport({
      host,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      auth: {
        user: this.config.smtpUser,
        pass: this.config.smtpPass,
      },
      tls: {
        rejectUnauthorized: false,
        servername: 'imaker.in',
      },
    });
  }

  /**
   * Verify SMTP credentials and connection to mail server.
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a custom email via SMTP.
   */
  async sendMail(options: SendMailOptions): Promise<SendMailResult> {
    if (!this.transporter) {
      return { success: false, error: 'Mail transporter not initialized' };
    }

    const fromAddress = `"${this.config.fromName}" <${this.config.fromEmail}>`;

    try {
      const info = await this.transporter.sendMail({
        from: fromAddress,
        to: options.to,
        ...(options.cc !== undefined ? { cc: options.cc } : {}),
        ...(options.bcc !== undefined ? { bcc: options.bcc } : {}),
        subject: options.subject,
        ...(options.text !== undefined ? { text: options.text } : {}),
        ...(options.html !== undefined ? { html: options.html } : {}),
        ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : { replyTo: this.config.fromEmail }),
        ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
      });

      return {
        success: true,
        messageId: info.messageId,
        accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
        rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Send an employee onboarding / invitation email with claim code.
   */
  async sendEmployeeInvitation(options: EmployeeInvitationMailOptions): Promise<SendMailResult> {
    const claimUrl = options.claimUrl ?? 'https://sarjan.imaker.in/claim';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #1e3a8a; margin: 0;">Sarjan Construction ERP</h2>
          <p style="color: #64748b; margin-top: 4px;">Welcome to ${options.companyName}</p>
        </div>
        <div style="background-color: #f8fafc; padding: 20px; border-radius: 6px; margin-bottom: 20px;">
          <p style="margin-top: 0;">Hello <strong>${options.employeeName}</strong>,</p>
          <p>You have been invited to join <strong>${options.companyName}</strong> on the Sarjan Construction ERP platform.</p>
          <p>To set up your account and password, please use the secure claim code below:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="display: inline-block; font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #1e3a8a; background-color: #e2e8f0; padding: 12px 24px; border-radius: 6px;">
              ${options.claimCode}
            </span>
          </div>
          <p style="text-align: center; margin-top: 16px;">
            <a href="${claimUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Claim Your Account
            </a>
          </p>
        </div>
        <p style="font-size: 13px; color: #94a3b8; text-align: center; margin-bottom: 0;">
          This code is single-use and will expire after onboarding. If you did not expect this invitation, please ignore this email.
        </p>
      </div>
    `;

    const text = `Hello ${options.employeeName},\n\nYou have been invited to join ${options.companyName} on the Sarjan Construction ERP platform.\n\nYour account claim code is: ${options.claimCode}\n\nClaim your account at: ${claimUrl}\n\nThank you,\nSarjan Construction`;

    return this.sendMail({
      to: options.to,
      subject: `Welcome to ${options.companyName} — Account Invitation`,
      text,
      html,
    });
  }

  /**
   * Send a leave request review notification (Approved / Rejected).
   */
  async sendLeaveStatusNotification(options: LeaveStatusMailOptions): Promise<SendMailResult> {
    const isApproved = options.status === 'APPROVED';
    const statusColor = isApproved ? '#16a34a' : '#dc2626';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #1e3a8a; margin-top: 0;">Leave Request Update</h2>
        <p>Hello <strong>${options.employeeName}</strong>,</p>
        <p>Your leave request for <strong>${options.leaveType}</strong> has been updated:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Status:</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: ${statusColor};">${options.status}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Duration:</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${options.startDate} to ${options.endDate} (${options.totalDays} day${options.totalDays > 1 ? 's' : ''})</td>
          </tr>
          ${options.reviewerName ? `<tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Reviewed By:</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${options.reviewerName}</td></tr>` : ''}
          ${options.rejectionReason ? `<tr><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b;">Reason:</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #dc2626;">${options.rejectionReason}</td></tr>` : ''}
        </table>
        <p style="font-size: 13px; color: #94a3b8; margin-top: 24px;">
          Sarjan Construction ERP — Attendance & Leave Management
        </p>
      </div>
    `;

    const text = `Hello ${options.employeeName},\n\nYour leave request for ${options.leaveType} (${options.startDate} to ${options.endDate}) has been ${options.status}.\n\nThank you,\nSarjan Construction`;

    return this.sendMail({
      to: options.to,
      subject: `Leave Request ${options.status}: ${options.leaveType}`,
      text,
      html,
    });
  }

  /**
   * Returns the active mail configuration (passwords omitted).
   */
  getConfig(): Omit<MailConfig, 'smtpPass'> {
    return {
      smtpHost: this.config.smtpHost,
      smtpPort: this.config.smtpPort,
      smtpSecure: this.config.smtpSecure,
      smtpUser: this.config.smtpUser,
      fromName: this.config.fromName,
      fromEmail: this.config.fromEmail,
      incomingHost: this.config.incomingHost,
      imapPort: this.config.imapPort,
      pop3Port: this.config.pop3Port,
    };
  }
}
