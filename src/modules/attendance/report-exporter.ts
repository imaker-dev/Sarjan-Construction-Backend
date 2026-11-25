import { PassThrough } from 'node:stream';
import type { DailySiteReport, DailySiteReportLabour, Site } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { AttendanceSessionWithDetails } from './repository.js';
import type { DepartmentMusterSummary, WeeklyWorkHoursProgress } from './types.js';

export type ReportExportFormat = 'pdf' | 'xlsx';

export interface ExportStreamResult {
  stream: PassThrough;
  contentType: string;
  fileName: string;
}

export interface SiteReportExportData {
  report: DailySiteReport & {
    labourSummaries: DailySiteReportLabour[];
    site: Pick<Site, 'id' | 'code' | 'name'>;
    project: { id: string; code: string; name: string };
    submittedBy?: { id: string; employeeCode: string; displayName: string } | null;
    approvedBy?: { id: string; employeeCode: string; displayName: string } | null;
    lockedBy?: { id: string; employeeCode: string; displayName: string } | null;
  };
  sessions: AttendanceSessionWithDetails[];
}

export interface MusterRollExportData {
  title: string;
  scopeLabel: string;
  period: string;
  from: string;
  to: string;
  totalSessions: number;
  totalMandays: number;
  totalPresentUnits: number;
  totalOvertimePUnits: number;
  totalTotalPUnits: number;
  totalOvertimeHours: number;
  departmentSummaries?: DepartmentMusterSummary[];
  workerSummaries: {
    employeeId: string;
    employeeCode: string;
    displayName: string;
    tradeCategory: string | null;
    designation?: string | null;
    department?: { id: string; code: string; name: string } | null;
    presentUnits: number;
    overtimePUnits: number;
    totalPUnits: number;
    overtimeHours: number;
    sessionsCount: number;
    daysPresent: number;
    leaveDays: number;
    weeklyProgress?: WeeklyWorkHoursProgress;
  }[];
  sessions: AttendanceSessionWithDetails[];
}

const PDF_CONTENT_TYPE = 'application/pdf';
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
}

function fmtDateTime(dt: Date | string | null | undefined): string {
  if (!dt) return '-';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmtNum(val: unknown, decimals = 1): string {
  const n = Number(val ?? 0);
  return Number.isFinite(n) ? n.toFixed(decimals) : '0';
}

function styleExcelHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E3A5F' },
  };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 22;
}

function autoFitColumns(sheet: ExcelJS.Worksheet, minWidth = 12, maxWidth = 42): void {
  sheet.columns.forEach((col) => {
    let maxLen = minWidth;
    if (col.eachCell) {
      col.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        const text =
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? String(v)
            : '';
        maxLen = Math.max(maxLen, text.length + 2);
      });
    }
    col.width = Math.min(maxWidth, maxLen);
  });
}

function createPdfTableDrawer(doc: PDFKit.PDFDocument) {
  const pageLeft = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const ensureSpace = (neededHeight: number) => {
    if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
  };

  const drawSectionTitle = (title: string) => {
    ensureSpace(32);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1E3A5F').text(title, pageLeft);
    doc
      .moveTo(pageLeft, doc.y + 2)
      .lineTo(pageLeft + usableWidth, doc.y + 2)
      .strokeColor('#CBD5E1')
      .lineWidth(0.8)
      .stroke();
    doc.moveDown(0.4);
  };

  const drawTable = (headers: string[], colRatios: number[], rows: string[][]) => {
    const colWidths = colRatios.map((r) => Math.floor(usableWidth * r));
    const rowHeight = 18;

    const renderHeader = () => {
      ensureSpace(rowHeight + 6);
      const startY = doc.y;
      doc.rect(pageLeft, startY, usableWidth, rowHeight).fill('#1E3A5F');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
      let x = pageLeft + 4;
      headers.forEach((h, i) => {
        doc.text(h, x, startY + 5, { width: (colWidths[i] ?? 40) - 6, ellipsis: true, lineBreak: false });
        x += colWidths[i] ?? 40;
      });
      doc.y = startY + rowHeight;
    };

    renderHeader();

    rows.forEach((cells, rowIdx) => {
      if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        renderHeader();
      }
      const startY = doc.y;
      if (rowIdx % 2 === 1) {
        doc.rect(pageLeft, startY, usableWidth, rowHeight).fill('#F8FAFC');
      }
      doc.font('Helvetica').fontSize(8).fillColor('#0F172A');
      let x = pageLeft + 4;
      cells.forEach((val, i) => {
        doc.text(val, x, startY + 5, { width: (colWidths[i] ?? 40) - 6, ellipsis: true, lineBreak: false });
        x += colWidths[i] ?? 40;
      });
      doc
        .moveTo(pageLeft, startY + rowHeight)
        .lineTo(pageLeft + usableWidth, startY + rowHeight)
        .strokeColor('#E2E8F0')
        .lineWidth(0.4)
        .stroke();
      doc.y = startY + rowHeight;
    });
    doc.moveDown(0.4);
  };

  return { pageLeft, usableWidth, ensureSpace, drawSectionTitle, drawTable };
}

