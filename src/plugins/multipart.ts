import fp from 'fastify-plugin';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

export interface MultipartPluginOptions {
  maxFileSize?: number;
}

export default fp(async function multipartPlugin(
  app: FastifyInstance,
  opts?: MultipartPluginOptions,
) {
  await app.register(multipart, {
    limits: {
      fileSize: opts?.maxFileSize ?? 10 * 1024 * 1024, // 10MB default
      files: 1,
    },
    attachFieldsToBody: false,
  });
});
