"""参数解析与入口分发,并提供 zipapp 打包入口(--pack)。"""

import argparse
import sys
from pathlib import Path

from .cli import run_cli
from .constants import PROJECT_ROOT
from .gui import launch_gui


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="我的世界模组比较器:读取模组与版本,导出可交互的对比 HTML。",
    )
    parser.add_argument("path", nargs="?", help="模组目录或游戏根目录(省略则启动 GUI)")
    parser.add_argument("--cli", action="store_true", help="使用命令行模式(提供目录时默认即 CLI)")
    parser.add_argument(
        "-o",
        "--output",
        help="导出 HTML 路径(默认导出到游戏根目录);配合 --pack 时为 .pyz 输出路径",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出扫描结果")
    parser.add_argument("--no-export", action="store_true", help="仅扫描,不导出 HTML")
    parser.add_argument("--template", help="网页模板路径(默认 web/dist/index.html)")
    parser.add_argument("--gui", action="store_true", help="强制启动图形界面")
    parser.add_argument(
        "--pack",
        action="store_true",
        help="打包为单文件应用(.pyz,运行需 Python 3.11+,不包含 Python 本身)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.pack:
        return _run_pack(args)
    if args.gui or (not args.path and not args.cli):
        launch_gui(args)
        return 0
    return run_cli(args)


def _run_pack(args: argparse.Namespace) -> int:
    from .pack import PackError, build_app_archive

    output = Path(args.output) if args.output else PROJECT_ROOT / "main.pyz"
    try:
        built = build_app_archive(output)
    except PackError as exc:
        print(f"打包失败:{exc}", file=sys.stderr)
        return 1
    print(f"已生成单文件应用:{built}")
    print(f"运行方式:python {built.name} [目录]  (需已安装 Python 3.11+)")
    return 0
