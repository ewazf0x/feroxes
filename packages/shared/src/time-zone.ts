/**
 * Calendar periods in the owner's time zone, using only Intl (no tz library).
 * Budgets reset at local midnight, on local Mondays, and on the local 1st of the month.
 */
export type Period = 'day' | 'week' | 'month';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Monday … 6 = Sunday
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function localParts(ts: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 0,
  };
}

/** Offset of the zone from UTC at instant `ts`, in ms (local = utc + offset). */
export function zoneOffsetMs(ts: number, timeZone: string): number {
  const p = localParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** UTC instant of local wall-clock time y-m-d hh:mm in the zone. */
export function zonedTime(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

export function periodStart(period: Period, ts: number, timeZone: string): number {
  const p = localParts(ts, timeZone);
  switch (period) {
    case 'day':
      return zonedTime(timeZone, p.year, p.month, p.day);
    case 'week': {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day - p.weekday));
      return zonedTime(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    case 'month':
      return zonedTime(timeZone, p.year, p.month, 1);
  }
}

export function nextPeriodStart(period: Period, ts: number, timeZone: string): number {
  const start = periodStart(period, ts, timeZone);
  const p = localParts(start + 12 * 3_600_000, timeZone); // noon of the first local day: safe from DST edges
  switch (period) {
    case 'day': {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
      return zonedTime(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    case 'week': {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 7));
      return zonedTime(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    case 'month': {
      const d = new Date(Date.UTC(p.year, p.month, 1));
      return zonedTime(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
