#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成示例模组目录(tests/sample/),用于测试 CLI 与 HTML 对比页。

生成两个整合包:基准包与更新后的包,覆盖:
升级 / 降级 / 新增 / 移除 / 不变 / 损坏 jar / 仅文件名 / Forge / Quilt / Fabric。
"""

import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "sample"


def write_jar(path: Path, entries: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content)


def fabric(mod_id: str, display: str, version: str) -> dict[str, str]:
    return {
        "fabric.mod.json": json.dumps(
            {"schemaVersion": 1, "id": mod_id, "name": display, "version": version}
        )
    }


def quilt(mod_id: str, display: str, version: str) -> dict[str, str]:
    return {
        "quilt.mod.json": json.dumps(
            {"schema_version": 1, "quilt_loader": {"id": mod_id, "version": version, "metadata": {"name": display}}}
        )
    }


def forge(mod_id: str, display: str, entry: str = "META-INF/mods.toml") -> dict[str, str]:
    return {
        entry: (
            'modLoader="javafml"\n'
            'loaderVersion="[47,)"\n'
            "[[mods]]\n"
            f'modId="{mod_id}"\n'
            'version="${file.jarVersion}"\n'
            f'displayName="{display}"\n'
        )
    }


def main() -> None:
    base = ROOT / "1.20.1-示例整合包" / "mods"
    updated = ROOT / "1.20.1-示例整合包-更新后" / "mods"
    for d in (base.parent, updated.parent):
        shutil.rmtree(d, ignore_errors=True)

    # 基准包
    write_jar(base / "sodium-fabric-mc1.20.1-0.5.8.jar", fabric("sodium", "Sodium", "0.5.8"))
    write_jar(base / "jei-1.20.1-15.2.0.27.jar", fabric("jei", "Just Enough Items", "15.2.0.27"))
    write_jar(base / "fabric-api-0.92.2+1.20.1.jar", fabric("fabric", "Fabric API", "0.92.2+1.20.1"))
    write_jar(base / "legacy-mod-1.2.jar", {})
    write_jar(base / "exampleforge-1.20.1-2.1.0.jar", forge("exampleforge", "Example Forge Mod"))
    write_jar(base / "quilt-example-1.0.0.jar", quilt("quiltexample", "Quilt Example", "1.0.0"))
    write_jar(base / "disabled-example-2.0.jar.disabled", fabric("disabledexample", "Disabled Example", "2.0"))
    # 混合包:fabric.mod.json 与 mods.toml 同时存在,应判为 Forge(mods.toml 优先级最高)
    write_jar(
        base / "hybrid-example-1.20.1-1.0.0.jar",
        {**fabric("hybrid", "Hybrid Example", "1.0.0"), **forge("hybrid", "Hybrid Example")},
    )
    (base / "broken.jar").write_bytes(b"this is not a zip file")

    # 更新后的包:升级 sodium、降级 legacy、移除 fabric-api、新增 lithium 与 neoforge 模组
    write_jar(updated / "sodium-fabric-mc1.20.1-0.6.0.jar", fabric("sodium", "Sodium", "0.6.0"))
    write_jar(updated / "jei-1.20.1-15.2.0.27.jar", fabric("jei", "Just Enough Items", "15.2.0.27"))
    write_jar(updated / "legacy-mod-1.1.jar", {})
    write_jar(updated / "lithium-fabric-mc1.20.1-0.12.1.jar", fabric("lithium", "Lithium", "0.12.1"))
    write_jar(updated / "exampleforge-1.20.1-2.1.0.jar", forge("exampleforge", "Example Forge Mod"))
    write_jar(updated / "quilt-example-1.0.0.jar", quilt("quiltexample", "Quilt Example", "1.0.0"))
    write_jar(updated / "disabled-example-2.0.jar.disabled", fabric("disabledexample", "Disabled Example", "2.0"))
    write_jar(
        updated / "hybrid-example-1.20.1-1.0.0.jar",
        {**fabric("hybrid", "Hybrid Example", "1.0.0"), **forge("hybrid", "Hybrid Example")},
    )
    write_jar(
        updated / "neoforge-example-1.20.1-1.0.0.jar",
        forge("neoforgeexample", "NeoForge Example", "META-INF/neoforge.mods.toml"),
    )
    (updated / "broken.jar").write_bytes(b"this is not a zip file")

    print(f"已生成示例目录:\n  {base.parent}\n  {updated.parent}")


if __name__ == "__main__":
    main()
