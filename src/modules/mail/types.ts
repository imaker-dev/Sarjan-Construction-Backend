export interface MailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  fromName: string;
  fromEmail: string;

  // Incoming configuration (for reference / polling)
  incomingHost: string;
  imapPort: number;
  pop3Port: number;
}

export interface MailAttachment {
  filename: string;
  content?: string | Buffer | undefined;
  path?: string | undefined;
  contentType?: string | undefined;
}

export interface SendMailOptions {
  to: string | string[];
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  attachments?: MailAttachment[] | undefined;
}

export interface SendMailResult {
  success: boolean;
  messageId?: string | undefined;
  accepted?: string[] | undefined;
  rejected?: string[] | undefined;
  error?: string | undefined;
}

export interface EmployeeInvitationMailOptions {
  to: string;
  employeeName: string;
  companyName: string;
  claimCode: string;
  claimUrl?: string | undefined;
}

export interface LeaveStatusMailOptions {
  to: string;
  employeeName: string;
  leaveType: string;
  status: 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reviewerName?: string | undefined;
  startDate: string;
  endDate: string;
  totalDays: number;
  rejectionReason?: string | undefined;
}
