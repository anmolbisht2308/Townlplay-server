import { describe, expect, it } from "vitest";
import {
  addDays,
  isDateString,
  isTimeString,
  istDate,
  istTime,
  istToUtc,
  minutesToTime,
  timeToMinutes,
  weekday,
} from "../src/time.js";

describe("IST time utils", () => {
  it("reads the IST date and time of a UTC instant", () => {
    const at = new Date("2026-03-31T19:00:00Z"); // 00:30 IST on 1 April
    expect(istDate(at)).toBe("2026-04-01");
    expect(istTime(at)).toBe("00:30");
  });

  it("converts IST wall time to UTC", () => {
    expect(istToUtc("2026-04-01", "06:00").toISOString()).toBe("2026-04-01T00:30:00.000Z");
    expect(istToUtc("2026-04-01").toISOString()).toBe("2026-03-31T18:30:00.000Z");
    expect(() => istToUtc("2026-02-30", "06:00")).toThrow();
  });

  it("validates date and time strings", () => {
    expect(isDateString("2028-02-29")).toBe(true);
    expect(isDateString("2026-02-29")).toBe(false);
    expect(isDateString("2026-4-1")).toBe(false);
    expect(isTimeString("23:59")).toBe(true);
    expect(isTimeString("24:00")).toBe(false);
  });

  it("does date arithmetic and weekdays", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekday("2026-09-27")).toBe(0);
  });

  it("converts between HH:mm and minutes", () => {
    expect(timeToMinutes("06:30")).toBe(390);
    expect(timeToMinutes("24:00")).toBe(1440);
    expect(minutesToTime(390)).toBe("06:30");
    expect(minutesToTime(1440)).toBe("24:00");
    expect(() => minutesToTime(1441)).toThrow();
  });
});
