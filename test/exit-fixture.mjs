import { resolve } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, {
  alias: { "aibot-node-sdk": resolve("test/sdk.mjs") },
});
const extension = await jiti.import("../index.ts", { default: true });
const tools = new Map(),
  events = new Map();
const ctx = {
  cwd: process.env.PI_CODING_AGENT_DIR,
  sessionManager: { getSessionId: () => "exit-session" },
  ui: { setStatus() {} },
};
extension({
  registerTool: (x) => tools.set(x.name, x),
  registerCommand() {},
  on: (name, f) => events.set(name, f),
  sendUserMessage() {},
  sendMessage() {},
});
await events.get("session_start")({}, ctx);
const { clients } = await import("./sdk.mjs");
clients.at(-1).emit("message.text", {
  body: {
    chattype: "single",
    from: { userid: "alice" },
    text: { content: "start" },
  },
});
const task = await tools.get("wecombot-start").execute(
  "job",
  {
    chat: JSON.stringify(["bot", "single", "alice"]),
    description: "验证 Pi 退出清理",
    command: `node -e 'console.log(process.pid);setInterval(()=>{},1000)'`,
  },
  undefined,
  undefined,
  ctx,
);
for (let i = 0; i < 100; i++) {
  const status = await tools
    .get("wecombot-task")
    .execute("status", { id: task.details.id });
  const pid = Number(status.details.log.trim());
  if (pid) {
    console.log(JSON.stringify({ pid }));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5));
}
process.exit(1);
