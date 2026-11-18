-- Expanded operation catalogue: project/site administration, work planning,
-- drawings/engineering, labour, safety, quality, stores/procurement/machinery,
-- project finance, project reporting, and the full Finance catalogue.
-- Idempotent: safe to re-apply via ON CONFLICT DO NOTHING.
-- `sensitive` rows are excluded from PD/PI role coverage — they always need
-- an explicit per-employee grant under a distinct restricted policy.

INSERT INTO "OperationCatalogueEntry"("key","domain","name","description","sensitive") VALUES
-- Project and site administration
('PROJECT_PLAN_CREATE','PROJECT_ADMIN','Create project plan','Create the project execution plan and phases',FALSE),
('PROJECT_PLAN_UPDATE','PROJECT_ADMIN','Update project plan','Update the plan with a reason and version history',FALSE),
('PROJECT_MILESTONE_MANAGE','PROJECT_ADMIN','Manage milestones','Create and update project milestones',FALSE),
('SITE_CREATE','PROJECT_ADMIN','Create site','Create a site under the assigned project',FALSE),
('SITE_UPDATE','PROJECT_ADMIN','Update site','Maintain site details and operating dates',FALSE),
('SITE_CLOSE','PROJECT_ADMIN','Close site','Submit a site for closure after required checks',FALSE),
('PROJECT_TEAM_VIEW','PROJECT_ADMIN','View project team','View project leadership, departments, and team assignments',FALSE),
('PROJECT_TEAM_ASSIGN','PROJECT_ADMIN','Assign project team','Request or manage permitted team placements',FALSE),

-- Work planning and site execution
('WORK_PACKAGE_CREATE','WORK_EXECUTION','Create work package','Define a project or site work package',FALSE),
('WORK_PACKAGE_ASSIGN','WORK_EXECUTION','Assign work package','Assign a work package to a team or responsible employee',FALSE),
('WORK_PROGRESS_SUBMIT','WORK_EXECUTION','Submit work progress','Record work completed during a shift or day',FALSE),
('WORK_PROGRESS_REVIEW','WORK_EXECUTION','Review work progress','Review progress against the plan',FALSE),
('DELAY_REPORT_SUBMIT','WORK_EXECUTION','Submit delay report','Record a delay, cause, and impact',FALSE),
('SITE_INSTRUCTION_CREATE','WORK_EXECUTION','Create site instruction','Issue a site instruction or direction',FALSE),
('SITE_INSTRUCTION_ACKNOWLEDGE','WORK_EXECUTION','Acknowledge site instruction','Record that the responsible team received it',FALSE),
('SITE_INSTRUCTION_CLOSE','WORK_EXECUTION','Close site instruction','Confirm completion or resolution',FALSE),
('REQUEST_FOR_INFORMATION_SUBMIT','WORK_EXECUTION','Submit RFI','Raise a technical clarification request',FALSE),
('REQUEST_FOR_INFORMATION_RESPOND','WORK_EXECUTION','Respond to RFI','Record the approved response',FALSE),
('WORK_MEASUREMENT_RECORD','WORK_EXECUTION','Record work measurement','Record measured quantities for completed work',FALSE),
('WORK_COMPLETION_SUBMIT','WORK_EXECUTION','Submit work completion','Submit work for inspection or acceptance',FALSE),

-- Drawings and engineering
('DRAWING_SUBMIT','ENGINEERING','Submit drawing','Upload or submit a drawing for review',FALSE),
('DRAWING_REVIEW','ENGINEERING','Review drawing','Review a drawing for the project or site',FALSE),
('DRAWING_ISSUE_FOR_CONSTRUCTION','ENGINEERING','Issue drawing for construction','Mark the approved drawing as available for execution',FALSE),
('DRAWING_REVISION_SUBMIT','ENGINEERING','Submit drawing revision','Submit a revised drawing and identify changes',FALSE),
('TECHNICAL_INSPECTION_REQUEST','ENGINEERING','Request technical inspection','Request an engineering inspection',FALSE),
('TECHNICAL_INSPECTION_RECORD','ENGINEERING','Record technical inspection','Record inspection findings and actions',FALSE),
('DEFECT_REPORT_CREATE','ENGINEERING','Create defect report','Record a construction defect',FALSE),
('DEFECT_RECTIFICATION_VERIFY','ENGINEERING','Verify defect rectification','Verify that the defect was corrected',FALSE),

