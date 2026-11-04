-- Milestone 2: operation catalogue + department enablement + employee assignment.
CREATE TABLE "OperationCatalogueEntry" (
  "key"         TEXT    NOT NULL,
  "domain"      TEXT    NOT NULL,
  "name"        TEXT    NOT NULL,
  "description" TEXT    NOT NULL,
  "sensitive"   BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "OperationCatalogueEntry_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "OperationCatalogueEntry_domain_idx" ON "OperationCatalogueEntry"("domain");

CREATE TABLE "DepartmentOperation" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "companyId"    UUID        NOT NULL,
  "departmentId" UUID        NOT NULL,
  "operationKey" TEXT        NOT NULL,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "DepartmentOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DepartmentOperation_departmentId_companyId_fkey"
    FOREIGN KEY ("departmentId","companyId") REFERENCES "Department"("id","companyId") ON DELETE RESTRICT,
  CONSTRAINT "DepartmentOperation_operationKey_fkey"
    FOREIGN KEY ("operationKey") REFERENCES "OperationCatalogueEntry"("key"),
  CONSTRAINT "DepartmentOperation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "DepartmentOperation_companyId_departmentId_operationKey_key"
  ON "DepartmentOperation"("companyId","departmentId","operationKey");
CREATE INDEX "DepartmentOperation_companyId_departmentId_idx"
  ON "DepartmentOperation"("companyId","departmentId");

CREATE TABLE "EmployeeOperation" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "companyId"    UUID        NOT NULL,
  "employeeId"   UUID        NOT NULL,
  "operationKey" TEXT        NOT NULL,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "EmployeeOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeOperation_employeeId_companyId_fkey"
    FOREIGN KEY ("employeeId","companyId") REFERENCES "Employee"("id","companyId") ON DELETE RESTRICT,
  CONSTRAINT "EmployeeOperation_operationKey_fkey"
    FOREIGN KEY ("operationKey") REFERENCES "OperationCatalogueEntry"("key"),
  CONSTRAINT "EmployeeOperation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "EmployeeOperation_companyId_employeeId_operationKey_key"
  ON "EmployeeOperation"("companyId","employeeId","operationKey");
CREATE INDEX "EmployeeOperation_companyId_employeeId_idx"
  ON "EmployeeOperation"("companyId","employeeId");

-- Finance catalogue (exact keys from product spec). Idempotent re-seed safe.
INSERT INTO "OperationCatalogueEntry"("key","domain","name","description") VALUES
('FINANCE_EMPLOYEE_DIRECTORY_VIEW','EMPLOYEE_RECORDS','Employee directory view','View basic employee details needed for Finance work (name, code, department, project, status)'),
('FINANCE_EMPLOYMENT_DETAILS_VIEW','EMPLOYEE_RECORDS','Employment details view','View approved employment details needed for payroll processing'),
('FINANCE_PAYROLL_RECORD_VIEW','EMPLOYEE_RECORDS','Payroll record view','View payroll history and salary calculation details (authorized payroll staff only)', TRUE),
('EMPLOYEE_PAYROLL_PREPARE','PAYROLL','Prepare payroll','Prepare payroll for a pay period'),
('PAYROLL_REVIEW','PAYROLL','Review payroll','Review payroll calculations and exceptions'),
('SALARY_PAYMENT_APPROVE','PAYROLL','Approve salary payment','Approve a salary payment batch'),
('SALARY_PAYMENT_PROCESS','PAYROLL','Process salary payment','Record completed salary payments'),
('PAYROLL_REPORT_GENERATE','PAYROLL','Payroll report','Generate payroll summaries and payment reports'),
('CLIENT_BILL_DRAFT','BILLING','Draft client bill','Prepare a bill for the construction company''s client'),
('CLIENT_BILL_REVIEW','BILLING','Review client bill','Review quantities, rates, deductions, and supporting approvals'),
('CLIENT_BILL_APPROVE','BILLING','Approve client bill','Approve a client bill for issue'),
('CLIENT_INVOICE_ISSUE','BILLING','Issue client invoice','Record the invoice sent to the client'),
('VENDOR_INVOICE_SUBMIT','BILLING','Submit vendor invoice','Register a supplier or subcontractor bill for payment'),
('INVOICE_VERIFY','BILLING','Verify invoice','Check a vendor invoice against purchase order, receipt, and approvals'),
('BILL_PAYMENT_APPROVE','BILLING','Approve bill payment','Approve a vendor bill for payment'),
('PURCHASE_PAYMENT_PROCESS','BILLING','Process purchase payment','Record payment and its reference'),
('PROJECT_QUOTATION_COST_REVIEW','QUOTATION','Quotation cost review','Review estimated project costs and commercial assumptions'),
('PROJECT_QUOTATION_APPROVE','QUOTATION','Approve quotation','Approve a quotation before submission to client'),
('PROJECT_QUOTATION_ISSUE','QUOTATION','Issue quotation','Record the quotation sent to a client'),
('PROJECT_QUOTATION_REVISE','QUOTATION','Revise quotation','Prepare a revised quotation with reason and version history'),
('VENDOR_QUOTATION_COST_REVIEW','QUOTATION','Vendor quotation review','Review vendor quotations for cost and budget impact'),
('PETTY_CASH_REQUEST_REVIEW','WALLET','Petty-cash request review','Review a PI''s request for project or site funds'),
('PETTY_CASH_REQUEST_APPROVE','WALLET','Petty-cash request approve','Approve, return, or reject the request'),
('PROJECT_WALLET_CREDIT_PROCESS','WALLET','Wallet credit','Record Finance transfer to the project wallet ledger'),
('PROJECT_WALLET_LEDGER_VIEW','WALLET','Wallet ledger view','View wallet credits, expenses, and current calculated balance'),
('PROJECT_WALLET_RECEIPT_CONFIRM','WALLET','Wallet receipt confirm','View the PI''s confirmation that funds were received'),
('PETTY_CASH_EXPENSE_REVIEW','WALLET','Petty-cash expense review','Review submitted expenses and supporting receipts'),
('PROJECT_WALLET_RECONCILE','WALLET','Wallet reconcile','Reconcile wallet transactions and outstanding cash'),
('PROJECT_WALLET_REPORT_GENERATE','WALLET','Wallet report','Generate wallet statements and reconciliation reports'),
('FINANCE_PROJECT_BUDGET_REPORT_VIEW','REPORT','Budget report','View project budgets, actual costs, and remaining budget'),
('FINANCE_CASH_FLOW_REPORT_VIEW','REPORT','Cash-flow report','View cash-flow forecasts and actual transactions'),
('FINANCE_BILLING_REPORT_VIEW','REPORT','Billing report','View client bills, vendor bills, due dates, payment status'),
('FINANCE_SALARY_REPORT_VIEW','REPORT','Salary report','View permitted salary totals and payroll reports'),
('FINANCE_WALLET_REPORT_VIEW','REPORT','Wallet report','View project wallet balances and transaction history'),
('FINANCE_EXPENSE_REPORT_VIEW','REPORT','Expense report','View employee and project expense claims'),
('FINANCE_REPORT_EXPORT','REPORT','Export report','Export an authorized Finance report')
ON CONFLICT ("key") DO NOTHING;
