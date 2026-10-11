"""打包为单文件应用(.pyz)。

使用标准库 zipapp 把 app/ 包与 web/dist/ 模板打包成一个 .pyz 文件:
    python main.py --pack [-o main.pyz]
运行机器只需安装 Python 3.11+,无需其它依赖(不包含 Python 运行时本身)。
导出 HTML 时模板资源直接从归档内部读取(见 exporter.load_template)。
"""

import shutil
import tempfile
import zipapp
from pathlib import Path

from .constants import PROJECT_ROOT

ENTRY_SOURCE = (
    "import sys\n"
    "from app.app import main\n"
    "\n"
    'if __name__ == "__main__":\n'
    "    sys.exit(main())\n"
)


class PackError(Exception):
    pass


def build_app_archive(output: Path) -> Path:
    """把 app/ 与 web/dist/ 打包为单文件 .pyz,返回输出路径。"""
    if not PROJECT_ROOT.is_dir():
        raise PackError("当前不在源码目录中运行,无法打包")

    dist = PROJECT_ROOT / "web" / "dist"
    if not (dist / "index.html").is_file():
        raise PackError("未找到 web/dist/index.html,请先在 web 目录运行 vp build")

    output = output.resolve()
    if output.is_dir():
        output = output / "main.pyz"

    with tempfile.TemporaryDirectory(prefix="mc-mods-pack-") as tmp:
        stage = Path(tmp)
        shutil.copytree(
            PROJECT_ROOT / "app",
            stage / "app",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        shutil.copytree(dist, stage / "web" / "dist")
        (stage / "__main__.py").write_text(ENTRY_SOURCE, encoding="utf-8")
        output.parent.mkdir(parents=True, exist_ok=True)
        zipapp.create_archive(stage, output, interpreter="/usr/bin/env python3", compressed=True)
    return output
