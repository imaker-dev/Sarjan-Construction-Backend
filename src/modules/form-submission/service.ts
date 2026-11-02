import { randomUUID } from 'node:crypto';
import type { FormSubmission } from '@prisma/client';
import type { ActorContext, AuditRecord } from '../organization/types.js';
import {
  OrgEntityNotFoundError,
  OrgValidationError,
  InvalidStatusTransitionError,
} from '../organization/errors.js';
import type { Authorizer } from '../department/service.js';
import type { ScopeTarget } from '../access-control/service.js';
import { departmentScopeTarget } from '../operation/service.js';
import { TERMINAL_STATES } from '../workflow/definition-validation.js';
import { stepsOf } from '../workflow-instance/apply.js';
import { commandFingerprint } from '../workflow-instance/fingerprint.js';
import { IdempotencyConflictError } from '../workflow-instance/errors.js';
import {
  assertValuesObject,
  documentRefOf,
  fieldsOf,
  validateDraftValues,
  validateSubmitValues,
} from './value-check.js';
import type { SubmissionRepos, SubmissionUnitOfWork } from './repository.js';
import type {
  CreateSubmissionInput,
  SaveDraftInput,
  SubmitInput,
  SubmitResult,
  SubmissionDocVerifier,
  SubmissionListFilter,
} from './types.js';

export const FORM_SUBMISSION_READ = 'FORM_SUBMISSION_READ';
export const FORM_SUBMISSION_WRITE = 'FORM_SUBMISSION_WRITE';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function auditEntry(
  actor: ActorContext,
  base: Omit<AuditRecord, 'eventKey' | 'actorId' | 'actorType' | 'correlationId'>,
): AuditRecord {
  return {
    eventKey: randomUUID(),
    actorId: actor.actorId,
    actorType: actor.actorType,
    ...(actor.correlationId !== undefined ? { correlationId: actor.correlationId } : {}),
    ...base,
  };
}

export class FormSubmissionService {
  constructor(
    private readonly uow: SubmissionUnitOfWork,
    private readonly authorizer: Authorizer,
    private readonly now: () => Date = () => new Date(),
    private readonly docVerifier?: SubmissionDocVerifier,
  ) {}

