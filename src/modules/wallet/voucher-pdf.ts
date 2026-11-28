import PDFDocument from 'pdfkit';

export interface CashVoucherPdfLine {
  accountCode: string;
  accountHeadName: string;
  amount: string;
}

export interface CashVoucherPdfData {
  companyName: string;
  companyAddress: string;
  voucherRef: string;
  date: string;
  siteName: string;
  siteCode: string;
  paidTo: string;
  totalAmount: string;
  amountInWords: string;
  narration: string;
  preparedBy: string;
  checkedBy: string;
  lines: CashVoucherPdfLine[];
}

export interface FundingReceiptPdfData {
  companyName: string;
  companyAddress: string;
  receiptRef: string;
  date: string;
  siteName: string;
  siteCode: string;
  transferReference: string;
  purpose: string;
  transferredAmount: string;
  confirmedAmount: string;
  amountInWords: string;
  status: string;
  recordedBy: string;
  confirmedBy: string;
}

/**
 * Attaches stream listeners BEFORE drawing so no PDFKit chunks are dropped,
 * then resolves once `doc.end()` finishes.
 */
function createPdfCollector(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  title: string,
  refNo: string,
  dateLabel: string,
  dateValue: string,
  companyName: string,
  companyAddress: string,
): number {
  const headerH = 54;
  const dateBoxW = 105;
  const mainW = w - dateBoxW;

  doc.rect(x, y, mainW, headerH).stroke();
  doc.rect(x + mainW, y, dateBoxW, 22).stroke();
  doc.rect(x + mainW, y + 22, dateBoxW, headerH - 22).stroke();

  // Stylized SC emblem on left
  doc.save();
  doc.font('Helvetica-Bold').fontSize(18).text('SC', x + 8, y + 8, { width: 32 });
  doc.font('Helvetica').fontSize(6).text('The Creative Team', x + 5, y + 28, { width: 42 });
  doc.restore();

  // Title + Company Name + Address
  doc.font('Helvetica-Bold').fontSize(10).text(`${title}  (${refNo})`, x + 50, y + 4, {
    width: mainW - 58,
    align: 'center',
  });
  doc.font('Helvetica-Bold').fontSize(13).text(companyName, x + 50, y + 17, {
    width: mainW - 58,
    align: 'center',
  });
  if (companyAddress.length > 0) {
    doc.font('Helvetica').fontSize(7.5).text(companyAddress, x + 50, y + 34, {
      width: mainW - 58,
      align: 'center',
    });
  }

  // Date box
  doc.font('Helvetica-Bold').fontSize(9).text(dateLabel, x + mainW, y + 6, {
    width: dateBoxW,
    align: 'center',
  });
  doc.font('Helvetica').fontSize(9.5).text(dateValue, x + mainW, y + 32, {
    width: dateBoxW,
    align: 'center',
  });

  return y + headerH;
}

/**
 * Generates an A5 Landscape PDF matching the Sarjan Construction Pvt. Ltd.
 * printed Cash Voucher layout.
 */
