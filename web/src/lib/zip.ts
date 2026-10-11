/**
 * 按需读取 ZIP 条目的极简实现(仅面向 Chrome)。
 *
 * 不把整个文件读入内存,只通过 File.slice 读取:
 *   1. 文件末尾的中央目录(几 KB)
 *   2. 目标条目的局部头与压缩数据(几 KB)
 * 解压使用原生 DecompressionStream('deflate-raw')。
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export interface ZipEntryLocation {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

async function readRange(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** 读取中央目录,返回符合条件(wanted 为 true)的条目位置信息 */
export async function listZipEntries(
  file: File,
  wanted: (name: string) => boolean,
): Promise<Map<string, ZipEntryLocation>> {
  const tailLen = Math.min(file.size, 22 + 0xffff);
  const tailStart = file.size - tailLen;
  const tail = await readRange(file, tailStart, file.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG && i + 22 + view.getUint16(i + 20, true) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件");

  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorPos = eocd - 20;
    if (locatorPos < 0 || view.getUint32(locatorPos, true) !== EOCD64_LOCATOR_SIG) {
      throw new Error("zip64 结构不完整");
    }
    const recordOffset = Number(view.getBigUint64(locatorPos + 8, true));
    const record = await readRange(file, recordOffset, recordOffset + 56);
    const rv = new DataView(record.buffer, record.byteOffset, record.byteLength);
    count = Number(rv.getBigUint64(32, true));
    cdSize = Number(rv.getBigUint64(40, true));
    cdOffset = Number(rv.getBigUint64(48, true));
  }

  const cd = await readRange(file, cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const decoder = new TextDecoder();
  const result = new Map<string, ZipEntryLocation>();

  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cdView.getUint32(p, true) !== CDFH_SIG) break;
    const nameLen = cdView.getUint16(p + 28, true);
    const extraLen = cdView.getUint16(p + 30, true);
    const commentLen = cdView.getUint16(p + 32, true);
    const entryName = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (wanted(entryName)) {
      result.set(entryName, {
        name: entryName,
        method: cdView.getUint16(p + 10, true),
        compressedSize: cdView.getUint32(p + 20, true),
        offset: cdView.getUint32(p + 42, true),
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return result;
}

/** 读取并解压单个条目的内容 */
export async function extractZipEntry(file: File, entry: ZipEntryLocation): Promise<Uint8Array> {
  const head = await readRange(file, entry.offset, entry.offset + 30);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== LFH_SIG) throw new Error("zip 局部头损坏");
  const dataStart = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const raw = await readRange(file, dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`不支持的压缩方式:${entry.method}`);
}
