import { describe, it, expect } from "vitest";
import {
  exchangeRequestSchema,
  reserveRequestSchema,
  errorCodeSchema,
  operationDescriptorSchema,
} from "../src/index.js";

describe("contracts", () => {
  it("accepts a valid exchange request", () => {
    const res = exchangeRequestSchema.safeParse({
      platform: "telegram",
      initData: "auth_date=1&hash=abc",
    });
    expect(res.success).toBe(true);
  });

  it("rejects unknown platform and oversized initData", () => {
    expect(exchangeRequestSchema.safeParse({ platform: "email", initData: "x" }).success).toBe(
      false,
    );
    expect(
      exchangeRequestSchema.safeParse({ platform: "max", initData: "x".repeat(9000) }).success,
    ).toBe(false);
  });

  it("rejects reserve with client-chosen cost shape and bad operation format", () => {
    // No cost field exists: applications request an operation, platform prices it.
    const res = reserveRequestSchema.safeParse({
      operation: "fridge.scan",
      requestId: "req-12345678",
    });
    expect(res.success).toBe(true);
    if (res.success) expect("cost" in res.data).toBe(false);
    expect(
      reserveRequestSchema.safeParse({ operation: "../admin", requestId: "req-12345678" }).success,
    ).toBe(false);
    expect(
      reserveRequestSchema.safeParse({ operation: "fridge.scan", requestId: "short" }).success,
    ).toBe(false);
    expect(
      reserveRequestSchema.safeParse({ operation: "fridge.scan", requestId: "req-1\nDROP" })
        .success,
    ).toBe(false);
    expect(
      reserveRequestSchema.safeParse({ operation: "fridge.scan", requestId: "req 12345678" })
        .success,
    ).toBe(false);
  });

  it("rejects negative credit cost in operation registry", () => {
    expect(
      operationDescriptorSchema.safeParse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        appSlug: "fridge",
        operationKey: "fridge.scan",
        creditCost: -1,
        enabled: true,
      }).success,
    ).toBe(false);
  });

  it("error codes are a closed set", () => {
    expect(errorCodeSchema.safeParse("INSUFFICIENT_CREDITS").success).toBe(true);
    expect(errorCodeSchema.safeParse("FREE_MONEY").success).toBe(false);
  });
});
