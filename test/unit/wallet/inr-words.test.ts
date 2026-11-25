import { describe, it, expect } from 'vitest';
import { inrToWords } from '../../../src/modules/wallet/voucher-words.js';

describe('inrToWords', () => {
  it('renders rupees only', () => {
    expect(inrToWords('1250.00')).toBe('One Thousand Two Hundred Fifty Rupees Only');
    expect(inrToWords('0')).toBe('Zero Rupees Only');
    expect(inrToWords('1')).toBe('One Rupee Only');
    expect(inrToWords('20.00')).toBe('Twenty Rupees Only');
    expect(inrToWords('99')).toBe('Ninety Nine Rupees Only');
  });

  it('renders paise', () => {
    expect(inrToWords('1.50')).toBe('One Rupee and Fifty Paise Only');
    expect(inrToWords('0.05')).toBe('Zero Rupees and Five Paise Only');
    expect(inrToWords('0.01')).toBe('Zero Rupees and One Paisa Only');
    expect(inrToWords('1250.75')).toBe(
      'One Thousand Two Hundred Fifty Rupees and Seventy Five Paise Only',
    );
  });

  it('handles Indian grouping (lakh / crore)', () => {
    expect(inrToWords('100000')).toBe('One Lakh Rupees Only');
    expect(inrToWords('1250000')).toBe('Twelve Lakh Fifty Thousand Rupees Only');
    expect(inrToWords('10000000')).toBe('One Crore Rupees Only');
    expect(inrToWords('12345678.90')).toBe(
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees and Ninety Paise Only',
    );
  });

  it('renders negatives as Minus and normalizes sub-paise precision', () => {
    expect(inrToWords('-1')).toBe('Minus One Rupee Only');
    expect(inrToWords('1.004')).toBe('One Rupee Only');
  });
});
