import { describe, it, expect } from 'vitest';
import { calculateNetLeaveDays } from '../../../src/modules/leave/types.js';

describe('calculateNetLeaveDays', () => {
  it('returns 0.5 for half day regardless of dates', () => {
    const days = calculateNetLeaveDays('2026-11-20', '2026-11-20', true, false);
    expect(days).toBe(0.5);
  });

  it('calculates single full day', () => {
    // 2026-11-18 is Wednesday
    const days = calculateNetLeaveDays('2026-11-18', '2026-11-18', false, false);
    expect(days).toBe(1.0);
  });

  it('excludes Sundays when sandwich rule is disabled', () => {
    // 2026-11-20 is Friday, 2026-11-21 is Sat, 2026-11-22 is Sun, 2026-11-23 is Monday
    // Total calendar days = 4; Sundays = 1; Net = 3
    const days = calculateNetLeaveDays('2026-11-20', '2026-11-23', false, false);
    expect(days).toBe(3.0);
  });

  it('includes Sundays when sandwich rule is enabled', () => {
    // Friday to Monday inclusive = 4 days
    const days = calculateNetLeaveDays('2026-11-20', '2026-11-23', false, true);
    expect(days).toBe(4.0);
  });

  it('throws error if startDate is after endDate', () => {
    expect(() => calculateNetLeaveDays('2026-11-25', '2026-11-20', false, false)).toThrow(
      'startDate cannot be after endDate',
    );
  });
});
