/**
 * Vitest setup file for the clock check (issue #104). It moves the JavaScript clock forward by
 * CLOCK_OFFSET_DAYS days: `new Date()` and `Date.now()` answer real time plus the offset, and
 * time keeps running. Dates built from arguments, `performance.now()` and timers are untouched.
 * With the variable unset or 0 it does nothing. Used only through `clock-check.sh`.
 *
 * It does not move Postgres: `now()` in SQL stays real. A test that writes through the database
 * with a default of `now()` and then compares with this clock can fail under it without ever
 * failing on a machine whose real clock had moved. Judge each failure with that in mind.
 */
const days = Number(process.env.CLOCK_OFFSET_DAYS ?? 0);

if (Number.isFinite(days) && days !== 0) {
  const offsetMs = days * 86_400_000;
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...(args as [number]));
    }
    static override now(): number {
      return RealDate.now() + offsetMs;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
