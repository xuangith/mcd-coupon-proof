# 麦券明白账

券已经领到了，为什么今天不能用？写着“兑换”，还要不要付钱？

麦券明白账（`mcd-coupon-proof`）帮你把麦当劳券包读明白：还要付多少钱、哪天开始生效、什么时候过期、哪些条件还得去门店确认。它通过麦当劳官方 MCP 查询券包，把价格和时间整理成一张清单。

比如，11.9 元汉堡券会直接标出仍需付款；下周才能用的券会标成“尚未生效”；标题和价格对不上时，会告诉你哪里没核实清楚。判断看的是接口里的价格和规则，不是券名里的宣传语。

这是一个个人开发的参赛项目，非麦当劳官方产品。

## 两种运行方式

下载完整项目源码并解压，在终端切换到含本 README 的目录。安装好 Node.js 22 或更高版本后即可运行下面的命令，无需 `npm install`。

如果使用支持 Skill 的 Agent，可让它读取 `skills/mcd-coupon-proof/SKILL.md`。保留完整仓库目录结构，脚本位于 `src/`；单独复制 SKILL.md 不会携带 CLI。已有官方 MCP 的 Agent 也可以按 Skill 直接使用已配置工具。

### 合成数据演示

```sh
node src/cli.mjs demo
```

演示仅使用仓库内人工合成的示例，不联网、不读取 token，也不包含真实会员账户数据。它展示规则如何处理零元券、付费券、证据不足、未来或过期券及相互矛盾的字段。

### 真实只读账户审计

先在当前进程环境中配置 `MCD_MCP_TOKEN`，然后运行：

```sh
node src/cli.mjs audit
```

该命令只调用麦当劳官方 MCP 的 `query-my-coupons` 查询账户券包，并在本地解释返回信息；不会领取或使用优惠券、下单、消费积分或支付。也可以显式指定私人 token 文件：

```sh
node src/cli.mjs audit --token-file token.txt
```

该文件路径相对于当前工作目录；程序不会自动搜索凭据。不要把 token、真实券码、账户数据或私人配置提交到公开仓库。

两个命令都支持 `--json`，输出包含分析结果和 `complete` 布尔值。`complete=false` 表示结果未能确认完整，不应当作完整券包审计。

## 判定规则

- 价格只从官方结构化字段 `discountInfo.discountDesc === "用券价格"` 中解析，绝不根据券名推测价格。
- 只有 `ifFreeCoupon === true` 且存在一致、明确的零元用券价格，才判断为免费。明确正数可判断为付费；标志与金额冲突或证据不足时归为未知。
- “免费”只描述餐品价格证据，不代表无条件赠送；仍须查看消费门槛、渠道、时段和门店等限制。
- 日期按北京时间理解。优先采用精确的交易起止时间，其次才采用日期字段。无效日期、未生效、过期、停用、数量为零及不完整的时段条件不得误报为当前可用。
- 券按免费、付费、未知分类；同类按有效到期时间排序，无日期者置后。这不是省钱金额最大化排序。
- 输出遵循字段白名单，不返回券码、ID、图像 URL、账号或完整上游对象。
- 门店、渠道、时段和星期等实时适用性不能仅凭账户券包确认。最终以官方 MCP 和结算页面当时返回为准。

## MCP 与门店核验

已配置官方 MCP 的助手可以通过 `query-my-coupons` 读取账户券包。若用户给出具体门店及用餐方式，可选用 `query-store-coupons` 核验该门店当时可用的券；只有需要核算具体订单总价时，才考虑官方 `calculate-price`。这些是可选的 agent-native 检查，不属于本地合成演示或 CLI 账户审计，也不意味着本项目已经验证任何门店的适用性。参见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md) 和 [项目 Skill](skills/mcd-coupon-proof/SKILL.md)。

## 环境与验证状态

需要 Node.js 22 或更高版本。项目使用原生 ESM、`fetch` 和 `node:test`，无需第三方依赖。Bun 可运行演示，但项目验证以 Node.js 为准。

```sh
node --test
```

2026-10-24 已完成 27 项自动化测试和真实官方 MCP 只读调用验证，详见 [VALIDATION.md](VALIDATION.md)。测试使用本地 HTTP 服务与人工合成数据，演示不依赖真实账户。

## 开源与来源

原创代码采用 [MIT License](LICENSE)。[CONTEST_DECLARATION.md](CONTEST_DECLARATION.md) 按[活动官方原文](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/CONTEST_DECLARATION.md)保留，供本次参赛使用；MIT 授权不扩展至麦当劳商标、官方服务或官方声明。
