import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { clients } from "./sdk.mjs";
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "aibot-node-sdk": resolve("test/sdk.mjs") },
});
const extension = await jiti.import("../index.ts", { default: true });
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "wecom-test-"));
  process.env.PI_CODING_AGENT_DIR = root;
  await writeFile(
    join(root, "wecom-bot.json"),
    JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }] }),
  );
  const beforeExit = new Set(process.listeners("exit"));
  const h = bind(root);
  const exitListeners = process.listeners("exit").filter((listener) => !beforeExit.has(listener));
  t.after(async () => {
    await h.commands.get("wecombot-disable")?.handler("", h.ctx);
    await rm(root, { recursive: true, force: true });
    for (const listener of exitListeners) process.removeListener("exit", listener);
  });
  return h;
}
function bind(root, session = "session-1") {
  const tools = new Map(),
    commands = new Map(),
    events = new Map(),
    inputs = [];
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => session },
    ui: { setStatus() {}, notify() {} },
  };
  const pi = {
    registerTool: (x) => tools.set(x.name, x),
    registerCommand: (n, x) => commands.set(n, x),
    on: (n, f) => events.set(n, f),
    sendUserMessage: (content, options) => inputs.push({ content, options }),
    sendMessage: (message, options) =>
      inputs.push({ content: message.content, message, options }),
  };
  extension(pi);
  return {
    root,
    tools,
    commands,
    events,
    inputs,
    pi,
    ctx,
    async start() {
      await events.get("session_start")({}, ctx);
      this.ws = clients.at(-1);
    },
    text(content, user = "alice", chatid, reqId = Math.random().toString()) {
      this.ws.emit("message.text", {
        headers: reqId ? { req_id: reqId } : undefined,
        body: {
          msgid: Math.random().toString(),
          chattype: chatid ? "group" : "single",
          from: { userid: user },
          chatid,
          text: { content },
        },
      });
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("A21 新提问无需Agent干预就收尾旧占位并在新位置接续正文", async (t) => {
  const h = await harness(t); await h.start();
  h.text("第一问", "alice", undefined, "first-question"); await tick();
  const send = h.tools.get("wecombot-send");
  await send.execute("progress", { chat: alice, message: "已经找到记录，我继续核对" });
  const old = h.ws.streams.at(-1);
  h.text("第二问", "alice", undefined, "second-question");
  assert.equal(h.inputs.length, 2, "换位回执不能阻塞投递输入");
  await tick();
  assert.deepEqual(h.ws.streams.slice(-2).map(x => [x.headers.req_id, x.content, x.finish]), [
    ["first-question", "我接着看。", true],
    ["second-question", "处理中...", false],
  ], "没有任何Agent发言也应自动完成占位换位");
  assert.equal(h.ws.streams.at(-2).id, old.id);
  assert.notEqual(h.ws.streams.at(-1).id, old.id);
  const current = h.ws.streams.at(-1);
  await send.execute("answer", { chat: alice, message: "这是第二问的回答", ending: "done" });
  assert.deepEqual(h.ws.streams.at(-1), {
    headers: current.headers, id: current.id, content: "✅这是第二问的回答", finish: true,
  });
  assert.equal(h.ws.streams.filter(x => x.content === "已经找到记录，我继续核对").length, 1);
  assert.equal(h.ws.sent.length, 0);
});

test("A24 continuation沿用messages配置，非法值回退且兼容旧配置", async (t) => {
  for (const [name, value, expected] of [
    ["custom", " 我接着弄。 ", " 我接着弄。 "],
    ["missing", undefined, "我接着看。"],
    ["empty", "", "我接着看。"],
    ["whitespace", " \n\t", "我接着看。"],
    ["wrong-type", 123, "我接着看。"],
    ["utf8-limit", "看".repeat(6826) + "aa", "看".repeat(6826) + "aa"],
    ["over-limit", "看".repeat(6827), "我接着看。"],
  ]) await t.test(name, async (t) => {
    const h = await harness(t);
    await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({
      bots: [{ botId: "bot", secret: "fixture-only" }],
      messages: { working: "我在看", continuation: value, donePrefix: "完成：", questionPrefix: "问题：" },
    }));
    await h.start();
    h.text("开始", "alice", undefined, "original"); await tick();
    h.text("补充", "alice", undefined, "latest"); await tick();
    assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
      ["我在看", false], [expected, true], ["我在看", false],
    ]);
    await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "正文", ending: "done" });
    assert.equal(h.ws.streams.at(-1).content, "完成：正文");
    assert.equal(h.inputs.length, 2);
  });
});

test("A23 语音和媒体在接收层换位，下载完成不重复换位且其他chat独立", async (t) => {
  const h = await harness(t); await h.start();
  h.text("开始", "alice", undefined, "first"); await tick();
  h.ws.emit("message.voice", { headers: { req_id: "voice-next" }, body: {
    from: { userid: "alice" }, voice: { content: "语音补充" },
  } }); await tick();
  assert.deepEqual(h.ws.streams.slice(-2).map(x => [x.headers.req_id, x.content]), [
    ["first", "我接着看。"], ["voice-next", "处理中..."],
  ]);
  let downloaded;
  h.ws.download = () => new Promise(resolve => { downloaded = resolve; });
  h.ws.emit("message.image", { headers: { req_id: "image-next" }, body: {
    from: { userid: "alice" }, image: { url: "https://fixture/image" },
  } }); await tick();
  assert.equal(h.inputs.length, 2, "媒体尚未下载完成");
  assert.deepEqual(h.ws.streams.slice(-2).map(x => [x.headers.req_id, x.content]), [
    ["voice-next", "我接着看。"], ["image-next", "处理中..."],
  ]);
  h.text("其他聊天", "bob", "group", "other-chat"); await tick();
  assert.equal(h.ws.streams.filter(x => x.content === "我接着看。").length, 2);
  downloaded({ buffer: Buffer.from("image") });
  await until(() => h.inputs.length === 4); await tick();
  assert.equal(h.ws.streams.filter(x => x.headers.req_id === "image-next").length, 1,
    "下载完成后投递给Pi不能再次关闭/创建占位");
  await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "媒体已核对", ending: "done" });
  assert.equal(h.ws.streams.at(-1).headers.req_id, "image-next");
  assert.equal(h.ws.streams.at(-1).content, "✅媒体已核对");
});

test("发送工具在机器人认证前可用，输入各投递一次且正文不自动发送", async (t) => {
  const h = await harness(t);
  assert.ok(h.tools.has("wecombot-send"));
  await h.start();
  h.text("first");
  h.text("second");
  assert.equal(h.inputs.length, 2);
  assert.ok(
    h.inputs.every(
      (x) => x.message?.customType === "wecombot" && x.message.display === true,
    ),
  );
  assert.deepEqual(
    h.inputs.map((x) => x.options),
    [
      { triggerTurn: true, deliverAs: "steer" },
      { triggerTurn: true, deliverAs: "steer" },
    ],
  );
  await h.events.get("agent_end")?.(
    { messages: [{ content: [{ type: "text", text: "ordinary output" }] }] },
    h.ctx,
  );
  assert.equal(h.ws.sent.length, 0);
});

test("独立消息准确选择单聊/群聊，等待回执并暴露发送失败", async (t) => {
  const h = await harness(t);
  await h.start();
  // 此场景验证无可用回调时的既有主动 Markdown 路径。
  h.text("/wecombot-disable", "alice", undefined, null);
  h.text("hello", "bob", "group-1", null);
  const send = h.tools.get("wecombot-send");
  const a = JSON.stringify(["bot", "single", "alice"]),
    g = JSON.stringify(["bot", "group", "group-1"]);
  assert.ok(h.inputs[0].content.includes("/wecombot-disable"));
  assert.equal(h.inputs[0].options.expandPromptTemplates, undefined);
  let release;
  h.ws.sendWait = new Promise((r) => {
    release = r;
  });
  let finished = false;
  const pending = send
    .execute("1", { chat: g, message: "progress" })
    .then((r) => {
      finished = true;
      return r;
    });
  await tick();
  assert.equal(finished, false);
  release();
  await pending;
  h.ws.sendWait = undefined;
  await send.execute("2", { chat: a, message: "question" });
  assert.deepEqual(
    h.ws.sent.map((x) => [x.chatid, x.markdown.content]),
    [
      ["group-1", "progress"],
      ["alice", "question"],
    ],
  );
  h.ws.sendFailure = { errcode: 123, errmsg: "rejected" };
  await assert.rejects(
    send.execute("3", { chat: a, message: "failed" }),
    /123.*rejected/,
  );
  await assert.rejects(
    send.execute("4", { chat: "unknown", message: "failed" }),
    /未知/,
  );
});

test("精确 /new 通过内部命令切换，切换期间输入进入新绑定且只切换一次", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text(" /new");
  assert.equal(h.inputs.length, 1);
  h.text("/new");
  h.text("/new");
  h.text("new question");
  assert.equal(h.inputs.length, 2);
  assert.equal(h.inputs[1].content, "/wecombot-new");
  assert.equal(h.inputs[1].options.expandPromptTemplates, true);
  let newer;
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    newer = bind(h.root, "session-2");
    await newer.start();
    assert.equal(h.ws.sent.length, 0);
    await withSession({});
    return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx);
  assert.equal(clients.at(-1), h.ws);
  assert.equal(newer.inputs.length, 1);
  assert.ok(newer.inputs[0].content.endsWith("new question"));
  assert.equal(h.inputs.length, 2);
  assert.equal(
    h.ws.sent.filter((x) => x.markdown.content.includes("新会话")).length,
    1,
  );
  await h.events.get("session_shutdown")({}, h.ctx);
  h.text("still new");
  assert.equal(newer.inputs.length, 2);
});

test("后台命令立即返回，跨新会话向当前 Pi 提交旧任务结果一次", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("build");
  const chat = JSON.stringify(["bot", "single", "alice"]);
  const started = await h.tools.get("wecombot-start")?.execute(
    "job",
    {
      chat,
      description: "构建并检查产物",
      command: `node -e 'console.log("start"); setTimeout(()=>{console.log("done");process.exit(7)},250)'`,
    },
    undefined,
    undefined,
    h.ctx,
  );
  assert.ok(started?.details.id);
  const id = started.details.id;
  const running = await h.tools.get("wecombot-task").execute("status", { id });
  assert.equal(running.details.status, "running");
  h.text("/new");
  let newer;
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    newer = bind(h.root, "session-2");
    await newer.start();
    await withSession({});
    return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx);
  let finished;
  for (let i = 0; i < 100; i++) {
    finished = await newer.tools.get("wecombot-task").execute("status", { id });
    if (
      finished.details.status !== "running" &&
      newer.inputs.some((x) => x.message?.customType === "wecombot-task")
    )
      break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(finished.details.exitCode, 7);
  assert.ok(finished.details.log.includes("done"));
  assert.equal(finished.details.chat, chat);
  assert.equal(h.ws.sent.filter((x) => x.markdown.content.includes(id)).length, 0);
  assert.equal(newer.inputs.length, 1);
  const event = newer.inputs[0];
  assert.equal(event.message.customType, "wecombot-task");
  assert.deepEqual(event.options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(event.content, /此前会话的旧任务结果，仅向原 chat 汇报/);
  const facts = JSON.parse(event.content.slice(event.content.indexOf("{\n")));
  assert.equal(facts.description, "构建并检查产物");
  assert.equal(facts.sessionId, "session-1");
  assert.equal(facts.currentSessionId, "session-2");
  assert.equal(facts.previousSession, true);
  assert.equal(facts.chat, chat);
  assert.equal(facts.exitCode, 7);
  assert.equal(facts.cwd, h.root);
  assert.equal(facts.command, finished.details.command);
  assert.equal(facts.logPath, started.details.logPath);
  assert.match(facts.log, /done/);
  await newer.tools.get("wecombot-task").execute("again", { id });
  assert.equal(newer.inputs.length, 1);
});