-- Labour and attendance
('LABOUR_RECORD_CREATE','LABOUR','Create labour record','Create a project/site labour record',FALSE),
('LABOUR_PROJECT_ASSIGN','LABOUR','Assign labour to project','Place a worker at a project or site',FALSE),
('LABOUR_ATTENDANCE_MARK','LABOUR','Mark labour attendance','Record attendance, including supported QR check-in',FALSE),
('LABOUR_ATTENDANCE_CORRECTION_REQUEST','LABOUR','Request attendance correction','Request a correction to an attendance record',FALSE),
('LABOUR_ATTENDANCE_REVIEW','LABOUR','Review attendance correction','Review and approve or return a correction',FALSE),
('LABOUR_SHIFT_ASSIGN','LABOUR','Assign shift','Assign a worker or crew to a shift',FALSE),
('LABOUR_DAILY_REPORT_SUBMIT','LABOUR','Submit daily labour report','Submit daily labour and workforce totals',FALSE),

-- Safety
('SAFETY_INDUCTION_RECORD','SAFETY','Record safety induction','Record a worker''s site safety induction',FALSE),
('SAFETY_HAZARD_REPORT','SAFETY','Report hazard','Report a hazard and its location',FALSE),
('SAFETY_INSPECTION_SUBMIT','SAFETY','Submit safety inspection','Record a planned or ad hoc safety inspection',FALSE),
('SAFETY_INCIDENT_REPORT','SAFETY','Report incident','Record an incident or near miss',FALSE),
('SAFETY_CORRECTIVE_ACTION_ASSIGN','SAFETY','Assign corrective action','Assign a corrective action to a responsible person',FALSE),
('SAFETY_CORRECTIVE_ACTION_VERIFY','SAFETY','Verify corrective action','Verify that the action was completed',FALSE),
('SAFETY_PERMIT_REQUEST','SAFETY','Request work permit','Request a controlled-work permit where the process requires one',FALSE),
('SAFETY_PERMIT_CLOSE','SAFETY','Close work permit','Close the permit after the work-area checks',FALSE),

-- Quality control
('QUALITY_PLAN_MANAGE','QUALITY','Manage quality plan','Maintain the project or site quality plan',FALSE),
('QUALITY_INSPECTION_REQUEST','QUALITY','Request quality inspection','Request an inspection of work or materials',FALSE),
('QUALITY_INSPECTION_RECORD','QUALITY','Record quality inspection','Record inspection results',FALSE),
('MATERIAL_TEST_REQUEST','QUALITY','Request material test','Request a material test',FALSE),
('MATERIAL_TEST_RESULT_RECORD','QUALITY','Record material test result','Record test results and supporting documents',FALSE),
('CONCRETE_CUBE_SAMPLE_REGISTER','QUALITY','Register concrete cube sample','Register a concrete cube sample and trace it to the pour',FALSE),
('CONCRETE_CUBE_TEST_RESULT_RECORD','QUALITY','Record cube test result','Record a cube test result',FALSE),
('NON_CONFORMANCE_REPORT_CREATE','QUALITY','Create non-conformance report','Record work or material that does not meet requirements',FALSE),
('NON_CONFORMANCE_CORRECTIVE_ACTION','QUALITY','Manage non-conformance action','Track corrective action through verification and closure',FALSE),

