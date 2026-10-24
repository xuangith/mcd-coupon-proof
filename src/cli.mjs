import { readFile } from "node:fs/promises";
import { auditCoupons } from "./audit.mjs";
import { createMcdClient, McdError } from "./mcp.mjs";

const usage = `麦券明白账 — 用官方数据看清每张券

node src/cli.mjs demo [--json]
node src/cli.mjs audit [--token-file <路径>] [--json]

demo 使用人工合成数据，不联网。
audit 默认读取 MCD_MCP_TOKEN，只查询账户券包。
--token-file 显式指定私人 token 文件；请勿上传该文件。
结果不代表当前门店可用，核销条件以官方券面和门店校验为准。`;

function render(report) {
  const kinds = { free: "零元价格证据", paid: "仍需付款", unknown: "价格待核实" };
  const states = {
    available: "账户显示可用",
    upcoming: "尚未生效",
    expired: "已过期",
    restricted: "存在使用限制",
    unknown: "状态待核实",
  };
  const lines = [
    report.source === "demo" ? "麦券明白账 · 合成演示" : "麦券明白账 · 实时账户查询",
    `核对时间：${report.checkedAt}`,
    `共 ${report.summary.total} 张：零元证据 ${report.summary.free}，仍需付款 ${report.summary.paid}，待核实 ${report.summary.unknown}`,
    report.complete ? "券包读取完整。" : "券包未完整读取，以下仅为部分结果。",
    "",
  ];
  for (const coupon of report.coupons) {
    lines.push(
      `${coupon.title} | ${kinds[coupon.kind]} | ${states[coupon.availability]}`,
      `  用券价格：${coupon.priceCents === null ? "未知" : `${(coupon.priceCents / 100).toFixed(2)} 元`}`,
      `  有效期：${coupon.start ?? "未知"} 至 ${coupon.end ?? "未知"}`,
      ...coupon.reasons.map((reason) => `  · ${reason}`),
      `  · ${coupon.channelNotice}`,
      "",
    );
  }
  lines.push("零元价格不等于无条件赠送；餐厅、渠道及附加消费条件仍需核验。");
  return lines.join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (command !== "demo" && command !== "audit") {
    throw new McdError("ARGUMENT_ERROR", "命令应为 demo 或 audit；使用 --help 查看用法。");
  }
  let json = false;
  let tokenFile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" && !json) {
      json = true;
    } else if (arg === "--token-file" && command === "audit" &&
               tokenFile === undefined && args[index + 1] &&
               !args[index + 1].startsWith("--")) {
      tokenFile = args[++index];
    } else {
      throw new McdError("ARGUMENT_ERROR", "参数无效、重复或缺少值；使用 --help 查看用法。");
    }
  }
  let report;
  if (command === "demo") {
    const fixture = JSON.parse(await readFile(new URL("../examples/demo.json", import.meta.url), "utf8"));
    report = {
      ...auditCoupons(fixture.coupons, new Date(fixture.now)),
      complete: true,
      source: "demo",
    };
  } else {
    let token = process.env.MCD_MCP_TOKEN;
    if (tokenFile !== undefined) {
      try {
        token = await readFile(tokenFile, "utf8");
      } catch {
        throw new McdError("TOKEN_FILE_ERROR", "无法读取指定 token 文件，请检查路径和权限。");
      }
    }
    const client = createMcdClient(token?.trim());
    const snapshot = await client.readCoupons();
    report = {
      ...auditCoupons(snapshot.coupons, new Date()),
      complete: snapshot.complete,
      source: "live",
    };
  }
  console.log(json ? JSON.stringify(report, null, 2) : render(report));
}

try {
  await main();
} catch (error) {
  if (error instanceof McdError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error("AUDIT_ERROR: 无法完成券包分析，请检查输入格式；未输出账户原始数据。");
  }
  process.exitCode = 1;
}
