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
    text(content, user = "alice", chatid) {
      this.ws.emit("message.text", {
        headers: { req_id: Math.random().toString() },
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
  h.text("/wecombot-disable", "alice");
  h.text("hello", "bob", "group-1");
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

test("当前来源 Bot 向指定群聊按顺序发送独立文本和文件，成功等待最后回执", async (t) => {
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
  assert.equal(h.ws.sent.length, 1);
  gate.release();
  const attached = await pending;
  await h.tools.get("wecombot-send").execute("after", { chat, message: "after" });
  assert.deepEqual(attached.details.sent, [first, second]);
  assert.deepEqual(h.ws.uploads, [
    { buffer: Buffer.from("report"), type: "file", filename: "report.txt" },
    { buffer: Buffer.from([0, 1, 127, 255]), type: "file", filename: "build.hap" },
  ]);
  assert.deepEqual(h.ws.sent, [
    { chatid: "group-2", msgtype: "markdown", markdown: { content: "before" } },
    { chatid: "group-2", msgtype: "file", file: { media_id: "media-1" } },
    { chatid: "group-2", msgtype: "file", file: { media_id: "media-2" } },
    { chatid: "group-2", msgtype: "markdown", markdown: { content: "after" } },
  ]);
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

test("done/question 正文成功后独立发送对应 emoji，最后回执前不成功", async (t) => {
  for (const [ending, emoji] of [["done", "✅"], ["question", "💬"]]) await t.test(ending, async (t) => {
    const h = await harness(t);
    await h.start();
    h.text("result", "bob", "group-1");
    const calls = controlledSend(h.ws);
    let finished = false;
    const pending = h.tools.get("wecombot-send").execute("send", {
      chat: JSON.stringify(["bot", "group", "group-1"]), message: "正文", ending,
    }).then((value) => { finished = true; return value; });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].markdown.content, "正文");
    await tick();
    assert.equal(finished, false);
    assert.equal(calls.length, 1);
    calls[0].confirm();
    await tick();
    assert.equal(finished, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].chatid, calls[0].chatid);
    assert.deepEqual(calls[1].markdown, { content: emoji });
    assert.equal(calls[1].msgtype, "markdown");
    calls[1].confirm();
    const sent = await pending;
    assert.equal(finished, true);
    assert.match(sent.content[0].text, /正文已发送；收尾标记已发送/);
  });
});

test("正文拒绝或回执超时均不发送 emoji，保留原始错误", async (t) => {
  for (const reason of [{ errcode: 500, errmsg: "blocked" }, new Error("Reply ack timeout")]) await t.test(String(reason.errmsg || reason.message), async (t) => {
    const h = await harness(t);
    await h.start(); h.text("result");
    const calls = controlledSend(h.ws);
    const pending = h.tools.get("wecombot-send").execute("send", { chat: alice, message: "正文", ending: "done" });
    calls[0].reject(reason);
    await assert.rejects(pending, (err) => /正文发送未确认/.test(err.message)
      && /收尾标记未发送/.test(err.message)
      && /blocked|Reply ack timeout/.test(err.message));
    assert.equal(calls.length, 1);
  });
});

test("emoji 失败或未确认保留正文成功，单独重试不重发正文", async (t) => {
  for (const reason of [{ errcode: 400, errmsg: "denied" }, new Error("Reply ack timeout")]) await t.test(String(reason.errmsg || reason.message), async (t) => {
    const h = await harness(t);
    await h.start(); h.text("result");
    const calls = controlledSend(h.ws), send = h.tools.get("wecombot-send");
    const pending = send.execute("send", { chat: alice, message: "正文", ending: "question" });
    calls[0].confirm(); await tick(); calls[1].reject(reason);
    await assert.rejects(pending, (err) => /正文已发送/.test(err.message)
      && /收尾标记发送未确认/.test(err.message) && /denied|Reply ack timeout/.test(err.message));
    assert.equal(calls.length, 2);
    const retry = send.execute("retry", { chat: alice, message: "💬" });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].markdown.content, "💬");
    calls[2].confirm(); await retry;
    assert.equal(calls.length, 3);
  });
});

test("正文等待期间取消、new、Pi 绑定和连接变化会停止 emoji，保留迟到成功回执", async (t) => {
  for (const change of ["cancel", "new", "binding", "connection", "disconnect"]) await t.test(change, async (t) => {
    const h = await harness(t);
    await h.start(); h.text("result");
    const old = h.ws, calls = controlledSend(old), controller = new AbortController();
    const pending = h.tools.get("wecombot-send").execute("send", {
      chat: alice, message: "正文", ending: "done",
    }, controller.signal);
    if (change === "cancel") controller.abort();
    if (change === "new") h.text("/new");
    if (change === "binding") await bind(h.root, "session-1").start();
    if (change === "connection") {
      await h.commands.get("wecombot-disable").handler("", h.ctx);
      await h.commands.get("wecombot-enable").handler("", h.ctx);
    }
    if (change === "disconnect") old.emit("disconnected");
    calls[0].confirm();
    await assert.rejects(pending, (err) => /取消|失效|连接已变化/.test(err.message)
      && /正文已发送/.test(err.message) && /收尾标记未发送/.test(err.message));
    assert.equal(calls.length, 1);
    assert.equal(old.sent.length, 1);
    if (change === "connection") assert.equal(clients.at(-1).sent.length, 0);
  });
});

test("发送前取消或切换失效的调用不发送正文，emoji 请求发出后的取消不抹掉回执", async (t) => {
  const h = await harness(t);
  await h.start(); h.text("result");
  const controller = new AbortController(); controller.abort();
  const send = h.tools.get("wecombot-send");
  await assert.rejects(send.execute("cancelled", { chat: alice, message: "正文", ending: "done" }, controller.signal), /取消.*\n正文未发送\n收尾标记未发送/);
  assert.equal(h.ws.sent.length, 0);
  const calls = controlledSend(h.ws), later = new AbortController();
  const pending = send.execute("send", { chat: alice, message: "正文", ending: "done" }, later.signal);
  calls[0].confirm(); await tick(); later.abort(); calls[1].confirm();
  assert.match((await pending).content[0].text, /收尾标记已发送/);
  h.text("/new");
  await assert.rejects(send.execute("old", { chat: alice, message: "正文" }), /会话已失效.*\n正文未发送/);
  assert.equal(calls.length, 2);
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