test("收媒体保留原聊天，迟到下载不投递到已切换的 Pi", async (t) => {
  const h = await harness(t);
  await h.start();
  const frame = {
    headers: { req_id: "image-1" },
    body: {
      msgid: "image-1",
      chattype: "single",
      from: { userid: "alice" },
      image: { url: "https://image" },
    },
  };
  h.ws.emit("message.image", frame);
  for (let i = 0; i < 30 && h.inputs.length === 0; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.inputs.length, 1);
  assert.ok(h.inputs[0].content.includes("图片"));
  let release;
  h.ws.download = () =>
    new Promise((r) => {
      release = r;
    });
  h.ws.emit("message.image", {
    ...frame,
    body: { ...frame.body, msgid: "image-2" },
  });
  h.text("/new");
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    const newer = bind(h.root, "session-2");
    await newer.start();
    await withSession({});
    return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx);
  release({ buffer: Buffer.from("late") });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.inputs.length, 2);
});

test("附件读取真实内容和文件名，向指定聊天发送独立文件消息", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file", "alice");
  h.text("other", "bob");
  const path = join(h.root, "artifact.txt");
  await writeFile(path, "content");
  const attached = await h.tools.get("wecombot-attach")?.execute("attach", {
    chat: JSON.stringify(["bot", "single", "bob"]),
    paths: [path],
  });
  assert.equal(h.ws.sent[0]?.chatid, "bob");
  assert.deepEqual(h.ws.uploads, [{ buffer: Buffer.from("content"), type: "file", filename: "artifact.txt" }]);
  assert.deepEqual(h.ws.sent, [{ chatid: "bob", msgtype: "file", file: { media_id: "media-1" } }]);
  assert.match(attached.content[0].text, /已发送.*artifact.txt/s);
});

test("快速退出的后台命令能完成，启动无效目录得到具体错误", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("start");
  const chat = JSON.stringify(["bot", "single", "alice"]);
  const jobs = [];
  for (let i = 0; i < 5; i++)
    jobs.push(
      (
        await h.tools
          .get("wecombot-start")
          .execute(
            "fast",
            { chat, description: "验证后台命令", command: "exit 0" },
            undefined,
            undefined,
            h.ctx,
          )
      ).details.id,
    );
  for (const id of jobs) {
    let task;
    for (let i = 0; i < 50; i++) {
      task = await h.tools.get("wecombot-task").execute("status", { id });
      if (task.details.status !== "running") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(task.details.status, "exited");
    assert.equal(task.details.exitCode, 0);
  }
  await assert.rejects(
    h.tools
      .get("wecombot-start")
      .execute(
        "invalid",
        { chat, description: "验证后台命令", command: "echo should-not-run", cwd: join(h.root, "missing") },
        undefined,
        undefined,
        h.ctx,
      ),
    /ENOENT/,
  );
});

test("新会话取消和失败给出具体通知，后续输入继续处理", async (t) => {
  const h = await harness(t);
  await h.start();
  h.ctx.newSession = async () => ({ cancelled: true });
  h.text("/new");
  h.text("after cancellation");
  await h.commands.get("wecombot-new").handler("", h.ctx);
  assert.ok(h.ws.sent.at(-1).markdown.content.includes("取消"));
  assert.ok(h.inputs.at(-1).content.endsWith("after cancellation"));
  h.ctx.newSession = async () => {
    throw new Error("disk full");
  };
  h.text("/new");
  h.text("after failure");
  await h.commands.get("wecombot-new").handler("", h.ctx);
  assert.ok(h.ws.sent.at(-1).markdown.content.includes("disk full"));
  assert.ok(h.inputs.at(-1).content.endsWith("after failure"));
});

test("旧 Bot 迟到下载被丢弃，后台结果不依赖企微连接，禁用跨 Pi 会话保留", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("start");
  const old = h.ws;
  let release;
  old.download = () =>
    new Promise((r) => {
      release = r;
    });
  old.emit("message.file", {
    body: {
      chattype: "single",
      from: { userid: "alice" },
      file: { url: "https://file" },
    },
  });
  await writeFile(
    join(h.root, "wecom-bot.json"),
    JSON.stringify({
      bots: [
        { botId: "bot", secret: "s" },
        { botId: "bot2", secret: "s" },
      ],
    }),
  );
  h.ctx.ui.select = async (_title, options) => options[1];
  await h.commands.get("wecombot-use").handler("", h.ctx);
  release({ buffer: Buffer.from("late") });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.inputs.length, 1);
  const current = clients.at(-1);
  h.ws = current;
  h.text("build", "bob");
  const chat = JSON.stringify(["bot2", "single", "bob"]);
  current.sendFailure = { errcode: 500, errmsg: "temporary" };
  const started = await h.tools
    .get("wecombot-start")
    .execute("job", { chat, description: "验证后台命令", command: "exit 0" }, undefined, undefined, h.ctx);
  let task;
  for (let i = 0; i < 50; i++) {
    task = await h.tools
      .get("wecombot-task")
      .execute("status", { id: started.details.id });
    if (task.details.status !== "running") break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await until(() => taskEvents(h).length === 1);
  assert.equal(current.sent.length, 0);
  current.sendFailure = undefined;
  await Promise.all(
    [1, 2].map(() =>
      h.tools.get("wecombot-task").execute("retry", { id: started.details.id }),
    ),
  );
  assert.equal(taskEvents(h).length, 1);
  current.emit("authenticated");
  assert.equal(current.sent.length, 0);
  assert.equal(taskEvents(h).length, 1);
  await h.commands.get("wecombot-disable").handler("", h.ctx);
  await h.events.get("session_shutdown")({}, h.ctx);
  const newer = bind(h.root, "session-2");
  await newer.start();
  assert.equal(clients.at(-1), current);
});

test("Pi进程正常退出会终止仍在运行的后台进程组", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wecom-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "wecom-bot.json"),
    JSON.stringify({ bots: [{ botId: "bot", secret: "s" }] }),
  );
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["test/exit-fixture.mjs"],
    { env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 5000 },
  );
  const { pid } = JSON.parse(stdout.trim());
  let alive = true;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") {
        alive = false;
        break;
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  if (alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  assert.equal(alive, false);
});

test("旧Pi停止后替换失败会说明输入未处理，后续消息和new明确失败", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("/new");
  h.text("during replacement");
  h.ctx.newSession = async () => {
    await h.events.get("session_shutdown")({}, h.ctx);
    throw new Error("replacement failed");
  };
  await h.commands.get("wecombot-new").handler("", h.ctx);
  assert.match(
    h.ws.sent.at(-1).markdown.content,
    /Pi会话不可用.*重启Pi.*切换期间的输入未处理/s,
  );
  const sentBefore = h.ws.sent.length;
  h.text("later");
  h.text("/new");
  await tick();
  assert.equal(h.inputs.length, 1);
  assert.equal(h.ws.sent.length, sentBefore + 2);
  assert.ok(
    h.ws.sent.slice(-2).every((x) => /Pi会话不可用/.test(x.markdown.content)),
  );
});

test("附件读取失败说明失败阶段、具体路径及原始原因", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "missing.txt");
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }), (err) => /读取失败/.test(err.message) && err.message.includes(path) && /ENOENT/.test(err.message));
  assert.equal(h.ws.sent.length, 0);
  assert.equal(h.ws.uploads?.length || 0, 0);
});

test("附件上传被拒绝给出具体原因且不发送文件", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "rejected.txt");
  await writeFile(path, "payload");
  h.ws.uploadFailure = { errcode: 400, errmsg: "too large" };
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }), (err) => /上传失败/.test(err.message) && err.message.includes(path) && /400.*too large/.test(err.message));
  assert.equal(h.ws.sent.length, 0);
});

test("附件发送回执失败说明具体文件和企微错误", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "send-rejected.txt");
  await writeFile(path, "payload");
  h.ws.sendFailure = { errcode: 500, errmsg: "blocked" };
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }), (err) => /发送未确认/.test(err.message) && err.message.includes(path) && /500.*blocked/.test(err.message));
  assert.equal(h.ws.uploads.length, 1);
  assert.equal(h.ws.sent.length, 0);
});

test("多附件部分成功时列出已发送文件、失败原因及尚未发送文件", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("files");
  const sent = join(h.root, "sent.txt"), missing = join(h.root, "missing.txt"), remaining = join(h.root, "remaining.txt");
  await writeFile(sent, "first");
  await writeFile(remaining, "third");
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [sent, missing, remaining],
  }), (err) => err.message.includes(`已发送文件:\n${sent}`) && /读取失败.*ENOENT/.test(err.message) && err.message.includes(`未发送文件:\n${missing}\n${remaining}`));
  assert.equal(h.ws.sent.length, 1);
  assert.deepEqual(h.ws.uploads.map((x) => x.filename), ["sent.txt"]);
});

test("已取消的附件调用不读取上传或发送", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "cancelled.txt");
  await writeFile(path, "payload");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }, controller.signal), /附件发送已取消/);
  assert.equal(h.ws.uploads?.length || 0, 0);
  assert.equal(h.ws.sent.length, 0);
});

function holdUpload(ws) {
  let enter, release;
  const started = new Promise((resolve) => { enter = resolve; });
  ws.uploadWait = new Promise((resolve) => { release = resolve; });
  const upload = ws.uploadMedia.bind(ws);
  ws.uploadMedia = (...args) => {
    const pending = upload(...args);
    enter();
    return pending;
  };
  return { started, release };
}

test("上传期间取消会等待上传结果并停止文件发送", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "cancel-upload.txt");
  await writeFile(path, "payload");
  const gate = holdUpload(h.ws), controller = new AbortController();
  let finished = false;
  const pending = h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }, controller.signal).finally(() => { finished = true; });
  await gate.started;
  assert.equal(finished, false);
  assert.equal(h.ws.sent.length, 0);
  controller.abort();
  gate.release();
  await assert.rejects(pending, /附件发送已取消/);
  assert.equal(h.ws.sent.length, 0);
});

test("上传期间收到 new 后旧附件不能向企微继续发送", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "old-session.txt");
  await writeFile(path, "payload");
  const gate = holdUpload(h.ws);
  const pending = h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  });
  await gate.started;
  h.text("/new");
  gate.release();
  await assert.rejects(pending, /附件发送会话已失效/);
  assert.equal(h.ws.sent.length, 0);
});

