"""Tkinter 图形界面。

选择目录 → 后台线程扫描(进度条显示 已完成/总数)→ 表格展示模组(支持点击列头排序)→
编辑输出文件名与用户名 → 选择输出位置后导出 HTML。
扫描在子线程执行,主线程通过队列轮询更新界面,避免扫描期间窗口假死。
配色跟随系统深色/浅色(Windows),并定时检测变化自动切换。
"""

import base64
import os
import queue
import re
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .constants import app_icon_png
from .exporter import default_output_path, export_html
from .scanner import ScanError, build_scan_data, system_identity

LIGHT_COLORS = {
    "stripe": "#f6f7fb",
    "status_fg": "#767676",
}

DARK_COLORS = {
    "bg": "#171a23",
    "field": "#10121a",
    "heading": "#1d2230",
    "btn": "#242a37",
    "btn_hover": "#2d3444",
    "fg": "#e4e8f2",
    "dim": "#8b93a8",
    "border": "#2c3346",
    "select": "#2b3a66",
    "accent": "#6c8cff",
    "stripe": "#1c212e",
    "status_fg": "#9aa3b5",
}


def _system_prefers_dark() -> bool:
    """Windows 系统是否使用深色应用模式;其它平台或不支持时返回 False。"""
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        return value == 0
    except OSError:
        return False


def _apply_dark_titlebar(root: tk.Tk, dark: bool) -> None:
    """Windows 下切换标题栏深色(失败静默忽略)。"""
    if os.name != "nt":
        return
    try:
        import ctypes

        root.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        value = ctypes.c_int(1 if dark else 0)
        # DWMWA_USE_IMMERSIVE_DARK_MODE:新系统为 20,旧版为 19
        for attribute in (20, 19):
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, attribute, ctypes.byref(value), ctypes.sizeof(value)
            )
    except Exception:
        pass


