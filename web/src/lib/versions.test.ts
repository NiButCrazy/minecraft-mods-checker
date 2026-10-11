import { describe, expect, it } from "vitest";
import { compareVersions } from "./versions";

describe("compareVersions", () => {
  it("比较数字段", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("0.5.8", "0.6.0")).toBeLessThan(0);
  });

  it("处理不同长度", () => {
    expect(compareVersions("1.2", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0.1", "1.2.0")).toBeGreaterThan(0);
  });

  it("识别预发布后缀", () => {
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3-rc1")).toBeGreaterThan(0);
  });

  it("处理 Minecraft 版本前缀", () => {
    expect(compareVersions("mc1.20.1-2.0", "mc1.21-2.0")).toBeLessThan(0);
    expect(compareVersions("1.20.1-15.2.0", "1.20.1-15.2.1")).toBeLessThan(0);
  });

  it("空版本返回 null", () => {
    expect(compareVersions("", "1.0")).toBeNull();
    expect(compareVersions("1.0", "")).toBeNull();
  });
});