test("上传期间切换 Bot 不使用旧素材发送到任何 Bot", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const old = h.ws, path = join(h.root, "old-bot.txt");
  await writeFile(path, "payload");
  const gate = holdUpload(old);
  const pending = h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  });
  await gate.started;
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({ bots: [
    { botId: "bot", secret: "s" }, { botId: "bot2", secret: "s" },
  ] }));
  h.ctx.ui.select = async (_title, options) => options[1];
  await h.commands.get("wecombot-use").handler("", h.ctx);
  const newer = clients.at(-1);
  gate.release();
  await assert.rejects(pending, /来源机器人连接已变化/);
  assert.equal(old.sent.length, 0);
  assert.equal(newer.sent.length, 0);
  assert.equal(newer.uploads?.length || 0, 0);
});

function holdFileSend(ws) {
  let enter, release;
  const started = new Promise((resolve) => { enter = resolve; });
  ws.sendWait = new Promise((resolve) => { release = resolve; });
  const send = ws.sendMediaMessage.bind(ws);
  ws.sendMediaMessage = (...args) => {
    const pending = send(...args);
    enter();
    return pending;
  };
  return { started, release };
}

test("附件等待文件回执，期间取消仍如实报告回执确认已发送的文件", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "sent-before-cancel.txt");
  await writeFile(path, "payload");
  const gate = holdFileSend(h.ws), controller = new AbortController();
  let finished = false;
  const pending = h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }, controller.signal).finally(() => { finished = true; });
  await gate.started;
  assert.equal(finished, false);
  assert.equal(h.ws.sent.length, 0);
  controller.abort();
  gate.release();
  await assert.rejects(pending, (err) => /附件发送已取消/.test(err.message) && err.message.includes(`已发送文件:\n${path}`) && /未发送文件:\n无/.test(err.message));
  assert.deepEqual(h.ws.sent, [{ chatid: "alice", msgtype: "file", file: { media_id: "media-1" } }]);
});

test("new 已开始时旧会话附件工具不能启动上传", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("/new");
  const path = join(h.root, "during-switch.txt");
  await writeFile(path, "payload");
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  }), /附件发送会话已失效/);
  assert.equal(h.ws.uploads?.length || 0, 0);
  assert.equal(h.ws.sent.length, 0);
});

test("上传期间禁用再启用同一 Bot 也不能沿用旧连接素材", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const old = h.ws, path = join(h.root, "disabled.txt");
  await writeFile(path, "payload");
  const gate = holdUpload(old);
  const pending = h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [path],
  });
  await gate.started;
  await h.commands.get("wecombot-disable").handler("", h.ctx);
  await h.commands.get("wecombot-enable").handler("", h.ctx);
  const newer = clients.at(-1);
  assert.notEqual(newer, old);
  gate.release();
  await assert.rejects(pending, /来源机器人连接已变化或已禁用/);
  assert.equal(old.sent.length, 0);
  assert.equal(newer.sent.length, 0);
});

test("上传期间 Pi 绑定替换后旧调用失败，新会话仍能发送附件", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("file");
  const path = join(h.root, "replaced.txt"), chat = JSON.stringify(["bot", "single", "alice"]);
  await writeFile(path, "payload");
  const gate = holdUpload(h.ws);
  const pending = h.tools.get("wecombot-attach").execute("attach", { chat, paths: [path] });
  await gate.started;
  await h.events.get("session_shutdown")({}, h.ctx);
  const newer = bind(h.root, "session-2");
  await newer.start();
  gate.release();
  await assert.rejects(pending, /附件发送会话已失效/);
  await assert.rejects(h.tools.get("wecombot-attach").execute("old", { chat, paths: [path] }), /附件发送会话已失效/);
  assert.equal(h.ws.sent.length, 0);
  const attached = await newer.tools.get("wecombot-attach").execute("new", { chat, paths: [path] });
  assert.deepEqual(attached.details.sent, [path]);
  assert.equal(h.ws.sent.length, 1);
  assert.equal(h.inputs.length, 1);
  assert.equal(newer.inputs.length, 0);
});

test("文件回执期间 new 发生时保留已发项并停止其余附件", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("files");
  const first = join(h.root, "confirmed.txt"), second = join(h.root, "not-sent.txt");
  await writeFile(first, "first");
  await writeFile(second, "second");
  const gate = holdFileSend(h.ws);
  const pending = h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths: [first, second],
  });
  await gate.started;
  h.text("/new");
  gate.release();
  await assert.rejects(pending, (err) => /附件发送会话已失效/.test(err.message) && err.message.includes(`已发送文件:\n${first}`) && err.message.includes(`未发送文件:\n${second}`));
  assert.equal(h.ws.sent.length, 1);
  assert.deepEqual(h.ws.uploads.map((x) => x.filename), ["confirmed.txt"]);
});

test("当前来源 Bot 群聊进展与独立附件回执后可同泡最终收尾", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("old bot");
  const old = h.ws;
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({ bots: [
    { botId: "bot", secret: "s" }, { botId: "bot2", secret: "s" },
  ] }));
  h.ctx.ui.select = async (_title, options) => options[1];
  await h.commands.get("wecombot-use").handler("", h.ctx);
  h.ws = clients.at(-1);
  h.text("first known", "alice");
  h.text("send files", "bob", "group-2");
  const chat = JSON.stringify(["bot2", "group", "group-2"]);
  const first = join(h.root, "report.txt"), second = join(h.root, "build.hap");
  await writeFile(first, "report");
  await writeFile(second, Buffer.from([0, 1, 127, 255]));
  await h.tools.get("wecombot-send").execute("before", { chat, message: "before" });
  const gate = holdFileSend(h.ws);
  let finished = false;
  const pending = h.tools.get("wecombot-attach").execute("attach", { chat, paths: [first, second] }).then((value) => { finished = true; return value; });
  await gate.started;
  assert.equal(finished, false);
  assert.equal(h.ws.sent.length, 0);
  gate.release();
  const attached = await pending;
  await h.tools.get("wecombot-send").execute("after", { chat, message: "after", ending: "done" });
  assert.deepEqual(attached.details.sent, [first, second]);
  assert.deepEqual(h.ws.uploads, [
    { buffer: Buffer.from("report"), type: "file", filename: "report.txt" },
    { buffer: Buffer.from([0, 1, 127, 255]), type: "file", filename: "build.hap" },
  ]);
  assert.deepEqual(h.ws.sent, [
    { chatid: "group-2", msgtype: "file", file: { media_id: "media-1" } },
    { chatid: "group-2", msgtype: "file", file: { media_id: "media-2" } },
  ]);
  assert.deepEqual(h.ws.streams.filter(x => x.finish).map(x => x.content), ["before", "✅after"]);
  assert.equal(old.uploads?.length || 0, 0);
  assert.equal(old.sent.length, 0);
  await assert.rejects(h.tools.get("wecombot-attach").execute("unknown", { chat: "unknown", paths: [first] }), /未知企微聊天标识/);
  await assert.rejects(h.tools.get("wecombot-attach").execute("other-bot", { chat: JSON.stringify(["bot", "single", "alice"]), paths: [first] }), /来源机器人未连接/);
  assert.equal(h.ws.uploads.length, 2);
});

test("第二个附件上传失败时保留第一个已发送文件并停止后续上传", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("files");
  const paths = ["first.txt", "upload-failed.txt", "remaining.txt"].map((name) => join(h.root, name));
  for (const path of paths) await writeFile(path, "payload");
  const upload = h.ws.uploadMedia.bind(h.ws);
  h.ws.uploadMedia = (...args) => {
    if (h.ws.uploads?.length === 1) h.ws.uploadFailure = new Error("upload denied");
    return upload(...args);
  };
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths,
  }), (err) => /上传失败: upload denied/.test(err.message) && err.message.includes(`已发送文件:\n${paths[0]}`) && err.message.includes(`未发送文件:\n${paths[1]}\n${paths[2]}`));
  assert.equal(h.ws.sent.length, 1);
  assert.equal(h.ws.uploads.length, 2);
});

test("第二个附件发送失败时仅第一个列为已发且不尝试第三个", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("files");
  const paths = ["first.txt", "send-failed.txt", "remaining.txt"].map((name) => join(h.root, name));
  for (const path of paths) await writeFile(path, "payload");
  const send = h.ws.sendMediaMessage.bind(h.ws);
  h.ws.sendMediaMessage = (...args) => {
    if (h.ws.sent.length === 1) h.ws.sendFailure = new Error("send denied");
    return send(...args);
  };
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths,
  }), (err) => /发送未确认: send denied/.test(err.message) && err.message.includes(`已发送文件:\n${paths[0]}`) && err.message.includes(`发送未确认文件:\n${paths[1]}`) && err.message.includes(`未发送文件:\n${paths[2]}`));
  assert.equal(h.ws.sent.length, 1);
  assert.equal(h.ws.uploads.length, 2);
});

test("文件已传出但回执超时标为发送未确认，只有尚未尝试项列为未发送", async (t) => {
  const h = await harness(t);
  await h.start();
  h.text("files");
  const paths = ["confirmed.txt", "ack-timeout.txt", "not-attempted.txt"].map((name) => join(h.root, name));
  for (const path of paths) await writeFile(path, "payload");
  const transmitted = [];
  h.ws.sendMediaMessage = async (chatid, type, media_id) => {
    transmitted.push({ chatid, msgtype: type, [type]: { media_id } });
    if (transmitted.length === 1) return { errcode: 0 };
    throw new Error("Reply ack timeout");
  };
  await assert.rejects(h.tools.get("wecombot-attach").execute("attach", {
    chat: JSON.stringify(["bot", "single", "alice"]), paths,
  }), (err) => /发送未确认.*Reply ack timeout/.test(err.message)
    && err.message.includes(`已发送文件:\n${paths[0]}`)
    && err.message.includes(`发送未确认文件:\n${paths[1]}`)
    && err.message.includes(`未发送文件:\n${paths[2]}`)
    && !err.message.includes(`未发送文件:\n${paths[1]}`));
  assert.deepEqual(transmitted, [
    { chatid: "alice", msgtype: "file", file: { media_id: "media-1" } },
    { chatid: "alice", msgtype: "file", file: { media_id: "media-2" } },
  ]);
  assert.equal(h.ws.uploads.length, 2);
});

test("配置解析或读取失败时公开启动与列表按空机器人处理", async (t) => {
  for (const failure of ["parse", "read"]) await t.test(failure, async (t) => {
    const h = await harness(t);
    const config = join(h.root, "wecom-bot.json");
    if (failure === "parse") await writeFile(config, "{invalid");
    else {
      await rm(config);
      await mkdir(config);
    }
    const notices = [], before = clients.length;
    h.ctx.ui.notify = (message, level) => notices.push({ message, level });
    await h.start();
    assert.equal(clients.length, before);
    await h.commands.get("wecombot-list").handler("", h.ctx);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /暂无.*机器人/);
  });
});