-- Stores, procurement, and machinery
('MATERIAL_REQUEST_SUBMIT','STORES','Submit material request','Request material for project/site work',FALSE),
('MATERIAL_REQUEST_REVIEW','STORES','Review material request','Review quantities, availability, and intended use',FALSE),
('MATERIAL_RECEIPT_RECORD','STORES','Record material receipt','Record material received at site',FALSE),
('MATERIAL_INSPECTION_RECORD','STORES','Record material inspection','Record checks performed on received material',FALSE),
('MATERIAL_ISSUE_RECORD','STORES','Record material issue','Record material issued to a team or work package',FALSE),
('MATERIAL_RETURN_RECORD','STORES','Record material return','Record unused or returned material',FALSE),
('STOCK_TRANSFER_REQUEST','STORES','Request stock transfer','Request a transfer between project or site stores',FALSE),
('PURCHASE_REQUEST_SUBMIT','STORES','Submit purchase request','Request procurement for a project requirement',FALSE),
('VENDOR_QUOTATION_COMPARE','STORES','Compare vendor quotations','Record a comparison of quotations for project procurement',FALSE),
('MACHINERY_BOOKING_REQUEST','STORES','Request machinery booking','Request equipment for a project or site',FALSE),
('MACHINERY_ALLOCATION_REVIEW','STORES','Review machinery allocation','Review equipment availability and allocation',FALSE),
('MACHINERY_CHECK_IN_OUT_RECORD','STORES','Record machinery check in/out','Record equipment movement to or from site',FALSE),
('MACHINERY_DAILY_LOG_SUBMIT','STORES','Submit machinery daily log','Record hours, usage, downtime, and operator details',FALSE),
('MACHINERY_MAINTENANCE_REQUEST','STORES','Request machinery maintenance','Request maintenance or repair',FALSE),
('MACHINERY_FUEL_RECORD','STORES','Record machinery fuel','Record fuel issued and consumed for equipment',FALSE),

-- Project finance and cost tracking (project-scoped; company Finance keeps
-- separate authority over company-wide payments and sensitive payroll).
('PROJECT_BUDGET_VIEW','PROJECT_FINANCE','View project budget','View the approved budget for the assigned project',FALSE),
('PROJECT_BUDGET_CREATE','PROJECT_FINANCE','Create project budget','Prepare a project budget proposal',FALSE),
('PROJECT_BUDGET_REVISE','PROJECT_FINANCE','Revise project budget','Submit a budget revision with justification',FALSE),
('PROJECT_COST_REPORT_VIEW','PROJECT_FINANCE','View project cost report','View project costs and budget variance',FALSE),
('CASH_FLOW_FORECAST_SUBMIT','PROJECT_FINANCE','Submit cash-flow forecast','Submit a project cash-flow forecast',FALSE),
('PETTY_CASH_REQUEST_SUBMIT','PROJECT_FINANCE','Submit petty-cash request','PI requests project or site funds',FALSE),
('PETTY_CASH_EXPENSE_SUBMIT','PROJECT_FINANCE','Submit petty-cash expense','Submit an expense with its receipt or voucher',FALSE),

-- Project reporting and records
('PROJECT_DASHBOARD_VIEW','PROJECT_REPORTS','View project dashboard','View project and site status',FALSE),
('DAILY_SITE_REPORT_SUBMIT','PROJECT_REPORTS','Submit daily site report','Submit daily progress, labour, equipment, and issue summaries',FALSE),
('WEEKLY_PROJECT_REPORT_GENERATE','PROJECT_REPORTS','Generate weekly project report','Generate a weekly project progress report',FALSE),
('PROJECT_COST_REPORT_GENERATE','PROJECT_REPORTS','Generate project cost report','Generate budget, committed cost, and actual cost reports',FALSE),
('PROJECT_MATERIAL_REPORT_VIEW','PROJECT_REPORTS','View material report','View material requests, receipts, issues, and stock',FALSE),
('PROJECT_MACHINERY_REPORT_VIEW','PROJECT_REPORTS','View machinery report','View equipment use, downtime, and maintenance',FALSE),
('PROJECT_SAFETY_REPORT_VIEW','PROJECT_REPORTS','View safety report','View hazards, incidents, inspections, and corrective actions',FALSE),
('PROJECT_QUALITY_REPORT_VIEW','PROJECT_REPORTS','View quality report','View inspections, tests, defects, and non-conformance items',FALSE),
('PROJECT_DOCUMENT_UPLOAD','PROJECT_REPORTS','Upload project document','Upload a project or site document',FALSE),
('PROJECT_DOCUMENT_VIEW','PROJECT_REPORTS','View project documents','View documents available within the assigned project scope',FALSE),
('PROJECT_HANDOVER_SUBMIT','PROJECT_REPORTS','Submit project handover','Submit project or site handover records',FALSE),