export function exportSiteReportToStream(
  data: SiteReportExportData,
  format: ReportExportFormat,
): ExportStreamResult {
  const { report, sessions } = data;
  const baseName = `site-report-${sanitizeFilePart(report.site.code)}-${report.businessDate}`;
  const stream = new PassThrough();

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sarjan Construction ERP';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('Site Summary');
    summarySheet.addRows([
      ['DAILY SITE REPORT (DSR)'],
      ['Project', `${report.project.code} - ${report.project.name}`],
      ['Site', `${report.site.code} - ${report.site.name}`],
      ['Business Date', report.businessDate],
      ['Status', report.status],
      ['Weather', `${report.weather} (Stoppage: ${fmtNum(report.weatherStoppageHours, 2)} hrs)`],
      ['Safety Incident', report.safetyIncidentReported ? `YES - ${report.safetyNotes ?? ''}` : 'No'],
      ['Work Progress Notes', report.workProgressNotes ?? '-'],
      ['Site Obstacles / Remarks', report.siteObstaclesRemarks ?? '-'],
      [],
      ['WORKFORCE TOTALS', 'Count / Value'],
      ['Total Workers Headcount', report.totalWorkersHeadcount],
      ['Total Present Units (Hazri)', Number(report.totalPresentUnits)],
      ['Total Overtime Hours', Number(report.totalOvertimeHours)],
      ['Total Overtime P-Units', Number(report.totalOvertimePUnits)],
      ['Flagged Sessions', report.totalFlaggedSessions],
      ['Cat A (Staff) Count / Units', `${report.catAStaffCount} / ${fmtNum(report.catAStaffUnits)}`],
      ['Cat B (Direct Labour) Count / Units', `${report.catBDirectCount} / ${fmtNum(report.catBDirectUnits)}`],
      ['Cat C (Subcontractor) Count / Units', `${report.catCSubconCount} / ${fmtNum(report.catCSubconUnits)}`],
      [],
      ['SIGN-OFF', 'Actor', 'Timestamp'],
      ['Submitted', report.submittedBy ? `${report.submittedBy.employeeCode} ${report.submittedBy.displayName}` : '-', fmtDateTime(report.submittedAt)],
      ['Approved', report.approvedBy ? `${report.approvedBy.employeeCode} ${report.approvedBy.displayName}` : '-', fmtDateTime(report.approvedAt)],
      ['Locked', report.lockedBy ? `${report.lockedBy.employeeCode} ${report.lockedBy.displayName}` : '-', fmtDateTime(report.lockedAt)],
    ]);
    summarySheet.getRow(1).font = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
    styleExcelHeaderRow(summarySheet.getRow(11));
    styleExcelHeaderRow(summarySheet.getRow(21));
    autoFitColumns(summarySheet);

    const labourSheet = workbook.addWorksheet('Labour Breakdown');
    const lHeader = labourSheet.addRow([
      'Category',
      'Subcontractor',
      'Trade Category',
      'Headcount',
      'Present Units',
      'Overtime Hours',
      'Remarks',
    ]);
    styleExcelHeaderRow(lHeader);
    for (const l of report.labourSummaries) {
      labourSheet.addRow([
        l.category,
        l.subcontractorName ?? '-',
        l.tradeCategory,
        l.headcount,
        Number(l.presentUnits),
        Number(l.overtimeHours),
        l.remarks ?? '-',
      ]);
    }
    autoFitColumns(labourSheet);

    const sessionSheet = workbook.addWorksheet('Attendance Sessions');
    const sHeader = sessionSheet.addRow([
      'Employee Code',
      'Employee Name',
      'Trade',
      'Punch In',
      'Punch Out',
      'Net Mins',
      'Present Units',
      'OT Hours',
      'Status',
      'Flagged',
      'Remarks',
    ]);
    styleExcelHeaderRow(sHeader);
    for (const s of sessions) {
      sessionSheet.addRow([
        s.employee.employeeCode,
        s.employee.displayName,
        s.employee.tradeCategory ?? '-',
        fmtDateTime(s.punchInAt),
        fmtDateTime(s.punchOutAt),
        s.netDurationMins,
        Number(s.presentUnits),
        Number(s.overtimeHours),
        s.status,
        s.isFlagged ? s.flagReason ?? 'YES' : 'NO',
        s.punchOutRemarks ?? '-',
      ]);
    }
    autoFitColumns(sessionSheet);

    void workbook.xlsx
      .write(stream)
      .then(() => stream.end())
      .catch((err: unknown) => stream.destroy(err instanceof Error ? err : new Error(String(err))));

    return {
      stream,
      contentType: XLSX_CONTENT_TYPE,
      fileName: `${baseName}.xlsx`,
    };
  }

  // PDF generation
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
  doc.on('error', (err) => stream.destroy(err));
  doc.pipe(stream);

  const { pageLeft, drawSectionTitle, drawTable } = createPdfTableDrawer(doc);

  doc.font('Helvetica-Bold').fontSize(15).fillColor('#1E3A5F').text('DAILY SITE REPORT (DSR)', pageLeft);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#334155')
    .text(`Project: ${report.project.code} - ${report.project.name}   |   Site: ${report.site.code} - ${report.site.name}`)
    .text(`Business Date: ${report.businessDate}   |   Status: ${report.status}   |   Generated: ${fmtDateTime(new Date())}`);

  drawSectionTitle('Site & Environmental Conditions');
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#0F172A')
    .text(`Weather: ${report.weather} (Stoppage: ${fmtNum(report.weatherStoppageHours, 2)} hrs)`)
    .text(`Safety Incident: ${report.safetyIncidentReported ? `YES — ${report.safetyNotes ?? ''}` : 'None Reported'}`)
    .text(`Work Progress: ${report.workProgressNotes ?? '-'}`)
    .text(`Obstacles / Remarks: ${report.siteObstaclesRemarks ?? '-'}`);

  drawSectionTitle('Workforce Category Summary');
  drawTable(
    ['Category', 'Headcount', 'Present Units (Hazri)'],
    [0.5, 0.25, 0.25],
    [
      ['Category A (Staff)', String(report.catAStaffCount), fmtNum(report.catAStaffUnits)],
      ['Category B (Direct Labour)', String(report.catBDirectCount), fmtNum(report.catBDirectUnits)],
      ['Category C (Subcontractor)', String(report.catCSubconCount), fmtNum(report.catCSubconUnits)],
      [
        'TOTAL',
        String(report.totalWorkersHeadcount),
        `${fmtNum(report.totalPresentUnits)} (OT: ${fmtNum(report.totalOvertimeHours, 2)} hrs)`,
      ],
    ],
  );

  drawSectionTitle('Labour & Trade Breakdown');
  if (report.labourSummaries.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748B').text('No labour breakdown rows recorded.');
  } else {
    drawTable(
      ['Category', 'Subcontractor', 'Trade', 'Count', 'Units', 'OT Hrs'],
      [0.18, 0.24, 0.24, 0.1, 0.12, 0.12],
      report.labourSummaries.map((l) => [
        l.category,
        l.subcontractorName ?? '-',
        l.tradeCategory,
        String(l.headcount),
        fmtNum(l.presentUnits),
        fmtNum(l.overtimeHours, 2),
      ]),
    );
  }

  if (sessions.length > 0) {
    drawSectionTitle(`Worker Sessions (${sessions.length})`);
    drawTable(
      ['Code', 'Name', 'Punch In', 'Punch Out', 'Units', 'Status'],
      [0.12, 0.24, 0.22, 0.22, 0.08, 0.12],
      sessions.map((s) => [
        s.employee.employeeCode,
        s.employee.displayName,
        fmtDateTime(s.punchInAt),
        fmtDateTime(s.punchOutAt),
        fmtNum(s.presentUnits),
        s.status,
      ]),
    );
  }

  drawSectionTitle('Sign-Off Trail');
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#334155')
    .text(`Submitted: ${report.submittedBy ? `${report.submittedBy.employeeCode} ${report.submittedBy.displayName}` : '-'} (${fmtDateTime(report.submittedAt)})`)
    .text(`Approved:  ${report.approvedBy ? `${report.approvedBy.employeeCode} ${report.approvedBy.displayName}` : '-'} (${fmtDateTime(report.approvedAt)})`)
    .text(`Locked:    ${report.lockedBy ? `${report.lockedBy.employeeCode} ${report.lockedBy.displayName}` : '-'} (${fmtDateTime(report.lockedAt)})`);

  doc.end();

  return {
    stream,
    contentType: PDF_CONTENT_TYPE,
    fileName: `${baseName}.pdf`,
  };
}

