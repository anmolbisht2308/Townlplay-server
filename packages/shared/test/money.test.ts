import { describe, expect, it } from "vitest";
import { formatPaise, isPaise, percentOfPaise, rupeesToPaise } from "../src/money.js";

describe("money", () => {
  it("converts rupees to integer paise", () => {
    expect(rupeesToPaise(1250.5)).toBe(125050);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
  });

  it("formats paise in Indian grouping", () => {
    expect(formatPaise(125000)).toBe("₹1,250");
    expect(formatPaise(125050)).toBe("₹1,250.50");
    expect(formatPaise(10000000)).toBe("₹1,00,000");
    expect(() => formatPaise(1.5)).toThrow();
  });

  it("validates and takes percentages of paise", () => {
    expect(isPaise(100)).toBe(true);
    expect(isPaise(-1)).toBe(false);
    expect(isPaise(1.5)).toBe(false);
    expect(percentOfPaise(99900, 30)).toBe(29970);
    expect(percentOfPaise(333, 50)).toBe(167);
  });
});