-- Finance: budget, estimate, and project cost
('PROJECT_ESTIMATE_PREPARE','BUDGET','Prepare project estimate','Prepare the project cost estimate',FALSE),
('PROJECT_ESTIMATE_REVISE','BUDGET','Revise project estimate','Revise an estimate with a reason and version history',FALSE),
('PROJECT_BUDGET_REVIEW','BUDGET','Review project budget','Review budget details and supporting records',FALSE),
('PROJECT_BUDGET_APPROVE','BUDGET','Approve project budget','Approve a budget within the user''s authority',FALSE),
('PROJECT_COST_COMMITMENT_RECORD','BUDGET','Record cost commitment','Record costs committed through contracts or purchase orders',FALSE),
('PROJECT_COST_ACTUALS_REVIEW','BUDGET','Review cost actuals','Review posted costs against the project',FALSE),
('PROJECT_COST_TO_COMPLETE_UPDATE','BUDGET','Update cost to complete','Update the forecast cost to finish',FALSE),
('PROJECT_VARIATION_COST_REVIEW','BUDGET','Review variation cost','Assess the financial effect of a scope or quantity change',FALSE),

-- Finance: quotations and contract finance
('PROJECT_QUOTATION_PREPARE','QUOTATION','Prepare project quotation','Prepare a client quotation from approved project costing',FALSE),
('CONTRACT_FINANCIAL_TERMS_REVIEW','QUOTATION','Review contract financial terms','Review contract value, payment terms, retention, and advances',FALSE),
('CONTRACT_CHANGE_ORDER_COST_REVIEW','QUOTATION','Review change order cost','Review the cost and revenue impact of a change order',FALSE),

-- Finance: project cash flow and wallet
('PROJECT_CASH_FLOW_FORECAST_SUBMIT','WALLET','Submit cash-flow forecast','Submit expected project receipts and spending',FALSE),
('PROJECT_CASH_FLOW_FORECAST_REVISE','WALLET','Revise cash-flow forecast','Revise a forecast with a reason',FALSE),
('PROJECT_CASH_FLOW_REVIEW','WALLET','Review cash flow','Review funding needs and forecast changes',FALSE),
('PROJECT_WALLET_RETURN_FUNDS','WALLET','Return wallet funds','Record unused funds returned to Finance',FALSE),
('PROJECT_WALLET_CLOSE','WALLET','Close project wallet','Close a reconciled wallet or site cash account',FALSE),

-- Finance: purchase, vendor bills, and payments
('PURCHASE_REQUEST_FINANCE_REVIEW','BILLING','Finance-review purchase request','Check project budget and financial coding for a purchase request',FALSE),
('PURCHASE_ORDER_FINANCE_REVIEW','BILLING','Finance-review purchase order','Review the financial terms of a purchase order',FALSE),
('SUBCONTRACTOR_BILL_REVIEW','BILLING','Review subcontractor bill','Review subcontractor bills, measurements, advances, and deductions',FALSE),
('VENDOR_ADVANCE_REQUEST_REVIEW','BILLING','Review vendor advance request','Review an advance request against the contract or order',FALSE),
('VENDOR_ADVANCE_PAYMENT_PROCESS','BILLING','Process vendor advance payment','Record an approved vendor advance payment',TRUE),
('VENDOR_ADVANCE_RECOVERY_RECORD','BILLING','Record advance recovery','Record recovery of advances from later bills',FALSE),
('BILL_PAYMENT_PROPOSE','BILLING','Propose bill payment','Prepare a payment proposal and due date',FALSE),
('RETENTION_RELEASE_REVIEW','BILLING','Review retention release','Review eligibility to release retained amounts',FALSE),
('VENDOR_CREDIT_NOTE_RECORD','BILLING','Record vendor credit note','Record a vendor credit note or adjustment',FALSE),

-- Finance: client billing and collections
('CLIENT_RECEIPT_RECORD','BILLING','Record client receipt','Record money received from a client',FALSE),
('CLIENT_RECEIPT_ALLOCATE','BILLING','Allocate client receipt','Allocate receipts to invoices or advances',FALSE),
('CLIENT_RETENTION_TRACK','BILLING','Track client retention','Track retention withheld and release conditions',FALSE),
('CLIENT_ADVANCE_TRACK','BILLING','Track client advances','Track client advances and their adjustment',FALSE),
('CLIENT_OUTSTANDING_REVIEW','BILLING','Review client outstanding','Review overdue client balances',FALSE),
('CLIENT_CREDIT_NOTE_RECORD','BILLING','Record client credit note','Record an approved credit note or billing adjustment',FALSE),
('CLIENT_COLLECTION_ACTION_RECORD','BILLING','Record collection action','Record collection follow-up and outcome',FALSE),

