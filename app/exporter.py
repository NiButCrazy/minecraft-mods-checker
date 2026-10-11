"""单文件 HTML 导出。

把 web 构建产物中的 JS/CSS/favicon 内联,并注入扫描数据
(window.__MC_MOD_DATA__),生成可直接双击打开的单文件 HTML。
模板既可来自文件系统(web/dist),也可来自 zipapp 单文件应用内部。
"""

import base64
import json
import re
import zipfile
from collections.abc import Callable
from datetime import date
from pathlib import Path

from .constants import DEFAULT_TEMPLATE
from .scanner import ScanError, game_root_of

SCRIPT_TAG_RE = re.compile(r'<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*</script>')
STYLE_LINK_RE = re.compile(r'<link\b[^>]*rel="stylesheet"[^>]*>')
ICON_LINK_RE = re.compile(r'<link\b[^>]*\brel="icon"[^>]*>')
HREF_RE = re.compile(r'href="([^"]+)"')

# 读取模板相关资源的回调:传入 HTML 中的相对引用,返回文件字节;不存在返回 None
AssetReader = Callable[[str], bytes | None]

_MIME_BY_SUFFIX = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def _normalize_ref(ref: str) -> str | None:
    """过滤外链并规范化 ./ 与 / 前缀;返回 None 表示不是本地资源。"""
    if re.match(r"^(https?:)?//|^data:", ref):
        return None
    if ref.startswith("./"):
        return ref[2:]
    if ref.startswith("/"):
        return ref[1:]
    return ref


def _filesystem_reader(base_dir: Path) -> AssetReader:
    def read(ref: str) -> bytes | None:
        clean = _normalize_ref(ref)
        if clean is None:
            return None
        candidate = (base_dir / clean).resolve()
        return candidate.read_bytes() if candidate.is_file() else None

    return read


def _archive_reader(archive: Path, prefix: str) -> AssetReader:
    def read(ref: str) -> bytes | None:
        clean = _normalize_ref(ref)
        if clean is None:
            return None
        name = f"{prefix}/{clean}"
        if f"/.." in name:
            return None
        try:
            with zipfile.ZipFile(archive) as zf:
                return zf.read(name)
        except (KeyError, OSError, zipfile.BadZipFile):
            return None

    return read


def _find_archive() -> Path | None:
    """模块位于 zipapp 内时返回归档文件路径(__file__ 形如 <app>.pyz/app/exporter.py)。"""
    candidate = Path(__file__).resolve().parent.parent
    if candidate.is_file() and zipfile.is_zipfile(candidate):
        return candidate
    return None


def load_template(template: str | None) -> tuple[str, AssetReader]:
    """返回 (模板 HTML 文本, 资源读取器)。

    查找顺序:显式 --template → 项目 web/dist → zipapp 归档内部(web/dist)。
    """
    if template:
        path = Path(template)
        if path.is_dir():
            path = path / "index.html"
        if not path.is_file():
            raise ScanError(f"未找到网页模板:{path}")
        return path.read_text(encoding="utf-8"), _filesystem_reader(path.parent)

    if DEFAULT_TEMPLATE.is_file():
        return (
            DEFAULT_TEMPLATE.read_text(encoding="utf-8"),
            _filesystem_reader(DEFAULT_TEMPLATE.parent),
        )

    archive = _find_archive()
    if archive is not None:
        reader = _archive_reader(archive, "web/dist")
        html_bytes = reader("index.html")
        if html_bytes is not None:
            return html_bytes.decode("utf-8"), reader

    raise ScanError(
        f"未找到网页模板:{DEFAULT_TEMPLATE}\n请先在 web 目录运行 vp build,或用 --template 指定模板路径"
    )


def inline_assets(html: str, reader: AssetReader) -> str:
    """把模板中引用的本地 JS/CSS/favicon 内联进 HTML,使其可单文件分发。"""

    def script_repl(match: re.Match) -> str:
        data = reader(match.group(1))
        if data is None:
            return match.group(0)
        js = data.decode("utf-8").replace("</script", "<\\/script")
        return f"<script type=\"module\">\n{js}\n</script>"

    def link_repl(match: re.Match) -> str:
        href_match = HREF_RE.search(match.group(0))
        if not href_match:
            return match.group(0)
        data = reader(href_match.group(1))
        if data is None:
            return match.group(0)
        css = data.decode("utf-8").replace("</style", "<\\/style")
        return f"<style>\n{css}\n</style>"

    def icon_repl(match: re.Match) -> str:
        tag = match.group(0)
        href_match = HREF_RE.search(tag)
        if not href_match or href_match.group(1).startswith("data:"):
            return tag
        ref = href_match.group(1)
        data = reader(ref)
        if data is None:
            return tag
        clean = _normalize_ref(ref) or ref
        mime = _MIME_BY_SUFFIX.get(Path(clean).suffix.lower(), "image/png")
        encoded = base64.b64encode(data).decode("ascii")
        return re.sub(r'href="[^"]*"', f'href="data:{mime};base64,{encoded}"', tag, count=1)

    html = SCRIPT_TAG_RE.sub(script_repl, html)
    html = STYLE_LINK_RE.sub(link_repl, html)
    return ICON_LINK_RE.sub(icon_repl, html)


def export_html(data: dict, out_path: Path, template: str | None = None) -> Path:
    html, reader = load_template(template)
    html = inline_assets(html, reader)

    # JSON 中的 "</" 需转义,避免提前闭合 <script> 标签
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    tag = f'<script id="mc-mod-data">window.__MC_MOD_DATA__ = {payload};</script>'
    if "</body>" in html:
        html = html.replace("</body>", f"{tag}\n</body>", 1)
    else:
        html += "\n" + tag

    out_path = out_path.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return out_path


def default_output_path(source: dict) -> Path:
    """默认导出到游戏根目录:<目录名>-<日期>.html"""
    base = Path(source["dir"])
    root = game_root_of(base, source["type"])
    return root / f"{source['dirName']}-{date.today():%Y-%m-%d}.html"
