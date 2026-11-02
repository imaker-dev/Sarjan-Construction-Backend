import { describe, it, expect, beforeEach } from 'vitest';
import {
  DocumentService,
  makeSubmissionDocVerifier,
} from '../../../src/modules/document/service.js';
import {
  DocumentNotAvailableError,
  DocumentStorageError,
  DocumentUnsupportedTypeError,
} from '../../../src/modules/document/errors.js';
import { sanitizeFileName } from '../../../src/modules/document/filename.js';
import { sniffContentType } from '../../../src/modules/document/sniff.js';
import { makeDocumentStorage } from '../../../src/modules/document/storage.js';
import { FormSubmissionService } from '../../../src/modules/form-submission/service.js';
import { FakeSubmissionUoW } from '../form-submission/fakes.js';
import {
  InvalidStatusTransitionError,
  OrgEntityNotFoundError,
} from '../../../src/modules/organization/errors.js';
import { AccessDeniedError } from '../../../src/modules/access-control/errors.js';
import { FakeDocumentUoW, FakeStorage, emptyDocumentStore, fakeDocument } from './fakes.js';
import type { DocumentStore } from './fakes.js';
import { FakeAuthorizer, fakeInstance } from '../workflow-instance/fakes.js';
import { fakeDepartment, fakeOperation } from '../form-submission/fakes.js';
import type { ActorContext } from '../../../src/modules/organization/types.js';

const actor: ActorContext = { actorId: 'principal-1', actorType: 'USER' };
const reviewer: ActorContext = { actorId: 'reviewer-1', actorType: 'USER' };

