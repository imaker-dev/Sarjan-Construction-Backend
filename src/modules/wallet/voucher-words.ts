import { Prisma } from '@prisma/client';

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  const o = ONES[n % 10] ?? '';
  return o === '' ? t : `${t} ${o}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h === 0) return twoDigits(rest);
  return rest === 0 ? `${ONES[h]} Hundred` : `${ONES[h]} Hundred ${twoDigits(rest)}`;
}

/**
 * Indian-system words for a whole rupee figure: … crore | lakh | thousand |
 * hundred-and-below. Exact for values below 10^15 (BigInt math, no floats).
 */
function rupeesWords(rupees: bigint): string {
  if (rupees === 0n) return 'Zero';
  const CRORE = 10_000_000n;
  const LAKH = 100_000n;
  const THOUSAND = 1_000n;
  const parts: string[] = [];
  let n = rupees;
  const crore = n / CRORE;
  if (crore > 0n) {
    // Values this large are unrealistic for site wallets but stay correct.
    parts.push(`${rupeesWords(crore)} Crore`);
    n %= CRORE;
  }
  const lakh = n / LAKH;
  if (lakh > 0n) {
    parts.push(`${twoDigits(Number(lakh))} Lakh`);
    n %= LAKH;
  }
  const thousand = n / THOUSAND;
  if (thousand > 0n) {
    parts.push(`${twoDigits(Number(thousand))} Thousand`);
    n %= THOUSAND;
  }
  const rest = Number(n);
  if (rest > 0) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/**
 * "One Thousand Two Hundred Fifty Rupees and Twenty-Five Paise Only" —
 * exact Decimal input, never floating-point.
 */
export function inrToWords(amount: Prisma.Decimal | string): string {
  const d = amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
  const fixed = d.toFixed(2); // exact decimal string, e.g. "1250.25"
  const negative = fixed.startsWith('-');
  const [rStr = '0', pStr = '00'] = (negative ? fixed.slice(1) : fixed).split('.');
  const rupees = BigInt(rStr);
  const paise = Number(pStr.slice(0, 2).padEnd(2, '0'));
  const rWords = rupees === 0n ? 'Zero' : rupeesWords(rupees);
  const rLabel = rupees === 1n ? 'Rupee' : 'Rupees';
  let out = `${rWords} ${rLabel}`;
  if (paise > 0) out += ` and ${twoDigits(paise)} ${paise === 1 ? 'Paisa' : 'Paise'}`;
  out += ' Only';
  return negative ? `Minus ${out}` : out;
}
