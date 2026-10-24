import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMcdClient, McdError } from "../src/mcp.mjs";

const TOKEN = "synthetic-test-token";
const pageResult = (page, coupons = []) => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      code: 200,
      success: true,
      data: { coupons, currentPage: page, totalPages: 1, totalCount: coupons.length },
    }),
  }],
});

async function serverFor(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, headers: req.headers });
    res.setHeader("content-type", "application/json");
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "synthetic-session");
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: body.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
      }));
    } else if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
    } else {
      respond(body, res);
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  const request = (url, options) => {
    assert.equal(url, "https://mcp.mcd.cn");
    assert.equal(options.redirect, "error");
    return fetch(`http://127.0.0.1:${address.port}`, options);
  };
  return { client: createMcdClient(TOKEN, request), requests };
}

test("reads all coupon pages with the negotiated session", async (t) => {
  // Given: a real HTTP server returning two pages.
  const { client, requests } = await serverFor(t, (body, res) => {
    const page = Number(body.params.arguments.page);
    const result = pageResult(page, [{ title: `sample-${page}` }]);
    const payload = JSON.parse(result.content[0].text);
    payload.data.totalPages = 2;
    payload.data.totalCount = 2;
    result.content[0].text = JSON.stringify(payload);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  // When
  const result = await client.readCoupons();
  // Then
  assert.equal(result.complete, true);
  assert.deepEqual(result.coupons.map((coupon) => coupon.title), ["sample-1", "sample-2"]);
  assert.equal(requests[2].headers["mcp-session-id"], "synthetic-session");
  assert.equal(requests[2].headers.authorization, `Bearer ${TOKEN}`);
});

test("finishes an SSE result without waiting for the server to close", async (t) => {
  // Given: the stream deliberately stays open after its response event.
  const { client } = await serverFor(t, (body, res) => {
    res.setHeader("content-type", "text/event-stream");
    const result = pageResult(1);
    res.write(`: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify({
      jsonrpc: "2.0", id: body.id, result,
    })}\r\n\r\n`);
  });
  // When
  const result = await client.readCoupons();
  // Then
  assert.equal(result.complete, true);
  assert.deepEqual(result.coupons, []);
});

test("marks results incomplete at the five-page limit", async (t) => {
  // Given
  const { client, requests } = await serverFor(t, (body, res) => {
    res.end(JSON.stringify({
      jsonrpc: "2.0", id: body.id,
      result: { structuredContent: {
        code: 200,
        data: {
          coupons: [{ title: "sample" }],
          currentPage: Number(body.params.arguments.page),
          totalPages: 6, totalCount: 6,
        },
      } },
    }));
  });
  // When
  const result = await client.readCoupons();
  // Then
  assert.equal(result.complete, false);
  assert.equal(result.coupons.length, 5);
  assert.equal(requests.filter((entry) => entry.body.method === "tools/call").length, 5);
});

for (const [name, result, code] of [
  ["tool errors", { isError: true, content: [{ type: "text", text: TOKEN }] }, "TOOL_ERROR"],
  ["account errors", { structuredContent: { code: 401, message: TOKEN } }, "ACCOUNT_ERROR"],
  ["malformed JSON", { content: [{ type: "text", text: `broken-${TOKEN}` }] }, "INVALID_RESPONSE"],
  ["wrong page", pageResult(2), "INVALID_RESPONSE"],
]) {
  test(`rejects ${name} without leaking upstream text`, async (t) => {
    // Given
    const { client } = await serverFor(t, (body, res) => {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    // When / Then
    await assert.rejects(client.readCoupons(), (error) =>
      error instanceof McdError && error.code === code && !error.message.includes(TOKEN));
  });
}

test("rejects a mismatched JSON-RPC response", async (t) => {
  // Given
  const { client } = await serverFor(t, (body, res) => {
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id + 1, result: pageResult(1) }));
  });
  // When / Then
  await assert.rejects(client.readCoupons(), { code: "INVALID_RESPONSE" });
});

test("returns a safe authentication error without retrying", async (t) => {
  // Given
  const { client, requests } = await serverFor(t, (_body, res) => {
    res.writeHead(401);
    res.end(TOKEN);
  });
  // When / Then
  await assert.rejects(client.readCoupons(), (error) =>
    error.code === "UNAUTHORIZED" && !error.message.includes(TOKEN));
  assert.equal(requests.length, 3);
});

test("refuses redirects rather than forwarding authorization", async (t) => {
  // Given
  const { client, requests } = await serverFor(t, (_body, res) => {
    res.writeHead(302, { location: "/other-origin-path" });
    res.end();
  });
  // When / Then
  await assert.rejects(client.readCoupons(), { code: "CONNECTION_ERROR" });
  assert.equal(requests.length, 3);
});

test("rejects a changing coupon snapshot", async (t) => {
  // Given
  const { client } = await serverFor(t, (body, res) => {
    const page = Number(body.params.arguments.page);
    res.end(JSON.stringify({
      jsonrpc: "2.0", id: body.id,
      result: { structuredContent: {
        code: 200,
        data: { coupons: [], currentPage: page, totalPages: 2, totalCount: page },
      } },
    }));
  });
  // When / Then
  await assert.rejects(client.readCoupons(), { code: "SNAPSHOT_CHANGED" });
});

test("rejects invalid credentials before any request", () => {
  // Given / When / Then
  for (const token of [undefined, "", "token\ninjected"]) {
    assert.throws(() => createMcdClient(token), { code: "TOKEN_REQUIRED" });
  }
});
