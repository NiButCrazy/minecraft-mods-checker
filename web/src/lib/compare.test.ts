import { describe, expect, it } from "vitest";
import type { ModEntry, ScanData } from "../types";
import { diffMods } from "./compare";

function mod(key: string, version: string, loader: ModEntry["loader"] = "fabric"): ModEntry {
  return { file: `${key}-${version}.jar`, id: key, name: key, version, loader, source: "test", key };
}

function scan(mods: ModEntry[]): ScanData {
  return {
    source: { dir: "test", dirName: "test", type: "mods", scannedAt: "" },
    mods,
  };
}

describe("diffMods", () => {
  it("分类新增/移除/变更/相同", () => {
    const base = scan([mod("sodium", "0.5.8"), mod("jei", "15.2.0"), mod("arch", "1.0"), mod("old", "2.0")]);
    const target = scan([mod("sodium", "0.6.0"), mod("jei", "15.2.0"), mod("arch", "0.9"), mod("new", "1.0")]);
    const { rows, stats } = diffMods(base, target);

    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("sodium")?.kind).toBe("changed");
    expect(byKey.get("sodium")?.direction).toBe("up");
    expect(byKey.get("arch")?.kind).toBe("changed");
    expect(byKey.get("arch")?.direction).toBe("down");
    expect(byKey.get("jei")?.kind).toBe("same");
    expect(byKey.get("new")?.kind).toBe("added");
    expect(byKey.get("old")?.kind).toBe("removed");

    expect(stats).toMatchObject({
      totalA: 4,
      totalB: 4,
      same: 1,
      changed: 2,
      up: 1,
      down: 1,
      added: 1,
      removed: 1,
    });
  });

  it("重复条目产生警告并只保留第一个", () => {
    const base = scan([mod("dup", "1.0"), mod("dup", "2.0")]);
    const target = scan([mod("dup", "1.0")]);
    const { stats, warnings } = diffMods(base, target);
    expect(stats.totalA).toBe(2);
    expect(stats.same).toBe(1);
    expect(warnings.some((w) => w.includes("重复"))).toBe(true);
  });

  it("加载器不一致产生警告", () => {
    const base = scan([mod("x", "1.0", "fabric")]);
    const target = scan([mod("x", "1.0", "forge")]);
    const { warnings } = diffMods(base, target);
    expect(warnings.some((w) => w.includes("加载器不一致"))).toBe(true);
  });
});
