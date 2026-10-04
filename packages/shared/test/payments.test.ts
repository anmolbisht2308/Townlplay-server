import { describe, expect, it } from "vitest";
import {
  parseConvenienceFeeConfig,
  payoutSetupRequestSchema,
  pushSubscriptionSchema,
} from "../src/payments.js";

describe("payments schemas", () => {
  it("parses the convenience fee config", () => {
    expect(parseConvenienceFeeConfig(undefined)).toEqual({ flatPaise: 0, percent: 0 });
    expect(parseConvenienceFeeConfig("flat:1000")).toEqual({ flatPaise: 1000, percent: 0 });
    expect(parseConvenienceFeeConfig("flat:500, percent:1.5")).toEqual({
      flatPaise: 500,
      percent: 1.5,
    });
    expect(() => parseConvenienceFeeConfig("tip:5")).toThrow();
    expect(() => parseConvenienceFeeConfig("percent:50")).toThrow();
  });

  it("validates bank details and push subscriptions", () => {
    const ok = {
      accountHolderName: "Green Arena LLP",
      accountNumber: "123456789012",
      ifsc: "hdfc0001234",
    };
    expect(payoutSetupRequestSchema.parse(ok).ifsc).toBe("HDFC0001234");
    expect(payoutSetupRequestSchema.safeParse({ ...ok, accountNumber: "12ab" }).success).toBe(
      false,
    );
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: "http://x.com",
        keys: { p256dh: "a".repeat(20), auth: "b".repeat(16) },
      }).success,
    ).toBe(false);
  });
});