test("后台 shell 退出保留其退出结果并终止同组残留子进程", async (t) => {
  let pid, logPath;
  t.after(async () => {
    if (!pid && logPath) pid = Number((await readFile(logPath, "utf8")).trim());
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
    }
  });
  const h = await harness(t);
  await h.start();
  h.text("background child");
  const started = await h.tools.get("wecombot-start").execute("job", {
    chat: JSON.stringify(["bot", "single", "alice"]),
    description: "验证子进程清理",
    command: "sleep 60 & echo $!",
  }, undefined, undefined, h.ctx);
  logPath = started.details.logPath;
  let task;
  for (let i = 0; i < 100; i++) {
    task = await h.tools.get("wecombot-task").execute("status", { id: started.details.id });
    pid = Number(task.details.log.trim());
    if (task.details.status !== "running" && pid) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(task.details.status, "exited");
  assert.equal(task.details.exitCode, 0);
  assert.equal(task.details.signal, null);
  assert.ok(pid > 0);
  let alive = true;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (err) {
      if (err.code !== "ESRCH") throw err;
      alive = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, `shell 已退出，其子进程 ${pid} 仍在运行`);
});

async function until(check) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("等待可观察结果超时");
}
const taskEvents = (h) => h.inputs.filter((x) => x.message?.customType === "wecombot-task");
const eventFacts = (event) => JSON.parse(event.content.slice(event.content.indexOf("{\n")));
const alice = JSON.stringify(["bot", "single", "alice"]);
function controlledSend(ws) {
  const calls = [];
  ws.sendMessage = (chatid, body) => new Promise((resolve, reject) => {
    calls.push({ chatid, ...body, reject, confirm() {
      ws.sent.push({ chatid, ...body });
      resolve({ errcode: 0 });
    } });
  });
  return calls;
}
async function startJob(h, params = {}) {
  return h.tools.get("wecombot-start").execute("job", {
    chat: alice, description: "验证任务接续", command: "echo completed", ...params,
  }, undefined, undefined, h.ctx);
}
async function finishedJob(h, id) {
  return until(async () => {
    const { details } = await h.tools.get("wecombot-task").execute("status", { id });
    return details.status !== "running" && details;
  });
}
async function gatedJob(h) {
  return startJob(h, {
    command: `while [ ! -f '${h.root}/release' ]; do sleep 0.01; done; echo completed`,
  });
}

test("无回调时done/question合并正文，等待单次实际回执", async (t) => {
  for (const [ending, prefix] of [["done", "✅"], ["question", "💬"]]) await t.test(ending, async (t) => {
    const h = await harness(t); await h.start(); h.text("result", "bob", "group-1", null);
    const calls = controlledSend(h.ws);
    let finished = false;
    const pending = h.tools.get("wecombot-send").execute("send", {
      chat: JSON.stringify(["bot", "group", "group-1"]), message: "正文", ending,
    }).then(value => { finished = true; return value; });
    assert.equal(calls[0].markdown.content, prefix + "正文");
    await tick(); assert.equal(finished, false);
    calls[0].confirm(); assert.match((await pending).content[0].text, /正文已发送/);
    assert.equal(calls.length, 1);
    assert.equal(h.ws.streams.length, 0);
  });
});

test("主动正文拒绝或回执超时保留原始错误，不再发送独立标记", async (t) => {
  for (const reason of [{ errcode: 500, errmsg: "blocked" }, new Error("Reply ack timeout")]) await t.test(String(reason.errmsg || reason.message), async (t) => {
    const h = await harness(t); await h.start(); h.text("result", "alice", undefined, null);
    const calls = controlledSend(h.ws);
    const pending = h.tools.get("wecombot-send").execute("send", { chat: alice, message: "正文", ending: "done" });
    calls[0].reject(reason);
    await assert.rejects(pending, /blocked|Reply ack timeout/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].markdown.content, "✅正文");
  });
});

test("A10 正文请求后的取消或切换保留迟到成功事实且不再续开", async (t) => {
  for (const change of ["cancel", "new", "binding", "connection", "disconnect", "shutdown"]) await t.test(change, async (t) => {
    const h = await harness(t); await h.start(); h.text("result"); await tick();
    const old = h.ws, calls = controlledStreams(old), controller = new AbortController();
    const pending = h.tools.get("wecombot-send").execute("send", { chat: alice, message: "正文" }, controller.signal);
    await tick(); assert.equal(calls[0].content, "正文");
    if (change === "cancel") controller.abort();
    if (change === "new") h.text("/new");
    if (change === "binding") await bind(h.root, "session-1").start();
    if (change === "connection") {
      await h.commands.get("wecombot-disable").handler("", h.ctx);
      await h.commands.get("wecombot-enable").handler("", h.ctx);
    }
    if (change === "disconnect") old.emit("disconnected");
    if (change === "shutdown") await h.events.get("session_shutdown")({}, h.ctx);
    calls[0].confirm();
    await assert.rejects(pending, err => /取消|失效|连接已变化/.test(err.message) && /正文已发送/.test(err.message));
    await tick(); assert.equal(calls.length, 1);
    if (change === "connection") assert.equal(clients.at(-1).streams.length, 0);
  });
});

test("发送前取消或切换失效不发送正文", async (t) => {
  const h = await harness(t); await h.start(); h.text("result"); await tick();
  const controller = new AbortController(); controller.abort();
  const send = h.tools.get("wecombot-send"), before = h.ws.streams.length;
  await assert.rejects(send.execute("cancelled", { chat: alice, message: "正文", ending: "done" }, controller.signal), /取消.*\n正文未发送/);
  assert.equal(h.ws.streams.length, before);
  h.text("/new"); await tick();
  const after = h.ws.streams.length;
  await assert.rejects(send.execute("old", { chat: alice, message: "正文" }), /会话已失效.*\n正文未发送/);
  assert.equal(h.ws.streams.length, after);
});

test("助手正文、agent_end 和 agent_settled 不自动生成收尾", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("result");
  for (const name of ["agent_end", "agent_settled"]) await h.events.get(name)?.({ messages: [{ role: "assistant", content: "完成 ✅" }] }, h.ctx);
  assert.equal(h.ws.sent.length, 0);
});

test("后台用途必填且不接受空白，正常退出事件保留用途、来源与日志尾部", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  const tool = h.tools.get("wecombot-start");
  assert.ok(tool.parameters.required.includes("description"));
  for (const description of [undefined, "", "   "]) await assert.rejects(startJob(h, { description }), /description/);
  const started = await startJob(h, { command: `node -e 'process.stdout.write("x".repeat(20000)+"TAIL")'` });
  assert.ok(started.details.id); assert.ok(started.details.logPath);
  await until(() => taskEvents(h)[0]);
  const event = taskEvents(h)[0], facts = eventFacts(event);
  assert.equal(facts.previousSession, false);
  assert.match(event.content, /继续用户原本已要求的后续步骤/);
  assert.equal(facts.exitCode, 0);
  assert.equal(facts.signal, null);
  assert.equal(facts.description, "验证任务接续");
  assert.equal(facts.chat, alice);
  assert.equal(Buffer.byteLength(facts.log), 16384);
  assert.ok(facts.log.endsWith("TAIL"));
  const queried = await h.tools.get("wecombot-task").execute("status", { id: started.details.id });
  assert.equal(queried.details.log, facts.log);
  assert.equal(queried.details.delivery, "submitted");
  assert.equal(h.ws.sent.length, 0);
});

test("没有绑定时保留待派发，查询无副作用，绑定就绪提交一次", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  const started = await gatedJob(h);
  await h.events.get("session_shutdown")({}, h.ctx);
  await writeFile(join(h.root, "release"), "go");
  const task = await finishedJob(h, started.details.id);
  assert.equal(task.delivery, "pending");
  for (let i = 0; i < 3; i++) await h.tools.get("wecombot-task").execute("query", { id: task.id });
  assert.equal(taskEvents(h).length, 0);
  const newer = bind(h.root, "session-2"); await newer.start();
  await until(() => taskEvents(newer).length === 1);
  await newer.events.get("session_start")({}, newer.ctx);
  h.ws.emit("authenticated"); await tick();
  assert.equal(taskEvents(h).length, 0);
  assert.equal(taskEvents(newer).length, 1);
  assert.equal(eventFacts(taskEvents(newer)[0]).previousSession, true);
  assert.equal(h.ws.sent.length, 0);
});

test("new 切换期间完成的任务在切换收尾后排空，session_start 不重复提交", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  const started = await gatedJob(h);
  h.text("/new");
  let newer;
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    newer = bind(h.root, "session-2"); await newer.start();
    await writeFile(join(h.root, "release"), "go");
    const task = await finishedJob(newer, started.details.id);
    assert.equal(task.delivery, "pending");
    assert.equal(taskEvents(newer).length, 0);
    await withSession({});
    return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx);
  await until(() => taskEvents(newer).length === 1);
  await newer.events.get("session_start")({}, newer.ctx); await tick();
  assert.equal(taskEvents(newer).length, 1);
  assert.equal(eventFacts(taskEvents(newer)[0]).sessionId, "session-1");
  assert.equal(h.ws.sent.length, 1); // 仅 /new 确认
});

test("同会话 reload 的旧启动回调提交给当前 Pi，Bot 切换不改变原 chat", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  const started = await gatedJob(h);
  const newer = bind(h.root, "session-1"); await newer.start();
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({ bots: [
    { botId: "bot", secret: "s" }, { botId: "bot2", secret: "s" },
  ] }));
  newer.ctx.ui.select = async (_title, options) => options[1];
  await newer.commands.get("wecombot-use").handler("", newer.ctx);
  await writeFile(join(h.root, "release"), "go");
  await until(() => taskEvents(newer).length === 1);
  const facts = eventFacts(taskEvents(newer)[0]);
  assert.equal(facts.previousSession, false);
  assert.equal(facts.chat, alice);
  assert.equal(facts.id, started.details.id);
  assert.equal(taskEvents(h).length, 0);
  await assert.rejects(newer.tools.get("wecombot-send").execute("reply", { chat: facts.chat, message: "result" }), /来源机器人未连接/);
  assert.equal(h.ws.sent.length, 0);
  assert.equal(clients.at(-1).sent.length, 0);
});

test("Pi 同步提交失败保留错误与待派发状态，查询和再认证不重试", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  h.pi.sendMessage = () => { throw new Error("Pi unavailable"); };
  const started = await startJob(h);
  const task = await until(async () => {
    const { details } = await h.tools.get("wecombot-task").execute("status", { id: started.details.id });
    return details.deliveryError && details;
  });
  assert.equal(task.delivery, "pending");
  assert.match(task.deliveryError, /Pi unavailable/);
  const received = [];
  h.pi.sendMessage = (message, options) => received.push({ message, options });
  h.ws.emit("authenticated");
  await h.tools.get("wecombot-task").execute("query", { id: task.id });
  assert.equal(received.length, 0);
  await h.events.get("session_start")({}, h.ctx);
  await until(() => received.length === 1);
  const queried = await h.tools.get("wecombot-task").execute("status", { id: task.id });
  assert.equal(queried.details.delivery, "submitted");
  assert.equal(queried.details.deliveryError, undefined);
  await h.events.get("session_start")({}, h.ctx); await tick();
  assert.equal(received.length, 1);
});

