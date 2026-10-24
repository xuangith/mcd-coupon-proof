import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const cleanEnvironment = { ...process.env };
delete cleanEnvironment.MCD_MCP_TOKEN;

test("runs the demo without credentials and emits machine-readable results", async () => {
  // Given / When
  const { stdout, stderr } = await execute(process.execPath, [cli, "demo", "--json"], {
    env: cleanEnvironment,
  });
  const report = JSON.parse(stdout);
  // Then
  assert.equal(report.source, "demo");
  assert.equal(report.complete, true);
  assert.ok(report.summary.total >= 6);
  assert.ok(report.summary.free >= 1);
  assert.ok(report.summary.paid >= 1);
  assert.ok(report.summary.unknown >= 1);
  assert.equal(stderr, "");
});

test("fails live mode without credentials before a network call", async () => {
  // Given / When / Then
  await assert.rejects(
    execute(process.execPath, [cli, "audit"], { env: cleanEnvironment }),
    (error) => error.code === 1 && error.stdout === "" && error.stderr.startsWith("TOKEN_REQUIRED:"),
  );
});

test("rejects invalid CLI arguments without reflecting their values", async () => {
  // Given
  const secret = "synthetic-secret-argument";
  // When / Then
  await assert.rejects(
    execute(process.execPath, [cli, "demo", `--${secret}`], { env: cleanEnvironment }),
    (error) => error.code === 1 && !error.stderr.includes(secret) &&
      error.stderr.startsWith("ARGUMENT_ERROR:"),
  );
});
