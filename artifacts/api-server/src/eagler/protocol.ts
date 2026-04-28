import { encodeULEB128, decodeULEB128 } from "@thi.ng/leb128";

export interface ReadResult<T> {
  value: T;
  newBuffer: Buffer;
}

export function writeVarInt(int: number): Buffer {
  return Buffer.from(encodeULEB128(int));
}

export function readVarInt(buff: Buffer, offset?: number): ReadResult<number> {
  const b = offset ? buff.subarray(offset) : buff;
  const read = decodeULEB128(b);
  const len = read[1];
  return { value: Number(read[0]), newBuffer: b.subarray(len) };
}

export function writeString(str: string): Buffer {
  const bufferized = Buffer.from(str, "utf8");
  return Buffer.concat([writeVarInt(bufferized.length), bufferized]);
}

export function readString(buff: Buffer, offset?: number): ReadResult<string> {
  const b = offset ? buff.subarray(offset) : buff;
  const len = readVarInt(b);
  const str = len.newBuffer.subarray(0, len.value).toString("utf8");
  return { value: str, newBuffer: len.newBuffer.subarray(len.value) };
}

export function writeShort(num: number): Buffer {
  const alloc = Buffer.alloc(2);
  alloc.writeInt16BE(num, 0);
  return alloc;
}

export function readShort(buff: Buffer, offset?: number): ReadResult<number> {
  const b = offset ? buff.subarray(offset) : buff;
  return { value: (b[0]! << 8) | b[1]!, newBuffer: b.subarray(2) };
}

export function uuidStringToBuffer(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (uuid.length !== 36 || hex.length !== 32)
    throw new Error(`Invalid UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
}

export function uuidBufferToString(buf: Buffer): string {
  if (buf.length !== 16) throw new Error(`Invalid UUID buffer length: ${buf.length}`);
  const s = buf.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
