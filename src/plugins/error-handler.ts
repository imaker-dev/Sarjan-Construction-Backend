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
    request.log.warn(
      {
        method: request.method,
        url: request.url,
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        requestId: request.id,
      },
      `API Error [404 NOT_FOUND] ${request.method} ${request.url}`,
    );
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id },
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      request.log.warn(
        {
          method: request.method,
          url: request.url,
          statusCode: error.statusCode,
          errorCode: error.code,
          errorMessage: error.message,
          requestId,
        },
        `API Error [${error.statusCode} ${error.code}] ${request.method} ${request.url}: ${error.message}`,
      );
      const body: ErrorBody = {
        error: { code: error.code, message: error.message, requestId },
      };
      return reply.status(error.statusCode).send(body);
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      request.log.warn(
        {
          method: request.method,
          url: request.url,
          statusCode: error.statusCode,
          errorCode: error.code,
          errorMessage: error.message,
          validation: error.validation,
          requestId,
        },
        `API Error [${error.statusCode} ${error.code}] ${request.method} ${request.url}: ${error.message}`,
      );
      const body: ErrorBody = {
        error: { code: error.code, message: error.message, requestId },
      };
      return reply.status(error.statusCode).send(body);
    }

    request.log.error(
      {
        method: request.method,
        url: request.url,
        statusCode: 500,
        err: error,
        requestId,
      },
      `API Unhandled Error [500] ${request.method} ${request.url}: ${error.message}`,
    );
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