  /**
   * Create a workflow-linked draft. The FormVersion must be referenced by a
   * step of the instance's PINNED WorkflowVersion — the caller cannot select
   * an arbitrary form or version.
   */
  async createDraft(
    actor: ActorContext,
    companyId: string,
    input: CreateSubmissionInput,
  ): Promise<FormSubmission> {
    if (!UUID_RE.test(input.workflowInstanceId)) {
      throw new OrgValidationError('workflowInstanceId', 'required — must be a UUID');
    }
    if (!UUID_RE.test(input.formVersionId)) {
      throw new OrgValidationError('formVersionId', 'must be a UUID');
    }
    if (input.values !== undefined) assertValuesObject(input.values);

    return this.uow.run(async (repos) => {
      const instance = await repos.instances.findById(companyId, input.workflowInstanceId);
      if (instance === null) throw new OrgEntityNotFoundError('WORKFLOW_INSTANCE');
      const target = await this.scopeTargetForOperation(repos, companyId, instance.operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_SUBMISSION_WRITE, target);
      if (TERMINAL_STATES.has(instance.state)) {
        throw new InvalidStatusTransitionError(
          'WORKFLOW_INSTANCE',
          instance.state,
          'create submission',
        );
      }
      // Authority is the pinned snapshot: the requested FormVersion must be
      // bound to a step of THIS instance's definition.
      const version = await repos.workflowVersions.findById(
        companyId,
        instance.workflowId,
        instance.workflowVersionId,
      );
      if (version === null) throw new OrgEntityNotFoundError('WORKFLOW_VERSION');
      const bound = stepsOf(version.definition).some(
        (s) => s.formVersionId === input.formVersionId,
      );
      if (!bound) {
        throw new OrgValidationError(
          'formVersionId',
          "not referenced by this instance's pinned workflow definition",
        );
      }
      const formVersion = await repos.formVersionRows.findById(companyId, input.formVersionId);
      if (formVersion === null) throw new OrgEntityNotFoundError('FORM_VERSION');
      const form = await repos.forms.findById(companyId, formVersion.formId);
      if (form === null) throw new OrgEntityNotFoundError('FORM');
      if (form.operationId !== instance.operationId) {
        throw new OrgValidationError('formVersionId', 'belongs to a different operation');
      }
      if (input.values !== undefined) {
        validateDraftValues(fieldsOf(formVersion.schema), input.values, {
          allowDocumentRefs: this.docVerifier !== undefined,
        });
      }
      const submission = await repos.submissionWrites.create({
        companyId,
        operationId: instance.operationId,
        workflowInstanceId: instance.id,
        formId: formVersion.formId,
        formVersionId: input.formVersionId,
        ...(input.values !== undefined ? { draftValues: input.values } : {}),
      });
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FORM_SUBMISSION_CREATED',
          entityType: 'FORM_SUBMISSION',
          entityId: submission.id,
          companyId,
          statusAfter: 'DRAFT',
          changedFields: {
            workflowInstanceId: { before: null, after: instance.id },
            formVersionId: { before: null, after: input.formVersionId },
          },
        }),
      );
      return submission;
    });
  }

  /** Save draft values — type/shape checked; required fields may be incomplete. */
  async saveDraft(
    actor: ActorContext,
    companyId: string,
    submissionId: string,
    input: SaveDraftInput,
  ): Promise<FormSubmission> {
    assertValuesObject(input.values);
    return this.uow.run(async (repos) => {
      const submission = await repos.submissionWrites.findById(companyId, submissionId);
      if (submission === null) throw new OrgEntityNotFoundError('FORM_SUBMISSION');
      const target = await this.scopeTargetForOperation(repos, companyId, submission.operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_SUBMISSION_WRITE, target);
      if (submission.status !== 'DRAFT' && submission.status !== 'RETURNED') {
        throw new InvalidStatusTransitionError('FORM_SUBMISSION', submission.status, 'saveDraft');
      }
      const formVersion = await repos.formVersionRows.findById(companyId, submission.formVersionId);
      if (formVersion === null) throw new OrgEntityNotFoundError('FORM_VERSION');
      validateDraftValues(fieldsOf(formVersion.schema), input.values, {
        allowDocumentRefs: this.docVerifier !== undefined,
      });
      const updated = await repos.submissionWrites.saveDraft(
        companyId,
        submissionId,
        input.values,
        input.expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FORM_SUBMISSION_DRAFT_SAVED',
          entityType: 'FORM_SUBMISSION',
          entityId: submissionId,
          companyId,
          statusBefore: submission.status,
          statusAfter: updated.status,
        }),
      );
      return updated;
    });
  }

  /**
   * Submit: full validation against the pinned FormVersion, then an
   * immutable SubmissionRevision is appended and the pointer advances — all
   * in one transaction. Guards read revisions, never draft values.
   */
  async submit(
    actor: ActorContext,
    companyId: string,
    submissionId: string,
    input: SubmitInput = {},
  ): Promise<SubmitResult> {
    if (input.values !== undefined) assertValuesObject(input.values);
    if (input.idempotencyKey === '') {
      throw new OrgValidationError('idempotencyKey', 'must be non-empty');
    }
    const fingerprint =
      input.idempotencyKey !== undefined
        ? commandFingerprint({
            action: 'SUBMIT',
            ...(input.values !== undefined ? { values: input.values } : {}),
          })
        : undefined;

    return this.uow.run(async (repos) => {
      const submission = await repos.submissionWrites.findById(companyId, submissionId);
      if (submission === null) throw new OrgEntityNotFoundError('FORM_SUBMISSION');
      const target = await this.scopeTargetForOperation(repos, companyId, submission.operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_SUBMISSION_WRITE, target);

      if (input.idempotencyKey !== undefined) {
        const recorded = await repos.submissionRevisions.findByIdempotencyKey(
          companyId,
          submissionId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.requestFingerprint !== fingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          return { submission, revision: recorded, replayed: true };
        }
      }
      if (submission.status !== 'DRAFT' && submission.status !== 'RETURNED') {
        throw new InvalidStatusTransitionError('FORM_SUBMISSION', submission.status, 'submit');
      }
      const formVersion = await repos.formVersionRows.findById(companyId, submission.formVersionId);
      if (formVersion === null) throw new OrgEntityNotFoundError('FORM_VERSION');
      const candidate = input.values ?? (submission.draftValues as Record<string, unknown> | null);
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new OrgValidationError('values', 'no draft values to submit');
      }
      const fields = fieldsOf(formVersion.schema);
      validateSubmitValues(fields, candidate, {
        allowDocumentRefs: this.docVerifier !== undefined,
      });
      // Every $documentId must resolve to an AVAILABLE document actively
      // linked to THIS submission and field — verified inside this tx.
      for (const field of fields) {
        const docId = field.key in candidate ? documentRefOf(candidate[field.key]) : null;
        if (docId !== null) {
          const ok =
            this.docVerifier !== undefined &&
            (await this.docVerifier(repos, companyId, submissionId, field.key, docId));
          if (!ok) throw new OrgEntityNotFoundError('DOCUMENT');
        }
      }

      const revision = await repos.submissionRevisions.create({
        companyId,
        submissionId,
        revision: submission.latestRevision + 1,
        values: candidate,
        ...(actor.actorType === 'USER' ? { submittedByPrincipalId: actor.actorId } : {}),
        ...(input.idempotencyKey !== undefined && fingerprint !== undefined
          ? { idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint }
          : {}),
        eventKey: randomUUID(),
      });
      const updated = await repos.submissionWrites.markSubmitted(
        companyId,
        submissionId,
        {
          currentRevisionId: revision.id,
          latestRevision: revision.revision,
          ...(actor.actorType === 'USER' ? { submittedByPrincipalId: actor.actorId } : {}),
          submittedAt: this.now(),
        },
        input.expectedVersion,
      );
      await repos.audit.record(
        auditEntry(actor, {
          action: 'FORM_SUBMISSION_SUBMITTED',
          entityType: 'FORM_SUBMISSION',
          entityId: submissionId,
          companyId,
          statusBefore: submission.status,
          statusAfter: 'SUBMITTED',
          changedFields: {
            revision: { before: submission.latestRevision, after: revision.revision },
          },
        }),
      );
      return { submission: updated, revision, replayed: false };
    });
  }

  async getSubmission(
    actor: ActorContext,
    companyId: string,
    submissionId: string,
  ): Promise<FormSubmission> {
    return this.uow.run(async (repos) => {
      const submission = await repos.submissionWrites.findById(companyId, submissionId);
      if (submission === null) throw new OrgEntityNotFoundError('FORM_SUBMISSION');
      const target = await this.scopeTargetForOperation(repos, companyId, submission.operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_SUBMISSION_READ, target);
      return submission;
    });
  }

  async listSubmissions(actor: ActorContext, companyId: string, filter?: SubmissionListFilter) {
    await this.authorizer.assertPermission(actor.actorId, FORM_SUBMISSION_READ, {
      companyId,
      scopeType: 'COMPANY',
      scopeId: companyId,
    });
    return this.uow.run(({ submissionWrites }) => submissionWrites.list(companyId, filter));
  }

  async listRevisions(actor: ActorContext, companyId: string, submissionId: string) {
    return this.uow.run(async (repos) => {
      const submission = await repos.submissionWrites.findById(companyId, submissionId);
      if (submission === null) throw new OrgEntityNotFoundError('FORM_SUBMISSION');
      const target = await this.scopeTargetForOperation(repos, companyId, submission.operationId);
      await this.authorizer.assertPermission(actor.actorId, FORM_SUBMISSION_READ, target);
      return repos.submissionRevisions.listBySubmission(companyId, submissionId);
    });
  }

  // ----------------------------------------------------------------- internal

  private async scopeTargetForOperation(
    repos: SubmissionRepos,
    companyId: string,
    operationId: string,
  ): Promise<ScopeTarget> {
    const operation = await repos.operations.findById(companyId, operationId);
    if (!operation) throw new OrgEntityNotFoundError('OPERATION');
    const department = await repos.departments.findById(companyId, operation.departmentId);
    if (!department) throw new OrgEntityNotFoundError('DEPARTMENT');
    return departmentScopeTarget(department);
  }
}