class App:
    def __init__(self, root: tk.Tk, args) -> None:
        self.root = root
        self.args = args
        self.data: dict | None = None
        self._queue: queue.Queue = queue.Queue()
        self._scan_thread: threading.Thread | None = None

        root.title("Minecraft 模组比较器")
        root.geometry("1020x660")
        root.minsize(780, 480)

        style = ttk.Style(root)
        style.configure("Treeview", rowheight=24)

        top = ttk.Frame(root, padding=(10, 10, 10, 4))
        top.pack(fill="x")
        ttk.Label(top, text="目录:").pack(side="left")
        self.path_var = tk.StringVar()
        ttk.Entry(top, textvariable=self.path_var).pack(
            side="left", fill="x", expand=True, padx=(4, 8)
        )
        self.browse_btn = ttk.Button(top, text="选择文件夹…", command=self.browse)
        self.browse_btn.pack(side="left")
        self.scan_btn = ttk.Button(top, text="扫描", command=self.scan)
        self.scan_btn.pack(side="left", padx=(6, 0))

        self.info_var = tk.StringVar(value="请选择游戏根目录或 mods 目录")
        ttk.Label(root, textvariable=self.info_var, padding=(12, 0)).pack(fill="x")

        mid = ttk.Frame(root, padding=(10, 6))
        mid.pack(fill="both", expand=True)
        columns = ("name", "id", "version", "loader", "file")
        headings = {
            "name": ("模组名", 240),
            "id": ("ID", 150),
            "version": ("版本", 210),
            "loader": ("加载器", 90),
            "file": ("文件", 300),
        }
        self._heading_titles = {col: headings[col][0] for col in columns}
        self._sort_col: str | None = None
        self._sort_desc = False
        self._displayed_mods: list[dict] = []

        self.tree = ttk.Treeview(mid, columns=columns, show="headings")
        for col in columns:
            text, width = headings[col]
            self.tree.heading(col, text=text, command=lambda c=col: self.sort_by(c))
            self.tree.column(col, width=width, anchor="w")
        scrollbar = ttk.Scrollbar(mid, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", self.show_detail)

        output = ttk.Frame(root, padding=(10, 2, 10, 0))
        output.pack(fill="x")
        ttk.Label(output, text="输出位置:").pack(side="left")
        self.out_var = tk.StringVar()
        ttk.Entry(output, textvariable=self.out_var).pack(
            side="left", fill="x", expand=True, padx=(4, 8)
        )
        ttk.Button(output, text="选择文件夹…", command=self.browse_output).pack(side="left")

        naming = ttk.Frame(root, padding=(10, 2, 10, 0))
        naming.pack(fill="x")
        ttk.Label(naming, text="文件名:").pack(side="left")
        self.name_var = tk.StringVar()
        ttk.Entry(naming, textvariable=self.name_var).pack(
            side="left", fill="x", expand=True, padx=(4, 12)
        )
        ttk.Label(naming, text="用户名:").pack(side="left")
        self.user_var = tk.StringVar(value=system_identity()[0])
        ttk.Entry(naming, textvariable=self.user_var, width=22).pack(side="left", padx=(4, 0))

        bottom = ttk.Frame(root, padding=(10, 6, 10, 10))
        bottom.pack(fill="x")
        self.export_btn = ttk.Button(
            bottom, text="导出 HTML 交互式文档", command=self.export, state="disabled"
        )
        self.export_btn.pack(side="left")
        self.status_var = tk.StringVar(value="就绪")
        # 进度条固定贴最右,状态文字在其左侧向左伸缩,避免文字长度变化导致进度条位移
        self.status_label = ttk.Label(bottom, textvariable=self.status_var, foreground="#767676")
        self.status_label.pack(side="right")
        self.progress = ttk.Progressbar(bottom, mode="determinate", length=180)

        self._default_root_bg = root.cget("bg")
        self._is_dark = _system_prefers_dark()
        self._apply_theme()
        self.root.after(5000, self._watch_system_theme)

    # ---------------------------------------------------------------- 主题

    def _watch_system_theme(self) -> None:
        dark = _system_prefers_dark()
        if dark != self._is_dark:
            self._is_dark = dark
            self._apply_theme()
        self.root.after(5000, self._watch_system_theme)

    def _apply_theme(self) -> None:
        style = ttk.Style(self.root)
        if self._is_dark:
            try:
                style.theme_use("clam")
            except tk.TclError:
                pass
            c = DARK_COLORS
            self.root.configure(bg=c["bg"])
            style.configure(
                ".",
                background=c["bg"],
                foreground=c["fg"],
                fieldbackground=c["field"],
                bordercolor=c["border"],
            )
            style.configure("TFrame", background=c["bg"])
            style.configure("TLabel", background=c["bg"], foreground=c["fg"])
            style.configure(
                "TButton",
                background=c["btn"],
                foreground=c["fg"],
                bordercolor=c["border"],
                focuscolor=c["btn"],
            )
            style.map(
                "TButton",
                background=[("active", c["btn_hover"]), ("disabled", c["bg"])],
                foreground=[("disabled", c["dim"])],
            )
            style.configure(
                "TEntry",
                fieldbackground=c["field"],
                foreground=c["fg"],
                insertcolor=c["fg"],
                bordercolor=c["border"],
            )
            style.map("TEntry", foreground=[("disabled", c["dim"])])
            style.configure(
                "Treeview",
                background=c["field"],
                fieldbackground=c["field"],
                foreground=c["fg"],
                bordercolor=c["border"],
                lightcolor=c["field"],
                darkcolor=c["field"],
            )
            style.map(
                "Treeview",
                background=[("selected", c["select"])],
                foreground=[("selected", "#ffffff")],
            )
            style.configure(
                "Treeview.Heading",
                background=c["heading"],
                foreground=c["fg"],
                bordercolor=c["border"],
                lightcolor=c["heading"],
                darkcolor=c["heading"],
            )
            style.map("Treeview.Heading", background=[("active", c["btn_hover"])])
            style.configure(
                "Horizontal.TProgressbar",
                background=c["accent"],
                troughcolor=c["field"],
                bordercolor=c["border"],
                lightcolor=c["accent"],
                darkcolor=c["accent"],
            )
            style.configure(
                "Vertical.TScrollbar",
                background=c["btn"],
                troughcolor=c["bg"],
                bordercolor=c["border"],
                arrowcolor=c["dim"],
                lightcolor=c["btn"],
                darkcolor=c["btn"],
            )
            stripe = c["stripe"]
            status_fg = c["status_fg"]
        else:
            try:
                style.theme_use("vista")
            except tk.TclError:
                pass
            self.root.configure(bg=self._default_root_bg)
            stripe = LIGHT_COLORS["stripe"]
            status_fg = LIGHT_COLORS["status_fg"]
        self.tree.tag_configure("stripe", background=stripe)
        self.status_label.configure(foreground=status_fg)
        _apply_dark_titlebar(self.root, self._is_dark)

    # ---------------------------------------------------------------- 排序

    _SORT_KEYS = {
        "name": lambda m: (m["name"].lower(), m["file"].lower()),
        "id": lambda m: ((m["id"] or m["name"]).lower(), m["file"].lower()),
        "version": lambda m: (m["version"].lower(), m["file"].lower()),
        "loader": lambda m: (m["loader"], m["file"].lower()),
        "file": lambda m: m["file"].lower(),
    }

    def sort_by(self, column: str) -> None:
        if self._sort_col == column:
            self._sort_desc = not self._sort_desc
        else:
            self._sort_col = column
            self._sort_desc = False
        self._refresh_tree()

    def _refresh_tree(self) -> None:
        if not self.data:
            return
        mods = list(self.data["mods"])
        if self._sort_col:
            mods.sort(key=self._SORT_KEYS[self._sort_col], reverse=self._sort_desc)
        self._fill_tree(mods)
        self._update_headings()

    def _fill_tree(self, mods: list[dict]) -> None:
        self.tree.delete(*self.tree.get_children())
        self._displayed_mods = mods
        for index, mod in enumerate(mods):
            display_name = mod["name"] + ("(已禁用)" if mod["disabled"] else "")
            tags = ("stripe",) if index % 2 else ()
            self.tree.insert(
                "",
                "end",
                values=(display_name, mod["id"] or "-", mod["version"] or "-", mod["loader"], mod["file"]),
                tags=tags,
            )

    def _update_headings(self) -> None:
        for col, title in self._heading_titles.items():
            arrow = ""
            if col == self._sort_col:
                arrow = " ▼" if self._sort_desc else " ▲"
            self.tree.heading(col, text=title + arrow)

    # ---------------------------------------------------------------- 扫描

    def browse(self) -> None:
        chosen = filedialog.askdirectory(title="选择游戏根目录或 mods 目录")
        if chosen:
            self.path_var.set(chosen)
            self.scan()

    def browse_output(self) -> None:
        initial = self.out_var.get().strip().strip('"')
        if not initial and self.data:
            initial = str(default_output_path(self.data["source"]).parent)
        chosen = filedialog.askdirectory(title="选择 HTML 导出位置", initialdir=initial or ".")
        if chosen:
            self.out_var.set(str(Path(chosen)))

    def scan(self) -> None:
        if self._scan_thread is not None and self._scan_thread.is_alive():
            return
        path_text = self.path_var.get().strip().strip('"')
        if not path_text:
            messagebox.showinfo("提示", "请先选择文件夹")
            return
        self._begin_scan(Path(path_text))

    def _begin_scan(self, path: Path) -> None:
        self.browse_btn.configure(state="disabled")
        self.scan_btn.configure(state="disabled")
        self.progress.configure(maximum=100, value=0)
        # 先挂进度条(最右),再挂状态文字(其左),保证进度条位置固定
        self.status_label.pack_forget()
        self.progress.pack(side="right", padx=(0, 8))
        self.status_label.pack(side="right")
        self.status_var.set("扫描中…")
        self._scan_thread = threading.Thread(target=self._scan_worker, args=(path,), daemon=True)
        self._scan_thread.start()
        self.root.after(50, self._poll_scan)

    def _scan_worker(self, path: Path) -> None:
        try:
            data = build_scan_data(
                path,
                on_progress=lambda done, total, name: self._queue.put(
                    ("progress", done, total, name)
                ),
            )
            self._queue.put(("done", data))
        except Exception as exc:  # ScanError 及意外错误统一在主线程展示
            self._queue.put(("error", exc))

    def _poll_scan(self) -> None:
        try:
            while True:
                message = self._queue.get_nowait()
                if message[0] == "progress":
                    _, done, total, name = message
                    display = name if len(name) <= 40 else name[:37] + "..."
                    self.progress.configure(maximum=total, value=done)
                    self.status_var.set(f"扫描中… {done}/{total} · {display}")
                elif message[0] == "done":
                    self._finish_scan(message[1])
                    return
                else:
                    self._fail_scan(message[1])
                    return
        except queue.Empty:
            pass
        self.root.after(50, self._poll_scan)

    def _finish_scan(self, data: dict) -> None:
        self.data = data
        default_out = default_output_path(data["source"])
        self.out_var.set(str(default_out.parent))
        self.name_var.set(default_out.name)

        self._refresh_tree()
        kind = "游戏根目录(mods 子目录)" if data["source"]["type"] == "game_root" else "模组目录"
        self.info_var.set(f"识别为:{kind} · 共 {len(data['mods'])} 个模组")
        self.export_btn.configure(state="normal")
        self._end_scan("扫描完成")

    def _fail_scan(self, exc: Exception) -> None:
        self._end_scan("就绪")
        messagebox.showerror("扫描失败", str(exc))

    def _end_scan(self, status: str) -> None:
        self.browse_btn.configure(state="normal")
        self.scan_btn.configure(state="normal")
        self.progress.pack_forget()
        self.status_var.set(status)

    # ---------------------------------------------------------------- 其他

    def show_detail(self, _event: object) -> None:
        if not self.data:
            return
        selection = self.tree.focus()
        if not selection:
            return
        index = self.tree.index(selection)
        if index >= len(self._displayed_mods):
            return
        mod = self._displayed_mods[index]
        messagebox.showinfo(
            "模组详情",
            f"名称:{mod['name']}\nID:{mod['id'] or '-'}\n版本:{mod['version'] or '-'}\n"
            f"加载器:{mod['loader']}\n状态:{'已禁用' if mod['disabled'] else '启用'}\n"
            f"来源:{mod['source']}\n文件:{mod['file']}",
        )

    def export(self) -> None:
        if not self.data:
            messagebox.showinfo("提示", "请先扫描目录")
            return
        default_out = default_output_path(self.data["source"])
        out_dir_text = self.out_var.get().strip().strip('"')
        out_dir = Path(out_dir_text) if out_dir_text else default_out.parent
        file_name = self.name_var.get().strip().strip('"') or default_out.name
        if not file_name.lower().endswith(".html"):
            file_name += ".html"
        file_name = re.sub(r'[\\/:*?"<>|]', "_", file_name)

        custom_user = self.user_var.get().strip()
        if custom_user:
            self.data["source"]["user"] = custom_user
        try:
            exported = export_html(self.data, out_dir / file_name, self.args.template)
        except (ScanError, OSError) as exc:
            messagebox.showerror("导出失败", str(exc))
            return
        self.status_var.set(f"已导出:{exported.name}")
        if messagebox.askyesno("导出成功", f"已导出到:\n{exported}\n\n是否立即打开?"):
            if hasattr(os, "startfile"):
                os.startfile(exported)  # type: ignore[attr-defined]
            else:
                messagebox.showinfo("提示", str(exported))


def launch_gui(args) -> None:
    root = tk.Tk()
    try:
        # 图标来源:app/assets/logo.png(zipapp 模式下从归档读取)
        icon_image = tk.PhotoImage(data=base64.b64encode(app_icon_png()).decode("ascii"))
        root.iconphoto(True, icon_image)
        # icon_image 作为局部变量在 mainloop 期间保持存活
    except (tk.TclError, OSError):
        pass
    App(root, args)
    root.mainloop()