/** Grants a principal the listed scope ids (all permissions); denies the rest. */
class ScopedAuthorizer extends FakeAuthorizer {
  constructor(private readonly grants: Map<string, Set<string>>) {
    super(true);
  }
  private ok(principalId: string, target: { scopeId: string }): boolean {
    return this.grants.get(principalId)?.has(target.scopeId) === true;
  }
  override async assertPermission(
    principalId: string,
    permissionKey: string,
    target: { scopeId: string },
  ): Promise<void> {
    if (!this.ok(principalId, target)) {
      throw new AccessDeniedError(`${permissionKey} denied at scope`);
    }
  }
  override async hasPermission(
    principalId: string,
    _permissionKey: string,
    target: { scopeId: string },
  ): Promise<boolean> {
    return this.ok(principalId, target);
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ header

const INSTANCE_ID = '33333333-3333-3333-3333-333333333333';
const FORM_VERSION_ID = '11111111-1111-1111-1111-111111111111';
const DOC_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let store: DocumentStore;
let storage: FakeStorage;
let authorizer: FakeAuthorizer;
let service: DocumentService;

beforeEach(() => {
  store = emptyDocumentStore();
  storage = new FakeStorage();
  authorizer = new FakeAuthorizer(true);
  service = new DocumentService({
    uow: new FakeDocumentUoW(store),
    authorizer,
    storage,
    maxBytes: 10 * 1024 * 1024,
    staleUploadingMinutes: 60,
  });
});

const docs = () => store.documents;
const links = () => store.documentLinks;

const fileSchema = {
  fields: [
    { key: 'amount', type: 'DECIMAL', label: 'Amount', required: true },
    { key: 'photo', type: 'IMAGE', label: 'Photo' },
    { key: 'note', type: 'TEXT', label: 'Note' },
  ],
};

const formDef = {
  initialState: 'SUBMITTED',
  steps: [
    {
      key: 'collect',
      kind: 'EXECUTION',
      from: 'SUBMITTED',
      action: 'EXECUTE',
      to: 'COMPLETED',
      formVersionId: FORM_VERSION_ID,
    },
    { key: 'close', kind: 'CLOSURE', from: 'COMPLETED', action: 'CLOSE', to: 'CLOSED' },
  ],
};

/** Seed the org/instance/form graph a link or submission needs. */
function seedTargetGraph() {
  store.departments.push(fakeDepartment({ id: 'd1', companyId: 'c1' }));
  store.operations.push(fakeOperation({ id: 'op1', companyId: 'c1', departmentId: 'd1' }));
  store.workflowVersions.push({
    id: 'wfv1',
    companyId: 'c1',
    workflowId: 'wf1',
    definition: formDef,
  });
  store.instances.push(fakeInstance({ id: INSTANCE_ID }));
  store.formRows.push({ id: 'f1', companyId: 'c1', operationId: 'op1', status: 'ACTIVE' });
  store.formVersionRows.push({
    id: FORM_VERSION_ID,
    companyId: 'c1',
    formId: 'f1',
    schema: fileSchema,
  });
}

function seedSubmission() {
  store.formSubmissions.push({
    id: 'sub-1',
    companyId: 'c1',
    operationId: 'op1',
    workflowInstanceId: INSTANCE_ID,
    formId: 'f1',
    formVersionId: FORM_VERSION_ID,
    status: 'DRAFT',
    draftValues: null,
    latestRevision: 0,
    currentRevisionId: null,
    submittedByPrincipalId: null,
    submittedAt: null,
    returnedReason: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function uploadApproved() {
  const d = await service.upload(actor, 'c1', { fileName: 'site.png', body: PNG });
  await service.approve(reviewer, 'c1', d.id);
  return d;
}

describe('filename + sniff', () => {
  it('sanitizes path traversal, control chars, and empties', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\win\\sys32.dll')).toBe('sys32.dll');
    expect(sanitizeFileName('a\nb.png')).toBe('ab.png');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('x'.repeat(200))).toHaveLength(120);
  });

  it('sniffs PNG/JPEG/PDF magic bytes and rejects the rest', () => {
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffContentType(EXE)).toBeNull();
  });
});

describe('upload lifecycle', () => {
  it('UPLOADING → QUARANTINED with server-verified metadata + audit', async () => {
    const d = await service.upload(actor, 'c1', { fileName: 'site.png', body: PNG });
    expect(d.status).toBe('QUARANTINED');
    expect(d.contentType).toBe('image/png');
    expect(d.sizeBytes).toBe(PNG.length);
    expect(d.sha256).toHaveLength(64);
    expect(d.storageKey.startsWith('c/c1/')).toBe(true);
    expect(storage.objects.size).toBe(1);
    expect(store.auditLog.map((a) => a.action)).toEqual([
      'DOCUMENT_UPLOAD_INITIATED',
      'DOCUMENT_UPLOADED',
    ]);
  });

  it('rejects disallowed bytes → REJECTED row, no object, audited', async () => {
    await expect(service.upload(actor, 'c1', { fileName: 'evil.exe', body: EXE })).rejects.toThrow(
      DocumentUnsupportedTypeError,
    );
    expect(docs()[0]?.status).toBe('REJECTED');
    expect(storage.objects.size).toBe(0);
    expect(store.auditLog.some((a) => a.action === 'DOCUMENT_REJECTED')).toBe(true);
  });

  it('storage failure marks REJECTED and cleans the partial object', async () => {
    storage.failPut = 'disk full';
    await expect(service.upload(actor, 'c1', { fileName: 'a.png', body: PNG })).rejects.toThrow(
      DocumentStorageError,
    );
    expect(docs()[0]?.status).toBe('REJECTED');
    expect(storage.objects.size).toBe(0);
  });
});

describe('quarantine / approve / download', () => {
  it('only AVAILABLE documents download — even for the uploader', async () => {
    const d = await service.upload(actor, 'c1', { fileName: 'site.png', body: PNG });
    await expect(service.getDownload(actor, 'c1', d.id)).rejects.toThrow(DocumentNotAvailableError);
    const approved = await service.approve(reviewer, 'c1', d.id);
    expect(approved.status).toBe('AVAILABLE');
    const dl = await service.getDownload(actor, 'c1', d.id);
    expect(dl.fileName).toBe('site.png');
    expect(dl.contentType).toBe('image/png');
    expect(store.auditLog.some((a) => a.action === 'DOCUMENT_DOWNLOADED')).toBe(true);
  });

  it('archived docs cannot download but stay queryable', async () => {
    const d = await uploadApproved();
    await service.archive(reviewer, 'c1', d.id);
    await expect(service.getDownload(actor, 'c1', d.id)).rejects.toThrow(DocumentNotAvailableError);
    expect(docs()[0]?.status).toBe('ARCHIVED');
  });

  it('reject removes the object and blocks download', async () => {
    const d = await service.upload(actor, 'c1', { fileName: 'a.png', body: PNG });
    await service.reject(reviewer, 'c1', d.id, 'not a site photo');
    expect(storage.objects.size).toBe(0);
    await expect(service.getDownload(actor, 'c1', d.id)).rejects.toThrow(DocumentNotAvailableError);
  });
});

describe('links', () => {
  it('links AVAILABLE doc to a declared FILE/IMAGE field; non-file fields rejected', async () => {
    seedTargetGraph();
    seedSubmission();
    const d = await uploadApproved();
    await service.link(actor, 'c1', d.id, {
      kind: 'FORM_SUBMISSION',
      formSubmissionId: 'sub-1',
      fieldKey: 'photo',
    });
    expect(links()).toHaveLength(1);
    const d2 = await uploadApproved();
    await expect(
      service.link(actor, 'c1', d2.id, {
        kind: 'FORM_SUBMISSION',
        formSubmissionId: 'sub-1',
        fieldKey: 'note',
      }),
    ).rejects.toThrow(/cannot reference documents/);
    await expect(
      service.link(actor, 'c1', d2.id, {
        kind: 'FORM_SUBMISSION',
        formSubmissionId: 'sub-1',
        fieldKey: 'nope',
      }),
    ).rejects.toThrow(/not declared/);
  });

  it('quarantined docs cannot link; duplicate active link rejected', async () => {
    seedTargetGraph();
    seedSubmission();
    const q = await service.upload(actor, 'c1', { fileName: 'q.png', body: PNG });
    await expect(
      service.link(actor, 'c1', q.id, { kind: 'FORM_SUBMISSION', formSubmissionId: 'sub-1' }),
    ).rejects.toThrow(DocumentNotAvailableError);
    const d = await uploadApproved();
    await service.link(actor, 'c1', d.id, {
      kind: 'FORM_SUBMISSION',
      formSubmissionId: 'sub-1',
      fieldKey: 'photo',
    });
    await expect(
      service.link(actor, 'c1', d.id, {
        kind: 'FORM_SUBMISSION',
        formSubmissionId: 'sub-1',
        fieldKey: 'photo',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('instance links work; unlink is soft and preserves history', async () => {
    seedTargetGraph();
    const d = await uploadApproved();
    await service.link(actor, 'c1', d.id, {
      kind: 'WORKFLOW_INSTANCE',
      workflowInstanceId: INSTANCE_ID,
    });
    const link = links()[0];
    if (link === undefined) throw new Error('missing link');
    await service.unlink(actor, 'c1', link.id);
    expect(links()[0]?.unlinkedAt).not.toBeNull();
    expect(links()[0]?.unlinkedByPrincipalId).toBe('principal-1');
    await expect(service.unlink(actor, 'c1', link.id)).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });
});

describe('reconcile', () => {
  it('stale UPLOADING rows become REJECTED and objects are removed', async () => {
    const stale = fakeDocument({
      status: 'UPLOADING',
      uploadedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const rej = fakeDocument({ status: 'REJECTED' });
    store.documents.push(stale, rej);
    storage.objects.set(stale.storageKey, PNG);
    storage.objects.set(rej.storageKey, PNG);
    const r = await service.reconcile(reviewer, 'c1');
    expect(r.staleUploadingMarked).toBe(1);
    expect(r.rejectedObjectsDeleted).toBe(2);
    expect(store.documents.find((d) => d.id === stale.id)?.status).toBe('REJECTED');
    expect(storage.objects.size).toBe(0);
  });
});

describe('authorization', () => {
  it('denies without permission; cross-company is not found', async () => {
    const strict = new DocumentService({
      uow: new FakeDocumentUoW(store),
      authorizer: new FakeAuthorizer(false),
      storage,
      maxBytes: 10 * 1024 * 1024,
      staleUploadingMinutes: 60,
    });
    await expect(strict.upload(actor, 'c1', { fileName: 'a.png', body: PNG })).rejects.toThrow(
      AccessDeniedError,
    );
    const d = await service.upload(actor, 'c1', { fileName: 'a.png', body: PNG });
    await service.approve(reviewer, 'c1', d.id);
    // A different principal with no link-scope permission is denied.
    const stranger: ActorContext = { actorId: 'principal-9', actorType: 'USER' };
    await expect(strict.getDownload(stranger, 'c1', d.id)).rejects.toThrow(AccessDeniedError);
    await expect(service.getDownload(actor, 'c2', d.id)).rejects.toThrow(OrgEntityNotFoundError);
  });
});

describe('local storage guard', () => {
  it('refuses production; null when dir unset', () => {
    expect(makeDocumentStorage(undefined, 'development')).toBeNull();
    expect(() => makeDocumentStorage('/tmp/docs', 'production')).toThrow(DocumentStorageError);
    expect(makeDocumentStorage('/tmp/docs', 'development')).not.toBeNull();
  });
});

describe('scope + quarantine review access', () => {
  const HO = 'ho-1';
  const PRJ = 'prj-1';
  const PRJ2 = 'prj-2';
  const SITE = 'site-1';

  function scopedService(grants: Map<string, Set<string>>) {
    return new DocumentService({
      uow: new FakeDocumentUoW(store),
      authorizer: new ScopedAuthorizer(grants),
      storage,
      maxBytes: 10 * 1024 * 1024,
      staleUploadingMinutes: 60,
    });
  }

  function seedScopes() {
    store.headOfficeRows.push({ id: HO, companyId: 'c1' });
    store.projectRows.push({ id: PRJ, companyId: 'c1', headOfficeId: HO });
    store.projectRows.push({ id: PRJ2, companyId: 'c1', headOfficeId: HO });
    store.siteRows.push({ id: SITE, companyId: 'c1', projectId: PRJ });
  }

  it('captures and validates the upload scope; unknown/cross-company scope fails', async () => {
    seedScopes();
    const svc = scopedService(new Map([['principal-1', new Set([PRJ])]]));
    const d = await svc.upload(actor, 'c1', {
      fileName: 'a.png',
      body: PNG,
      scope: { scopeType: 'PROJECT', projectId: PRJ },
    });
    expect(d.scopeType).toBe('PROJECT');
    expect(d.projectId).toBe(PRJ);
    await expect(
      svc.upload(actor, 'c1', {
        fileName: 'b.png',
        body: PNG,
        scope: { scopeType: 'PROJECT', projectId: 'nope' },
      }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    // uploader granted only at PRJ — cannot upload at company scope
    await expect(svc.upload(actor, 'c1', { fileName: 'c.png', body: PNG })).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it('scoped reviewer inspects a QUARANTINED doc; other-scope reviewer and readers cannot', async () => {
    seedScopes();
    const uploader = scopedService(new Map([['principal-1', new Set([PRJ])]]));
    const d = await uploader.upload(actor, 'c1', {
      fileName: 'a.png',
      body: PNG,
      scope: { scopeType: 'PROJECT', projectId: PRJ },
    });
    const svc = scopedService(
      new Map([
        ['rev-prj', new Set([PRJ])],
        ['rev-other', new Set([PRJ2])],
      ]),
    );
    const rv: ActorContext = { actorId: 'rev-prj', actorType: 'USER' };
    const stream = await svc.getReviewStream(rv, 'c1', d.id);
    expect(stream.fileName).toBe('a.png');
    expect(store.auditLog.some((a) => a.action === 'DOCUMENT_REVIEW_ACCESSED')).toBe(true);
    // reviewer scoped to another project cannot inspect
    const other: ActorContext = { actorId: 'rev-other', actorType: 'USER' };
    await expect(svc.getReviewStream(other, 'c1', d.id)).rejects.toThrow(AccessDeniedError);
    // review path does not turn into a download for normal readers
    await expect(svc.getDownload(other, 'c1', d.id)).rejects.toThrow(AccessDeniedError);
    await expect(svc.getDownload(rv, 'c1', d.id)).rejects.toThrow(DocumentNotAvailableError);
  });

  it('review-access only streams quarantined docs — approved docs use the normal path', async () => {
    seedScopes();
    const svc = scopedService(new Map([['principal-1', new Set([PRJ, 'c1'])]]));
    const d = await svc.upload(actor, 'c1', { fileName: 'a.png', body: PNG });
    await service.approve(reviewer, 'c1', d.id);
    await expect(svc.getReviewStream(actor, 'c1', d.id)).rejects.toThrow(DocumentNotAvailableError);
  });

  it('project-scoped doc cannot be linked to a target outside its scope', async () => {
    seedScopes();
    seedTargetGraph(); // dept d1 is COMPANY-scoped
    seedSubmission();
    const svc = scopedService(new Map([['principal-1', new Set([PRJ, 'c1'])]]));
    const d = await svc.upload(actor, 'c1', {
      fileName: 'a.png',
      body: PNG,
      scope: { scopeType: 'PROJECT', projectId: PRJ },
    });
    await service.approve(reviewer, 'c1', d.id);
    // dept d1 is COMPANY → outside the PRJ doc scope → containment rejects
    await expect(
      svc.link(actor, 'c1', d.id, {
        kind: 'FORM_SUBMISSION',
        formSubmissionId: 'sub-1',
      }),
    ).rejects.toThrow(/outside the document scope/);
    // company-scoped doc can link anywhere in-company
    const cd = await service.upload(actor, 'c1', { fileName: 'c.png', body: PNG });
    await service.approve(reviewer, 'c1', cd.id);
    await service.link(actor, 'c1', cd.id, {
      kind: 'FORM_SUBMISSION',
      formSubmissionId: 'sub-1',
    });
    expect(links()).toHaveLength(1);
    // cross-company target fails as not-found
    await expect(
      service.link(actor, 'c2', cd.id, {
        kind: 'FORM_SUBMISSION',
        formSubmissionId: 'sub-1',
      }),
    ).rejects.toThrow();
  });

  it('site-scoped doc may link inside its site dept; approved reads still need permission', async () => {
    seedScopes();
    // dept scoped to SITE with a site→project chain
    store.departments.push(
      fakeDepartment({ id: 'd-site', companyId: 'c1', scopeType: 'SITE', siteId: SITE }),
    );
    store.operations.push(
      fakeOperation({ id: 'op-site', companyId: 'c1', departmentId: 'd-site' }),
    );
    store.formSubmissions.push({
      id: 'sub-site',
      companyId: 'c1',
      operationId: 'op-site',
      workflowInstanceId: 'i1',
      formId: 'f1',
      formVersionId: FORM_VERSION_ID,
      status: 'DRAFT',
      draftValues: null,
      latestRevision: 0,
      currentRevisionId: null,
      submittedByPrincipalId: null,
      submittedAt: null,
      returnedReason: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const svc = scopedService(
      new Map([
        ['principal-1', new Set([SITE])],
        ['rev', new Set([SITE])],
      ]),
    );
    const d = await svc.upload(actor, 'c1', {
      fileName: 'a.png',
      body: PNG,
      scope: { scopeType: 'SITE', siteId: SITE },
    });
    const svc2 = scopedService(
      new Map([
        ['rev', new Set([SITE])],
        ['principal-1', new Set([SITE])],
      ]),
    );
    await svc2.approve({ actorId: 'rev', actorType: 'USER' }, 'c1', d.id);
    await svc.link(actor, 'c1', d.id, {
      kind: 'FORM_SUBMISSION',
      formSubmissionId: 'sub-site',
    });
    expect(links()).toHaveLength(1);
    // approved download — stranger without scope is denied even though doc is AVAILABLE
    const stranger: ActorContext = { actorId: 'stranger', actorType: 'USER' };
    await expect(svc.getDownload(stranger, 'c1', d.id)).rejects.toThrow(AccessDeniedError);
  });
});

describe('form submission integration', () => {
  it('accepts $documentId only when AVAILABLE + linked to the field', async () => {
    seedTargetGraph();
    const subs = new FormSubmissionService(
      new FakeSubmissionUoW(store),
      authorizer,
      undefined,
      makeSubmissionDocVerifier(),
    );
    const doc = await uploadApproved();
    const s = await subs.createDraft(actor, 'c1', {
      workflowInstanceId: INSTANCE_ID,
      formVersionId: FORM_VERSION_ID,
    });
    // Not linked yet — must fail closed.
    await expect(
      subs.submit(actor, 'c1', s.id, { values: { amount: 5, photo: { $documentId: doc.id } } }),
    ).rejects.toThrow(OrgEntityNotFoundError);
    await service.link(actor, 'c1', doc.id, {
      kind: 'FORM_SUBMISSION',
      formSubmissionId: s.id,
      fieldKey: 'photo',
    });
    const r = await subs.submit(actor, 'c1', s.id, {
      values: { amount: 5, photo: { $documentId: doc.id } },
    });
    expect(r.submission.status).toBe('SUBMITTED');
  });

  it('FILE/IMAGE fields stay rejected when the verifier is not wired', async () => {
    seedTargetGraph();
    const subs = new FormSubmissionService(new FakeSubmissionUoW(store), authorizer);
    const s = await subs.createDraft(actor, 'c1', {
      workflowInstanceId: INSTANCE_ID,
      formVersionId: FORM_VERSION_ID,
    });
    await expect(
      subs.submit(actor, 'c1', s.id, {
        values: { amount: 5, photo: { $documentId: DOC_UUID } },
      }),
    ).rejects.toThrow(/unsupported/);
  });
});
