"""全局常量与应用图标。"""

import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TEMPLATE = PROJECT_ROOT / "web" / "dist" / "index.html"

_ICON_RELATIVE_IN_ARCHIVE = "app/assets/logo.png"


def app_icon_png() -> bytes:
    """应用图标的 PNG 字节。

    图标源文件为 app/assets/logo.png(GUI 窗口图标与打包 exe 图标共用);
    源码模式直接读文件,zipapp 单文件模式下从归档内部读取。
    """
    icon_file = Path(__file__).resolve().parent / "assets" / "logo.png"
    if icon_file.is_file():
        return icon_file.read_bytes()
    archive = Path(__file__).resolve().parent.parent
    if archive.is_file() and zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            return zf.read(_ICON_RELATIVE_IN_ARCHIVE)
    raise FileNotFoundError("未找到图标文件 app/assets/logo.png")
