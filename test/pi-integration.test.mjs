// Real Pi 1.5.2 + loopback SSE model. Only the WeCom SDK is substituted.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { clients } from "./sdk.mjs";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, {
  alias: { "aibot-node-sdk": resolve("test/sdk.mjs") },
});
const extension = await jiti.import("../index.ts", { default: true });
async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("真实 Pi 验证等待超时");
}
function completion(res, tool, args) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
    : { role: "assistant", content: "local model finished" };
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
  ]) res.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

for (const mode of ["busy", "idle"]) test(`真实 Pi 1.5.2：后台事件在 ${mode} 时被模型消费并通过工具回复`, { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wecom-pi-"));
  const priorRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const beforeExit = new Set(process.listeners("exit"));
  const requests = [], errors = [], tools = new Map();
  let session, ws, jobId, holdStarted = false, releaseHold;
  const holding = new Promise((resolve) => { releaseHold = resolve; });
  const chat = JSON.stringify(["bot", "single", "alice"]);
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      switch (requests.length) {
        case 1:
          completion(res, "wecombot-start", {
            chat, description: `真实 Pi ${mode} 接续验证`,
            command: `while [ ! -f '${root}/release' ]; do sleep 0.01; done; echo build-output`,
          }); break;
        case 2:
          if (mode === "busy") completion(res, "verification_hold", {});
          else completion(res);
          break;
        case 3:
          completion(res, "wecombot-send", { chat, message: `${mode}: 已读取后台结果`, ending: "done" }); break;
        default: completion(res);
      }
    } catch (err) { errors.push(err); res.destroy(); }
  });
  t.after(async () => {
    releaseHold();
    await writeFile(join(root, "release"), "cleanup");
    if (jobId) await until(async () => (await tools.get("wecombot-task").execute("cleanup", { id: jobId })).details.status !== "running");
    ws?.disconnect();
    if (session) { await session.abort(); session.dispose(); }
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
    for (const listener of process.listeners("exit")) if (!beforeExit.has(listener)) process.removeListener("exit", listener);
    if (priorRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorRoot;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(root, "wecom-bot.json"), JSON.stringify({ bots: [{ botId: "bot", secret: "fixture-only" }] }));
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false,
  });
  runtime.registerProvider("local-verification", {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    api: "openai-completions", apiKey: "fixture-only",
    models: [{
      id: "fixture", name: "Local fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 1024,
    }],
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, disabledBuiltinExtensions: ["mcp"],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      extension({ ...pi, registerTool(tool) { tools.set(tool.name, tool); pi.registerTool(tool); } });
      pi.registerTool({
        name: "verification_hold", label: "Hold", description: "Local verification gate",
        parameters: { type: "object", properties: {} },
        async execute() {
          holdStarted = true;
          await holding;
          return { content: [{ type: "text", text: "hold completed" }], details: {} };
        },
      });
    }],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  ({ session } = await createAgentSession({
    cwd: root, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel("local-verification", "fixture"), thinkingLevel: "off",
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
    tools: ["wecombot-*", "verification_hold"],
  }));
  session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "wecombot-start") jobId = event.result.details.id;
  });
  await session.bindExtensions({ onError: (err) => errors.push(err) });
  ws = clients.at(-1);
  ws.emit("message.text", { body: { chattype: "single", from: { userid: "alice" }, text: { content: "verify background" } } });
  if (mode === "busy") {
    await until(() => holdStarted);
    assert.equal(session.isStreaming, true);
  } else await until(() => requests.length === 2 && !session.isStreaming);
  assert.equal(ws.sent.length, 0);
  await writeFile(join(root, "release"), "go");
  await until(async () => (await tools.get("wecombot-task").execute("query", { id: jobId })).details.delivery === "submitted");
  if (mode === "busy") {
    assert.equal(requests.length, 2, "steer 不应中断正在执行的工具");
    assert.equal(ws.sent.length, 0);
    releaseHold();
  }
  await until(() => requests.length === 4 && !session.isStreaming);
  const consumed = JSON.stringify(requests[2].messages);
  assert.match(consumed, /wecombot-task/);
  assert.match(consumed, /build-output/);
  assert.match(consumed, new RegExp(`真实 Pi ${mode} 接续验证`));
  assert.deepEqual(ws.sent.map((x) => [x.chatid, x.markdown.content]), [
    ["alice", `${mode}: 已读取后台结果`], ["alice", "✅"],
  ]);
  assert.deepEqual(errors, []);
  const pkg = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "1.5.2");
});