test("日志读取失败仍提交已知退出事实和具体错误，查询也保留状态", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  const started = await gatedJob(h);
  await rm(started.details.logPath);
  await writeFile(join(h.root, "release"), "go");
  await until(() => taskEvents(h).length === 1);
  const facts = eventFacts(taskEvents(h)[0]);
  assert.equal(facts.exitCode, 0);
  assert.equal(facts.log, "");
  assert.match(facts.logError, /ENOENT/);
  const queried = await h.tools.get("wecombot-task").execute("query", { id: facts.id });
  assert.equal(queried.details.status, "exited");
  assert.match(queried.details.logError, /ENOENT/);
});

test("真实子进程被信号终止时事件保留信号事实", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  await startJob(h, { command: "kill -TERM $$" });
  await until(() => taskEvents(h).length === 1);
  const facts = eventFacts(taskEvents(h)[0]);
  assert.equal(facts.status, "exited");
  assert.equal(facts.exitCode, null);
  assert.equal(facts.signal, "SIGTERM");
  assert.match(taskEvents(h)[0].content, /信号终止不等于编译错误/);
  assert.equal(h.ws.sent.length, 0);
});

test("真实 spawn 启动失败仍记录错误并提交完成事件", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("start");
  const cwd = join(h.root, "vanishing-cwd");
  await mkdir(cwd);
  const { rmSync } = await import("node:fs");
  // 在 stat 校验后、实际 spawn 前移除目录，确定性触发 OS 的 ENOENT。
  const started = await h.tools.get("wecombot-start").execute("start", {
    chat: alice, description: "验证启动错误", cwd,
    get command() { rmSync(cwd, { recursive: true, force: true }); return "echo must-not-run"; },
  }, undefined, undefined, h.ctx);
  await until(() => taskEvents(h).length === 1);
  const facts = eventFacts(taskEvents(h)[0]);
  assert.equal(facts.id, started.details.id);
  assert.equal(facts.status, "failed");
  assert.match(facts.error, /ENOENT/);
  assert.equal(facts.signal, null);
  assert.equal(facts.log, "");
  assert.equal(h.ws.sent.length, 0);
});


test("A01 合法文本语音媒体立即占位，回执与下载均不阻塞输入", async (t) => {
  const h = await harness(t); await h.start();
  let ack;
  h.ws.streamReply = () => new Promise((resolve) => { ack = resolve; });
  h.text("开始");
  assert.equal(h.inputs.length, 1);
  await tick();
  assert.equal(h.ws.streams[0]?.content, "处理中...");
  assert.equal(h.ws.streams[0]?.finish, false);
  h.text("补充");
  assert.equal(h.inputs.length, 2);
  ack({ errcode: 0 }); await tick();
  assert.equal(h.ws.streams[1].content, "我接着看。");
  h.ws.streamReply = undefined;
  ack({ errcode: 0 }); await tick();
  assert.equal(h.ws.streams.length, 3);
  h.ws.emit("message.voice", { headers: { req_id: "voice" }, body: {
    from: { userid: "bob" }, voice: { content: "语音任务" },
  } });
  let downloaded;
  h.ws.download = () => new Promise((resolve) => { downloaded = resolve; });
  h.ws.emit("message.image", { headers: { req_id: "media" }, body: {
    from: { userid: "carol" }, image: { url: "https://fixture/image" },
  } });
  await tick();
  assert.deepEqual(h.ws.streams.map(x => [x.headers.req_id === "voice" || x.headers.req_id === "media", x.content]), [
    [false, "处理中..."], [false, "我接着看。"], [false, "处理中..."],
    [true, "处理中..."], [true, "处理中..."],
  ]);
  assert.equal(h.inputs.length, 3);
  downloaded({ buffer: Buffer.from("image") });
  await until(() => h.inputs.length === 4);
  assert.match(h.inputs.at(-1).content, /图片:/);
});


test("A03 A04 进展原位定格后接续，最终与提问合并前缀且不再占位", async (t) => {
  const h = await harness(t); await h.start(); h.text("开始");
  const send = h.tools.get("wecombot-send");
  for (const message of ["收到，我先检查接口", "接口确认支持，正在核对限制", "限制已经查清，接下来验证客户端效果。"])
    await send.execute("progress", { chat: alice, message });
  await send.execute("final", { chat: alice, message: "结论: xxxxx", ending: "done" });
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["处理中...", false], ["收到，我先检查接口", true],
    ["处理中...", false], ["接口确认支持，正在核对限制", true],
    ["处理中...", false], ["限制已经查清，接下来验证客户端效果。", true],
    ["处理中...", false], ["✅结论: xxxxx", true],
  ]);
  for (let i = 0; i < 8; i += 2) assert.equal(h.ws.streams[i].id, h.ws.streams[i+1].id);
  assert.equal(new Set(h.ws.streams.map(x => x.id)).size, 4);
  const firstReq = h.ws.streams[0].headers.req_id;
  assert.ok(h.ws.streams.every(x => x.headers.req_id === firstReq));
  h.text("再问"); await tick();
  const out = await send.execute("question", { chat: alice, message: "选哪个？", ending: "question" });
  assert.equal(h.ws.streams.at(-1).content, "💬选哪个？");
  assert.equal(h.ws.streams.at(-1).finish, true);
  assert.match(out.content[0].text, /已发送/);
  assert.equal(h.ws.sent.length, 0);
});

function controlledStreams(ws) {
  const calls = [];
  ws.streamReply = (call) => new Promise((resolve, reject) => calls.push({ ...call, reject, confirm: () => resolve({ errcode: 0 }) }));
  return calls;
}
test("A22 正文排队及换位ACK期间新增输入，正文始终使用最新位置", async (t) => {
  const h = await harness(t); await h.start();
  const calls = controlledStreams(h.ws);
  h.text("第一问", "alice", undefined, "first");
  const body = h.tools.get("wecombot-send").execute("queued", { chat: alice, message: "合并回答", ending: "done" });
  h.text("第二问", "alice", undefined, "second");
  h.text("第三问", "alice", undefined, "third");
  assert.equal(h.inputs.length, 3);
  calls[0].confirm(); await tick();
  assert.equal(calls[1].content, "我接着看。", "已排队正文不能抢先写入旧占位");
  calls[1].confirm(); await tick();
  assert.equal(calls[2].headers.req_id, "third", "合并尚未发出的过时建泡动作");
  assert.equal(calls[2].content, "处理中...");
  h.text("第四问", "alice", undefined, "fourth");
  calls[2].confirm(); await tick();
  assert.equal(calls[3].content, "我接着看。", "新占位ACK期间到达的输入也必须生效");
  calls[3].confirm(); await tick();
  assert.equal(calls[4].headers.req_id, "fourth");
  calls[4].confirm(); await tick();
  assert.equal(calls[5].content, "✅合并回答");
  assert.equal(calls[5].id, calls[4].id);
  assert.equal(calls[5].headers.req_id, "fourth");
  calls[5].confirm(); await body; await tick();
  assert.equal(calls.length, 7, "旧ending不能吞掉调用开始后新增输入的占位");
  assert.equal(calls[6].content, "处理中...");
  assert.equal(calls[6].headers.req_id, "fourth");
  calls[6].confirm(); await tick();
  assert.equal(h.ws.sent.length, 0);
});
test("A25 旧会话排队的换位动作不能关闭新会话的占位", async (t) => {
  const h = await harness(t); await h.start();
  const calls = controlledStreams(h.ws);
  h.text("旧输入", "alice", undefined, "old");
  h.text("旧排队输入", "alice", undefined, "old-queued");
  const newer = bind(h.root, "session-2"); await newer.start();
  newer.text("新输入", "alice", undefined, "new"); await tick();
  const current = calls[1];
  assert.equal(current.headers.req_id, "new");
  newer.text("新补充", "alice", undefined, "new-latest");
  calls[0].confirm(); await tick();
  assert.equal(calls.some(x => x.id === current.id && x.finish), false,
    "旧会话队列不能越过新会话正在等待的初始回执去关闭当前占位");
  for (const call of calls.slice(2)) call.confirm(); await tick();
  current.confirm(); await tick();
  const close = calls.find(x => x.id === current.id && x.finish);
  assert.equal(close.content, "我接着看。");
  close.confirm(); await tick();
  assert.equal(calls.at(-1).headers.req_id, "new-latest");
  calls.at(-1).confirm(); await tick();
  const sent = newer.tools.get("wecombot-send").execute("done", { chat: alice, message: "新回应", ending: "done" });
  await tick(); calls.at(-1).confirm(); await sent;
  assert.equal(calls.at(-1).content, "✅新回应");
  assert.equal(calls.at(-1).headers.req_id, "new-latest");
});
test("A25 换位关闭失败或新占位失败不丢输入，正文不重复且回执保真", async (t) => {
  for (const mode of ["old-close", "new-open"]) await t.test(mode, async (t) => {
    const h = await harness(t); await h.start();
    h.text("开始", "alice", undefined, "original"); await tick();
    h.ws.streamReply = async call => {
      if ((mode === "old-close" && call.content === "我接着看。") ||
          (mode === "new-open" && call.headers.req_id === "latest" && !call.finish))
        throw new Error("Reply ack timeout");
      return { errcode: 0 };
    };
    h.text("补充", "alice", undefined, "latest"); await tick();
    assert.equal(h.inputs.length, 2);
    const sent = await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "完整回答", ending: "done" });
    assert.match(sent.content[0].text, /正文已发送/);
    const bodies = [...h.ws.streams, ...h.ws.sent.map(x => ({ content: x.markdown?.content }))]
      .filter(x => x.content === "✅完整回答");
    assert.equal(bodies.length, 1);
    assert.equal(h.ws.sent.length, mode === "new-open" ? 1 : 0);
    if (mode === "old-close") assert.equal(bodies[0].headers.req_id, "latest");
  });
});

test("A25 换位回执期间取消准确报告正文未发送，新输入仍保留占位", async (t) => {
  const h = await harness(t); await h.start();
  const calls = controlledStreams(h.ws), controller = new AbortController();
  h.text("开始", "alice", undefined, "original");
  const pending = h.tools.get("wecombot-send").execute("cancel", { chat: alice, message: "不应发送", ending: "done" }, controller.signal);
  const rejected = assert.rejects(pending, /消息发送已取消\n正文未发送/);
  h.text("新补充", "alice", undefined, "latest");
  calls[0].confirm(); await tick();
  assert.equal(calls[1].content, "我接着看。");
  controller.abort();
  calls[1].confirm(); await tick();
  assert.equal(calls[2].headers.req_id, "latest");
  calls[2].confirm(); await rejected; await tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].finish, false);
  assert.equal(h.ws.sent.length, 0);
});

