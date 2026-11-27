import type { LeaveType } from '@prisma/client';

export interface DefaultLeaveTypeTemplate {
  code: string;
  name: string;
  description: string;
  leaveType: LeaveType;
}

/**
 * Default leave type definitions provisioned for every customer company at
 * creation (and idempotently backfilled via db:reconcile).
 */
export const DEFAULT_LEAVE_TYPES: readonly DefaultLeaveTypeTemplate[] = [
  {
    code: 'CL',
    name: 'Casual Leave',
    description: 'Casual leave for short-term personal needs',
    leaveType: 'CASUAL',
  },
  {
    code: 'SL',
    name: 'Sick Leave',
    description: 'Medical and sick leave',
    leaveType: 'SICK',
  },
  {
    code: 'PL',
    name: 'Privilege Leave',
    description: 'Earned / privilege leave accrued over service',
    leaveType: 'PRIVILEGE',
  },
  {
    code: 'LOP',
    name: 'Loss of Pay',
    description: 'Unpaid leave when paid leave balance is exhausted',
    leaveType: 'LOSS_OF_PAY',
  },
];
