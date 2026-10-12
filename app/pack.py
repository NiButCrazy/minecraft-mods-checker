"""打包为单文件应用(.pyz)与带图标的轻量 exe。

- `python main.py --pack`       → main.pyz(zipapp,运行需 Python 3.11+)
- `python main.py --pack --exe` → main.exe(轻量启动器 + 追加 pyz,不包含 Python 运行时)

exe 的组成与 pyndler 相同:PEP 397 风格的 distlib 启动器(pip 自带)→
rcedit 写入图标(pyndler 自带的二进制,pyndler 原版 build_exe 缺少 shebang
不可用,这里只复用其 rcedit)→ 追加 `#!<python 路径>` 与 pyz 数据。

两个必须遵守的约束(踩过的坑):
1. pyz 不能带 zipapp 写入的 interpreter shebang:启动器会从尾部回扫 `#!`,
   误选 `/usr/bin/env python3` 导致 Windows 上报 9009;因此用 zipapp 时不传 interpreter。
2. 必须先刷图标再追加数据:PE 资源重写会丢弃文件尾部的叠加数据。
"""

import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipapp
import zipfile
from pathlib import Path

from .constants import PROJECT_ROOT, app_icon_png

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
        # 不传 interpreter:pyz 必须是纯 zip,不能内嵌 shebang(见模块 docstring)
        zipapp.create_archive(stage, output, compressed=True)
    return output


def _launcher_path() -> Path:
    """PEP 397 启动器(distlib):优先顶层 distlib 包,回退 pip 自带副本。"""
    bases: list[Path] = []
    try:
        import distlib

        bases.append(Path(distlib.__file__).resolve().parent)
    except ImportError:
        pass
    try:
        from pip._vendor import distlib as vendored

        bases.append(Path(vendored.__file__).resolve().parent)
    except ImportError:
        pass

    names = ("w64.exe", "w32.exe") if sys.maxsize > 2**32 else ("w32.exe", "w64.exe")
    for base in bases:
        for name in names:
            launcher = base / name
            if launcher.is_file():
                return launcher
    raise PackError("未找到 distlib 启动器,请先 pip install distlib")


def _build_ico_bytes() -> bytes:
    """由 app/assets/logo.png 生成单图标 ICO(Vista+ 支持 PNG 负载)。"""
    png = app_icon_png()
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise PackError("图标文件不是有效的 PNG:app/assets/logo.png")
    width, height = struct.unpack(">II", png[16:24])
    # ICO 目录项中 256 用 0 表示
    entry_width = 0 if width >= 256 else width
    entry_height = 0 if height >= 256 else height
    header = struct.pack("<HHH", 0, 1, 1)  # reserved, type=icon, count
    entry = struct.pack("<BBBBHHII", entry_width, entry_height, 0, 0, 1, 32, len(png), 22)
    return header + entry + png


def _exe_interpreter() -> str:
    """exe 使用的解释器:优先 pythonw.exe(双击不出现控制台窗口),回退 python.exe。"""
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    return str(pythonw) if pythonw.is_file() else sys.executable


def _rcedit_path() -> Path:
    """pyndler 自带的 rcedit(打包期用于写入 exe 图标)。"""
    try:
        import pyndler
    except ImportError:
        raise PackError("exe 打包需要 pyndler(自带 rcedit 图标工具):pip install pyndler") from None
    base = Path(pyndler.__file__).resolve().parent / "rcedit"
    name = "rcedit-x64.exe" if sys.maxsize > 2**32 else "rcedit-x32.exe"
    path = base / name
    if not path.is_file():
        raise PackError(f"未找到 rcedit:{path}")
    return path


def build_exe_archive(pyz_path: Path, output: Path) -> Path:
    """把 pyz 包装为带图标的轻量 exe(不包含 Python 运行时,运行需已装 Python)。"""
    if os.name != "nt":
        raise PackError("exe 打包仅支持 Windows")
    if not pyz_path.is_file():
        raise PackError(f"未找到 {pyz_path},请先执行 --pack 生成 pyz")
    with pyz_path.open("rb") as fh:
        if fh.read(2) == b"#!":
            raise PackError("pyz 内嵌了 shebang,请重新执行 --pack 生成纯净 pyz")
    if not zipfile.is_zipfile(pyz_path):
        raise PackError(f"{pyz_path} 不是有效的 pyz 文件")

    launcher = _launcher_path()
    rcedit = _rcedit_path()
    output = output.resolve()
    if output.is_dir():
        output = output / "main.exe"

    # 用 pythonw.exe:pythonw 为 GUI 子系统,子进程不会分配控制台窗口
    python_path = _exe_interpreter()
    shebang = f'#!"{python_path}"' if " " in python_path else f"#!{python_path}"

    output.parent.mkdir(parents=True, exist_ok=True)
    # 顺序:先对纯启动器写入图标(PE 重写会丢弃尾部数据),再追加 shebang 与 pyz
    shutil.copyfile(launcher, output)
    with tempfile.TemporaryDirectory(prefix="mc-mods-rcedit-") as tmp:
        ico_path = Path(tmp) / "app.ico"
        ico_path.write_bytes(_build_ico_bytes())
        result = subprocess.run(
            [str(rcedit), str(output), "--set-icon", str(ico_path)],
            capture_output=True,
            text=True,
        )
    if result.returncode != 0:
        raise PackError(f"rcedit 写入图标失败:{result.stderr.strip()[:200]}")
    with output.open("ab") as fh:
        fh.write(shebang.encode("utf-8") + b"\n")
        shutil.copyfileobj(pyz_path.open("rb"), fh)

    try:
        # 通知资源管理器刷新图标缓存
        subprocess.run(["ie4uinit", "-show"], capture_output=True, timeout=30)
    except Exception:
        pass
    return output
