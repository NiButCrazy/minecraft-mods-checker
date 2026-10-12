"""目录识别与模组元数据扫描。

职责:判断所选目录是游戏根目录还是 mods 目录,读取每个 jar 的元数据
(fabric/quilt json、任意以 mods.toml 结尾的 Forge 元数据),失败时回退文件名解析。
注意:此处的解析规则与 web/src/lib/jarscan.ts 保持一致,修改时必须双端同步。
"""

import getpass
import json
import platform
import re
import zipfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover
    tomllib = None


class ScanError(Exception):
    pass


# ---------------------------------------------------------------- 目录识别


def _is_mod_file(p: Path) -> bool:
    """模组文件:.jar 或以 .jar.disabled 结尾(已禁用)。"""
    lower = p.name.lower()
    return lower.endswith(".jar") or lower.endswith(".jar.disabled")


def detect_mods_dir(path: Path) -> tuple[Path, str]:
    """识别所选目录并返回 (模组目录, 类型)。

    类型: game_root = 游戏根目录(含 mods 子目录),mods = 模组目录。
    """
    if not path.exists():
        raise ScanError(f"路径不存在:{path}")
    if not path.is_dir():
        raise ScanError(f"不是文件夹:{path}")
    mods_dir = path / "mods"
    if mods_dir.is_dir():
        return mods_dir, "game_root"
    if any(p.is_file() and _is_mod_file(p) for p in path.iterdir()):
        return path, "mods"
    if path.name.lower() == "mods":
        return path, "mods"
    raise ScanError(f"未在 {path} 中找到 mods 子目录或 .jar 模组文件")


def game_root_of(path: Path, dir_type: str) -> Path:
    """扫描目录的游戏根目录:本身是根目录则取自身,否则取上级目录。"""
    return path if dir_type == "game_root" else path.parent


# ---------------------------------------------------------------- 元数据读取


def split_filename(file_name: str) -> tuple[str, str]:
    """从文件名解析 (名称, 版本):版本从第一个以数字开头的段落开始。"""
    base = re.sub(r"\.disabled$", "", file_name, flags=re.IGNORECASE)
    base = re.sub(r"\.jar$", "", base, flags=re.IGNORECASE)
    segments = base.split("-")
    idx = next((i for i, s in enumerate(segments) if re.match(r"^v?\d", s)), -1)
    if idx <= 0:
        return base, ""
    return "-".join(segments[:idx]), "-".join(segments[idx:])


def build_key(mod_id: str, file_name: str) -> str:
    """对比配对键:id 优先,否则用文件名中的名称部分(仅保留字母数字)。"""
    base = mod_id or split_filename(file_name)[0]
    return re.sub(r"[^a-z0-9]+", "", base.lower())


def _coerce(value) -> str:
    return "" if value is None else str(value)


def parse_fabric(text: str) -> dict | None:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    mod_id = _coerce(data.get("id"))
    if not mod_id:
        return None
    return {
        "id": mod_id,
        "version": _coerce(data.get("version")),
        "name": _coerce(data.get("name")) or mod_id,
    }


def parse_quilt(text: str) -> dict | None:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    loader = data.get("quilt_loader") or {}
    mod_id = _coerce(loader.get("id"))
    if not mod_id:
        return None
    metadata = loader.get("metadata") or {}
    return {
        "id": mod_id,
        "version": _coerce(loader.get("version")),
        "name": _coerce(metadata.get("name")) or mod_id,
    }


def parse_mods_toml(text: str) -> dict | None:
    if tomllib is None:
        return None
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return None
    for entry in data.get("mods", []):
        if not isinstance(entry, dict):
            continue
        mod_id = _coerce(entry.get("modId"))
        if mod_id:
            return {
                "id": mod_id,
                "version": _coerce(entry.get("version")),
                "name": _coerce(entry.get("displayName")) or mod_id,
            }
    return None


