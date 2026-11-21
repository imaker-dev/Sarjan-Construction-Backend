-- Fill gaps in the finance/billing/wallet operation catalogue identified
-- during FINANCE-department enablement. Additive and idempotent:
-- ON CONFLICT preserves any rows already created by clients or earlier seeds.
-- `sensitive` rows are excluded from PD/PI role coverage and always need an
-- explicit per-employee grant under a distinct restricted policy.

INSERT INTO "OperationCatalogueEntry"("key","domain","name","description","sensitive") VALUES
-- Employee records for Finance work
('FINANCE_EMPLOYEE_DIRECTORY_VIEW','PAYROLL','View employee directory','View basic employee details needed for Finance work',FALSE),
('FINANCE_EMPLOYMENT_DETAILS_VIEW','PAYROLL','View employment details','View approved employment details needed for costing or payroll',TRUE),

-- Client billing and vendor invoices
('CLIENT_BILL_DRAFT','BILLING','Draft client bill','Prepare a client bill from approved work and measurement records',FALSE),
('CLIENT_BILL_REVIEW','BILLING','Review client bill','Review quantities, rates, deductions, retention, and supporting records',FALSE),
('CLIENT_BILL_APPROVE','BILLING','Approve client bill','Approve a bill for issue',TRUE),
('CLIENT_INVOICE_ISSUE','BILLING','Issue client invoice','Record an issued client invoice',TRUE),
('VENDOR_INVOICE_SUBMIT','BILLING','Submit vendor invoice','Register a supplier or subcontractor invoice',FALSE),
('INVOICE_VERIFY','BILLING','Verify invoice','Check an invoice against the order, receipt, and approvals',FALSE),
('BILL_PAYMENT_APPROVE','BILLING','Approve bill payment','Approve payment under company authorization rules',TRUE),

-- Quotations and contract finance
('PROJECT_QUOTATION_COST_REVIEW','QUOTATION','Review quotation costing','Review price, margin, assumptions, and exclusions',FALSE),
('PROJECT_QUOTATION_APPROVE','QUOTATION','Approve quotation','Approve the quotation before issue',FALSE),
('PROJECT_QUOTATION_ISSUE','QUOTATION','Issue quotation','Record the quotation sent to the client',FALSE),
('PROJECT_QUOTATION_REVISE','QUOTATION','Revise quotation','Prepare a revised quotation with version history',FALSE),
('VENDOR_QUOTATION_COST_REVIEW','QUOTATION','Review vendor quotation costing','Review vendor quotations for project cost and budget impact',FALSE),

-- Petty cash and project wallet (review/approval side)
('PETTY_CASH_REQUEST_REVIEW','WALLET','Review petty cash request','Finance reviews purpose, amount, budget, and supporting information',FALSE),
('PETTY_CASH_REQUEST_APPROVE','WALLET','Approve petty cash request','Approve, reject, or return the request',TRUE),
('PETTY_CASH_EXPENSE_REVIEW','WALLET','Review petty cash expense','Review expense details and evidence',FALSE),
('PROJECT_WALLET_CREDIT_PROCESS','WALLET','Process wallet credit','Record a Finance transfer in the wallet ledger',TRUE),
('PROJECT_WALLET_LEDGER_VIEW','WALLET','View wallet ledger','View wallet credits, expenses, and calculated balance',FALSE),
('PROJECT_WALLET_RECEIPT_CONFIRM','WALLET','Confirm wallet receipt','PI confirms that funds were received',FALSE),
('PROJECT_WALLET_RECONCILE','WALLET','Reconcile wallet','Reconcile wallet transactions and cash held',FALSE),
('PROJECT_WALLET_REPORT_GENERATE','WALLET','Generate wallet report','Generate the project wallet ledger report',FALSE),

-- Finance reports
('FINANCE_CASH_FLOW_REPORT_VIEW','REPORT','View cash flow report','Actual and forecast cash flow',FALSE)
ON CONFLICT ("key") DO NOTHING;
