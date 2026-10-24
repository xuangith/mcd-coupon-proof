import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { auditCoupons } from "../src/audit.mjs";

const now = new Date("2026-10-24T10:00:00+08:00");
const valid = (overrides = {}) => ({
  title: "测试券",
  ifFreeCoupon: true,
  enable: 1,
  discountInfo: { discountDesc: "用券价格", discountValue: "0元" },
  tradeStartDate: "2026-10-01",
  tradeEndDate: "2026-10-31",
  ...overrides,
});

test("titles never substitute for official price evidence", () => {
  const result = auditCoupons([valid({ title: "免费巨无霸" })], now);
  assert.equal(result.coupons[0].kind, "free");
  const misleading = auditCoupons([valid({
    title: "免费巨无霸",
    ifFreeCoupon: undefined,
    discountInfo: undefined,
  })], now);
  assert.equal(misleading.coupons[0].kind, "unknown");
  assert.equal(misleading.coupons[0].priceCents, null);
});

test("free flag and explicit positive price conflict to unknown", () => {
  const result = auditCoupons([valid({
    discountInfo: { discountDesc: "用券价格", discountValue: "11.90元" },
  })], now);
  assert.equal(result.coupons[0].kind, "unknown");
  assert.equal(result.coupons[0].priceCents, 1190);
});

test("missing and invalid time evidence cannot become available", () => {
  const result = auditCoupons([
    valid({ tradeStartDate: undefined }),
    valid({ tradeEndDate: "2026-02-30" }),
  ], now);
  assert.deepEqual(result.coupons.map((coupon) => coupon.availability), ["unknown", "unknown"]);
});

test("date-only boundaries use Beijing start and end of day", () => {
  const before = auditCoupons([valid({ tradeStartDate: "2026-10-24" })],
    new Date("2026-10-23T15:59:59Z"));
  assert.equal(before.coupons[0].availability, "upcoming");
  const atStart = auditCoupons([valid({ tradeStartDate: "2026-10-24" })],
    new Date("2026-10-23T16:00:00Z"));
  assert.equal(atStart.coupons[0].availability, "available");
  const atEnd = auditCoupons([valid({ tradeEndDate: "2026-10-24" })],
    new Date("2026-10-24T15:59:59Z"));
  assert.equal(atEnd.coupons[0].availability, "available");
  const after = auditCoupons([valid({ tradeEndDate: "2026-10-24" })],
    new Date("2026-10-24T16:00:00Z"));
  assert.equal(after.coupons[0].availability, "expired");
});

test("future, expired, unavailable quantity and time restrictions differ", () => {
  const coupons = [
    valid({ title: "数量为零", totalAvailableCount: 0 }),
    valid({ title: "限制时段", isAllTradeTime: 0,
      tradeTimePeriods: [{ startTime: "09:00:00", endTime: "12:00:00" }] }),
    valid({ title: "未来", tradeStartDate: "2026-10-25" }),
    valid({ title: "过期", tradeEndDate: "2026-10-23" }),
  ];
  const result = auditCoupons(coupons, now);
  const byTitle = Object.fromEntries(result.coupons.map((coupon) => [coupon.title, coupon]));
  assert.equal(byTitle["数量为零"].availability, "restricted");
  assert.equal(byTitle["限制时段"].availability, "restricted");
  assert.equal(byTitle["未来"].availability, "upcoming");
  assert.equal(byTitle["过期"].availability, "expired");
});

test("future and expired dates remain explicit when the service disables a coupon", () => {
  // Given
  const coupons = [
    valid({ title: "future", enable: 0, tradeStartDate: "2026-10-25" }),
    valid({ title: "expired", enable: 0, tradeEndDate: "2026-10-23" }),
  ];
  // When
  const result = auditCoupons(coupons, now);
  // Then
  const states = Object.fromEntries(result.coupons.map((c) => [c.title, c.availability]));
  assert.deepEqual(states, { expired: "expired", future: "upcoming" });
});

test("official weekday, incomplete time and daily quantity limits require review", () => {
  // Given
  const coupons = [
    valid({ weekdays: [1, 2] }),
    valid({ isAllTradeTime: 0 }),
    valid({ currentDayAvailableCount: 0 }),
  ];
  // When
  const result = auditCoupons(coupons, now);
  // Then
  assert.deepEqual(result.coupons.map((c) => c.availability),
    ["restricted", "restricted", "restricted"]);
});

test("sub-cent numbers and unverified price aliases never become a free price", () => {
  // Given
  const coupons = [
    valid({ discountInfo: { discountDesc: "用券价格", discountValue: 0.001 } }),
    valid({ discountInfo: { discountDesc: "用券价格", price: 0 } }),
  ];
  // When
  const result = auditCoupons(coupons, now);
  // Then
  assert.deepEqual(result.coupons.map((c) => [c.kind, c.priceCents]),
    [["unknown", null], ["unknown", null]]);
});

test("invalid date objects do not leak nested account fields", () => {
  // Given
  const coupons = [valid({ tradeEndDate: { token: "secret-token" } })];
  // When
  const result = auditCoupons(coupons, now);
  // Then
  assert.equal(result.coupons[0].end, null);
  assert.equal(result.coupons[0].availability, "unknown");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("sorting prioritizes kind then earliest valid expiration", () => {
  const result = auditCoupons([
    valid({ title: "paid late", ifFreeCoupon: false,
      discountInfo: { discountDesc: "用券价格", discountValue: "8元" },
      tradeEndDate: "2026-10-30" }),
    valid({ title: "unknown", ifFreeCoupon: false }),
    valid({ title: "free late", tradeEndDate: "2026-10-30" }),
    valid({ title: "free early", tradeEndDate: "2026-10-25" }),
    valid({ title: "free no date", tradeEndDate: undefined }),
  ], now);
  assert.deepEqual(result.coupons.map((coupon) => coupon.title), [
    "free early", "free late", "free no date", "paid late", "unknown",
  ]);
});

test("output is allowlisted and summary matches audited kinds", () => {
  const raw = valid({
    couponCode: "secret-code",
    id: "private-id",
    imageUrl: "https://example.invalid/private.png",
    account: "private-account",
    nested: { token: "secret-token" },
  });
  const result = auditCoupons([raw], now);
  assert.deepEqual(Object.keys(result), ["checkedAt", "summary", "coupons"]);
  assert.deepEqual(Object.keys(result.coupons[0]), [
    "title", "kind", "priceCents", "availability", "start", "end", "reasons", "channelNotice",
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(result.summary, { total: 1, free: 1, paid: 0, unknown: 0 });
});

test("demo contains the required synthetic scenarios", async () => {
  const demo = JSON.parse(await readFile(new URL("../examples/demo.json", import.meta.url)));
  const result = auditCoupons(demo.coupons, new Date(demo.now));
  assert.equal(result.summary.total, 6);
  assert.equal(result.summary.unknown, 2);
  assert.ok(result.coupons.some((coupon) => coupon.availability === "upcoming"));
  assert.ok(result.coupons.some((coupon) => coupon.availability === "expired"));
});