test("A24 重读continuation不主动改泡，已开始的换位保留文案快照", async (t) => {
  const h = await harness(t);
  const config = continuation => JSON.stringify({ bots: [{ botId: "bot", secret: "fixture-only" }], messages: { continuation } });
  await writeFile(join(h.root, "wecom-bot.json"), config("我接着弄。"));
  await h.start(); h.text("开始", "alice", undefined, "original"); await tick();
  const calls = controlledStreams(h.ws);
  h.text("补充1", "alice", undefined, "second"); await tick();
  assert.equal(calls[0].content, "我接着弄。");
  await writeFile(join(h.root, "wecom-bot.json"), config("我继续处理。"));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  assert.equal(calls.length, 1, "重读配置不主动改写或新建气泡");
  calls[0].confirm(); await tick(); calls[1].confirm(); await tick();
  h.text("补充2", "alice", undefined, "third"); await tick();
  assert.equal(calls[2].content, "我继续处理。");
  calls[2].confirm(); await tick(); calls[3].confirm(); await tick();
  assert.equal(h.inputs.length, 3);
});
test("A05 A06 快速回复等占位，正文确认后续开，不同 chat 独立且 ending 不吞新输入", async (t) => {
  const h = await harness(t); await h.start();
  const calls = controlledStreams(h.ws), send = h.tools.get("wecombot-send");
  h.text("开始");
  const progress = send.execute("fast", { chat: alice, message: "先查接口" });
  await tick(); assert.equal(calls.length, 1);
  calls[0].confirm(); await tick(); assert.equal(calls.length, 2);
  h.text("另一任务", "bob", "group"); await tick();
  assert.equal(calls.length, 3);
  const groupReq = calls[2].headers.req_id;
  calls[2].confirm(); calls[1].confirm(); await tick();
  assert.equal(calls.length, 4); assert.equal(calls[3].content, "处理中...");
  assert.equal(calls[3].headers.req_id, calls[0].headers.req_id);
  assert.notEqual(groupReq, calls[3].headers.req_id);
  calls[3].confirm(); await progress;
  const done = send.execute("done", { chat: alice, message: "交付", ending: "done" });
  await tick(); assert.equal(calls[4].content, "✅交付");
  h.text("新增要求");
  calls[4].confirm(); await done; await tick();
  assert.equal(calls[5].content, "处理中...");
  assert.notEqual(calls[5].headers.req_id, calls[4].headers.req_id);
  calls[5].confirm(); await tick();
  assert.equal(h.ws.sent.length, 0);
});

test("A07 虚拟三十分钟只在9/18/27分钟轮换，不调用模型且最终收尾", async (t) => {
  const h = await harness(t); await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  h.text("长任务"); await tick();
  for (let minute = 1; minute <= 30; minute++) {
    t.mock.timers.tick(60000); await tick();
    const renewals = h.ws.streams.filter(x => x.content === "任务仍在进行中。");
    assert.equal(renewals.length, Math.floor(minute / 9));
  }
  assert.equal(h.inputs.length, 1);
  await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "长任务完成", ending: "done" });
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["处理中...", false], ["任务仍在进行中。", true],
    ["处理中...", false], ["任务仍在进行中。", true],
    ["处理中...", false], ["任务仍在进行中。", true],
    ["处理中...", false], ["✅长任务完成", true],
  ]);
  t.mock.timers.tick(600000); await tick(); assert.equal(h.ws.streams.length, 8);
});

test("A08 占位失败不丢输入，正文成功后续开失败仍成功", async (t) => {
  const h = await harness(t); await h.start();
  h.ws.streamReply = async () => { throw { errcode: 400, errmsg: "placeholder denied" }; };
  h.text("任务"); await tick(); assert.equal(h.inputs.length, 1);
  await h.tools.get("wecombot-send").execute("fallback", { chat: alice, message: "完整结论", ending: "done" });
  assert.equal(h.ws.sent[0].markdown.content, "✅完整结论");
  h.ws.streamReply = undefined; h.text("新任务"); await tick();
  h.ws.streamReply = async call => { if (!call.finish) throw { errcode: 400, errmsg: "next denied" }; return { errcode: 0 }; };
  const out = await h.tools.get("wecombot-send").execute("progress", { chat: alice, message: "阶段事实" });
  assert.match(out.content[0].text, /正文已发送/);
  assert.equal(h.ws.streams.filter(x => x.content === "阶段事实").length, 1);
});

test("A09 流正文明确拒绝只降级一次，超时不重发且停用旧req_id", async (t) => {
  for (const mode of ["rejected", "timeout"]) await t.test(mode, async (t) => {
    const h = await harness(t); await h.start(); h.text("任务"); await tick();
    const req = h.ws.streams[0].headers.req_id;
    h.ws.streamReply = async () => { throw mode === "rejected" ? { errcode: 400, errmsg: "stream invalid" } : new Error("Reply ack timeout"); };
    const pending = h.tools.get("wecombot-send").execute("body", { chat: alice, message: "结论", ending: "done" });
    if (mode === "rejected") {
      assert.match((await pending).content[0].text, /已发送/);
      assert.deepEqual(h.ws.sent.map(x => x.markdown.content), ["✅结论"]);
    } else {
      await assert.rejects(pending, /Reply ack timeout.*\n正文发送未确认/);
      assert.equal(h.ws.sent.length, 0);
      const before = h.ws.streams.length;
      await h.tools.get("wecombot-send").execute("later", { chat: alice, message: "后续正文", ending: "question" });
      assert.equal(h.ws.streams.length, before, `不能复用不确定的 ${req}`);
      assert.deepEqual(h.ws.sent.map(x => x.markdown.content), ["💬后续正文"]);
    }
  });
});

test("A09 超过流字节上限保留完整正文，遗留占位可见中性结束", async (t) => {
  const h = await harness(t); await h.start(); h.text("长正文"); await tick();
  const message = "中".repeat(7000);
  await h.tools.get("wecombot-send").execute("long", { chat: alice, message, ending: "done" });
  assert.equal(h.ws.sent[0]?.markdown.content, "✅" + message);
  assert.ok(h.ws.streams.every(x => Buffer.byteLength(x.content) <= 20480));
  assert.equal(h.ws.streams.at(-1).finish, true);
  assert.match(h.ws.streams.at(-1).content, /占位已停止/);
});

test("A07 自然进展重置九分钟时钟，轮换未确认停用来源且不再开流", async (t) => {
  const h = await harness(t); await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  h.text("开始"); await tick();
  t.mock.timers.tick(8 * 60000); await tick();
  await h.tools.get("wecombot-send").execute("progress", { chat: alice, message: "进展" });
  t.mock.timers.tick(60000); await tick(); assert.equal(h.ws.streams.length, 3);
  h.ws.streamReply = async () => { throw new Error("Reply ack timeout"); };
  t.mock.timers.tick(8 * 60000); await tick();
  assert.equal(h.ws.streams.length, 4);
  assert.equal(h.ws.streams.at(-1).content, "任务仍在进行中。");
  t.mock.timers.tick(30 * 60000); await tick(); assert.equal(h.ws.streams.length, 4);
  await h.tools.get("wecombot-send").execute("final", { chat: alice, message: "结论", ending: "done" });
  assert.equal(h.ws.streams.length, 4);
  assert.equal(h.ws.sent[0].markdown.content, "✅结论");
});

test("A10 断线再认证与绑定替换后迟到占位ACK不续开，不复用旧回调", async (t) => {
  for (const mode of ["disconnect", "binding"]) await t.test(mode, async (t) => {
    const h = await harness(t); await h.start();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const calls = controlledStreams(h.ws);
    h.text("开始"); await tick();
    if (mode === "disconnect") { h.ws.emit("disconnected"); h.ws.emit("authenticated"); }
    else await bind(h.root, "session-1").start();
    calls[0].confirm(); await tick();
    t.mock.timers.tick(20 * 60000); await tick();
    assert.equal(calls.filter(x => !x.finish).length, 1);
    if (mode === "disconnect") assert.equal(calls.length, 1, "重连后不使用旧连接回调清理");
    h.ws.streamReply = undefined;
    const current = mode === "binding" ? bind(h.root, "session-1") : h;
    if (mode === "binding") await current.start();
    await current.tools.get("wecombot-send").execute("new", { chat: alice, message: "新回应", ending: "done" });
    assert.equal(h.ws.sent.at(-1)?.markdown.content, "✅新回应");
  });
});

test("A11 A13 idle后台维持占位，显式ending优先，提交结果自动重启且settled中性清理", async (t) => {
  const h = await harness(t); await h.start(); h.text("后台任务"); await tick();
  const task = await gatedJob(h);
  await h.tools.get("wecombot-send").execute("wait", { chat: alice, message: "结果出来后回来" });
  await h.events.get("agent_settled")?.({ aborted: false }, h.ctx); await tick();
  assert.equal(h.ws.streams.at(-1).content, "处理中...");
  await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "当前请求已交付", ending: "done" });
  await h.events.get("agent_settled")?.({ aborted: false }, h.ctx); await tick();
  assert.equal(h.ws.streams.at(-1).content, "✅当前请求已交付");
  await writeFile(join(h.root, "release"), "go");
  await until(() => taskEvents(h).length === 1); await tick();
  assert.equal(h.ws.streams.at(-1).content, "处理中...");
  await h.events.get("turn_start")({}, h.ctx);
  await h.events.get("agent_end")?.({}, h.ctx); await tick();
  assert.equal(h.ws.streams.at(-1).content, "处理中...");
  await h.events.get("agent_settled")?.({ aborted: false }, h.ctx); await tick();
  assert.equal(h.ws.streams.at(-1).content, "本轮运行已结束。");
  assert.ok(h.ws.streams.every(x => x.content !== "✅"));
});

test("A06 当前流保留原headers，续开使用最新输入回调", async (t) => {
  const h = await harness(t); await h.start();
  h.text("第一条", "alice", undefined, "original"); await tick();
  h.text("补充", "alice", undefined, "latest"); await tick();
  await h.tools.get("wecombot-send").execute("progress", { chat: alice, message: "进展" });
  assert.deepEqual(h.ws.streams.map(x => x.headers.req_id), ["original", "original", "latest", "latest", "latest"]);
  assert.deepEqual(h.ws.streams.map(x => x.content), ["处理中...", "我接着看。", "处理中...", "进展", "处理中..."]);
});

test("A10 new期间合法输入在新绑定投递并用其原回调占位", async (t) => {
  const h = await harness(t); await h.start(); h.text("/new");
  h.text("切换期间", "alice", undefined, "during-new");
  let newer;
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    newer = bind(h.root, "session-2"); await newer.start();
    await withSession({}); return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx); await tick();
  assert.equal(newer.inputs.length, 1);
  assert.equal(h.ws.streams.at(-1)?.headers.req_id, "during-new");
  assert.equal(h.ws.streams.at(-1)?.content, "处理中...");
});

