import {
  readShort,
  readString,
  uuidStringToBuffer,
  writeShort,
  writeString,
} from "./protocol";

// EaglerXBungee handshake packet IDs
export const PACKET_ID = {
  CSLogin: 0x01,
  SCIdentify: 0x02,
  CSUsername: 0x04,
  SCSyncUuid: 0x05,
  CSSetSkin: 0x07,
  CSReady: 0x08,
  SCReady: 0x09,
  SCDisconnect: 0xff,
  CSChannelMessage: 0x17,
  SCChannelMessage: 0x3f,
} as const;

// EaglerXBungee error sub-types (used inside SCDisconnect 0xFF)
export const SC_ERROR_CODE = {
  CUSTOM: 0x08,
} as const;

export interface ParsedCSLogin {
  networkVersion: number;
  gameVersion: number;
  brand: string;
  version: string;
  username: string;
}

// Parse the EaglerX 0x01 client login packet.
// Layout: 0x01 0x02 <numNetVers:short> <netVers...> <numGameVers:short> <gameVers...>
//   <brand:string> <version:string> 0x00 <username:string>
export function parseCSLogin(packet: Buffer): ParsedCSLogin {
  if (packet[0] !== PACKET_ID.CSLogin)
    throw new Error(`Not a CSLogin packet (id=${packet[0]?.toString(16)})`);
  if (packet.length < 8)
    throw new Error(`CSLogin packet too short (len=${packet.length})`);
  let p = packet.subarray(2);
  let head = readShort(p);
  // capped at 8 to avoid DoS
  let count = Math.min(8, head.value);
  let networkVersion = head.value; // fallback if no advertised list
  for (let i = 0; i < count; i++) {
    head = readShort(head.newBuffer);
    networkVersion = head.value;
  }
  head = readShort(head.newBuffer);
  count = Math.min(8, head.value);
  let gameVersion = head.value;
  for (let i = 0; i < count; i++) {
    head = readShort(head.newBuffer);
    gameVersion = head.value;
  }
  const brand = readString(head.newBuffer);
  const version = readString(brand.newBuffer);
  const username = readString(version.newBuffer, 1); // skip auth byte (0x00)
  return {
    networkVersion,
    gameVersion,
    brand: brand.value,
    version: version.value,
    username: username.value,
  };
}

export interface BuildSCIdentifyOpts {
  networkVersion?: number;
  gameVersion?: number;
  branding?: string;
  version?: string;
}

// Build the EaglerX 0x02 server identify response.
// Layout: 0x02 <protoVer:short> <gameVer:short> <branding:string> <version:string> 0x00 0x00 0x00
export function buildSCIdentify(opts: BuildSCIdentifyOpts = {}): Buffer {
  const { networkVersion = 3, gameVersion = 47, branding = "lax1dude", version = "1.0.0" } = opts;
  return Buffer.concat([
    Buffer.from([PACKET_ID.SCIdentify]),
    writeShort(networkVersion),
    writeShort(gameVersion),
    writeString(branding),
    writeString(version),
    Buffer.from([0x00, 0x00, 0x00]),
  ]);
}

// Parse 0x04 client username packet — confirms the username after handshake.
export function parseCSUsername(packet: Buffer): { username: string } {
  if (packet[0] !== PACKET_ID.CSUsername)
    throw new Error(`Not a CSUsername packet (id=${packet[0]?.toString(16)})`);
  if (packet.length < 3)
    throw new Error(`CSUsername packet too short (len=${packet.length})`);
  const p = packet.subarray(1);
  const u = readString(p);
  return { username: u.value };
}

// Build 0x05 server sync uuid packet.
// Layout: 0x05 <username:string> <uuid:16 bytes>
export function buildSCSyncUuid(username: string, uuid: string): Buffer {
  return Buffer.concat([
    Buffer.from([PACKET_ID.SCSyncUuid]),
    writeString(username),
    uuidStringToBuffer(uuid),
  ]);
}

// Build 0x09 server ready packet.
export function buildSCReady(): Buffer {
  return Buffer.from([PACKET_ID.SCReady]);
}

// Build a pre-handshake disconnect packet (0xFF + 0x08 custom + uint8 length + utf8 message).
export function buildSCDisconnect(message: string): Buffer {
  const msg = Buffer.from(message, "utf8").subarray(0, 255);
  return Buffer.concat([Buffer.from([PACKET_ID.SCDisconnect, SC_ERROR_CODE.CUSTOM, msg.length]), msg]);
}

// Build a post-handshake (PLAY state) disconnect packet.
// 0x40 in EaglerX/MC 1.8 PLAY = "kick_disconnect", payload is a JSON-string.
export function buildPlayDisconnect(jsonChat: string): Buffer {
  return Buffer.concat([Buffer.from([0x40]), writeString(jsonChat)]);
}
