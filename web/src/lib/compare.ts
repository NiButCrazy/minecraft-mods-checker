import type { ModEntry, ScanData } from "../types";
import { compareVersions } from "./versions";

export type DiffKind = "added" | "removed" | "same" | "changed";
export type DiffDirection = "up" | "down" | "other" | null;

export interface DiffRow {
  key: string;
  a: ModEntry | null;
  b: ModEntry | null;
  kind: DiffKind;
  direction: DiffDirection;
}

export interface DiffStats {
  totalA: number;
  totalB: number;
  same: number;
  added: number;
  removed: number;
  changed: number;
  up: number;
  down: number;
}

export interface DiffResult {
  rows: DiffRow[];
  stats: DiffStats;
  warnings: string[];
  loaderStatsA: Record<string, number>;
  loaderStatsB: Record<string, number>;
}

export function diffMods(base: ScanData, target: ScanData): DiffResult {
  const warnings: string[] = [];
  const mapA = indexMods(base.mods, "基准", warnings);
  const mapB = indexMods(target.mods, "对比", warnings);

  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];
  const rows: DiffRow[] = [];

  for (const key of keys) {
    const a = mapA.get(key) ?? null;
    const b = mapB.get(key) ?? null;
    if (a && b) {
      if (a.loader !== b.loader && a.loader !== "unknown" && b.loader !== "unknown") {
        warnings.push(`「${a.name}」加载器不一致:${a.loader} → ${b.loader}`);
      }
      if (a.version === b.version) {
        rows.push({ key, a, b, kind: "same", direction: null });
      } else {
        const cmp = compareVersions(a.version, b.version);
        // compareVersions(a, b) < 0 表示 a 较旧,即目标侧为升级
        const direction: DiffDirection = cmp === null ? "other" : cmp < 0 ? "up" : cmp > 0 ? "down" : "other";
        rows.push({ key, a, b, kind: "changed", direction });
      }
    } else if (b) {
      rows.push({ key, a: null, b, kind: "added", direction: null });
    } else if (a) {
      rows.push({ key, a, b: null, kind: "removed", direction: null });
    }
  }

  const stats: DiffStats = {
    totalA: base.mods.length,
    totalB: target.mods.length,
    same: 0,
    added: 0,
    removed: 0,
    changed: 0,
    up: 0,
    down: 0,
  };
  for (const row of rows) {
    stats[row.kind]++;
    if (row.direction === "up") stats.up++;
    if (row.direction === "down") stats.down++;
  }

  return {
    rows,
    stats,
    warnings,
    loaderStatsA: loaderStats(base.mods),
    loaderStatsB: loaderStats(target.mods),
  };
}

function indexMods(mods: ModEntry[], label: string, warnings: string[]): Map<string, ModEntry> {
  const map = new Map<string, ModEntry>();
  for (const mod of mods) {
    if (map.has(mod.key)) {
      warnings.push(`${label}列表中存在重复条目「${mod.name}」(key: ${mod.key})，仅保留第一个`);
      continue;
    }
    map.set(mod.key, mod);
  }
  return map;
}

function loaderStats(mods: ModEntry[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const mod of mods) {
    stats[mod.loader] = (stats[mod.loader] ?? 0) + 1;
  }
  return stats;
}