-- Finance: payroll, employee costs, and expenses
('PAYROLL_INPUT_REVIEW','PAYROLL','Review payroll inputs','Review approved attendance and payroll inputs',TRUE),
('EMPLOYEE_EXPENSE_SUBMIT','PAYROLL','Submit employee expense','Submit an employee business expense claim',FALSE),
('EXPENSE_REIMBURSEMENT_REVIEW','PAYROLL','Review expense reimbursement','Review eligibility, receipt, and cost allocation',FALSE),
('EXPENSE_REIMBURSEMENT_APPROVE','PAYROLL','Approve expense reimbursement','Approve or return a reimbursement claim',FALSE),
('EXPENSE_REIMBURSEMENT_PROCESS','PAYROLL','Process expense reimbursement','Record the reimbursement payment',TRUE),
('EMPLOYEE_ADVANCE_REVIEW','PAYROLL','Review employee advance','Review an employee advance request',TRUE),
('EMPLOYEE_ADVANCE_SETTLE','PAYROLL','Settle employee advance','Reconcile an advance against expenses or repayment',TRUE),

-- Finance: accounting, banking, tax, and close
('JOURNAL_ENTRY_PREPARE','ACCOUNTING','Prepare journal entry','Prepare an accounting journal with explanation and support',FALSE),
('JOURNAL_ENTRY_REVIEW','ACCOUNTING','Review journal entry','Review a journal before posting',FALSE),
('GENERAL_LEDGER_VIEW','ACCOUNTING','View general ledger','View authorized ledger entries',FALSE),
('BANK_TRANSACTION_IMPORT','ACCOUNTING','Import bank transactions','Import or record bank transactions',TRUE),
('BANK_RECONCILIATION_PREPARE','ACCOUNTING','Prepare bank reconciliation','Match bank activity to recorded transactions',TRUE),
('BANK_RECONCILIATION_REVIEW','ACCOUNTING','Review bank reconciliation','Review and close a reconciliation',TRUE),
('FINANCIAL_PERIOD_CLOSE_PREPARE','ACCOUNTING','Prepare period close','Run period-close checks and identify open items',FALSE),
('FINANCIAL_PERIOD_CLOSE_APPROVE','ACCOUNTING','Approve period close','Approve a financial period close',FALSE),
('TAX_DOCUMENT_REGISTER','ACCOUNTING','Register tax document','Register tax documents and references',FALSE),
('TAX_LIABILITY_REVIEW','ACCOUNTING','Review tax liability','Review recorded tax liabilities and supporting transactions',FALSE),
('TAX_PAYMENT_APPROVE','ACCOUNTING','Approve tax payment','Approve an authorized tax payment',TRUE),
('TAX_PAYMENT_RECORD','ACCOUNTING','Record tax payment','Record payment reference and evidence',TRUE),
('FIXED_ASSET_REGISTER','ACCOUNTING','Register fixed asset','Register a company or project asset',FALSE),
('ASSET_TRANSFER_RECORD','ACCOUNTING','Record asset transfer','Record an asset transfer between projects or sites',FALSE),
('ASSET_DISPOSAL_REVIEW','ACCOUNTING','Review asset disposal','Review a proposed asset disposal',FALSE),

