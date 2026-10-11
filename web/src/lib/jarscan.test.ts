import { describe, expect, it } from "vitest";
import { pickModsRoot, readJarMeta } from "./jarscan";
import { extractZipEntry, listZipEntries } from "./zip";

interface EntrySpec {
  name: string;
  content: string;
  store?: boolean;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 手工构造一个最小 zip(含 STORE 与 deflate 条目),用于测试按需读取 */
async function buildZip(entries: EntrySpec[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let cdSize = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = encoder.encode(entry.content);
    const method = entry.store ? 0 : 8;
    const data = entry.store ? raw : await deflateRaw(raw);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    cdSize += central.length;
    offset += local.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const FABRIC_JSON = JSON.stringify({ schemaVersion: 1, id: "sodium", name: "Sodium", version: "0.6.0" });

async function fabricJar(name = "sodium-fabric-mc1.20.1-0.6.0.jar"): Promise<File> {
  const bytes = await buildZip([
    { name: "fabric.mod.json", content: FABRIC_JSON },
    { name: "assets/sodium.bin", content: "x".repeat(4096), store: true },
  ]);
  return new File([bytes as BlobPart], name);
}

describe("zip 按需读取", () => {
  it("只解析所需条目并正确解压 deflate 数据", async () => {
    const file = await fabricJar();
    const found = await listZipEntries(file, (name) => name === "fabric.mod.json" || name === "missing.txt");
    expect([...found.keys()]).toEqual(["fabric.mod.json"]);
    const text = new TextDecoder().decode(await extractZipEntry(file, found.get("fabric.mod.json")!));
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, id: "sodium", name: "Sodium", version: "0.6.0" });
  });

  it("支持 stored(未压缩)条目", async () => {
    const file = await fabricJar();
    const found = await listZipEntries(file, (name) => name === "assets/sodium.bin");
    const data = await extractZipEntry(file, found.get("assets/sodium.bin")!);
    expect(data.length).toBe(4096);
  });

  it("非 zip 文件抛出错误", async () => {
    const bad = new File([new Uint8Array([1, 2, 3]) as BlobPart], "broken.jar");
    await expect(listZipEntries(bad, (name) => name === "fabric.mod.json")).rejects.toThrow();
  });
});

describe("readJarMeta", () => {
  it("从 jar 元数据读取 fabric 模组", async () => {
    const meta = await readJarMeta(await fabricJar());
    expect(meta).toMatchObject({
      id: "sodium",
      name: "Sodium",
      version: "0.6.0",
      loader: "fabric",
      source: "fabric.mod.json",
    });
  });

  it("损坏文件回退文件名解析", async () => {
    const bad = new File([new Uint8Array([1, 2, 3]) as BlobPart], "legacy-mod-1.2.jar");
    const meta = await readJarMeta(bad);
    expect(meta).toMatchObject({
      id: "",
      name: "legacy-mod",
      version: "1.2",
      loader: "unknown",
      source: "filename",
    });
    expect(meta.key).toBe("legacymod");
  });

  it("neoforge.mods.toml 统一视为 forge", async () => {
    const bytes = await buildZip([
      {
        name: "META-INF/neoforge.mods.toml",
        content: 'modLoader="javafml"\n[[mods]]\nmodId="neoforgeexample"\nversion="1.2.3"\ndisplayName="Neo Example"\n',
      },
    ]);
    const meta = await readJarMeta(new File([bytes as BlobPart], "neoforge-example-1.2.3.jar"));
    expect(meta).toMatchObject({
      id: "neoforgeexample",
      name: "Neo Example",
      version: "1.2.3",
      loader: "forge",
      source: "META-INF/neoforge.mods.toml",
    });
  });

  it("mods.toml 优先级最高:fabric.mod.json 与 mods.toml 同时存在时判为 forge", async () => {
    const bytes = await buildZip([
      { name: "fabric.mod.json", content: FABRIC_JSON },
      {
        name: "META-INF/mods.toml",
        content: 'modLoader="javafml"\n[[mods]]\nmodId="hybrid"\nversion="1.0.0"\ndisplayName="Hybrid"\n',
      },
    ]);
    const meta = await readJarMeta(new File([bytes as BlobPart], "hybrid-example-1.0.0.jar"));
    expect(meta).toMatchObject({
      id: "hybrid",
      name: "Hybrid",
      loader: "forge",
      source: "META-INF/mods.toml",
    });
  });

  it("识别 .jar.disabled 为已禁用", async () => {
    const bytes = await buildZip([{ name: "fabric.mod.json", content: FABRIC_JSON }]);
    const meta = await readJarMeta(new File([bytes as BlobPart], "sodium-fabric-mc1.20.1-0.6.0.jar.disabled"));
    expect(meta.disabled).toBe(true);
    expect(meta.id).toBe("sodium");
  });
});

describe("pickModsRoot", () => {
  const mk = (path: string) => ({ path, file: new File([], path.split("/").pop()!) });

  it("游戏根目录优先选择 mods 子目录而不是 jar 更多的 libraries", () => {
    const picked = pickModsRoot([
      mk("1.20.1/libraries/a.jar"),
      mk("1.20.1/libraries/b.jar"),
      mk("1.20.1/libraries/c.jar"),
      mk("1.20.1/mods/sodium.jar"),
      mk("1.20.1/mods/jei.jar.disabled"),
    ]);
    expect(picked).toMatchObject({ rootName: "1.20.1", type: "game_root", dirLabel: "1.20.1/mods" });
    expect(picked!.jars.map((f) => f.name)).toEqual(["sodium.jar", "jei.jar.disabled"]);
  });

  it("直接选择模组目录", () => {
    const picked = pickModsRoot([{ path: "mods/a.jar", file: new File([], "a.jar") }]);
    expect(picked).toMatchObject({ rootName: "mods", type: "mods", dirLabel: "mods" });
  });

  it("没有 jar 时返回 null", () => {
    expect(pickModsRoot([])).toBeNull();
  });
});