test("A22 会话切换期间连续输入合并建泡，使用最新有效来源", async (t) => {
  const h = await harness(t); await h.start(); h.text("/new");
  h.text("切换时第一条", "alice", undefined, "during-first");
  h.text("切换时第二条", "alice", undefined, "during-latest");
  let newer;
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    newer = bind(h.root, "session-2"); await newer.start();
    await withSession({}); return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx); await tick();
  assert.equal(newer.inputs.length, 2);
  assert.deepEqual(h.ws.streams.map(x => [x.headers.req_id, x.content, x.finish]), [
    ["during-latest", "处理中...", false],
  ]);
});

test("A13 未下载完的媒体与已知待投递输入不会被settled提前关闭", async (t) => {
  const h = await harness(t); await h.start();
  let release;
  h.ws.download = () => new Promise(resolve => { release = resolve; });
  h.ws.emit("message.file", { headers: { req_id: "media-pending" }, body: {
    from: { userid: "alice" }, file: { url: "https://fixture/file" },
  } }); await tick();
  await h.events.get("agent_settled")({ aborted: false }, h.ctx); await tick();
  assert.equal(h.ws.streams.length, 1);
  release({ buffer: Buffer.from("file") }); await until(() => h.inputs.length === 1);
  h.ctx.hasPendingMessages = () => true;
  await h.events.get("agent_settled")({ aborted: false }, h.ctx); await tick();
  assert.equal(h.ws.streams.length, 1);
  h.ctx.hasPendingMessages = () => false;
  await h.events.get("turn_start")({}, h.ctx);
  await h.events.get("agent_settled")({ aborted: true }, h.ctx); await tick();
  assert.equal(h.ws.streams.at(-1).content, "本轮运行已中止。");
  assert.equal(h.ws.streams.at(-1).finish, true);
});

test("A01 A02 非法空媒体、精确new与终端事件不制造工作占位", async (t) => {
  const h = await harness(t); await h.start();
  await h.events.get("before_agent_start")({ systemPrompt: "terminal" }, h.ctx);
  await h.events.get("turn_start")({}, h.ctx);
  await h.events.get("agent_settled")({ aborted: false }, h.ctx);
  h.ws.emit("message.image", { headers: { req_id: "empty-image" }, body: { from: { userid: "alice" }, image: {} } });
  h.ws.emit("message.text", { headers: { req_id: "empty-text" }, body: { from: { userid: "alice" }, text: { content: "" } } });
  h.text("/new"); await tick();
  assert.equal(h.ws.streams.length, 0);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.inputs[0].content, "/wecombot-new");
});

test("A09 事件循环迟到导致流过期时走完整主动正文，24小时旧回调不再开流", async (t) => {
  const h = await harness(t); await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  h.text("开始"); await tick();
  // 只推进挂钟，模拟事件循环未及时执行续期，而非让轮换计时器先执行。
  t.mock.timers.setTime(11 * 60000 + 1000);
  await h.tools.get("wecombot-send").execute("late", { chat: alice, message: "迟到结论", ending: "done" });
  assert.deepEqual(h.ws.sent.map(x => x.markdown.content), ["✅迟到结论"]);
  assert.equal(h.ws.streams.length, 1);
  t.mock.timers.setTime(25 * 60 * 60000 + 1000);
  h.text("无新回调输入", "alice", undefined, null); await tick();
  assert.equal(h.ws.streams.length, 1);
});

test("A10 后续占位ACK期间取消停止轮换并保留正文成功", async (t) => {
  const h = await harness(t); await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  h.text("任务"); await tick();
  let confirm;
  h.ws.streamReply = call => call.finish ? Promise.resolve({ errcode: 0 }) : new Promise(resolve => { confirm = resolve; });
  const controller = new AbortController();
  const pending = h.tools.get("wecombot-send").execute("progress", { chat: alice, message: "阶段完成" }, controller.signal);
  await tick();
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [["处理中...",false],["阶段完成",true],["处理中...",false]]);
  controller.abort(); confirm({ errcode: 0 });
  const observed = await pending.then(value => ({ success: value.content[0].text }), err => ({ error: err.message }));
  h.ws.streamReply = undefined;
  t.mock.timers.tick(9 * 60000); await tick();
  assert.match(observed.error || "", /取消.*\n正文已发送/);
  assert.equal(h.ws.streams.filter(x => x.content === "任务仍在进行中。").length, 0);
});

test("A10 超限中性清理期间取消准确报告正文未发送", async (t) => {
  const h = await harness(t); await h.start(); h.text("长正文"); await tick();
  let confirm;
  h.ws.streamReply = () => new Promise(resolve => { confirm = resolve; });
  const controller = new AbortController();
  const pending = h.tools.get("wecombot-send").execute("long", { chat: alice, message: "中".repeat(7000), ending: "done" }, controller.signal);
  await tick();
  assert.equal(h.ws.streams.at(-1).content, "本轮占位已停止。");
  controller.abort(); confirm({ errcode: 0 });
  const observed = await pending.then(value => ({ success: value.content[0].text }), err => ({ error: err.message }));
  assert.match(observed.error || "", /取消.*\n正文未发送/);
  assert.equal(h.ws.sent.length, 0);
});

test("A10 旧代媒体下载不维持新会话已settled的占位", async (t) => {
  const h = await harness(t); await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let release;
  h.ws.download = () => new Promise(resolve => { release = resolve; });
  h.ws.emit("message.image", { headers: { req_id: "old-media" }, body: {
    from: { userid: "alice" }, image: { url: "https://fixture/image" },
  } }); await tick();
  const newer = bind(h.root, "session-2"); await newer.start();
  newer.text("新会话输入", "alice", undefined, "new-text"); await tick();
  await newer.events.get("turn_start")({}, newer.ctx);
  await newer.events.get("agent_settled")({ aborted: false }, newer.ctx); await tick();
  release({ buffer: Buffer.from("old image") }); await tick(); await tick();
  t.mock.timers.tick(9 * 60000); await tick();
  const currentStreams = h.ws.streams.filter(x => x.headers.req_id === "new-text");
  assert.equal(currentStreams.filter(x => x.content === "任务仍在进行中。").length, 0);
  assert.equal(currentStreams.at(-1)?.finish, true);
});

test("A10 new排队输入的旧回调不在重连后复活", async (t) => {
  const h = await harness(t); await h.start(); h.text("/new");
  h.text("切换期间的输入", "alice", undefined, "pre-disconnect");
  h.ws.emit("disconnected"); h.ws.emit("authenticated");
  let newer;
  h.ctx.newSession = async ({ withSession }) => {
    await h.events.get("session_shutdown")({}, h.ctx);
    newer = bind(h.root, "session-2"); await newer.start();
    await withSession({}); return { cancelled: false };
  };
  await h.commands.get("wecombot-new").handler("", h.ctx); await tick();
  assert.equal(newer.inputs.length, 1, "输入仍须投递给Pi");
  assert.equal(h.ws.streams.filter(x => x.headers.req_id === "pre-disconnect").length, 0);
});


test("A16 Agent仍只需原四工具，发送参数保留chat/message/ending", async (t) => {
  const h = await harness(t);
  assert.deepEqual([...h.tools.keys()].sort(), ["wecombot-attach", "wecombot-send", "wecombot-start", "wecombot-task"]);
  const send = h.tools.get("wecombot-send");
  assert.deepEqual(Object.keys(send.parameters.properties).sort(), ["chat", "ending", "message"]);
  assert.deepEqual(send.parameters.required, ["chat", "message"]);
  const prompt = (await h.events.get("before_agent_start")({ systemPrompt: "base" }, h.ctx)).systemPrompt;
  assert.match(prompt, /多步任务先调用 wecombot-send/);
  assert.match(prompt, /配置的收尾前缀与正文合并发送/);
  assert.doesNotMatch(prompt + send.description, /✅|💬/);
  assert.doesNotMatch(prompt + send.description, /streamId|req_id|heartbeat|计时器|9 分钟|独立发送 ✅/);
});

test("配置文案贯穿首次占位、进展接续和两种收尾的流式及主动正文", async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({
    bots: [{ botId: "bot", secret: "secret" }],
    messages: { working: "排查中...", donePrefix: "[完成] ", questionPrefix: "[提问] " },
  }));
  await h.start(); h.text("开始"); await tick();
  const send = h.tools.get("wecombot-send");
  await send.execute("progress", { chat: alice, message: "关键事实" });
  await send.execute("question", { chat: alice, message: "选哪个？", ending: "question" });
  h.text("继续"); await tick();
  await send.execute("done", { chat: alice, message: "交付", ending: "done" });
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["排查中...", false], ["关键事实", true], ["排查中...", false], ["[提问] 选哪个？", true],
    ["排查中...", false], ["[完成] 交付", true],
  ]);
  h.text("无回调", "bob", undefined, null);
  const bob = JSON.stringify(["bot", "single", "bob"]);
  await send.execute("active-done", { chat: bob, message: "主动结论", ending: "done" });
  await send.execute("active-question", { chat: bob, message: "主动提问", ending: "question" });
  assert.deepEqual(h.ws.sent.map(x => [x.chatid, x.markdown.content]), [
    ["bob", "[完成] 主动结论"], ["bob", "[提问] 主动提问"],
  ]);
});

test("文案逐字段校验、部分配置与显式空前缀保留", async (t) => {
  const cases = [
    { messages: { working: " \n\t", donePrefix: 42, questionPrefix: "问：" }, expected: ["处理中...", "✅结论", "问：问题"] },
    { messages: { working: "中".repeat(6827), donePrefix: false, questionPrefix: null }, expected: ["处理中...", "✅结论", "💬问题"] },
    { messages: { working: "排查中", donePrefix: "", questionPrefix: " " }, expected: ["排查中", "结论", " 问题"] },
    { messages: { donePrefix: "完成：" }, expected: ["处理中...", "完成：结论", "💬问题"] },
    { messages: { working: "", donePrefix: "a".repeat(20481), questionPrefix: "💬".repeat(5121) }, expected: ["处理中...", "✅结论", "💬问题"] },
    ...[null, [], true, "bad"].map(messages => ({ messages, expected: ["处理中...", "✅结论", "💬问题"] })),
  ];
  for (const [i, { messages, expected }] of cases.entries()) await t.test(String(i), async (t) => {
    const h = await harness(t);
    await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages }));
    await h.start(); h.text("开始"); await tick();
    const send = h.tools.get("wecombot-send");
    await send.execute("done", { chat: alice, message: "结论", ending: "done" });
    h.text("问题"); await tick();
    await send.execute("question", { chat: alice, message: "问题", ending: "question" });
    assert.deepEqual([h.ws.streams[0].content, ...h.ws.streams.filter(x => x.finish).map(x => x.content)], expected);
    assert.equal(h.inputs.length, 2, "无效文案不丢弃合法Bot的输入");
  });
});

