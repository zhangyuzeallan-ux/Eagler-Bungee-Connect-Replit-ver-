import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import minecraftProtocol from "minecraft-protocol";
import { logger } from "../lib/logger";
import {
  buildPlayDisconnect,
  buildSCDisconnect,
  buildSCIdentify,
  buildSCReady,
  buildSCSyncUuid,
  parseCSLogin,
  parseCSUsername,
  PACKET_ID,
} from "./handshake";
import { generateOfflineUUID, validateUsername, awaitPacket } from "./util";

const { createSerializer, createDeserializer, createClient, states } = minecraftProtocol;

interface PlayerOptions {
  ws: WebSocket;
  req: IncomingMessage;
  upstreamHost: string;
  upstreamPort: number;
  protocolVersion: number; // 47 for 1.8.x
  eaglerNetworkVersion: number; // 3 for current EaglerX
  brand: string;
  proxyVersion: string;
}

type ClientState = "PRE_HANDSHAKE" | "POST_HANDSHAKE" | "DISCONNECTED";

export class EaglerPlayer extends EventEmitter {
  public username = "";
  public uuid = "";
  public state: ClientState = "PRE_HANDSHAKE";

  private ws: WebSocket;
  private req: IncomingMessage;
  private opts: PlayerOptions;
  private serverConnection: ReturnType<typeof createClient> | null = null;
  private serverSerializer: ReturnType<typeof createSerializer>;
  private serverDeserializer: ReturnType<typeof createDeserializer>;
  private clientSerializer: ReturnType<typeof createSerializer>;
  private clientDeserializer: ReturnType<typeof createDeserializer>;
  private streamStarted = false;
  private clientIp: string;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(opts: PlayerOptions) {
    super();
    this.opts = opts;
    this.ws = opts.ws;
    this.req = opts.req;
    this.clientIp =
      ((opts.req.headers["x-forwarded-for"] as string) || "")
        .split(",")[0]
        ?.trim() ||
      opts.req.socket.remoteAddress ||
      "unknown";

    this.serverSerializer = createSerializer({
      state: states.PLAY, isServer: true, version: "1.8.9", customPackets: null,
    });
    this.clientSerializer = createSerializer({
      state: states.PLAY, isServer: false, version: "1.8.9", customPackets: null,
    });
    this.serverDeserializer = createDeserializer({
      state: states.PLAY, isServer: true, version: "1.8.9", customPackets: null,
    });
    this.clientDeserializer = createDeserializer({
      state: states.PLAY, isServer: false, version: "1.8.9", customPackets: null,
    });
  }

