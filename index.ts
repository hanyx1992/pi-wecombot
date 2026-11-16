import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { WSClient } from "aibot-node-sdk";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Bot {
  botId: string;
  secret: string;
  name?: string;
}
interface Chat {
  botId: string;
  target: string;
}
interface Binding {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}
interface Incoming {
  chat: string;
  text: string;
}
interface Switching {
  chat: string;
  started: boolean;
  pending: Incoming[];
}
interface Task {
  id: string;
  description: string;
  sessionId: string;
  command: string;
  cwd: string;
  chat: string;
  logPath: string;
  status: "running" | "exited" | "failed";
  process: ChildProcess;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  delivery: "pending" | "preparing" | "submitted";
  deliveryError?: string;
}
interface State {
  bots: Bot[];
  loaded: boolean;
  activeBotId?: string;
  enabled: boolean;
  ws?: WSClient;
  connected: boolean;
  chats: Map<string, Chat>;
  binding?: Binding;
  epoch: number;
  switching?: Switching;
  tasks: Map<string, Task>;
}
const result = (text: string, details = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const error = (err: unknown) =>
  err instanceof Error
    ? err.message
    : typeof err === "object" && err !== null
      ? JSON.stringify(err)
      : String(err);
const PROMPT = `
[wecombot] 终端消息照常回复。企微消息须沿用来源 chat；输出正文对用户不可见，想让用户看到必须调 wecombot-send（发消息不结束任务）。

像技术同事在企微打字那样边做边聊：短句直说、一次一件事，通常几句话说完，别写成带标题分点的长报告，不堆表情寒暄。
- 简单问题直接答；多步任务先调用 wecombot-send，简短确认收到并说明第一步，省略 ending，再调用其他工具。
- 边查边同步：每确认一个关键事实、转向、阻塞或阶段产物，就先发一两句再查下一项（讲清结果、影响和下一步，不报流水账或空泛状态），别攒到最后连发。
- 只有需要用户决定、暂时只能等待后台任务或最终交付时才结束本轮：拍板问题问清后停下等回复；收到补充要求先回应其内容再调整；最终只发结论和关键结果，细节等追问或改发文件，不机械拆条、不重复总结。

wecombot-send 最终交付填 ending:"done"，需要用户回答或决定填 ending:"question"；扩展在正文成功后独立发送 ✅／💬，正文不要手动追加同一收尾 emoji。尚会自主继续或只等后台结果时省略 ending，等待时自然说明结果出来后会回来。done 只标记当前所回应请求已交付，正文仍须如实说明结果与限制；question 不取消其他已授权工作。

用 wecombot-attach 独立发送本地文件，以回执为准，失败或“发送未确认”如实说明。编译等长命令用 wecombot-start 后台启动并填写简短用途 description，以继续响应新消息；完成事件会唤醒当前 Pi，结合原请求与日志接续并向原 chat 汇报，查状态或日志时调 wecombot-task 核实。精确 /new 由扩展处理并保留后台任务；跨会话的旧任务结果只汇报，可读现有日志，不自动修改代码、重跑或恢复旧工作，继续须由用户在新会话提出要求。`;

export default function (pi: ExtensionAPI) {
  const root =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const config = join(root, "wecom-bot.json");
  const key = Symbol.for(`pi-wecombot:${root}`);
  const cache = globalThis as unknown as Record<symbol, State | undefined>;
  const state: State = cache[key] ?? {
    bots: [],
    loaded: false,
    enabled: true,
    connected: false,
    chats: new Map(),
    epoch: 0,
    tasks: new Map(),
  };
  if (!cache[key]) {
    cache[key] = state;
    process.once("exit", () => {
      for (const task of state.tasks.values())
        if (task.status === "running" && task.process.pid) {
          try {
            process.kill(-task.process.pid, "SIGKILL");
          } catch {}
        }
    });
  }

  async function load() {
    try {
      state.bots =
        (JSON.parse(await readFile(config, "utf8")) as { bots: Bot[] }).bots ||
        [];
    } catch {
      state.bots = [];
    }
  }
  async function save() {
    await mkdir(root, { recursive: true });
    await writeFile(
      config,
      JSON.stringify({ bots: state.bots }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  function status() {
    state.binding?.ctx.ui.setStatus(
      "wecombot",
      state.connected ? `企微 ✅ ${state.chats.size}` : "",
    );
  }
  function disconnect() {
    const ws = state.ws;
    state.ws = undefined;
    state.connected = false;
    ws?.disconnect();
    status();
  }
  function connect(bot: Bot) {
    if (state.ws && state.activeBotId === bot.botId) return;
    disconnect();
    state.activeBotId = bot.botId;
    const ws = new WSClient({ botId: bot.botId, secret: bot.secret });
    state.ws = ws;
    ws.on("authenticated", () => {
      if (state.ws !== ws) return;
      state.connected = true;
      status();
    });
    ws.on("disconnected", () => {
      if (state.ws !== ws) return;
      state.connected = false;
      status();
    });
    ws.on("error", (err) => {
      if (state.ws !== ws) return;
      console.error("[wecombot]", error(err));
    });
    function source(frame: any): string | undefined {
      if (state.ws !== ws) return;
      const kind = frame.body?.chattype === "group" ? "group" : "single";
      const target =
        kind === "group" ? frame.body?.chatid : frame.body?.from?.userid;
      if (!target) return;
      const chat = JSON.stringify([bot.botId, kind, target]);
      state.chats.set(chat, { botId: bot.botId, target });
      status();
      return chat;
    }
    ws.on("message.text", (frame) => {
      const chat = source(frame);
      const text = frame.body?.text?.content;
      if (chat && text) receive(chat, text, true);
    });
    ws.on("message.voice", (frame) => {
      const chat = source(frame);
      if (chat && frame.body?.voice?.content)
        receive(chat, frame.body.voice.content);
    });
    async function media(
      frame: any,
      kind: "image" | "file" | "video" | "mixed",
    ) {
      const chat = source(frame);
      if (!chat) return;
      const epoch = state.epoch;
      const current = () => state.ws === ws && state.epoch === epoch;
      const items =
        kind === "mixed"
          ? frame.body?.mixed?.msg_item || []
          : [{ msgtype: kind, [kind]: frame.body?.[kind] }];
      const parts: string[] = [];
      for (const item of items) {
        if (item.msgtype === "text" && item.text?.content) {
          parts.push(item.text.content);
          continue;
        }
        const data = item[item.msgtype];
        if (!data?.url) continue;
        try {
          const { buffer, filename } = await ws.downloadFile(
            data.url,
            data.aeskey,
          );
          if (!current()) return;
          const folder = join(root, "tmp", "wecom-bot");
          await mkdir(folder, { recursive: true });
          const label =
            item.msgtype === "image"
              ? "图片"
              : item.msgtype === "video"
                ? "视频"
                : "文件";
          const path = join(
            folder,
            `${randomUUID()}-${basename(filename || data.filename || item.msgtype)}`,
          );
          await writeFile(path, buffer);
          parts.push(`${label}: ${path}`);
        } catch (err) {
          parts.push(`${item.msgtype} 下载失败: ${error(err)} (${data.url})`);
        }
      }
      if (current() && parts.length) receive(chat, parts.join("\n"));
    }
    for (const kind of ["image", "file", "video", "mixed"] as const) {
      ws.on(`message.${kind}`, (frame) => {
        void media(frame, kind).catch((err) =>
          console.error("[wecombot] 收媒体失败:", error(err)),
        );
      });
    }
    ws.on("event.enter_chat", (frame) => {
      if (state.ws === ws)
        void ws
          .replyWelcome(frame, {
            msgtype: "text",
            text: { content: `你好！我是 ${bot.name || "AI"} 助手。` },
          })
          .catch((err) =>
            console.error("[wecombot] 欢迎消息失败:", error(err)),
          );
    });
    ws.connect();
  }

  function deliver(input: Incoming) {
    state.binding?.pi.sendMessage(
      {
        customType: "wecombot",
        content: `[wecombot chat=${input.chat}]\n${input.text}`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
  function receive(chat: string, text: string, allowNew = false) {
    if (!state.binding && !state.switching) {
      void send(chat, "Pi会话不可用，请重启Pi；本条输入未处理。").catch(
        (err) => {
          console.error("[wecombot] 无可用Pi会话的通知失败:", error(err));
        },
      );
      return;
    }
    if (allowNew && text === "/new") {
      if (state.switching) return;
      const active = state.binding;
      if (!active) return;
      state.epoch++;
      state.switching = { chat, started: false, pending: [] };
      active.pi.sendUserMessage("/wecombot-new", {
        deliverAs: "steer",
        expandPromptTemplates: true,
      });
      return;
    }
    if (state.switching) state.switching.pending.push({ chat, text });
    else deliver({ chat, text });
  }
  async function finishSwitch(switching: Switching, message: string) {
    try {
      const notice = state.binding
        ? message
        : `${message}\nPi会话不可用，请重启Pi；切换期间的输入未处理。`;
      await send(switching.chat, notice);
    } catch (err) {
      console.error("[wecombot] 会话切换通知失败:", error(err));
    }
    if (state.switching !== switching) return;
    state.switching = undefined;
    if (!state.binding) return;
    for (const input of switching.pending) deliver(input);
    dispatchTasks();
  }
  pi.registerCommand("wecombot-new", {
    description: "由企微精确 /new 触发干净会话",
    handler: async (_args, ctx) => {
      const switching = state.switching;
      if (!switching || switching.started || state.binding?.pi !== pi) return;
      switching.started = true;
      try {
        const outcome = await ctx.newSession({
          withSession: async () => {
            await finishSwitch(switching, "已开启新会话；后台任务继续运行。");
          },
        });
        if (outcome.cancelled)
          await finishSwitch(switching, "新会话切换已取消。");
      } catch (err) {
        await finishSwitch(switching, `新会话切换失败: ${error(err)}`);
      }
    },
  });

  async function send(chat: string, message: string) {
    const source = state.chats.get(chat);
    if (!source) throw new Error("未知企微聊天标识");
    if (!state.ws || !state.connected || source.botId !== state.activeBotId)
      throw new Error("来源机器人未连接");
    try {
      await state.ws.sendMessage(source.target, {
        msgtype: "markdown",
        markdown: { content: message },
      });
    } catch (err) {
      throw new Error(`企微发送失败: ${error(err)}`);
    }
  }

  pi.registerTool({
    name: "wecombot-send",
    label: "发送企微消息",
    description:
      "向来源 chat 发送 Markdown 正文，等待企微回执。最终交付用 ending:done，需要用户答复用 question；正文成功后扩展独立发送 ✅/💬，正文勿重复追加。继续工作或等待后台时省略 ending。",
    parameters: Type.Object({
      chat: Type.String(),
      message: Type.String(),
      ending: Type.Optional(
        Type.Union([Type.Literal("done"), Type.Literal("question")]),
      ),
    }),
    async execute(_id, params, signal) {
      const source = state.chats.get(params.chat);
      if (!source) throw new Error("未知企微聊天标识");
      const ws = state.ws;
      if (!ws || !state.connected || source.botId !== state.activeBotId)
        throw new Error("来源机器人未连接");
      const epoch = state.epoch;
      const check = () => {
        if (signal?.aborted) throw new Error("消息发送已取消");
        if (state.binding?.pi !== pi || state.epoch !== epoch || state.switching)
          throw new Error("消息发送会话已失效");
        if (state.ws !== ws || !state.connected)
          throw new Error("来源机器人连接已变化或已禁用");
      };
      let body = "未发送";
      let ending = "未发送";
      try {
        check();
        body = "发送未确认";
        await ws.sendMessage(source.target, {
          msgtype: "markdown",
          markdown: { content: params.message },
        });
        body = "已发送";
        if (params.ending) {
          check();
          ending = "发送未确认";
          await ws.sendMessage(source.target, {
            msgtype: "markdown",
            markdown: { content: params.ending === "done" ? "✅" : "💬" },
          });
          ending = "已发送";
        }
      } catch (err) {
        throw new Error(
          `${error(err)}\n正文${body}${params.ending ? `\n收尾标记${ending}` : ""}`,
        );
      }
      return result(
        params.ending ? "正文已发送；收尾标记已发送" : "已发送",
        { body, ...(params.ending ? { ending } : {}) },
      );
    },
  });

  pi.registerTool({
    name: "wecombot-attach",
    label: "发送企微文件",
    description:
      "读取本地文件，向来源 chat 上传并发送独立文件消息，等待企微回执。",
    parameters: Type.Object({
      chat: Type.String(),
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_id, params, signal) {
      const source = state.chats.get(params.chat);
      if (!source) throw new Error("未知企微聊天标识");
      const ws = state.ws;
      if (!ws || !state.connected || source.botId !== state.activeBotId)
        throw new Error("来源机器人未连接");
      const sent: string[] = [];
      let unconfirmed: string | undefined;
      const epoch = state.epoch;
      const check = () => {
        if (signal?.aborted) throw new Error("附件发送已取消");
        if (
          state.binding?.pi !== pi ||
          state.epoch !== epoch ||
          state.switching
        )
          throw new Error("附件发送会话已失效");
        if (state.ws !== ws || !state.connected)
          throw new Error("来源机器人连接已变化或已禁用");
      };
      try {
        check();
        for (const path of params.paths) {
          let buffer: Buffer;
          try {
            if (!(await stat(path)).isFile()) throw new Error("不是普通文件");
            check();
            buffer = await readFile(path);
          } catch (err) {
            throw new Error(`文件 ${path} 读取失败: ${error(err)}`);
          }
          check();
          let media;
          try {
            media = await ws.uploadMedia(buffer, {
              type: "file",
              filename: basename(path),
            });
          } catch (err) {
            throw new Error(`文件 ${path} 上传失败: ${error(err)}`);
          }
          check();
          try {
            await ws.sendMediaMessage(source.target, "file", media.media_id);
          } catch (err) {
            unconfirmed = path;
            throw new Error(`文件 ${path} 发送未确认: ${error(err)}`);
          }
          sent.push(path);
          check();
        }
      } catch (err) {
        throw new Error(
          `${error(err)}\n已发送文件:\n${sent.join("\n") || "无"}\n发送未确认文件:\n${unconfirmed || "无"}\n未发送文件:\n${params.paths.slice(sent.length + (unconfirmed ? 1 : 0)).join("\n") || "无"}`,
        );
      }
      return result(`已发送文件:\n${sent.join("\n")}`, { sent });
    },
  });

  async function taskLog(task: Task) {
    const file = await open(task.logPath, "r");
    try {
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 16384));
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, size - buffer.length),
      );
      return { log: buffer.subarray(0, bytesRead).toString("utf8") };
    } finally {
      await file.close();
    }
  }
  async function taskDetails(task: Task) {
    let tail: { log: string; logError?: string };
    try {
      tail = await taskLog(task);
    } catch (err) {
      tail = { log: "", logError: error(err) };
    }
    return {
      id: task.id,
      description: task.description,
      sessionId: task.sessionId,
      command: task.command,
      cwd: task.cwd,
      chat: task.chat,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      error: task.error,
      logPath: task.logPath,
      ...tail,
    };
  }
  async function dispatchTask(task: Task) {
    if (
      task.status === "running" || task.delivery !== "pending" ||
      !state.binding || state.switching
    ) return;
    task.delivery = "preparing";
    try {
      const details = await taskDetails(task);
      // 日志读取期间可能发生 /new 或 reload，提交前重新取当前绑定。
      const binding = state.binding;
      if (!binding || state.switching) {
        task.delivery = "pending";
        return;
      }
      const currentSessionId = binding.ctx.sessionManager.getSessionId();
      const previousSession = task.sessionId !== currentSessionId;
      binding.pi.sendMessage({
        customType: "wecombot-task",
        content: `[wecombot-task]\n${previousSession
          ? "这是此前会话的旧任务结果，仅向原 chat 汇报；可以读取现有日志，不得自动修改代码、重跑构建或恢复旧工作目标。继续旧任务需要用户在新会话提出要求。"
          : "这是当前会话的后台任务结果。结合原请求、用途和日志，继续用户原本已要求的后续步骤，并向原 chat 自然汇报。"}\n退出码 0 不直接证明用户目标达成；信号终止不等于编译错误。普通正文对企微不可见，回复须调用 wecombot-send。\n${JSON.stringify({ ...details, currentSessionId, previousSession }, null, 2)}`,
        display: true,
      }, { triggerTurn: true, deliverAs: "steer" });
      // Pi 1.5.2 返回 void：仅记录已提交，不代表模型已处理或企微已送达。
      task.delivery = "submitted";
      task.deliveryError = undefined;
    } catch (err) {
      task.delivery = "pending";
      task.deliveryError = error(err);
      console.error("[wecombot] 后台结果提交失败:", task.id, task.deliveryError);
    }
  }
  function dispatchTasks() {
    for (const task of state.tasks.values()) void dispatchTask(task);
  }
  pi.registerTool({
    name: "wecombot-start",
    label: "启动后台命令",
    description:
      "启动后台 shell 命令，必填简短用途 description，立即返回任务标识和日志位置；完成后唤醒当前 Pi，向原 chat 汇报。跨 /new 的旧任务仅汇报，不自动恢复旧工作。",
    parameters: Type.Object({
      chat: Type.String(),
      description: Type.String({ minLength: 1, pattern: "\\S" }),
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!state.chats.has(params.chat)) throw new Error("未知企微聊天标识");
      if (!params.description?.trim()) throw new Error("description 必须是非空简短用途");
      const epoch = state.epoch;
      const check = () => {
        if (
          signal?.aborted || state.binding?.pi !== pi ||
          state.epoch !== epoch || state.switching
        ) throw new Error("启动会话已停止");
      };
      const cwd = params.cwd || ctx.cwd;
      if (!(await stat(cwd)).isDirectory()) throw new Error("cwd 不是目录");
      check();
      const id = randomUUID();
      const logDir = join(root, "wecombot-jobs");
      await mkdir(logDir, { recursive: true });
      check();
      const logPath = join(logDir, `${id}.log`);
      const log = await open(logPath, "wx", 0o600);
      try {
        check();
        const child = spawn(params.command, {
          cwd,
          shell: "/bin/bash",
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        });
        const task: Task = {
          id,
          description: params.description.trim(),
          sessionId: ctx.sessionManager.getSessionId(),
          command: params.command,
          cwd,
          chat: params.chat,
          logPath,
          status: "running",
          process: child,
          delivery: "pending",
        };
        state.tasks.set(id, task);
        child.on("error", (err) => {
          task.error = error(err);
        });
        child.on("close", (code, signal) => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
          task.status = task.error ? "failed" : "exited";
          task.exitCode = code;
          task.signal = signal;
          void dispatchTask(task);
        });
      } finally {
        await log.close();
      }
      return result(`已启动后台任务 ${id}\n日志: ${logPath}`, { id, logPath });
    },
  });
  pi.registerTool({
    name: "wecombot-task",
    label: "查询后台任务",
    description:
      "只查询当前 Pi 进程中的后台任务状态、退出信息与最多 16 KiB 日志尾部，不重新提交完成事件。",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_id, params) {
      const task = state.tasks.get(params.id);
      if (!task) throw new Error("未知后台任务");
      const details = {
        ...await taskDetails(task),
        delivery: task.delivery,
        deliveryError: task.deliveryError,
      };
      return result(JSON.stringify(details, null, 2), details);
    },
  });

  pi.registerCommand("wecombot-add", {
    description: "添加机器人（全局）",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const botId = (await ctx.ui.input("BotID", "wwxxxxxxxxxxxxxxx"))?.trim();
      if (!botId) return;
      const secret = (await ctx.ui.input("Secret", ""))?.trim();
      if (!secret) return;
      await load();
      if (state.bots.some((b) => b.botId === botId)) {
        ctx.ui.notify("❌ 该机器人已存在", "error");
        return;
      }
      const bot = { botId, secret, name: name?.trim() || undefined };
      state.bots.push(bot);
      await save();
      state.enabled = true;
      connect(bot);
      ctx.ui.notify(`✅ 已添加 ${name || botId.slice(0, 8)}（全局配置）`, "info");
    },
  });
  pi.registerCommand("wecombot-list", {
    description: "列出所有机器人（全局）",
    handler: async (_args, ctx) => {
      await load();
      if (state.bots.length === 0) {
        ctx.ui.notify("全局暂无配置的机器人", "info");
      } else {
        const list = state.bots.map((b) => {
          const active = b.botId === state.activeBotId;
          return `${active ? "▶" : "○"} ${state.connected && active ? "✅" : ""} ${b.name || b.botId}`;
        }).join("\n");
        const active = state.bots.find((b) => b.botId === state.activeBotId);
        const processInfo = state.activeBotId
          ? `本进程启用: ${active?.name || state.activeBotId}`
          : "本进程未启用机器人";
        ctx.ui.notify(`全局机器人列表（共 ${state.bots.length} 个）: ${list}${processInfo}`, "info");
      }
    },
  });
  pi.registerCommand("wecombot-use", {
    description: "切换机器人（本进程）",
    handler: async (_args, ctx) => {
      await load();
      if (state.bots.length === 0) {
        ctx.ui.notify("暂无配置的机器人，请先添加", "warning");
        return;
      }
      const options = state.bots.map(
        (b) => `${b.name || b.botId} (${b.botId})`,
      );
      const selected = await ctx.ui.select("选择机器人（仅本进程）", options);
      if (!selected) return;
      const bot = state.bots[options.indexOf(selected)];
      if (!bot) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }
      state.enabled = true;
      disconnect();
      connect(bot);
      ctx.ui.notify(`✅ 本进程已切换到 ${bot.name || bot.botId}`, "info");
    },
  });
  pi.registerCommand("wecombot-remove", {
    description: "删除机器人（全局）",
    handler: async (_args, ctx) => {
      await load();
      if (state.bots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      const name = await ctx.ui.input("输入要删除的BotID或名称", "");
      if (!name) return;
      const bot = state.bots.find((b) => b.botId === name || b.name === name);
      if (!bot) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }
      state.bots = state.bots.filter((b) => b !== bot);
      await save();
      if (state.activeBotId === bot.botId) {
        disconnect();
        state.activeBotId = state.bots[0]?.botId;
        if (state.bots[0]) {
          if (state.enabled) connect(state.bots[0]);
          ctx.ui.notify(`✅ 已删除 ${bot.name || bot.botId}，自动切换到下一个`, "info");
        } else {
          ctx.ui.notify(`✅ 已删除 ${bot.name || bot.botId}（无可用机器人）`, "info");
        }
      } else {
        ctx.ui.notify(`✅ 已删除 ${bot.name || bot.botId}`, "info");
      }
    },
  });
  pi.registerCommand("wecombot-enable", {
    description: "启用机器人（本进程）",
    handler: async (_args, ctx) => {
      if (state.enabled) {
        ctx.ui.notify("本进程机器人已是启用状态", "info");
        return;
      }
      state.enabled = true;
      const bot =
        state.bots.find((b) => b.botId === state.activeBotId) || state.bots[0];
      if (bot) {
        connect(bot);
        ctx.ui.notify(`✅ 本进程已启用并连接 ${bot.name || bot.botId}`, "info");
      } else {
        ctx.ui.notify("✅ 本进程已启用，但未选择机器人，请先添加或使用 /wecombot-use 选择", "warning");
      }
      status();
    },
  });
  pi.registerCommand("wecombot-disable", {
    description: "禁用机器人（本进程）",
    handler: async (_args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("本进程机器人已是禁用状态", "info");
        return;
      }
      state.enabled = false;
      disconnect();
      ctx.ui.notify("🔌 本进程已禁用机器人并断开连接", "info");
    },
  });
  for (const name of [
    "wecombot-status",
    "wecombot-session",
    "wecombot-session-info",
  ])
    pi.registerCommand(name, {
      description: "查看企微连接与来源聊天",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `配置: ${config}\n启用: ${state.enabled}\n机器人: ${state.activeBotId || "无"}\n已认证: ${state.connected}\nPi会话: ${ctx.sessionManager.getSessionId()}\n已知聊天:\n${[...state.chats.keys()].join("\n")}`,
          "info",
        );
      },
    });
  pi.on("session_start", async (_event, ctx) => {
    if (!state.switching) state.epoch++;
    state.binding = { pi, ctx };
    if (!state.loaded) {
      await load();
      state.loaded = true;
      state.activeBotId = state.bots[0]?.botId;
    }
    const bot = state.bots.find((b) => b.botId === state.activeBotId);
    if (state.enabled && bot) connect(bot);
    status();
    dispatchTasks();
  });
  pi.on("session_shutdown", async () => {
    if (state.binding?.pi === pi) state.binding = undefined;
  });
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + PROMPT,
  }));
}
