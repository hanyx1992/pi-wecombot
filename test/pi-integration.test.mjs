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

for (const [mode, title] of [
  ["busy", "忙碌时接续后台结果"],
  ["idle", "空闲时接续后台结果"],
  ["ended", "显式收尾后后台结果另开占位"],
  ["settled", "正常 settled 中性收闭"],
  ["aborted", "真实中止后中性收闭"],
  ["settled-input", "settled 期间新增输入保留工作占位"],
  ["config-reload", "忙碌工具期间通过管理命令重读文案"],
  ["input-model", "模型推理等待时插件立即换位"],
  ["input-tool", "工具忙碌时插件立即换位且不中止原工具"],
]) test(`真实 Pi 1.5.2：${title}`, { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wecom-pi-"));
  const priorRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const beforeExit = new Set(process.listeners("exit"));
  const requests = [], errors = [], tools = new Map();
  const clientsBefore = clients.length, holdEnds = [];
  let session, ws, jobId, holdStarted = false, holdAborted = false, releaseHold, injected = false;
  const pendingAtInjection = [];
  const holding = new Promise((resolve) => { releaseHold = resolve; });
  const chat = JSON.stringify(["bot", "single", "alice"]);
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      if (mode === "input-model" || mode === "input-tool") {
        if (requests.length === 1) {
          if (mode === "input-model") {
            holdStarted = true;
            await holding;
            completion(res, "wecombot-send", { chat, message: "继续核对后的回答", ending: "done" });
          } else completion(res, "verification_hold", {});
        } else if (requests.length === 2 && mode === "input-tool") {
          completion(res, "wecombot-send", { chat, message: "继续核对后的回答", ending: "done" });
        } else completion(res);
        return;
      }
      if (mode === "config-reload") {
        switch (requests.length) {
          case 1: completion(res, "verification_hold", {}); break;
          case 2: completion(res, "wecombot-send", { chat, message: "已继续原任务" }); break;
          case 3: completion(res, "wecombot-send", { chat, message: "原任务完成", ending: "done" }); break;
          case 5: completion(res, "wecombot-send", { chat, message: "需要下一步答复", ending: "question" }); break;
          default: completion(res);
        }
        return;
      }
      switch (requests.length) {
        case 1:
          if (mode === "settled" || mode === "settled-input") { completion(res); break; }
          if (mode === "aborted") { completion(res, "verification_hold", {}); break; }
          completion(res, "wecombot-start", {
            chat, description: `真实 Pi ${mode} 接续验证`,
            command: `while [ ! -f '${root}/release' ]; do sleep 0.01; done; echo build-output`,
          }); break;
        case 2:
          if (mode === "busy" || mode === "settled-input") completion(res, "verification_hold", {});
          else if (mode === "ended") completion(res, "wecombot-send", { chat, message: "当前回应已交付；后台完成后另行汇报", ending: "done" });
          else completion(res);
          break;
        case 3:
          if (mode === "ended") completion(res);
          else completion(res, "wecombot-send", { chat, message: mode === "settled-input" ? "已处理新增输入" : `${mode}: 已读取后台结果`, ending: "done" });
          break;
        case 4:
          if (mode === "ended") completion(res, "wecombot-send", { chat, message: `${mode}: 已读取后台结果`, ending: "done" });
          else completion(res);
          break;
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
  await writeFile(join(root, "wecom-bot.json"), JSON.stringify({
    bots: [{ botId: "bot", secret: "fixture-only" }],
    ...(mode === "config-reload" ? { messages: { working: "旧工作占位", donePrefix: "旧完成：", questionPrefix: "旧提问：" } } : {}),
  }));
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
      // Earlier public handler injects input while Pi is emitting settlement,
      // before the bot's settlement cleanup observes the new callback.
      if (mode === "settled-input") pi.on("agent_settled", (_event, ctx) => {
        if (injected) return;
        injected = true;
        ws.emit("message.text", { headers: { req_id: "settled-new-input" }, body: {
          chattype: "single", from: { userid: "alice" }, text: { content: "settled期间新增输入" },
        } });
        pendingAtInjection.push(ctx.hasPendingMessages());
      });
      extension({ ...pi, registerTool(tool) { tools.set(tool.name, tool); pi.registerTool(tool); } });
      pi.registerTool({
        name: "verification_hold", label: "Hold", description: "Local verification gate",
        parameters: { type: "object", properties: {} },
        async execute(_id, _params, signal) {
          holdStarted = true;
          signal?.addEventListener("abort", () => { holdAborted = true; }, { once: true });
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
    if (event.type === "tool_execution_end" && event.toolName === "verification_hold") holdEnds.push(event);
  });
  await session.bindExtensions({ onError: (err) => errors.push(err) });
  ws = clients.at(-1);
  ws.emit("message.text", { headers: { req_id: `callback-${mode}` }, body: { chattype: "single", from: { userid: "alice" }, text: { content: "verify background" } } });
  if (mode === "input-model" || mode === "input-tool") {
    await until(() => holdStarted);
    ws.emit("message.text", { headers: { req_id: "new-question" }, body: {
      chattype: "single", from: { userid: "alice" }, text: { content: "新增问题" },
    } });
    await until(() => ws.streams.length === 3);
    assert.deepEqual(ws.streams.map(x => [x.headers.req_id, x.content, x.finish]), [
      [`callback-${mode}`, "处理中...", false],
      [`callback-${mode}`, "我接着看。", true],
      ["new-question", "处理中...", false],
    ]);
    assert.equal(requests.length, 1, "模型未返回/工具未结束时插件已完成换位，且没有新增模型请求");
    assert.equal(session.isStreaming, true);
    assert.equal(holdAborted, false);
    assert.deepEqual(holdEnds, []);
    assert.equal(clients.length, clientsBefore + 1);
    releaseHold();
    await until(() => !session.isStreaming && ws.streams.some(x => x.content === "✅继续核对后的回答"));
    const answer = ws.streams.find(x => x.content === "✅继续核对后的回答");
    assert.equal(answer.id, ws.streams[2].id);
    assert.equal(answer.headers.req_id, "new-question");
    if (mode === "input-tool") assert.equal(holdEnds[0].isError, false);
    assert.equal(holdAborted, false);
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(errors, []);
    return;
  }
  if (mode === "config-reload") {
    const connectionEvents = [];
    for (const event of ["authenticated", "disconnected"]) ws.on(event, () => connectionEvents.push(event));
    await until(() => holdStarted);
    assert.equal(session.isStreaming, true);
    assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), [["旧工作占位", false]]);
    await writeFile(join(root, "wecom-bot.json"), JSON.stringify({
      bots: [{ botId: "bot", secret: "fixture-only" }],
      messages: { working: "新工作占位", donePrefix: "新完成：", questionPrefix: "新提问：" },
    }));
    const dispositions = [];
    await session.prompt("/wecombot-list", {
      streamingBehavior: "steer", preflightResult: (result) => dispositions.push(result),
    });
    assert.deepEqual(dispositions, ["handled"], "真实 Pi 忙碌时仍应立即执行扩展命令");
    assert.equal(requests.length, 1, "管理命令不应向模型新增请求");
    assert.equal(session.isStreaming, true);
    assert.equal(holdAborted, false, "管理命令不应中止原工具");
    assert.deepEqual(holdEnds, [], "原工具应继续等待原有执行门槛");
    assert.equal(clients.length, clientsBefore + 1, "重读文案不能创建第二个 SDK 连接");
    assert.deepEqual(connectionEvents, [], "管理命令不应断开或重新认证现有连接");
    assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), [["旧工作占位", false]],
      "重读配置不主动改写已有气泡");
    releaseHold();
    await until(() => requests.length === 4 && !session.isStreaming);
    assert.equal(holdEnds.length, 1);
    assert.equal(holdEnds[0].isError, false);
    assert.equal(holdAborted, false);
    assert.match(JSON.stringify(requests[1].messages), /hold completed/);
    assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), [
      ["旧工作占位", false], ["已继续原任务", true],
      ["新工作占位", false], ["新完成：原任务完成", true],
    ]);
    assert.equal(ws.streams[0].id, ws.streams[1].id);
    assert.notEqual(ws.streams[0].id, ws.streams[2].id);
    assert.equal(ws.streams[2].id, ws.streams[3].id);
    ws.emit("message.text", { headers: { req_id: "callback-after-reload" }, body: {
      chattype: "single", from: { userid: "alice" }, text: { content: "继续下一步" },
    } });
    await until(() => requests.length === 6 && !session.isStreaming);
    assert.deepEqual(ws.streams.slice(4).map(x => [x.headers.req_id, x.content, x.finish]), [
      ["callback-after-reload", "新工作占位", false],
      ["callback-after-reload", "新提问：需要下一步答复", true],
    ]);
    assert.equal(ws.streams[4].id, ws.streams[5].id);
    assert.equal(clients.length, clientsBefore + 1);
    assert.deepEqual(connectionEvents, []);
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(errors, []);
    return;
  }
  if (mode === "settled-input") {
    await until(() => holdStarted);
    assert.deepEqual(pendingAtInjection, [false], "真实 Pi 的文本 pending 查询不包含已提交的 custom 接续事件");
    assert.match(JSON.stringify(requests[1].messages), /settled期间新增输入/);
    assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), [
      ["处理中...", false], ["我接着看。", true], ["处理中...", false],
    ],
      "旧回合 settled 不得收闭尚待消费的新输入占位");
    releaseHold();
    await until(() => requests.length === 4 && !session.isStreaming);
    assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), [
      ["处理中...", false], ["我接着看。", true],
      ["处理中...", false], ["✅已处理新增输入", true],
    ]);
    assert.equal(ws.streams[0].id, ws.streams[1].id);
    assert.equal(ws.streams[2].id, ws.streams[3].id);
    assert.equal(ws.streams[2].headers.req_id, "settled-new-input");
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(errors, []);
    return;
  }
  if (mode === "settled" || mode === "aborted") {
    if (mode === "aborted") {
      await until(() => holdStarted);
      const aborting = session.abort();
      releaseHold();
      await aborting;
    } else await until(() => requests.length === 1 && !session.isStreaming);
    await until(() => ws.streams.at(-1)?.finish);
    assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), [
      ["处理中...", false],
      [mode === "aborted" ? "本轮运行已中止。" : "本轮运行已结束。", true],
    ]);
    assert.equal(ws.streams[0].id, ws.streams[1].id);
    assert.equal(ws.streams[1].headers.req_id, `callback-${mode}`);
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(errors, []);
    return;
  }
  if (mode === "busy") {
    await until(() => holdStarted);
    assert.equal(session.isStreaming, true);
  } else await until(() => requests.length === (mode === "ended" ? 3 : 2) && !session.isStreaming);
  assert.equal(ws.sent.length, 0);
  assert.deepEqual(ws.streams.map(x => [x.content, x.finish]), mode === "ended"
    ? [["处理中...", false], ["✅当前回应已交付；后台完成后另行汇报", true]]
    : [["处理中...", false]], "后台仍活着时，显式 ending 停止当前接续链，其他情况保留占位");
  await writeFile(join(root, "release"), "go");
  await until(async () => (await tools.get("wecombot-task").execute("query", { id: jobId })).details.delivery === "submitted");
  if (mode === "busy") {
    assert.equal(requests.length, 2, "steer 不应中断正在执行的工具");
    assert.equal(ws.sent.length, 0);
    releaseHold();
  }
  await until(() => requests.length === (mode === "ended" ? 5 : 4) && !session.isStreaming);
  const consumed = JSON.stringify(requests[mode === "ended" ? 3 : 2].messages);
  assert.match(consumed, /wecombot-task/);
  assert.match(consumed, /build-output/);
  assert.match(consumed, new RegExp(`真实 Pi ${mode} 接续验证`));
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(ws.streams.map(x => [x.headers.req_id, x.content, x.finish]), [
    ...(mode === "ended" ? [
      [`callback-${mode}`, "处理中...", false],
      [`callback-${mode}`, "✅当前回应已交付；后台完成后另行汇报", true],
    ] : []),
    [`callback-${mode}`, "处理中...", false],
    [`callback-${mode}`, `✅${mode}: 已读取后台结果`, true],
  ]);
  assert.equal(ws.streams[0].id, ws.streams[1].id);
  if (mode === "ended") {
    assert.notEqual(ws.streams[0].id, ws.streams[2].id);
    assert.equal(ws.streams[2].id, ws.streams[3].id);
  }
  assert.deepEqual(errors, []);
  const pkg = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "1.5.2");
});