  public async run(firstPacket: Buffer): Promise<void> {
    try {
      await this.handshake(firstPacket);
      await this.connectUpstream();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { clientIp: this.clientIp, username: this.username, errMsg: msg },
        "[BUNGEE] Handshake/connect failed",
      );
      this.disconnect(`§cProxy error: ${msg}`);
    }
  }

  private async handshake(firstPacket: Buffer): Promise<void> {
    // Step 1: parse CSLogin
    let login;
    try {
      login = parseCSLogin(firstPacket);
    } catch (err) {
      logger.warn(
        {
          clientIp: this.clientIp,
          errMsg: err instanceof Error ? err.message : String(err),
          length: firstPacket.length,
          hex: firstPacket.subarray(0, 96).toString("hex"),
        },
        "[BUNGEE] Failed to parse CSLogin packet",
      );
      throw err;
    }
    logger.info(
      {
        clientIp: this.clientIp,
        username: login.username,
        brand: login.brand,
        version: login.version,
        netVer: login.networkVersion,
        gameVer: login.gameVersion,
      },
      "[BUNGEE] Login attempt",
    );

    if (login.gameVersion !== this.opts.protocolVersion) {
      throw new Error(`Wrong game version (got ${login.gameVersion}, want ${this.opts.protocolVersion})`);
    }
    validateUsername(login.username);

    this.username = login.username;
    this.uuid = generateOfflineUUID(this.username);

    // Step 2: send SCIdentify
    this.ws.send(
      buildSCIdentify({
        networkVersion: this.opts.eaglerNetworkVersion,
        gameVersion: this.opts.protocolVersion,
        branding: this.opts.brand,
        version: this.opts.proxyVersion,
      }),
    );

    // Step 3: wait for CSUsername (0x04)
    const usernameBuf = await awaitPacket(this.ws, 15000, (b) => b[0] === PACKET_ID.CSUsername);
    const u = parseCSUsername(usernameBuf);
    if (u.username !== this.username) {
      throw new Error("Username mismatch in handshake");
    }

    // Step 4: send SCSyncUuid
    this.ws.send(buildSCSyncUuid(this.username, this.uuid));

    // Step 5: wait for CSReady (0x08) AND CSSetSkin (0x07) in any order
    const seen = new Set<number>();
    while (!(seen.has(PACKET_ID.CSReady) && seen.has(PACKET_ID.CSSetSkin))) {
      const pkt = await awaitPacket(this.ws, 15000, (b) => {
        const id = b[0]!;
        return id === PACKET_ID.CSReady || id === PACKET_ID.CSSetSkin;
      });
      seen.add(pkt[0]!);
    }

    // Step 6: send SCReady
    this.ws.send(buildSCReady());
    this.state = "POST_HANDSHAKE";
    logger.info(
      { clientIp: this.clientIp, username: this.username, uuid: this.uuid },
      "[BUNGEE] EaglerX handshake complete",
    );
  }

  private async connectUpstream(): Promise<void> {
    const { upstreamHost, upstreamPort } = this.opts;
    logger.info(
      { clientIp: this.clientIp, username: this.username, upstream: `${upstreamHost}:${upstreamPort}` },
      "[BUNGEE] Connecting to upstream Minecraft server",
    );

    this.serverConnection = createClient({
      host: upstreamHost,
      port: upstreamPort,
      username: this.username,
      version: "1.8.9",
      auth: "offline",
      keepAlive: true,
      hideErrors: true,
    });

    let serverUuid: string | null = null;
    let resolved = false;

    const connectPromise = new Promise<void>((resolve, reject) => {
      const connectTimer = setTimeout(() => {
        if (!resolved) reject(new Error("Upstream connect timeout (45s)"));
      }, 45000);

      this.serverConnection!.on("error", (err: Error) => {
        clearTimeout(connectTimer);
        if (!resolved) reject(err);
        else this.disconnect(`§cUpstream error: ${err.message}`);
      });

      this.serverConnection!.on("end", (reason: string) => {
        clearTimeout(connectTimer);
        logger.info({ clientIp: this.clientIp, reason }, "[BUNGEE] Upstream ended");
        if (!resolved) reject(new Error(`Upstream closed: ${reason}`));
        else this.disconnect(`§eDisconnected: ${reason || "server closed connection"}`);
      });

      this.serverConnection!.on("packet", (packet: Record<string, unknown>, meta: { name: string; state: string }) => {
        // Capture login success UUID
        if (!this.streamStarted) {
          if (meta.name === "success" && meta.state === states.LOGIN && !serverUuid) {
            serverUuid = packet["uuid"] as string;
            return;
          }
          // First PLAY-state "login" packet → forward and start streaming
          if (meta.name === "login" && meta.state === states.PLAY && serverUuid) {
            try {
              const buf = this.serverSerializer.createPacketBuffer({ name: "login", params: packet });
              this.ws.send(buf);
              this.streamStarted = true;
              clearTimeout(connectTimer);
              resolved = true;
              resolve();
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
            return;
          }
          // Pre-PLAY login state housekeeping packets we ignore
          return;
        }

        // Stream-mode: forward upstream PLAY packet to EaglerX client
        if (meta.name === "kick_disconnect" || meta.name === "disconnect") {
          let kickMsg = packet["reason"] as string;
          try {
            const j = JSON.parse(kickMsg) as { text?: string };
            kickMsg = j.text ?? kickMsg;
          } catch { /* keep as-is */ }
          this.disconnect(kickMsg || "kicked by server");
          return;
        }
        try {
          const buf = this.serverSerializer.createPacketBuffer({ name: meta.name, params: packet });
          this.ws.send(buf);
        } catch (err) {
          // Some packets may fail to serialize for the client direction; log and skip.
          logger.debug(
            { name: meta.name, errMsg: err instanceof Error ? err.message : String(err) },
            "[BUNGEE] Failed to forward server→client packet",
          );
        }
      });
    });

    // Wire client→server forwarding
    this.ws.on("message", (msg: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary || !this.streamStarted || !this.serverConnection) return;
      const buf = Buffer.isBuffer(msg)
        ? msg
        : msg instanceof ArrayBuffer
          ? Buffer.from(msg)
          : Buffer.concat(msg as Buffer[]);
      // 0x17 EaglerX channel messages → ignore (skin requests etc.)
      if (buf.length > 0 && buf[0] === PACKET_ID.CSChannelMessage) return;
      try {
        const parsed = this.clientDeserializer.parsePacketBuffer(buf);
        const data = parsed.data as { name: string; params: Record<string, unknown> };
        const out = this.clientSerializer.createPacketBuffer({ name: data.name, params: data.params });
        // writeRaw writes a fully-serialized packet to the underlying socket
        (this.serverConnection as unknown as { writeRaw: (b: Buffer) => void }).writeRaw(out);
      } catch (err) {
        logger.debug(
          { errMsg: err instanceof Error ? err.message : String(err) },
          "[BUNGEE] Failed to parse client→server packet",
        );
      }
    });

    this.keepAliveTimer = setInterval(() => {
      if (this.ws.readyState === 1) {
        try { this.ws.ping(); } catch { /* ignore */ }
      }
    }, 15000);

    this.ws.on("close", () => {
      this.state = "DISCONNECTED";
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      try { this.serverConnection?.end(""); } catch { /* ignore */ }
      this.emit("disconnect");
    });

    await connectPromise;
    logger.info(
      { clientIp: this.clientIp, username: this.username },
      "[BUNGEE] Upstream connected, streaming PLAY packets",
    );
  }

  public disconnect(message: string): void {
    if (this.state === "DISCONNECTED") return;
    this.state = "DISCONNECTED";
    try {
      if (this.streamStarted) {
        this.ws.send(buildPlayDisconnect(JSON.stringify({ text: message })));
      } else {
        this.ws.send(buildSCDisconnect(message));
      }
    } catch { /* ignore */ }
    try { this.ws.close(); } catch { /* ignore */ }
    try { this.serverConnection?.end(""); } catch { /* ignore */ }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.emit("disconnect");
  }
}
