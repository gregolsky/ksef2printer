const TZ = 'Europe/Warsaw'

/** UTC offset of Europe/Warsaw at the given instant, as "+01:00" or "+02:00". */
export function warsawOffset(at: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value
  const m = /GMT([+-]\d{2}:\d{2})/.exec(part ?? '')
  return m?.[1] ?? '+00:00'
}

export interface Month {
  year: number
  month: number
}

export function parseMonth(s: string): Month | null {
  const m = /^(\d{4})-(\d{2})$/.exec(s)
  if (m == null) return null
  const year = Number(m[1])
  const month = Number(m[2])
  return month >= 1 && month <= 12 ? { year, month } : null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** First and last instant of a calendar month in Polish local time, as ISO-8601 with offset. */
export function monthBounds({ year, month }: Month): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  // Offsets are sampled at noon UTC, well away from the 01:00 UTC DST switch.
  const fromOffset = warsawOffset(new Date(Date.UTC(year, month - 1, 1, 12)))
  const toOffset = warsawOffset(new Date(Date.UTC(year, month - 1, lastDay, 12)))
  return {
    from: `${year}-${pad(month)}-01T00:00:00${fromOffset}`,
    to: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59${toOffset}`,
  }
}
