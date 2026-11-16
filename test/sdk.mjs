import { EventEmitter } from "node:events";
export const clients = [];
export class WSClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.streams = [];
    clients.push(this);
  }
  connect() {
    this.emit("authenticated");
  }
  disconnect() {
    this.emit("disconnected", "manual");
  }
  async sendMessage(chatid, body) {
    if (this.sendFailure) throw this.sendFailure;
    if (this.sendWait) await this.sendWait;
    this.sent.push({ chatid, ...body });
    return { errcode: 0 };
  }
  async replyStream(frame, id, content, finish = false) {
    const call = { headers: { ...frame.headers }, id, content, finish };
    this.streams.push(call);
    if (this.streamReply) return this.streamReply(call);
    return { errcode: 0 };
  }
  async uploadMedia(buffer, options) {
    (this.uploads ??= []).push({ buffer, ...options });
    if (this.uploadWait) await this.uploadWait;
    if (this.uploadFailure) throw this.uploadFailure;
    return { media_id: `media-${this.uploads.length}`, type: "file", created_at: "1" };
  }
  async sendMediaMessage(chatid, type, media_id) {
    return this.sendMessage(chatid, { msgtype: type, [type]: { media_id } });
  }
  async downloadFile() {
    return this.download ? this.download() : { buffer: Buffer.from("media") };
  }
  async replyWelcome() {}
}
