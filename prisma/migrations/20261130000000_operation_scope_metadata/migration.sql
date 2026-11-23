-- Operation catalogue scope + leadership-inheritance metadata (additive).
--
-- appliesTo: which department scopes an operation may be enabled on.
-- leadershipInheritable: whether PROJECT-scoped leadership roles
--   (PROJECT_DIRECTOR / PROJECT_INCHARGE) inherit the operation from
--   departments under their assigned projects/sites.
--
-- New rows default to appliesTo=[COMPANY], leadershipInheritable=false.
-- Eligibility is NEVER inferred from key prefix, domain, or sensitive=false —
-- only the explicit reviewed lists below grant it.

ALTER TABLE "OperationCatalogueEntry"
  ADD COLUMN "appliesTo" "ScopeType"[] NOT NULL DEFAULT ARRAY['COMPANY']::"ScopeType"[],
  ADD COLUMN "leadershipInheritable" BOOLEAN NOT NULL DEFAULT FALSE;

-- ── appliesTo backfill ──────────────────────────────────────────────────────

-- Field / project-execution domains: may be enabled on departments at any
-- scope (company support depts, head office, project, site).
UPDATE "OperationCatalogueEntry"
SET "appliesTo" = ARRAY['COMPANY','HEAD_OFFICE','PROJECT','SITE']::"ScopeType"[]
WHERE "domain" IN (
  'ENGINEERING', 'LABOUR', 'PROJECT_ADMIN', 'QUALITY', 'SAFETY',
  'STORES', 'WORK_EXECUTION', 'PROJECT_REPORTS'
);

-- Financial / commercial / HR domains: company-level administration only.
UPDATE "OperationCatalogueEntry"
SET "appliesTo" = ARRAY['COMPANY','HEAD_OFFICE']::"ScopeType"[]
WHERE "domain" IN (
  'ACCOUNTING', 'BILLING', 'BUDGET', 'EMPLOYEE_RECORDS', 'PAYROLL',
  'QUOTATION', 'REPORT', 'PROJECT_FINANCE', 'WALLET'
);

-- Exceptions inside financial domains: request-side and ledger-visibility
-- ops that field staff (site/project departments) legitimately perform.
UPDATE "OperationCatalogueEntry"
SET "appliesTo" = ARRAY['COMPANY','HEAD_OFFICE','PROJECT','SITE']::"ScopeType"[]
WHERE "key" IN (
  'PETTY_CASH_REQUEST_SUBMIT',
  'PETTY_CASH_EXPENSE_SUBMIT',
  'EMPLOYEE_EXPENSE_SUBMIT',
  'PROJECT_QUOTATION_PREPARE',
  'PROJECT_WALLET_LEDGER_VIEW',
  'PROJECT_WALLET_RECEIPT_CONFIRM',
  'PROJECT_WALLET_RETURN_FUNDS'
);

