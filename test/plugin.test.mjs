import { it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkPlugin } from "../scripts/check-plugin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "plugin");
const manifest = JSON.parse(readFileSync(join(source, ".claude-plugin/plugin.json"), "utf8"));

it("ships a self-contained, size-bounded plugin with matching release metadata", () => {
  checkPlugin(source);
  const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(marketplace.plugins[0].source, "./plugin");
  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.equal(pkg.version, manifest.version);
  const png = readFileSync(join(source, manifest.icon));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});

it("runs every packaged MCP tool without node_modules and uses only configured credentials", { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "claude-jev-release-"));
  const plugin = join(directory, "plugin with spaces");
  cpSync(source, plugin, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const requests = [];
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ authorization: req.headers.authorization, payload });
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { type: "noul", noul: 0.95 }];
      if (q.type === "choice") {
        const choice = Object.keys(q.criteria)[0];
        return [id, { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95 } }];
      }
      return [id, { type: "score", score: 0, confidence: 0.95, probabilities: { 0: 0.95 }, legend: { 0: q.criteria[0] } }];
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: payload.model, answers, usage: { input_tokens: 10 } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const baseURL = `http://127.0.0.1:${api.address().port}/v1/systemone`;

  async function connect(apiKey) {
    const values = { api_key: apiKey, model: "test-model", base_url: baseURL };
    const env = Object.fromEntries(Object.entries(manifest.mcpServers.jev.env).map(([name, reference]) => {
      const match = /^\$\{user_config\.(\w+)\}$/.exec(reference);
      assert.ok(match, `Expected explicit user_config mapping: ${name}`);
      return [name, values[match[1]]];
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: manifest.mcpServers.jev.args.map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", plugin)),
      cwd: plugin,
      env: { ...env, TYPESAFE_API_KEY: "ambient-typesafe-key", JEV_API_KEY: "ambient-jev-key", JEV_BASE_URL: "http://127.0.0.1:1", JEV_MODEL: "ambient-model" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr.on("data", (chunk) => { stderr += chunk; });
    const client = new Client({ name: "release-test", version: "1.0.0" });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    return { client, logs: () => stderr };
  }

  const missing = await connect("");
  const missingResult = await missing.client.callTool({ name: "jev_doctor", arguments: {} });
  assert.equal(missingResult.isError, true);
  assert.match(missingResult.content[0].text, /API key is required/);
  assert.equal(requests.length, 0, "No API request may use ambient credentials");
  await missing.client.close();

  const { client, logs } = await connect("configured-test-key");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["jev_ask", "jev_choice", "jev_doctor", "jev_noul", "jev_score"]);
  const state = "Private test ticket: invoice needs attention";
  const choice = { type: "choice", instructions: "Route to team", criteria: { billing: "Payments, invoices, and payouts", technical: "Software defects and outages" } };
  const calls = [
    { name: "jev_choice", arguments: { state, instructions: choice.instructions, criteria: JSON.stringify(choice.criteria) } },
    { name: "jev_noul", arguments: { state, instructions: "Is this urgent?" } },
    { name: "jev_score", arguments: { state, instructions: "Rate severity", criteria: JSON.stringify(["Low impact on users", "High impact on users"]) } },
    { name: "jev_ask", arguments: { state, questions: JSON.stringify({ team: choice, urgent: { type: "noul", instructions: "Is this urgent?" } }), model: "override-model" } },
    { name: "jev_doctor", arguments: { probe_state: state } },
  ];
  for (const call of calls) {
    const result = await client.callTool(call);
    assert.ok(!result.isError, result.content[0].text);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.model, call.arguments.model || "test-model");
    if (call.name === "jev_doctor") assert.equal(payload.ok, true);
    else assert.ok(payload.gated);
  }
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer configured-test-key");
    assert.equal(request.payload.state, state);
  }
  await client.close();
  assert.ok(!logs().includes("configured-test-key"));
  assert.ok(!logs().includes(state));
});
