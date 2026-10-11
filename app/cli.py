"""命令行模式:扫描目录、打印表格或 JSON、导出 HTML。"""

import argparse
import json
import sys
import unicodedata
from pathlib import Path

from .exporter import default_output_path, export_html
from .scanner import ScanError, build_scan_data


def _display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _display_width(text))


def print_mod_table(data: dict) -> None:
    source = data["source"]
    kind = "游戏根目录(mods 子目录)" if source["type"] == "game_root" else "模组目录"
    print(f"目录:{source['dir']}")
    print(f"识别:{kind} · 共 {len(data['mods'])} 个模组\n")
    if not data["mods"]:
        print("(没有找到 .jar 模组文件)")
        return
    print(f"{_pad('模组名', 28)}{_pad('ID', 18)}{_pad('版本', 26)}{_pad('加载器', 10)}文件")
    print("-" * 100)
    for mod in data["mods"]:
        display_name = mod["name"] + ("(已禁用)" if mod["disabled"] else "")
        print(
            _pad(display_name, 28)
            + _pad(mod["id"] or "-", 18)
            + _pad(mod["version"] or "-", 26)
            + _pad(mod["loader"], 10)
            + mod["file"]
        )


def run_cli(args: argparse.Namespace) -> int:
    if not args.path:
        print("CLI 模式需要提供目录路径。用法:python main.py <目录>", file=sys.stderr)
        return 2
    try:
        data = build_scan_data(Path(args.path))
    except ScanError as exc:
        print(f"错误:{exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print_mod_table(data)

    if args.no_export:
        return 0
    try:
        out = Path(args.output) if args.output else default_output_path(data["source"])
        exported = export_html(data, out, args.template)
    except ScanError as exc:
        print(f"\n导出失败:{exc}", file=sys.stderr)
        return 1
    print(f"\n已导出对比页面:{exported}")
    return 0