-- ── leadershipInheritable backfill (explicit reviewed set) ──────────────────
--
-- Only day-to-day project/site execution, technical review, reporting, and
-- request-submission operations are inheritable. All approval, payment,
-- payroll, disbursement, reconciliation, and other high-impact operations
-- are deliberately excluded: for PD/PI those require department membership
-- plus an explicit per-employee grant (the separately authorized path).
UPDATE "OperationCatalogueEntry"
SET "leadershipInheritable" = TRUE
WHERE "key" IN (
  -- Engineering & drawings
  'CONCRETE_CUBE_SAMPLE_REGISTER',
  'CONCRETE_CUBE_TEST_RESULT_RECORD',
  'DRAWING_ISSUE_FOR_CONSTRUCTION',
  'DRAWING_REVIEW',
  'DRAWING_REVISION_SUBMIT',
  'DRAWING_SUBMIT',
  'REQUEST_FOR_INFORMATION_RESPOND',
  'REQUEST_FOR_INFORMATION_SUBMIT',
  -- Labour & attendance
  'LABOUR_ATTENDANCE_CORRECTION_REQUEST',
  'LABOUR_ATTENDANCE_MARK',
  'LABOUR_ATTENDANCE_REVIEW',
  'LABOUR_DAILY_REPORT_SUBMIT',
  'LABOUR_PROJECT_ASSIGN',
  'LABOUR_RECORD_CREATE',
  'LABOUR_SHIFT_ASSIGN',
  -- Project administration & site lifecycle (SITE_CLOSE excluded — high impact)
  'PROJECT_MILESTONE_MANAGE',
  'PROJECT_PLAN_CREATE',
  'PROJECT_PLAN_UPDATE',
  'PROJECT_TEAM_ASSIGN',
  'PROJECT_TEAM_VIEW',
  'SITE_CREATE',
  'SITE_UPDATE',
  'SITE_INSTRUCTION_ACKNOWLEDGE',
  'SITE_INSTRUCTION_CLOSE',
  'SITE_INSTRUCTION_CREATE',
  -- Project reporting & documents (PROJECT_COST_REPORT_GENERATE excluded — financial)
  'DAILY_SITE_REPORT_SUBMIT',
  'PROJECT_DASHBOARD_VIEW',
  'PROJECT_DOCUMENT_UPLOAD',
  'PROJECT_DOCUMENT_VIEW',
  'PROJECT_HANDOVER_SUBMIT',
  'PROJECT_MACHINERY_REPORT_VIEW',
  'PROJECT_MATERIAL_REPORT_VIEW',
  'PROJECT_QUALITY_REPORT_VIEW',
  'PROJECT_SAFETY_REPORT_VIEW',
  'WEEKLY_PROJECT_REPORT_GENERATE',
  -- Quality, defects, non-conformance
  'DEFECT_RECTIFICATION_VERIFY',
  'DEFECT_REPORT_CREATE',
  'NON_CONFORMANCE_CORRECTIVE_ACTION',
  'NON_CONFORMANCE_REPORT_CREATE',
  'QUALITY_INSPECTION_RECORD',
  'QUALITY_INSPECTION_REQUEST',
  'QUALITY_PLAN_MANAGE',
  'TECHNICAL_INSPECTION_RECORD',
  'TECHNICAL_INSPECTION_REQUEST',
  -- Safety
  'SAFETY_CORRECTIVE_ACTION_ASSIGN',
  'SAFETY_CORRECTIVE_ACTION_VERIFY',
  'SAFETY_HAZARD_REPORT',
  'SAFETY_INCIDENT_REPORT',
  'SAFETY_INDUCTION_RECORD',
  'SAFETY_INSPECTION_SUBMIT',
  'SAFETY_PERMIT_CLOSE',
  'SAFETY_PERMIT_REQUEST',
  -- Stores & machinery
  'MACHINERY_ALLOCATION_REVIEW',
  'MACHINERY_BOOKING_REQUEST',
  'MACHINERY_CHECK_IN_OUT_RECORD',
  'MACHINERY_DAILY_LOG_SUBMIT',
  'MACHINERY_FUEL_RECORD',
  'MACHINERY_MAINTENANCE_REQUEST',
  'MATERIAL_INSPECTION_RECORD',
  'MATERIAL_ISSUE_RECORD',
  'MATERIAL_RECEIPT_RECORD',
  'MATERIAL_REQUEST_REVIEW',
  'MATERIAL_REQUEST_SUBMIT',
  'MATERIAL_RETURN_RECORD',
  'MATERIAL_TEST_REQUEST',
  'MATERIAL_TEST_RESULT_RECORD',
  'STOCK_TRANSFER_REQUEST',
  'VENDOR_QUOTATION_COMPARE',
  -- Work execution
  'DELAY_REPORT_SUBMIT',
  'WORK_COMPLETION_SUBMIT',
  'WORK_MEASUREMENT_RECORD',
  'WORK_PACKAGE_ASSIGN',
  'WORK_PACKAGE_CREATE',
  'WORK_PROGRESS_REVIEW',
  'WORK_PROGRESS_SUBMIT',
  -- Request-side wallet/quotation (submit, view, confirm — NOT approve/process)
  'PETTY_CASH_REQUEST_SUBMIT',
  'PETTY_CASH_EXPENSE_SUBMIT',
  'PROJECT_QUOTATION_PREPARE',
  'PROJECT_WALLET_LEDGER_VIEW',
  'PROJECT_WALLET_RECEIPT_CONFIRM',
  'PROJECT_WALLET_RETURN_FUNDS'
);
