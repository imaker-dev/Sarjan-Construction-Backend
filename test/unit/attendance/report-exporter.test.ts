import { describe, expect, it } from 'vitest';
import type { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import {
  exportMusterRollToStream,
  exportSiteReportToStream,
  type MusterRollExportData,
  type SiteReportExportData,
} from '../../../src/modules/attendance/report-exporter.js';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

const sampleSiteData: SiteReportExportData = {
  report: {
    id: '00000000-0000-4000-8000-0000000000d1',
    companyId: '00000000-0000-4000-8000-0000000000c1',
    projectId: '00000000-0000-4000-8000-0000000000b1',
    siteId: '00000000-0000-4000-8000-0000000000a1',
    businessDate: '2026-11-25',
    status: 'APPROVED',
    weather: 'CLEAR',
    weatherStoppageHours: new Prisma.Decimal(0),
    workProgressNotes: 'Tower A 4th floor slab concreting completed.',
    siteObstaclesRemarks: null,
    safetyIncidentReported: false,
    safetyNotes: null,
    totalWorkersHeadcount: 12,
    totalPresentUnits: new Prisma.Decimal(11.5),
    totalOvertimeHours: new Prisma.Decimal(4.5),
    totalOvertimePUnits: new Prisma.Decimal(0.5),
    totalFlaggedSessions: 0,
    catAStaffCount: 2,
    catAStaffUnits: new Prisma.Decimal(2),
    catBDirectCount: 6,
    catBDirectUnits: new Prisma.Decimal(6),
    catCSubconCount: 4,
    catCSubconUnits: new Prisma.Decimal(3.5),
    submittedById: null,
    submittedAt: new Date('2026-11-25T13:00:00Z'),
    approvedById: null,
    approvedAt: new Date('2026-11-25T14:00:00Z'),
    rejectionReason: null,
    lockedById: null,
    lockedAt: null,
    version: 1,
    createdAt: new Date('2026-11-25T12:00:00Z'),
    updatedAt: new Date('2026-11-25T14:00:00Z'),
    site: { id: '00000000-0000-4000-8000-0000000000a1', code: 'SITE-A', name: 'Shela Tower Site' },
    project: { id: '00000000-0000-4000-8000-0000000000b1', code: 'PRJ-01', name: 'Skyline Residency' },
    labourSummaries: [
      {
        id: '00000000-0000-4000-8000-0000000000e1',
        companyId: '00000000-0000-4000-8000-0000000000c1',
        reportId: '00000000-0000-4000-8000-0000000000d1',
        category: 'CAT_B_DIRECT_LABOUR',
        subcontractorId: null,
        subcontractorName: null,
        tradeCategory: 'MASON',
        headcount: 6,
        presentUnits: new Prisma.Decimal(6),
        overtimeHours: new Prisma.Decimal(2.5),
        remarks: 'On schedule',
        createdAt: new Date('2026-11-25T12:00:00Z'),
        updatedAt: new Date('2026-11-25T12:00:00Z'),
      },
    ],
  },
  sessions: [],
};

const sampleOfficeData: MusterRollExportData = {
  title: 'Office Attendance Report',
  scopeLabel: 'Head Office: HO-01',
  period: 'WEEKLY',
  from: '2026-11-23',
  to: '2026-11-28',
  totalSessions: 2,
  totalMandays: 2,
  totalPresentUnits: 2,
  totalOvertimePUnits: 0,
  totalTotalPUnits: 2,
  totalOvertimeHours: 0,
  departmentSummaries: [
    {
      departmentId: '00000000-0000-4000-8000-0000000000f1',
      departmentCode: 'FIN',
      departmentName: 'Finance & Accounts',
      category: 'FINANCE',
      totalEmployees: 1,
      presentCount: 1,
      absentCount: 0,
      totalPresentUnits: 2,
      totalOvertimeHours: 0,
    },
  ],
  workerSummaries: [
    {
      employeeId: '00000000-0000-4000-8000-000000000011',
      employeeCode: 'FIN-001',
      displayName: 'Anil Finance',
      tradeCategory: null,
      designation: 'Finance Manager',
      department: { id: '00000000-0000-4000-8000-0000000000f1', code: 'FIN', name: 'Finance & Accounts' },
      presentUnits: 2,
      overtimePUnits: 0,
      totalPUnits: 2,
      overtimeHours: 0,
      sessionsCount: 2,
      daysPresent: 2,
      leaveDays: 0,
      weeklyProgress: {
        weekStartDate: '2026-11-23',
        weekEndDate: '2026-11-28',
        targetWeeklyHours: 48,
        completedWeeklyHours: 16,
        remainingWeeklyHours: 32,
        progressPercentage: 33.3,
        isTargetCompleted: false,
        remainingWorkDaysInWeek: 4,
        isLastWorkingDay: false,
        requiredHoursToCompleteTarget: 8,
        status: 'ON_TRACK',
        priorDaysCompletedWeeklyHours: 8,
        todayCompletedHours: 8,
      },
    },
  ],
  sessions: [],
};

describe('report-exporter', () => {
  it('generates a valid PDF stream for a Site Report (DSR)', async () => {
    const res = exportSiteReportToStream(sampleSiteData, 'pdf');
    expect(res.contentType).toBe('application/pdf');
    expect(res.fileName).toBe('site-report-site-a-2026-11-25.pdf');
    const buf = await streamToBuffer(res.stream);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('generates a valid Excel (.xlsx) workbook for a Site Report (DSR)', async () => {
    const res = exportSiteReportToStream(sampleSiteData, 'xlsx');
    expect(res.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.fileName).toBe('site-report-site-a-2026-11-25.xlsx');
    const buf = await streamToBuffer(res.stream);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Site Summary',
      'Labour Breakdown',
      'Attendance Sessions',
    ]);
    const labourSheet = wb.getWorksheet('Labour Breakdown');
    expect(labourSheet?.getRow(2).getCell(3).value).toBe('MASON');
  });

  it('generates a valid PDF stream for an Office Muster Roll Report', async () => {
    const res = exportMusterRollToStream(sampleOfficeData, 'pdf');
    expect(res.contentType).toBe('application/pdf');
    expect(res.fileName).toBe('office-attendance-report-weekly-2026-11-23-to-2026-11-28.pdf');
    const buf = await streamToBuffer(res.stream);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('generates a valid Excel (.xlsx) workbook for an Office Muster Roll Report', async () => {
    const res = exportMusterRollToStream(sampleOfficeData, 'xlsx');
    expect(res.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const buf = await streamToBuffer(res.stream);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary & Departments',
      'Employee Muster',
      'Punch Sessions',
    ]);
    const workerSheet = wb.getWorksheet('Employee Muster');
    expect(workerSheet?.getRow(2).getCell(1).value).toBe('FIN-001');
    expect(workerSheet?.getRow(2).getCell(10).value).toBe(16);
  });
});