-- Finance reports (access controlled per report type and scope)
('FINANCE_PROJECT_PROFIT_LOSS_VIEW','REPORT','Project P&L report','Project profit and loss: recognized revenue, direct costs, overhead allocations, and margin',FALSE),
('FINANCE_SITE_PROFIT_LOSS_VIEW','REPORT','Site P&L report','Site-level management P&L where costs and revenue are coded to sites',FALSE),
('FINANCE_COMPANY_PROFIT_LOSS_VIEW','REPORT','Company P&L report','Company-wide P&L; restricted to authorized company Finance users',TRUE),
('FINANCE_BALANCE_SHEET_VIEW','REPORT','Balance sheet','Balance sheet for the configured company accounting scope',TRUE),
('FINANCE_TRIAL_BALANCE_VIEW','REPORT','Trial balance','Trial balance by accounting period',FALSE),
('FINANCE_GENERAL_LEDGER_REPORT_VIEW','REPORT','General ledger report','Ledger activity by account, project, site, and period',FALSE),
('FINANCE_BUDGET_VARIANCE_REPORT_VIEW','REPORT','Budget variance report','Budget, revised budget, committed cost, actual cost, and variance',FALSE),
('FINANCE_PROJECT_MARGIN_REPORT_VIEW','REPORT','Project margin report','Project revenue, cost, forecast-to-complete, and margin',FALSE),
('FINANCE_WORK_IN_PROGRESS_REPORT_VIEW','REPORT','Work-in-progress report','Work-in-progress and unbilled project amounts, where configured',FALSE),
('FINANCE_COST_TO_COMPLETE_REPORT_VIEW','REPORT','Cost-to-complete report','Estimated cost to finish and forecast final cost',FALSE),
('FINANCE_ACCOUNTS_PAYABLE_AGING_VIEW','REPORT','AP aging report','Vendor and subcontractor balances by due age',FALSE),
('FINANCE_ACCOUNTS_RECEIVABLE_AGING_VIEW','REPORT','AR aging report','Client balances by due age',FALSE),
('FINANCE_VENDOR_OUTSTANDING_REPORT_VIEW','REPORT','Vendor outstanding report','Unpaid vendor bills, advances, and retention',FALSE),
('FINANCE_CLIENT_OUTSTANDING_REPORT_VIEW','REPORT','Client outstanding report','Unpaid client bills, advances, and retention',FALSE),
('FINANCE_PAYMENT_DUE_REPORT_VIEW','REPORT','Payment due report','Approved and pending payments by due date',FALSE),
('FINANCE_PROJECT_WALLET_REPORT_VIEW','REPORT','Project wallet report','Wallet credits, expenses, balance, and unreconciled items',FALSE),
('FINANCE_PETTY_CASH_REPORT_VIEW','REPORT','Petty-cash report','Petty-cash requests, approvals, expenses, and returns',FALSE),
('FINANCE_PAYROLL_SUMMARY_REPORT_VIEW','REPORT','Payroll summary report','Payroll totals by period and project; restricted access',TRUE),
('FINANCE_EMPLOYEE_COST_REPORT_VIEW','REPORT','Employee cost report','Employee cost allocated to projects; personal salary details restricted',TRUE),
('FINANCE_EXPENSE_CLAIM_REPORT_VIEW','REPORT','Expense claim report','Expense claims, decisions, reimbursements, and outstanding advances',FALSE),
('FINANCE_TAX_REGISTER_REPORT_VIEW','REPORT','Tax register report','Registered tax liabilities and payment records',FALSE),
('FINANCE_BANK_RECONCILIATION_REPORT_VIEW','REPORT','Bank reconciliation report','Reconciliation status and unmatched transactions',TRUE),
('FINANCE_FIXED_ASSET_REPORT_VIEW','REPORT','Fixed asset report','Asset register, location, status, and authorized depreciation data',FALSE),
('FINANCE_PROJECT_COMPARISON_REPORT_VIEW','REPORT','Project comparison report','Compare financial performance across projects; company-level access required',TRUE)
ON CONFLICT ("key") DO NOTHING;

-- Keys that already exist from the earlier Finance seed which are
-- payroll/bank-sensitive under the distinct restricted policy.
UPDATE "OperationCatalogueEntry" SET "sensitive" = TRUE WHERE "key" IN (
  'FINANCE_PAYROLL_RECORD_VIEW',
  'EMPLOYEE_PAYROLL_PREPARE',
  'PAYROLL_REVIEW',
  'SALARY_PAYMENT_APPROVE',
  'SALARY_PAYMENT_PROCESS',
  'PAYROLL_REPORT_GENERATE',
  'PURCHASE_PAYMENT_PROCESS',
  'FINANCE_SALARY_REPORT_VIEW',
  'FINANCE_REPORT_EXPORT'
);
