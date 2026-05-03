import { createHash } from "crypto";
import type { WebSocket } from "ws";
import { uuidBufferToString } from "./protocol";

const USERNAME_REGEX = /[^0-9a-zA-Z_]/g;

export function generateOfflineUUID(username: string): string {
  const md5 = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  md5[6] = (md5[6]! & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8]! & 0x3f) | 0x80; // IETF variant
  return uuidBufferToString(md5);
}

export function validateUsername(name: string): void {
  if (name.length > 20) throw new Error("Username is too long");
  if (name.length < 3) throw new Error("Username is too short");
  if (USERNAME_REGEX.test(name))
    throw new Error("Username may only contain letters, digits, and underscores");
}

export function awaitPacket(
  ws: WebSocket,
  timeoutMs = 15000,
  filter?: (msg: Buffer) => boolean,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      ws.off("message", onMsg);
      ws.off("close", onClose);
      clearTimeout(timer);
    };
    const onMsg = (msg: Buffer | ArrayBuffer | Buffer[], _isBin: boolean) => {
      const buf = Buffer.isBuffer(msg)
        ? msg
        : msg instanceof ArrayBuffer
          ? Buffer.from(msg)
          : Buffer.concat(msg as Buffer[]);
      if (buf.length === 0) return;
      if (filter && !filter(buf)) return;
      cleanup();
      resolve(buf);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Connection closed before packet arrived"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for EaglerCraft packet"));
    }, timeoutMs);
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

export function isLikelyEaglerLoginFrame(buf: Buffer): boolean {
  return buf.length > 0 && buf[0] === 0x01;
}
