import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../common/errors/app-error.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      const body: ErrorBody = {
        error: { code: error.code, message: error.message, requestId },
      };
      return reply.status(error.statusCode).send(body);
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      const body: ErrorBody = {
        error: { code: error.code, message: error.message, requestId },
      };
      return reply.status(error.statusCode).send(body);
    }

    request.log.error({ err: error }, 'unhandled error');
    const body: ErrorBody = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        requestId,
      },
    };
    return reply.status(500).send(body);
  });
});