test("Bot添加删除保存时保留原始messages与其他顶层字段", async (t) => {
  const h = await harness(t);
  const messages = { working: "检查中...", donePrefix: "", continuation: "我接着弄。", unknownFutureOption: { retained: true } };
  const customMeta = { future: true };
  const path = join(h.root, "wecom-bot.json");
  await writeFile(path, JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages, customMeta }));
  await h.start();
  const inputs = ["第二个机器人", "bot2", "secret2"];
  h.ctx.ui.input = async () => inputs.shift();
  await h.commands.get("wecombot-add").handler("", h.ctx);
  let saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.messages, messages);
  assert.deepEqual(saved.customMeta, customMeta);
  assert.equal(saved.bots.length, 2);
  h.ctx.ui.input = async () => "bot2";
  await h.commands.get("wecombot-remove").handler("", h.ctx);
  saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.messages, messages, "不能写入默认questionPrefix覆盖用户的部分配置");
  assert.deepEqual(saved.customMeta, customMeta);
  assert.deepEqual(saved.bots, [{ botId: "bot", secret: "secret" }]);
  h.ws = clients.at(-1);
  h.text("使用保留设置"); await tick();
  assert.equal(h.ws.streams[0].content, "检查中...");
  await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "完成", ending: "done" });
  assert.equal(h.ws.streams.at(-1).content, "完成");
});

test("自定义工作文案用于九分钟轮换的新占位", async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({
    bots: [{ botId: "bot", secret: "secret" }], messages: { working: "检查中..." },
  }));
  await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  h.text("长任务"); await tick();
  t.mock.timers.tick(9 * 60000); await tick();
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["检查中...", false], ["任务仍在进行中。", true], ["检查中...", false],
  ]);
  assert.equal(h.inputs.length, 1, "轮换不唤醒模型");
  await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "完成", ending: "done" });
});

test("自定义工作文案用于显式收尾后的后台结果接续", async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({
    bots: [{ botId: "bot", secret: "secret" }], messages: { working: "后台处理中...", donePrefix: "完成：" },
  }));
  await h.start(); h.text("后台任务"); await tick();
  await gatedJob(h);
  await h.tools.get("wecombot-send").execute("done", { chat: alice, message: "当前回应已交付", ending: "done" });
  await writeFile(join(h.root, "release"), "go");
  await until(() => taskEvents(h).length === 1); await tick();
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["后台处理中...", false], ["完成：当前回应已交付", true], ["后台处理中...", false],
  ]);
  assert.notEqual(h.ws.streams[0].id, h.ws.streams[2].id);
  await h.tools.get("wecombot-send").execute("result", { chat: alice, message: "后台结果", ending: "done" });
  assert.equal(h.ws.streams.at(-1).content, "完成：后台结果");
});

test("明确拒绝降级仍保留配置前缀，拼接后超限正文完整主动发送", async (t) => {
  for (const mode of ["refused", "combined-limit"]) await t.test(mode, async (t) => {
    const h = await harness(t), prefix = mode === "refused" ? "完成：" : "a".repeat(20480);
    await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({
      bots: [{ botId: "bot", secret: "secret" }],
      messages: { working: mode === "refused" ? "处理中..." : "w".repeat(20480), donePrefix: prefix },
    }));
    await h.start(); h.text("任务"); await tick();
    if (mode === "refused") h.ws.streamReply = async call => {
      if (call.content === "完成：x") throw { errcode: 400, errmsg: "stream invalid" };
      return { errcode: 0 };
    };
    const out = await h.tools.get("wecombot-send").execute("body", { chat: alice, message: "x", ending: "done" });
    assert.match(out.content[0].text, /正文已发送/);
    assert.deepEqual(h.ws.sent.map(x => x.markdown.content), [prefix + "x"]);
    assert.ok(h.ws.streams.every(x => Buffer.byteLength(x.content) <= 20480));
    if (mode === "combined-limit") assert.equal(Buffer.byteLength(h.ws.sent[0].markdown.content), 20481);
  });
});

test("工作期间list重读文案不重连，后续占位和新调用使用新配置，已发请求不改写", async (t) => {
  const h = await harness(t); await h.start(); h.text("正在执行的任务"); await tick();
  const clientCount = clients.length, calls = controlledStreams(h.ws);
  const send = h.tools.get("wecombot-send"), path = join(h.root, "wecom-bot.json");
  const progress = send.execute("progress", { chat: alice, message: "第一项事实" });
  await tick();
  assert.deepEqual(calls.map(x => [x.content, x.finish]), [["第一项事实", true]]);
  await writeFile(path, JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages: {
    working: "新工作文案A", donePrefix: "完成A：", questionPrefix: "提问A：",
  } }));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  assert.equal(clients.length, clientCount);
  assert.equal(h.inputs.length, 1, "读取配置不触发模型新回合");
  assert.equal(calls.length, 1, "读取配置不主动刷新已显示气泡");
  calls[0].confirm(); await tick();
  assert.deepEqual(calls.map(x => [x.content, x.finish]), [["第一项事实", true], ["新工作文案A", false]]);
  calls[1].confirm(); await progress;
  const done = send.execute("done", { chat: alice, message: "结论1", ending: "done" });
  await tick(); assert.equal(calls[2].content, "完成A：结论1");
  await writeFile(path, JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages: {
    working: "新工作文案B", donePrefix: "完成B：", questionPrefix: "提问B：",
  } }));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  assert.equal(calls[2].content, "完成A：结论1", "已发出的正文等待ACK时保留原前缀");
  calls[2].confirm(); await done;
  h.text("新的提问"); await tick();
  assert.equal(calls[3].content, "新工作文案B");
  calls[3].confirm(); await tick();
  const question = send.execute("question", { chat: alice, message: "要继续吗？", ending: "question" });
  await tick(); assert.equal(calls[4].content, "提问B：要继续吗？");
  calls[4].confirm(); await question;
  assert.equal(clients.length, clientCount);
  assert.equal(h.inputs.length, 2);
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["处理中...", false], ["第一项事实", true], ["新工作文案A", false],
    ["完成A：结论1", true], ["新工作文案B", false], ["提问B：要继续吗？", true],
  ]);
});

test("list重读在九分钟轮换中使用新工作文案，显式空前缀立即用于新收尾", async (t) => {
  const h = await harness(t); await h.start();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  h.text("仍在工作的长任务"); await tick();
  const first = h.ws.streams[0], clientCount = clients.length;
  t.mock.timers.tick(8 * 60000); await tick();
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({
    bots: [{ botId: "bot", secret: "secret" }],
    messages: { working: "更新后的工作文案", donePrefix: "", questionPrefix: "" },
  }));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [["处理中...", false]],
    "命令不刷新已存在的占位，也不重置它的首次发送时间");
  t.mock.timers.tick(60000); await tick();
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["处理中...", false], ["任务仍在进行中。", true], ["更新后的工作文案", false],
  ]);
  assert.equal(h.ws.streams[1].id, first.id);
  assert.notEqual(h.ws.streams[2].id, first.id);
  assert.equal(h.inputs.length, 1, "读取配置和轮换均不触发模型回合");
  assert.equal(clients.length, clientCount);
  const send = h.tools.get("wecombot-send");
  await send.execute("done", { chat: alice, message: "长任务结果", ending: "done" });
  assert.equal(h.ws.streams.at(-1).content, "长任务结果");
  assert.equal(h.ws.streams.at(-1).finish, true);
  h.text("需要用户选择"); await tick();
  assert.equal(h.ws.streams.at(-1).content, "更新后的工作文案");
  await send.execute("question", { chat: alice, message: "要继续吗？", ending: "question" });
  assert.equal(h.ws.streams.at(-1).content, "要继续吗？");
  const count = h.ws.streams.length;
  t.mock.timers.tick(18 * 60000); await tick();
  assert.equal(h.ws.streams.length, count, "空前缀不改变ending停止轮换的语义");
});

test("list重读部分配置和无效字段按项回退，主动正文保持新前缀并可恢复默认", async (t) => {
  const h = await harness(t); await h.start(); h.text("无回调的既有聊天", "alice", undefined, null);
  const path = join(h.root, "wecom-bot.json"), send = h.tools.get("wecombot-send"), clientCount = clients.length;
  const partial = JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages: { donePrefix: "已完成：" } });
  await writeFile(path, partial);
  await h.commands.get("wecombot-list").handler("", h.ctx);
  assert.equal(await readFile(path, "utf8"), partial, "查询命令不重写配置文件");
  await send.execute("done1", { chat: alice, message: "第一项", ending: "done" });
  await send.execute("question1", { chat: alice, message: "问题1", ending: "question" });
  await writeFile(path, JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages: {
    working: "   ", donePrefix: "", questionPrefix: false,
  } }));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  await send.execute("done2", { chat: alice, message: "第二项", ending: "done" });
  await send.execute("question2", { chat: alice, message: "问题2", ending: "question" });
  await writeFile(path, JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }] }));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  await send.execute("done3", { chat: alice, message: "第三项", ending: "done" });
  await send.execute("question3", { chat: alice, message: "问题3", ending: "question" });
  assert.deepEqual(h.ws.sent.map(x => [x.chatid, x.markdown.content]), [
    ["alice", "已完成：第一项"], ["alice", "💬问题1"], ["alice", "第二项"],
    ["alice", "💬问题2"], ["alice", "✅第三项"], ["alice", "💬问题3"],
  ]);
  assert.equal(h.ws.streams.length, 0, "无有效回调不会因重读配置伪造工作占位");
  assert.equal(clients.length, clientCount);
  assert.equal(h.inputs.length, 1);
});

test("重读前已排队的调用保留旧前缀，重读后开始的调用采用新配置", async (t) => {
  const h = await harness(t); await h.start(); h.text("开始工作"); await tick();
  const calls = controlledStreams(h.ws), send = h.tools.get("wecombot-send");
  const progress = send.execute("progress", { chat: alice, message: "第一阶段" });
  await tick(); assert.equal(calls[0].content, "第一阶段");
  const queued = send.execute("queued", { chat: alice, message: "已排队的结论", ending: "done" });
  await tick(); assert.equal(calls.length, 1, "第二调用尚未发往SDK，正等前一正文ACK");
  await writeFile(join(h.root, "wecom-bot.json"), JSON.stringify({ bots: [{ botId: "bot", secret: "secret" }], messages: {
    working: "重读后的工作文案", donePrefix: "新完成：", questionPrefix: "新提问：",
  } }));
  await h.commands.get("wecombot-list").handler("", h.ctx);
  assert.equal(calls.length, 1);
  calls[0].confirm(); await tick();
  assert.equal(calls[1].content, "重读后的工作文案", "重读后新开的气泡使用新文案");
  calls[1].confirm(); await progress; await tick();
  assert.equal(calls[2].content, "✅已排队的结论", "重读不改写此前已开始的调用");
  assert.equal(calls[1].id, calls[2].id);
  calls[2].confirm(); await queued;
  h.text("重读后新的请求"); await tick();
  calls[3].confirm(); await tick();
  const afterReload = send.execute("after-reload", { chat: alice, message: "新结论", ending: "done" });
  await tick(); assert.equal(calls[4].content, "新完成：新结论");
  calls[4].confirm(); await afterReload;
  assert.deepEqual(h.ws.streams.map(x => [x.content, x.finish]), [
    ["处理中...", false], ["第一阶段", true], ["重读后的工作文案", false],
    ["✅已排队的结论", true], ["重读后的工作文案", false], ["新完成：新结论", true],
  ]);
});
