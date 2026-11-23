import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { MailService } from './service.js';

const SendMailBody = Type.Object({
  to: Type.Union([Type.String({ format: 'email' }), Type.Array(Type.String({ format: 'email' }))]),
  cc: Type.Optional(
    Type.Union([Type.String({ format: 'email' }), Type.Array(Type.String({ format: 'email' }))]),
  ),
  bcc: Type.Optional(
    Type.Union([Type.String({ format: 'email' }), Type.Array(Type.String({ format: 'email' }))]),
  ),
  subject: Type.String({ minLength: 1, maxLength: 250 }),
  text: Type.Optional(Type.String()),
  html: Type.Optional(Type.String()),
});

export function mailRoutes(mailService: MailService) {
  return async function routes(app: FastifyInstance) {
    const authGuard = async (req: FastifyRequest) => {
      await app.authenticate(req);
    };

    // View active mail server configuration details
    app.get(
      '/mail/config',
      {
        preHandler: [authGuard],
      },
      async () => {
        return mailService.getConfig();
      },
    );

    // Verify connectivity and authentication with SMTP mail server
    app.post(
      '/mail/verify',
      {
        preHandler: [authGuard],
      },
      async () => {
        const connected = await mailService.verifyConnection();
        return {
          connected,
          message: connected
            ? 'SMTP server connection and credentials verified successfully'
            : 'Failed to connect to SMTP server. Please verify network or password',
        };
      },
    );

    // Send a message via SMTP mail server
    app.post(
      '/mail/send',
      {
        preHandler: [authGuard],
        schema: {
          body: SendMailBody,
        },
      },
      async (req) => {
        const body = req.body as {
          to: string | string[];
          cc?: string | string[];
          bcc?: string | string[];
          subject: string;
          text?: string;
          html?: string;
        };

        const result = await mailService.sendMail(body);
        return result;
      },
    );
  };
}
