# 麦当劳 MCP 集成

官方 MCP 文档入口：[麦当劳 MCP 平台文档](https://open.mcd.cn/mcp/doc)。账户级工具需按官方平台流程取得 MCP Token。不要将 token 写入示例配置、版本库、日志或对话内容。

服务地址为 `https://mcp.mcd.cn`，使用 Streamable HTTP 和 `Authorization: Bearer` 认证。CLI 先发送 MCP `initialize`，协商 `2024-11-05` 协议，再发送 `notifications/initialized`，最后查询券包。支持 JSON 及 SSE 响应，并携带服务器返回的会话标识。

## 工具边界

- `query-my-coupons`：查询当前会员账户券包。`node src/cli.mjs audit` 只调用此工具，执行只读审计。
- `query-store-coupons`：按用户指定的当前门店检查可用券。它是可选的 agent-native 后续核验，不是 CLI 审计的一部分。只有用户提供了门店和用餐方式时才考虑调用；不能据账户券包推断门店可用性。
- `calculate-price`：按实际选购商品计算价格。只有用户需要核算具体订单总价时才考虑；不得为了判断券是否免费而调用或编造商品、订单参数。

工具参数、响应字段及服务端语义以官方文档和实际 MCP 响应为准。当前集成说明不复述未经核验的完整 schema。账户券包查询不等于门店、渠道、时段、星期或最终订单适用性验证。

实际工具调用参数：

```json
{
  "name": "query-my-coupons",
  "arguments": { "page": "1", "pageSize": "200" }
}
```

CLI 按页读取，最多查询官方允许的 5 页；读取数量与返回总数一致才标记 `complete=true`。查询过程总数变化时返回错误，避免拼接成不一致快照。HTTP、MCP 和业务错误分别处理，不能伪装成空券包。

业务价值：券名中的“免费”和“兑换”不一定代表零元。项目使用实际券包的 `discountInfo`、`ifFreeCoupon`、起止时间、`enable`、可用数量以及 `isAllTradeTime`、`tradeTimePeriods`、`weekdays`，将结构化证据转化成能读懂的结论，并保留未知限制。

## 本地 CLI

不联网的合成演示：

```sh
node src/cli.mjs demo
node src/cli.mjs demo --json
```

真实只读账户审计：

```sh
MCD_MCP_TOKEN='由运行环境安全注入' node src/cli.mjs audit
MCD_MCP_TOKEN='由运行环境安全注入' node src/cli.mjs audit --json
```

CLI 可直接从进程环境读取 `MCD_MCP_TOKEN`。若需要文件输入，必须明确指定：

```sh
node src/cli.mjs audit --token-file token.txt
node src/cli.mjs audit --token-file token.txt --json
```

`--token-file` 路径相对于当前工作目录，程序不自动发现凭据。JSON 结果包含审计结构及 `complete` 布尔值；若不完整，应如实保留该状态，不得显示成完整券包成功。

## MCP 客户端配置

见 [mcp-config.example.json](mcp-config.example.json)。其中 bearer token 仅以 `${MCD_MCP_TOKEN}` 环境变量占位符表达。配置文件中的环境变量插值由 MCP 客户端决定，客户端可能不会插值；应查阅所用客户端的配置规范并在本机确认。CLI 不依赖客户端插值，可直接读取当前进程的 `MCD_MCP_TOKEN` 环境变量。

## 传输与隐私

此项目的真实审计会将 bearer token 用于官方 MCP 请求。传输限制、分页上限和错误处理以实现及实际验证为准；不得将凭据发往非官方主机、跟随重定向或自动重试请求。真实账户数据与凭据属于私密信息：仅在用户明确配置凭据并主动运行审计后使用，不记录或公开券码、账号或原始上游对象。合成演示不读取凭据且不联网。

2026-10-24 已通过成品 CLI 完成真实官方 MCP 初始化和券包查询，命令退出码为 0，返回完整券包标记；未公开任何账户原始数据。认证错误、拒绝重定向、分页上限和 SSE 读取已通过本地 HTTP 测试。门店适用性与结算流程未运行，详见 [VALIDATION.md](VALIDATION.md)。
