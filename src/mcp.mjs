const ENDPOINT = "https://mcp.mcd.cn";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export class McdError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McdError";
    this.code = code;
  }
}

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new McdError("INVALID_RESPONSE", "官方服务返回的内容不是有效 JSON。");
  }
}

function checkRpc(value, id) {
  if (!isObject(value) || value.jsonrpc !== "2.0" || value.id !== id) {
    throw new McdError("INVALID_RESPONSE", "官方服务响应与本次请求不匹配。");
  }
  if (value.error !== undefined) {
    throw new McdError("RPC_ERROR", "官方 MCP 拒绝了请求，请检查账户权限或稍后手动重试。");
  }
  if (!isObject(value.result)) {
    throw new McdError("INVALID_RESPONSE", "官方服务缺少有效结果。");
  }
  return value.result;
}

async function readRpcResponse(response, id) {
  if (!response.body) {
    throw new McdError("INVALID_RESPONSE", "官方服务返回空响应。");
  }
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new McdError("RESPONSE_TOO_LARGE", "官方响应超过安全读取上限。");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!sse) continue;
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = event.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data && data !== "[DONE]") {
          const message = parseJson(data);
          if (isObject(message) && message.id === id) return checkRpc(message, id);
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (sse) {
      throw new McdError("INVALID_RESPONSE", "事件流结束，但未收到本次请求的完整结果。");
    }
    return checkRpc(parseJson(buffer), id);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The request may already have been aborted; the reader lock still needs release.
    }
    reader.releaseLock();
  }
}

function couponPage(result, expectedPage) {
  if (result.isError === true) {
    throw new McdError("TOOL_ERROR", "官方券包查询失败，未将错误结果当作空券包。");
  }
  let payload = result.structuredContent;
  if (payload === undefined) {
    const texts = Array.isArray(result.content)
      ? result.content.filter((item) => isObject(item) && item.type === "text")
      : [];
    if (texts.length !== 1 || typeof texts[0].text !== "string") {
      throw new McdError("INVALID_RESPONSE", "官方券包查询缺少可解析数据。");
    }
    payload = parseJson(texts[0].text);
  }
  if (!isObject(payload) || payload.code !== 200 || payload.success === false) {
    throw new McdError("ACCOUNT_ERROR", "官方账户查询未成功，请检查 token 是否有效。");
  }
  const data = payload.data;
  if (!isObject(data) || !Array.isArray(data.coupons) ||
      !data.coupons.every(isObject) || !Number.isInteger(data.totalCount) ||
      data.totalCount < 0 || !Number.isInteger(data.totalPages) ||
      data.totalPages < 0 || data.currentPage !== expectedPage ||
      data.coupons.length > 200) {
    throw new McdError("INVALID_RESPONSE", "官方券包分页格式不符合已知契约。");
  }
  return data;
}

export function createMcdClient(token, request = fetch) {
  if (typeof token !== "string" || token.length === 0 || /\s/.test(token)) {
    throw new McdError("TOKEN_REQUIRED", "请通过 MCD_MCP_TOKEN 或 --token-file 提供有效 token。");
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  let sequence = 0;
  const send = async (body) => {
    try {
      const response = await request(ENDPOINT, {
        method: "POST",
        headers: { ...headers },
        redirect: "error",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR";
        throw new McdError(code, `麦当劳服务返回 HTTP ${response.status}，本次未自动重试。`);
      }
      const session = response.headers.get("mcp-session-id");
      if (session) headers["Mcp-Session-Id"] = session;
      if (body.id === undefined) {
        await response.body?.cancel();
        return {};
      }
      return await readRpcResponse(response, body.id);
    } catch (error) {
      if (error instanceof McdError) throw error;
      throw new McdError("CONNECTION_ERROR", "无法完成官方 MCP 请求，可能超时、断网或发生重定向。");
    }
  };
  const rpc = (method, params) =>
    send({ jsonrpc: "2.0", id: ++sequence, method, params });

  return {
    async readCoupons() {
      const initialized = await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcd-coupon-proof", version: "1.0.0" },
      });
      if (initialized.protocolVersion !== "2024-11-05") {
        throw new McdError("PROTOCOL_ERROR", "服务端选择了当前客户端尚未支持的协议版本。");
      }
      headers["MCP-Protocol-Version"] = initialized.protocolVersion;
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const coupons = [];
      let totalCount;
      let totalPages;
      for (let page = 1; page <= 5; page += 1) {
        const result = await rpc("tools/call", {
          name: "query-my-coupons",
          arguments: { page: String(page), pageSize: "200" },
        });
        const data = couponPage(result, page);
        if (totalCount !== undefined &&
            (data.totalCount !== totalCount || data.totalPages !== totalPages)) {
          throw new McdError("SNAPSHOT_CHANGED", "查询期间券包发生变化，请重新运行以获得一致结果。");
        }
        totalCount = data.totalCount;
        totalPages = data.totalPages;
        coupons.push(...data.coupons);
        if (page >= totalPages) break;
      }
      return { coupons, complete: coupons.length === totalCount, totalCount };
    },
  };
}