export async function renderCashVoucherPdf(data: CashVoucherPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 22 });
  const done = createPdfCollector(doc);
  const x = 22;
  let y = 22;
  const w = doc.page.width - 44; // ~551 pt

  y = drawHeader(
    doc,
    x,
    y,
    w,
    'CASH VOUCHER',
    data.voucherRef,
    'Date',
    data.date,
    data.companyName,
    data.companyAddress,
  );

  // Site Name / Site Code row
  const siteRowH = 20;
  const siteLeftW = Math.round(w * 0.62);
  const siteRightW = w - siteLeftW;
  doc.rect(x, y, siteLeftW, siteRowH).stroke();
  doc.rect(x + siteLeftW, y, siteRightW, siteRowH).stroke();
  doc.font('Helvetica-Bold').fontSize(9).text('Site Name :', x + 5, y + 6, { continued: true });
  doc.font('Helvetica').text(` ${data.siteName}`);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('Site Code :', x + siteLeftW + 5, y + 6, { continued: true });
  doc.font('Helvetica').text(` ${data.siteCode}`);
  y += siteRowH;

  // Main split grid: Left account lines table + Right Paid to / Rs. / Rupees
  const leftW = siteLeftW;
  const rightW = siteRightW;
  const colCodeW = 65;
  const colAmtW = 78;
  const colHeadW = leftW - colCodeW - colAmtW;
  const rowH = 18;
  const minDataRows = 6;
  const displayRows = Math.max(minDataRows, data.lines.length);
  const tableH = (displayRows + 2) * rowH; // header + rows + TOTAL

  // Left table header
  doc.rect(x, y, colCodeW, rowH).stroke();
  doc.rect(x + colCodeW, y, colHeadW, rowH).stroke();
  doc.rect(x + colCodeW + colHeadW, y, colAmtW, rowH).stroke();
  doc.font('Helvetica-Bold').fontSize(8.5);
  doc.text('A/c. Code', x + 3, y + 5, { width: colCodeW - 6, align: 'center' });
  doc.text('Account Head', x + colCodeW + 4, y + 5, { width: colHeadW - 8, align: 'center' });
  doc.text('Amount', x + colCodeW + colHeadW + 3, y + 5, { width: colAmtW - 6, align: 'center' });

  // Left table body rows
  for (let i = 0; i < displayRows; i += 1) {
    const ry = y + (i + 1) * rowH;
    doc.rect(x, ry, colCodeW, rowH).stroke();
    doc.rect(x + colCodeW, ry, colHeadW, rowH).stroke();
    doc.rect(x + colCodeW + colHeadW, ry, colAmtW, rowH).stroke();
    const line = data.lines[i];
    if (line !== undefined) {
      doc.font('Helvetica').fontSize(8.5);
      doc.text(line.accountCode, x + 4, ry + 5, { width: colCodeW - 8 });
      doc.text(line.accountHeadName, x + colCodeW + 4, ry + 5, {
        width: colHeadW - 8,
        ellipsis: true,
      });
      doc.text(line.amount, x + colCodeW + colHeadW + 4, ry + 5, {
        width: colAmtW - 8,
        align: 'right',
      });
    }
  }

  // TOTAL row
  const totalY = y + (displayRows + 1) * rowH;
  doc.rect(x, totalY, colCodeW, rowH).stroke();
  doc.rect(x + colCodeW, totalY, colHeadW, rowH).stroke();
  doc.rect(x + colCodeW + colHeadW, totalY, colAmtW, rowH).stroke();
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('TOTAL....', x + colCodeW + 4, totalY + 5, { width: colHeadW - 10, align: 'right' });
  doc.text(data.totalAmount, x + colCodeW + colHeadW + 4, totalY + 5, {
    width: colAmtW - 8,
    align: 'right',
  });

  // Right panel: Paid to, Rs., Rupees
  const rx = x + leftW;
  const paidToH = Math.round(tableH * 0.34);
  const rsH = Math.round(tableH * 0.24);
  const rupeesH = tableH - paidToH - rsH;

  doc.rect(rx, y, rightW, paidToH).stroke();
  doc.rect(rx, y + paidToH, rightW, rsH).stroke();
  doc.rect(rx, y + paidToH + rsH, rightW, rupeesH).stroke();

  doc.font('Helvetica-Bold').fontSize(8.5).text('Paid to', rx + 6, y + 10, { continued: true });
  doc.font('Helvetica').text(`  ${data.paidTo || '_____________________'}`, {
    width: rightW - 14,
  });

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('Rs.:', rx + 6, y + paidToH + 10, { continued: true });
  doc.font('Helvetica-Bold').text(`  ${data.totalAmount} /-`);

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .text('Rupees  ', rx + 6, y + paidToH + rsH + 8, { continued: true });
  doc.font('Helvetica').fontSize(8).text(data.amountInWords, { width: rightW - 14 });

  y += tableH;

  // Narration + Signatures box
  const bottomH = doc.page.height - 22 - y;
  doc.rect(x, y, w, bottomH).stroke();
  doc
    .font('Helvetica-BoldOblique')
    .fontSize(9)
    .text('Narration :', x + 6, y + 6, { continued: true });
  doc.font('Helvetica').text(` ${data.narration}`, { width: w - 16 });

  // Receiver Sign stamp box + signature labels
  const sigY = y + bottomH - 18;
  const boxSize = 30;
  doc.rect(x + w - 75, sigY - boxSize - 6, boxSize, boxSize).stroke();

  doc.font('Helvetica-BoldOblique').fontSize(8.5);
  doc.text('Prepared By', x + 22, sigY);
  if (data.preparedBy.length > 0) {
    doc.font('Helvetica').fontSize(7.5).text(data.preparedBy, x + 22, sigY - 11);
  }
  doc.font('Helvetica-BoldOblique').fontSize(8.5).text('Checked By', x + Math.round(w * 0.42), sigY);
  if (data.checkedBy.length > 0) {
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .text(data.checkedBy, x + Math.round(w * 0.42), sigY - 11);
  }
  doc.font('Helvetica-BoldOblique').fontSize(8.5).text('Receiver Sign.', x + w - 95, sigY);

  doc.end();
  return done;
}

