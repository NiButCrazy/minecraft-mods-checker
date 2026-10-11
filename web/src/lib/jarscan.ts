import type { ModEntry, ModLoader, ScanData } from "../types";
import { extractZipEntry, listZipEntries } from "./zip";

const JAR_RE = /\.jar(\.disabled)?$/i;

const JSON_META = new Set(["quilt.mod.json", "fabric.mod.json"]);

/** 需要的元数据条目:fabric/quilt 的 json,以及所有以 mods.toml 结尾的文件(统一视为 Forge) */
function isWantedMeta(name: string): boolean {
  return JSON_META.has(name) || name.toLowerCase().endsWith("mods.toml");
}

function modsTomlPriority(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith("neoforge.mods.toml")) return 0;
  if (lower === "meta-inf/mods.toml") return 1;
  return 2;
}

interface RawMeta {
  id: string;
  version: string;
  name: string;
}

export interface FolderSelection {
  rootName: string;
  dirLabel: string;
  type: "game_root" | "mods";
  jars: File[];
}

export interface ScanProgress {
  done: number;
  total: number;
  current: string;
}

export interface JarEntry {
  path: string;
  file: File;
}

/** 从文件名解析 名称/版本(与 Python 端保持一致的规则) */
export function fromFilename(fileName: string): { name: string; version: string } {
  const base = fileName.replace(/\.disabled$/i, "").replace(/\.jar$/i, "");
  const segments = base.split("-");
  const idx = segments.findIndex((s) => /^v?\d/.test(s));
  if (idx <= 0) return { name: base, version: "" };
  return { name: segments.slice(0, idx).join("-"), version: segments.slice(idx).join("-") };
}

/** 对比配对键:id 优先,否则用文件名中的名称部分(仅保留字母数字) */
export function buildKey(id: string, fileName: string): string {
  const base = id || fromFilename(fileName).name;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** 从模组文件清单中识别出模组目录(优先名为 mods 的目录,否则取 jar 最多的目录) */
export function pickModsRoot(jars: JarEntry[]): FolderSelection | null {
  if (jars.length === 0) return null;
  const byDir = new Map<string, File[]>();
  for (const { path, file } of jars) {
    const slash = path.lastIndexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const list = byDir.get(dir);
    if (list) list.push(file);
    else byDir.set(dir, [file]);
  }
  const rootName = jars[0].path.split("/")[0] || "所选目录";

  let bestDir = "";
  let bestJars: File[] = [];
  for (const [dir, dirJars] of byDir) {
    const dirIsMods = dir.split("/").pop()?.toLowerCase() === "mods";
    const bestIsMods = bestDir.split("/").pop()?.toLowerCase() === "mods";
    if (
      bestJars.length === 0 ||
      (dirIsMods && !bestIsMods) ||
      (dirIsMods === bestIsMods && dirJars.length > bestJars.length)
    ) {
      bestDir = dir;
      bestJars = dirJars;
    }
  }
  return {
    rootName,
    dirLabel: bestDir || rootName,
    type: bestDir === rootName ? "mods" : "game_root",
    jars: bestJars,
  };
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 遍历 webkitdirectory 的 FileList,只保留模组 jar(分片让出主线程,避免大目录树卡顿) */
export async function collectJarEntries(
  list: FileList,
  onProgress?: (p: ScanProgress) => void,
): Promise<JarEntry[]> {
  const entries: JarEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const file = list.item(i);
    if (file && JAR_RE.test(file.name)) {
      entries.push({ path: file.webkitRelativePath || file.name, file });
    }
    if ((i & 1023) === 1023) {
      onProgress?.({ done: i + 1, total: list.length, current: "正在筛选模组文件…" });
      await yieldToUi();
    }
  }
  return entries;
}

async function scanFiles(
  jars: File[],
  selection: FolderSelection,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanData> {
  const sorted = [...jars].sort((x, y) => x.name.localeCompare(y.name, "zh-CN"));
  const results = new Array<ModEntry>(sorted.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(12, sorted.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= sorted.length) return;
      results[i] = await readJarMeta(sorted[i]);
      done++;
      onProgress?.({ done, total: sorted.length, current: sorted[i].name });
    }
  });
  await Promise.all(workers);
  results.sort((x, y) => x.name.localeCompare(y.name, "zh-CN"));

  return {
    source: {
      dir: selection.dirLabel,
      dirName: selection.rootName,
      type: selection.type,
      scannedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      tool: "web",
    },
    mods: results,
  };
}

