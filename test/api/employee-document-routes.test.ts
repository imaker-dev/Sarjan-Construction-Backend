import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { buildApp } from '../../src/app.js';
import type { EmployeeDocumentService } from '../../src/modules/employee/document-service.js';
import type { AuthService } from '../../src/modules/auth/service.js';
import type { AccessControlService } from '../../src/modules/access-control/service.js';
import type { PrincipalContext } from '../../src/plugins/authentication.js';

const testEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
};

const CID = '00000000-0000-4000-8000-0000000000c1';
const EID = '00000000-0000-4000-8000-0000000000e1';
const DOC_ID = '00000000-0000-4000-8000-0000000000d1';

const sampleDoc = {
  id: DOC_ID,
  companyId: CID,
  employeeId: EID,
  documentId: 'stored-doc-1',
  documentType: 'AADHAAR',
  title: 'Aadhaar Card',
  documentNumber: '1234-5678-9012',
  issuingAuthority: 'UIDAI',
  issueDate: new Date('2022-01-01'),
  expiryDate: null,
  verificationStatus: 'PENDING',
  verifiedByPrincipalId: null,
  verifiedAt: null,
  rejectionReason: null,
  metadata: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  document: {
    id: 'stored-doc-1',
    storageKey: 'company/c1/aadhaar.pdf',
    originalFileName: 'aadhaar.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'abc123sha',
    status: 'AVAILABLE',
  },
};

async function makeApp() {
  const spies = {
    uploadAndAttach: vi.fn().mockResolvedValue(sampleDoc),
    attachExisting: vi.fn().mockResolvedValue(sampleDoc),
    listDocuments: vi.fn().mockResolvedValue([sampleDoc]),
    getDocument: vi.fn().mockResolvedValue(sampleDoc),
    downloadDocument: vi.fn().mockResolvedValue({
      stream: Readable.from([Buffer.from('dummy file bytes')]),
      contentType: 'application/pdf',
      fileName: 'aadhaar.pdf',
    }),
    updateDocument: vi.fn().mockResolvedValue({ ...sampleDoc, version: 2 }),
    verifyDocument: vi.fn().mockResolvedValue({
      ...sampleDoc,
      verificationStatus: 'VERIFIED',
      version: 2,
    }),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    getCallerEmployee: vi.fn().mockResolvedValue({ id: EID, displayName: 'John' }),
  };
  const mockDocService = spies as unknown as EmployeeDocumentService;

  const authService = {
    buildActorContext: async (claims: { sub?: string }) =>
      ({
        actorId: claims.sub ?? 'admin1',
        actorType: 'USER',
        sessionId: 's1',
      }) as unknown as PrincipalContext,
    verifyAccessToken: async () => ({ sub: 'admin1', sid: 's1' }),
  } as unknown as AuthService;

  const accessControl = {
    assertPermission: async () => undefined,
    hasPermission: async () => true,
  } as unknown as AccessControlService;

  const app = await buildApp({
    env: testEnv,
    services: {
      authService,
      accessControl,
      employeeDocumentService: mockDocService,
      platformCompanyId: null,
    },
  });

  const token = app.tokenService.signAccessToken('admin1', 's1');
  const headers = {
    authorization: `Bearer ${token}`,
    'x-company-id': CID,
  };

  return { app, spies, headers };
}

describe('Employee Document Routes', () => {
  it('POST /employees/:id/documents attaches existing or base64 file with 201', async () => {
    const { app, headers, spies } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/employees/${EID}/documents`,
        headers,
        payload: {
          documentId: '00000000-0000-4000-8000-000000000099',
          documentType: 'AADHAAR',
          title: 'Aadhaar Card',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; verificationStatus: string }>();
      expect(body.id).toBe(DOC_ID);
      expect(spies.attachExisting).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET /employees/:id/documents lists documents with 200', async () => {
    const { app, headers } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/employees/${EID}/documents`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<unknown[]>();
      expect(body).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('GET /employees/:id/documents/:docId returns document metadata with 200', async () => {
    const { app, headers } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/employees/${EID}/documents/${DOC_ID}`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; title: string }>();
      expect(body.id).toBe(DOC_ID);
      expect(body.title).toBe('Aadhaar Card');
    } finally {
      await app.close();
    }
  });

  it('GET /employees/:id/documents/:docId/download streams file with correct headers with 200', async () => {
    const { app, headers } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/employees/${EID}/documents/${DOC_ID}/download`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('aadhaar.pdf');
      expect(res.body).toBe('dummy file bytes');
    } finally {
      await app.close();
    }
  });

  it('PATCH /employees/:id/documents/:docId updates metadata with 200', async () => {
    const { app, headers, spies } = await makeApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/employees/${EID}/documents/${DOC_ID}`,
        headers,
        payload: {
          title: 'Updated Aadhaar Title',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(spies.updateDocument).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('POST /employees/:id/documents/:docId/verify verifies status with 200', async () => {
    const { app, headers, spies } = await makeApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/employees/${EID}/documents/${DOC_ID}/verify`,
        headers,
        payload: {
          status: 'VERIFIED',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(spies.verifyDocument).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('DELETE /employees/:id/documents/:docId deletes document with 204', async () => {
    const { app, headers, spies } = await makeApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/employees/${EID}/documents/${DOC_ID}`,
        headers,
      });

      expect(res.statusCode).toBe(204);
      expect(spies.deleteDocument).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET /me/documents returns caller documents with 200', async () => {
    const { app, headers } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/documents',
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<unknown[]>();
      expect(body).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('GET /me/documents/:docId/download streams caller document with 200', async () => {
    const { app, headers } = await makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/me/documents/${DOC_ID}/download`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.body).toBe('dummy file bytes');
    } finally {
      await app.close();
    }
  });
});