/**
 * Generates an A5 Landscape PDF receipt for a recorded/confirmed wallet funding transfer.
 */
export async function renderFundingReceiptPdf(data: FundingReceiptPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 22 });
  const done = createPdfCollector(doc);
  const x = 22;
  let y = 22;
  const w = doc.page.width - 44;

  y = drawHeader(
    doc,
    x,
    y,
    w,
    'WALLET FUNDING RECEIPT',
    data.receiptRef,
    'Date',
    data.date,
    data.companyName,
    data.companyAddress,
  );

  const rowH = 22;
  const leftW = Math.round(w * 0.58);
  const rightW = w - leftW;

  doc.rect(x, y, leftW, rowH).stroke();
  doc.rect(x + leftW, y, rightW, rowH).stroke();
  doc.font('Helvetica-Bold').fontSize(9).text('Site Name :', x + 6, y + 6, { continued: true });
  doc.font('Helvetica').text(` ${data.siteName}`);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('Site Code :', x + leftW + 6, y + 6, { continued: true });
  doc.font('Helvetica').text(` ${data.siteCode}`);
  y += rowH;

  const detailsH = 126;
  doc.rect(x, y, leftW, detailsH).stroke();
  doc.rect(x + leftW, y, rightW, detailsH).stroke();

  doc.font('Helvetica-Bold').fontSize(9).text('Transfer Ref :', x + 6, y + 10, { continued: true });
  doc.font('Helvetica').text(` ${data.transferReference}`);
  doc.font('Helvetica-Bold').text('Status :', x + 6, y + 32, { continued: true });
  doc.font('Helvetica').text(` ${data.status}`);
  doc.font('Helvetica-Bold').text('Purpose :', x + 6, y + 54, { continued: true });
  doc.font('Helvetica').text(` ${data.purpose}`, { width: leftW - 14 });

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('Transferred :', x + leftW + 6, y + 12, { continued: true });
  doc.font('Helvetica').text(` INR ${data.transferredAmount}`);
  doc
    .font('Helvetica-Bold')
    .text('Confirmed :', x + leftW + 6, y + 36, { continued: true });
  doc.font('Helvetica-Bold').text(` INR ${data.confirmedAmount}`);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .text('Rupees : ', x + leftW + 6, y + 64, { continued: true });
  doc.font('Helvetica').fontSize(8).text(data.amountInWords, { width: rightW - 14 });

  y += detailsH;

  const footerH = doc.page.height - 22 - y;
  doc.rect(x, y, w, footerH).stroke();
  const sigY = y + footerH - 20;
  doc.font('Helvetica-BoldOblique').fontSize(8.5).text('Transferred By', x + 22, sigY);
  if (data.recordedBy.length > 0) {
    doc.font('Helvetica').fontSize(7.5).text(data.recordedBy, x + 22, sigY - 12);
  }
  doc
    .font('Helvetica-BoldOblique')
    .fontSize(8.5)
    .text('Confirmed By (PI)', x + Math.round(w * 0.55), sigY);
  if (data.confirmedBy.length > 0) {
    doc.font('Helvetica').fontSize(7.5).text(data.confirmedBy, x + Math.round(w * 0.55), sigY - 12);
  }

  doc.end();
  return done;
}