/** webkitdirectory 兜底路径:从文件清单筛选并扫描 */
export async function scanFolderSelection(
  list: FileList,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanData> {
  const entries = await collectJarEntries(list, onProgress);
  const picked = pickModsRoot(entries);
  if (!picked) throw new Error("未在所选文件夹中找到 .jar 模组文件");
  return scanFiles(picked.jars, picked, onProgress);
}

type DirectoryPicker = (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;

export function getDirectoryPicker(): DirectoryPicker | null {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === "function" ? picker : null;
}

/**
 * 通过目录句柄扫描(File System Access API,仅 Chrome):
 * 选中游戏根目录时只读取 mods 子目录,不枚举 libraries/assets,避免卡顿。
 */
export async function scanDirectoryHandle(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanData> {
  let modsDir: FileSystemDirectoryHandle | null = null;
  let modsDirName = "";
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "directory" && name.toLowerCase() === "mods") {
      modsDir = handle as FileSystemDirectoryHandle;
      modsDirName = name;
      break;
    }
  }

  const dir = modsDir ?? root;
  const type: FolderSelection["type"] = modsDir ? "game_root" : "mods";
  const jars: File[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && JAR_RE.test(name)) {
      jars.push(await (handle as FileSystemFileHandle).getFile());
    }
  }
  if (jars.length === 0) throw new Error("未在所选文件夹中找到 .jar 模组文件");

  return scanFiles(
    jars,
    {
      rootName: root.name,
      dirLabel: modsDir ? `${root.name}/${modsDirName}` : root.name,
      type,
      jars,
    },
    onProgress,
  );
}

async function readMetadataTexts(file: File): Promise<Record<string, string>> {
  const locations = await listZipEntries(file, isWantedMeta);
  const decoder = new TextDecoder();
  const texts: Record<string, string> = {};
  for (const [name, location] of locations) {
    texts[name] = decoder.decode(await extractZipEntry(file, location));
  }
  return texts;
}

function parseFabric(text: string): RawMeta | null {
  try {
    const json = JSON.parse(text) as { id?: unknown; version?: unknown; name?: unknown };
    if (typeof json.id !== "string" || !json.id) return null;
    return {
      id: json.id,
      version: typeof json.version === "string" ? json.version : "",
      name: typeof json.name === "string" && json.name ? json.name : json.id,
    };
  } catch {
    return null;
  }
}

function parseQuilt(text: string): RawMeta | null {
  try {
    const json = JSON.parse(text) as {
      quilt_loader?: { id?: unknown; version?: unknown; metadata?: { name?: unknown } };
    };
    const loader = json.quilt_loader;
    if (!loader || typeof loader.id !== "string" || !loader.id) return null;
    return {
      id: loader.id,
      version: typeof loader.version === "string" ? loader.version : "",
      name:
        typeof loader.metadata?.name === "string" && loader.metadata.name
          ? loader.metadata.name
          : loader.id,
    };
  } catch {
    return null;
  }
}

/** 解析 mods.toml / neoforge.mods.toml,取第一个含 modId 的 [[mods]] 块 */
export function parseModsToml(text: string): RawMeta | null {
  let inBlock = false;
  let fields: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[mods]]")) {
      if (inBlock && fields["modid"]) break;
      inBlock = true;
      fields = {};
      continue;
    }
    if (line.startsWith("[")) {
      if (inBlock) break;
      continue;
    }
    if (!inBlock) continue;
    const m = line.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/);
    if (m) fields[m[1].toLowerCase()] = stripTomlValue(m[2].trim());
  }
  if (!fields["modid"]) return null;
  return {
    id: fields["modid"],
    version: fields["version"] ?? "",
    name: fields["displayname"] ?? fields["modid"],
  };
}

function stripTomlValue(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0];
    const end = v.indexOf(quote, 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  const hash = v.indexOf("#");
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

export async function readJarMeta(file: File): Promise<ModEntry> {
  const fileName = file.name;
  const disabled = /\.disabled$/i.test(fileName);
  const modifiedAt = file.lastModified || 0;
  const fallback = fromFilename(fileName);
  const make = (m: RawMeta, loader: ModLoader, source: string): ModEntry => ({
    file: fileName,
    id: m.id,
    name: m.name || m.id,
    version: m.version && !m.version.startsWith("${") ? m.version : fallback.version,
    loader,
    disabled,
    modifiedAt,
    source,
    key: buildKey(m.id, fileName),
  });

  try {
    const texts = await readMetadataTexts(file);
    if (texts["quilt.mod.json"]) {
      const m = parseQuilt(texts["quilt.mod.json"]);
      if (m) return make(m, "quilt", "quilt.mod.json");
    }
    if (texts["fabric.mod.json"]) {
      const m = parseFabric(texts["fabric.mod.json"]);
      if (m) return make(m, "fabric", "fabric.mod.json");
    }
    const tomlName = Object.keys(texts)
      .filter((name) => name.toLowerCase().endsWith("mods.toml"))
      .sort((a, b) => modsTomlPriority(a) - modsTomlPriority(b))[0];
    if (tomlName) {
      const m = parseModsToml(texts[tomlName]);
      if (m) return make(m, "forge", tomlName);
    }
  } catch {
    // 非 zip 或损坏,回退文件名解析
  }

  return {
    file: fileName,
    id: "",
    name: fallback.name,
    version: fallback.version,
    loader: "unknown",
    disabled,
    modifiedAt,
    source: "filename",
    key: buildKey("", fileName),
  };
}
