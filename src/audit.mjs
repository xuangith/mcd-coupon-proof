const CHANNEL_NOTICE = "最终适用门店与渠道需实时核验";
const KIND_ORDER = { free: 0, paid: 1, unknown: 2 };

function parsePrice(coupon) {
  if (coupon?.discountInfo?.discountDesc !== "用券价格") return null;
  const value = coupon.discountInfo.discountValue;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(?:¥|￥)?\s*(\d+)(?:\.(\d{1,2}))?\s*(?:元)?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseBeijingDate(value, endOfDay = false) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  const normalized = hasZone ? text : `${text.replace(" ", "T")}${text.length === 10
    ? endOfDay ? "T23:59:59+08:00" : "T00:00:00+08:00"
    : "+08:00"}`;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  const datePart = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const [year, month, day] = datePart.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day) return null;
  }
  return timestamp;
}

function couponDates(coupon) {
  const startValue = coupon?.tradeStartDateTime ?? coupon?.tradeStartDate ?? null;
  const endValue = coupon?.tradeEndDateTime ?? coupon?.tradeEndDate ?? null;
  return {
    start: typeof startValue === "string" ? startValue : null,
    end: typeof endValue === "string" ? endValue : null,
    startTime: parseBeijingDate(startValue),
    endTime: parseBeijingDate(endValue, true),
  };
}

function timeRestricted(coupon) {
  return coupon?.isAllTradeTime === 0
    || (coupon?.tradeTimePeriods != null &&
      (!Array.isArray(coupon.tradeTimePeriods) || coupon.tradeTimePeriods.length > 0))
    || (coupon?.weekdays != null &&
      (!Array.isArray(coupon.weekdays) || coupon.weekdays.length > 0));
}

function auditOne(coupon, now) {
  const reasons = [];
  const priceCents = parsePrice(coupon);
  const explicitFree = coupon?.ifFreeCoupon === true;
  let kind = "unknown";
  if (priceCents === 0 && explicitFree) kind = "free";
  else if (priceCents > 0 && !explicitFree) kind = "paid";

  if (kind === "free") reasons.push("官方标记免费，且用券价格为0元");
  else if (kind === "paid") reasons.push(`官方用券价格为${(priceCents / 100).toFixed(2)}元`);
  else if (explicitFree && priceCents > 0) reasons.push("免费标记与正数用券价格冲突");
  else if (priceCents === 0) reasons.push("零元价格缺少明确免费标记");
  else reasons.push("缺少可验证的官方用券价格证据");

  const { start, end, startTime, endTime } = couponDates(coupon);
  let availability = "unknown";
  if ((start != null && startTime == null) || (end != null && endTime == null)) {
    reasons.push("开始或结束时间无效，无法确认可用性");
  } else if (startTime == null || endTime == null) {
    reasons.push("开始或结束时间证据缺失");
  } else if (startTime > endTime) {
    reasons.push("有效期顺序无效，无法确认可用性");
  } else if (now.getTime() < startTime) {
    availability = "upcoming";
    reasons.push("尚未到开始时间");
  } else if (now.getTime() > endTime) {
    availability = "expired";
    reasons.push("已超过结束时间");
  } else if (coupon?.enable === 0 || coupon?.enable === false
    || coupon?.totalAvailableCount === 0 || coupon?.currentDayAvailableCount === 0) {
    availability = "restricted";
    reasons.push("券已停用、总可用数量为0或今日可用数量为0");
  } else if (timeRestricted(coupon)) {
    availability = "restricted";
    reasons.push("存在未核验的时段或星期限制");
  } else if (coupon?.enable !== 1) {
    reasons.push("启用状态证据缺失或无效");
  } else {
    availability = "available";
    reasons.push("有效期内且启用状态为1");
  }

  return {
    title: typeof coupon?.title === "string" ? coupon.title : "未命名优惠券",
    kind,
    priceCents,
    availability,
    start,
    end,
    reasons,
    channelNotice: typeof coupon?.toastText === "string" && coupon.toastText.trim()
      ? `${coupon.toastText}；${CHANNEL_NOTICE}` : CHANNEL_NOTICE,
    _endTime: endTime,
  };
}

export function auditCoupons(coupons, now) {
  if (!Array.isArray(coupons)) throw new TypeError("coupons must be an array");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const audited = coupons.map((coupon) => auditOne(coupon, now));
  audited.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a._endTime ?? Infinity) - (b._endTime ?? Infinity));
  const result = audited.map(({ _endTime, ...coupon }) => coupon);
  const summary = { total: result.length, free: 0, paid: 0, unknown: 0 };
  for (const coupon of result) summary[coupon.kind]++;
  return { checkedAt: now.toISOString(), summary, coupons: result };
}