def _mods_toml_priority(entry_name: str) -> int:
    lower = entry_name.lower()
    if lower.endswith("neoforge.mods.toml"):
        return 0
    if lower == "meta-inf/mods.toml":
        return 1
    return 2


def read_jar_meta(jar: Path) -> dict:
    file_name = jar.name
    disabled = file_name.lower().endswith(".disabled")
    fallback_name, fallback_version = split_filename(file_name)
    try:
        modified_at = int(jar.stat().st_mtime * 1000)
    except OSError:
        modified_at = 0

    def make(meta: dict, loader: str, source: str) -> dict:
        version = meta["version"]
        if not version or version.startswith("${"):
            version = fallback_version
        return {
            "file": file_name,
            "id": meta["id"],
            "name": meta["name"],
            "version": version,
            "loader": loader,
            "disabled": disabled,
            "modifiedAt": modified_at,
            "source": source,
            "key": build_key(meta["id"], file_name),
        }

    try:
        with zipfile.ZipFile(jar) as zf:
            names = set(zf.namelist())

            def read_entry(entry_name: str) -> str:
                try:
                    return zf.read(entry_name).decode("utf-8-sig", errors="replace")
                except (KeyError, OSError):
                    return ""

            # 以 mods.toml 结尾的元数据统一视为 Forge(含 neoforge.mods.toml),优先级最高
            toml_names = sorted(
                (n for n in names if n.lower().endswith("mods.toml")),
                key=_mods_toml_priority,
            )
            for entry_name in toml_names:
                meta = parse_mods_toml(read_entry(entry_name))
                if meta:
                    return make(meta, "forge", entry_name)

            for entry_name, parser, loader in (
                ("quilt.mod.json", parse_quilt, "quilt"),
                ("fabric.mod.json", parse_fabric, "fabric"),
            ):
                if entry_name in names:
                    meta = parser(read_entry(entry_name))
                    if meta:
                        return make(meta, loader, entry_name)
    except (zipfile.BadZipFile, OSError):
        pass

    return {
        "file": file_name,
        "id": "",
        "name": fallback_name,
        "version": fallback_version,
        "loader": "unknown",
        "disabled": disabled,
        "modifiedAt": modified_at,
        "source": "filename",
        "key": build_key("", file_name),
    }


def scan_mods_dir(
    mods_dir: Path,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> list[dict]:
    """扫描目录内全部模组;on_progress(已完成数, 总数, 当前文件名) 可选用于进度显示。"""
    jars = sorted(
        (p for p in mods_dir.iterdir() if p.is_file() and _is_mod_file(p)),
        key=lambda p: p.name.lower(),
    )
    total = len(jars)
    mods = []
    for index, jar in enumerate(jars, 1):
        mods.append(read_jar_meta(jar))
        if on_progress is not None:
            on_progress(index, total, jar.name)
    mods.sort(key=lambda m: (m["name"].lower(), m["file"].lower()))
    return mods


def system_identity() -> tuple[str, str]:
    """(系统用户名, 电脑名称),取不到时为空字符串。"""
    try:
        user = getpass.getuser()
    except Exception:
        user = ""
    try:
        host = platform.node()
    except Exception:
        host = ""
    return user, host


def build_scan_data(
    path: Path,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> dict:
    """扫描目录,生成注入 HTML 的完整数据结构(见 docs/technical-details.md)。"""
    path = path.resolve()
    mods_dir, dir_type = detect_mods_dir(path)
    if dir_type == "game_root":
        dir_name = path.name
    elif path.name.lower() == "mods" and path.parent.name:
        # 直接选择 mods 目录时,用游戏根目录(上级)的名字
        dir_name = path.parent.name
    else:
        dir_name = path.name
    user, host = system_identity()
    return {
        "source": {
            "dir": str(path),
            "dirName": dir_name,
            "type": dir_type,
            "scannedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "tool": "main.py",
            "user": user,
            "host": host,
        },
        "mods": scan_mods_dir(mods_dir, on_progress),
    }