export function exportMusterRollToStream(
  data: MusterRollExportData,
  format: ReportExportFormat,
): ExportStreamResult {
  const baseName = `${sanitizeFilePart(data.title)}-${data.period.toLowerCase()}-${data.from}-to-${data.to}`;
  const stream = new PassThrough();

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sarjan Construction ERP';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('Summary & Departments');
    summarySheet.addRows([
      [data.title],
      ['Scope', data.scopeLabel],
      ['Period', `${data.period} (${data.from} to ${data.to})`],
      ['Total Sessions', data.totalSessions],
      ['Total Mandays', data.totalMandays],
      ['Total Present Units', data.totalPresentUnits],
      ['Total Overtime Hours', data.totalOvertimeHours],
      [],
      ['Department Code', 'Department Name', 'Category', 'Total Employees', 'Present', 'Absent', 'Present Units', 'Overtime Hours'],
    ]);
    summarySheet.getRow(1).font = { bold: true, size: 13, color: { argb: 'FF1E3A5F' } };
    styleExcelHeaderRow(summarySheet.getRow(9));

    for (const d of data.departmentSummaries ?? []) {
      summarySheet.addRow([
        d.departmentCode,
        d.departmentName,
        d.category ?? '-',
        d.totalEmployees,
        d.presentCount,
        d.absentCount,
        d.totalPresentUnits,
        d.totalOvertimeHours,
      ]);
    }
    autoFitColumns(summarySheet);

    const workerSheet = workbook.addWorksheet('Employee Muster');
    const wHeader = workerSheet.addRow([
      'Employee Code',
      'Name',
      'Designation',
      'Department',
      'Days Present',
      'Leave Days',
      'Present Units',
      'Overtime Hours',
      'Weekly Target (h)',
      'Weekly Completed (h)',
      'Weekly Remaining (h)',
      'Progress (%)',
      'Weekly Status',
    ]);
    styleExcelHeaderRow(wHeader);
    for (const w of data.workerSummaries) {
      workerSheet.addRow([
        w.employeeCode,
        w.displayName,
        w.designation ?? '-',
        w.department ? `${w.department.code} - ${w.department.name}` : '-',
        w.daysPresent,
        w.leaveDays,
        w.presentUnits,
        w.overtimeHours,
        w.weeklyProgress?.targetWeeklyHours ?? 48,
        w.weeklyProgress?.completedWeeklyHours ?? 0,
        w.weeklyProgress?.remainingWeeklyHours ?? 48,
        w.weeklyProgress?.progressPercentage ?? 0,
        w.weeklyProgress?.status ?? '-',
      ]);
    }
    autoFitColumns(workerSheet);

    const sessionSheet = workbook.addWorksheet('Punch Sessions');
    const sHeader = sessionSheet.addRow([
      'Business Date',
      'Employee Code',
      'Employee Name',
      'Location',
      'Punch In',
      'Punch Out',
      'Net Mins',
      'Present Units',
      'OT Hours',
      'Status',
      'Remarks',
    ]);
    styleExcelHeaderRow(sHeader);
    for (const s of data.sessions) {
      const location = s.site
        ? `Site: ${s.site.code}`
        : s.headOffice
          ? `HO: ${s.headOffice.code}`
          : '-';
      sessionSheet.addRow([
        s.businessDate,
        s.employee.employeeCode,
        s.employee.displayName,
        location,
        fmtDateTime(s.punchInAt),
        fmtDateTime(s.punchOutAt),
        s.netDurationMins,
        Number(s.presentUnits),
        Number(s.overtimeHours),
        s.status,
        s.punchOutRemarks ?? '-',
      ]);
    }
    autoFitColumns(sessionSheet);

    void workbook.xlsx
      .write(stream)
      .then(() => stream.end())
      .catch((err: unknown) => stream.destroy(err instanceof Error ? err : new Error(String(err))));

    return {
      stream,
      contentType: XLSX_CONTENT_TYPE,
      fileName: `${baseName}.xlsx`,
    };
  }

  // PDF generation
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
  doc.on('error', (err) => stream.destroy(err));
  doc.pipe(stream);

  const { pageLeft, drawSectionTitle, drawTable } = createPdfTableDrawer(doc);

  doc.font('Helvetica-Bold').fontSize(15).fillColor('#1E3A5F').text(data.title.toUpperCase(), pageLeft);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#334155')
    .text(`Scope: ${data.scopeLabel}   |   Period: ${data.period} (${data.from} to ${data.to})`)
    .text(
      `Sessions: ${data.totalSessions}   |   Mandays: ${data.totalMandays}   |   Present Units: ${fmtNum(data.totalPresentUnits)}   |   OT Hrs: ${fmtNum(data.totalOvertimeHours, 2)}`,
    );

  if (data.departmentSummaries && data.departmentSummaries.length > 0) {
    drawSectionTitle('Department Summary');
    drawTable(
      ['Code', 'Department', 'Total', 'Present', 'Absent', 'Units', 'OT Hrs'],
      [0.1, 0.34, 0.1, 0.11, 0.11, 0.12, 0.12],
      data.departmentSummaries.map((d) => [
        d.departmentCode,
        d.departmentName,
        String(d.totalEmployees),
        String(d.presentCount),
        String(d.absentCount),
        fmtNum(d.totalPresentUnits),
        fmtNum(d.totalOvertimeHours, 2),
      ]),
    );
  }

  drawSectionTitle('Employee Muster & 48h Weekly Progress');
  if (data.workerSummaries.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748B').text('No employee attendance records found.');
  } else {
    drawTable(
      ['Code', 'Name', 'Dept', 'Days', 'Units', '48h Bar', 'Status'],
      [0.11, 0.24, 0.16, 0.08, 0.1, 0.16, 0.15],
      data.workerSummaries.map((w) => [
        w.employeeCode,
        w.displayName,
        w.department?.code ?? '-',
        String(w.daysPresent),
        fmtNum(w.presentUnits),
        w.weeklyProgress
          ? `${w.weeklyProgress.completedWeeklyHours}/${w.weeklyProgress.targetWeeklyHours}h (${w.weeklyProgress.progressPercentage}%)`
          : '-',
        w.weeklyProgress?.status ?? '-',
      ]),
    );
  }

  if (data.sessions.length > 0) {
    drawSectionTitle(`Detailed Punch Log (${data.sessions.length})`);
    drawTable(
      ['Date', 'Code', 'Name', 'Punch In', 'Punch Out', 'Units', 'Status'],
      [0.12, 0.1, 0.2, 0.19, 0.19, 0.08, 0.12],
      data.sessions.map((s) => [
        s.businessDate,
        s.employee.employeeCode,
        s.employee.displayName,
        fmtDateTime(s.punchInAt),
        fmtDateTime(s.punchOutAt),
        fmtNum(s.presentUnits),
        s.status,
      ]),
    );
  }

  doc.end();

  return {
    stream,
    contentType: PDF_CONTENT_TYPE,
    fileName: `${baseName}.pdf`,
  };
}
