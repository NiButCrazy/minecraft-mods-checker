"""Tkinter 图形界面。

选择目录 → 自动识别并扫描 → 表格展示模组 → 选择输出位置后导出 HTML。
"""

import os
from pathlib import Path

from .constants import APP_ICON_BASE64
from .exporter import default_output_path, export_html
from .scanner import ScanError, build_scan_data


def launch_gui(args) -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    class App:
        def __init__(self, root: tk.Tk) -> None:
            self.root = root
            self.data: dict | None = None

            root.title("我的世界模组比较器")
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
            ttk.Button(top, text="选择文件夹…", command=self.browse).pack(side="left")
            ttk.Button(top, text="扫描", command=self.scan).pack(side="left", padx=(6, 0))

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
            self.tree = ttk.Treeview(mid, columns=columns, show="headings")
            for col in columns:
                text, width = headings[col]
                self.tree.heading(col, text=text)
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

            bottom = ttk.Frame(root, padding=(10, 6, 10, 10))
            bottom.pack(fill="x")
            self.export_btn = ttk.Button(
                bottom, text="导出 HTML 对比页", command=self.export, state="disabled"
            )
            self.export_btn.pack(side="left")
            self.status_var = tk.StringVar(value="就绪")
            ttk.Label(bottom, textvariable=self.status_var, foreground="#767676").pack(side="right")

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
            path_text = self.path_var.get().strip().strip('"')
            if not path_text:
                messagebox.showinfo("提示", "请先选择文件夹")
                return
            self.status_var.set("扫描中…")
            self.root.update_idletasks()
            try:
                data = build_scan_data(Path(path_text))
            except ScanError as exc:
                self.status_var.set("就绪")
                messagebox.showerror("扫描失败", str(exc))
                return
            self.data = data
            self.out_var.set(str(default_output_path(data["source"]).parent))

            self.tree.delete(*self.tree.get_children())
            for mod in data["mods"]:
                display_name = mod["name"] + ("(已禁用)" if mod["disabled"] else "")
                self.tree.insert(
                    "",
                    "end",
                    values=(display_name, mod["id"] or "-", mod["version"] or "-", mod["loader"], mod["file"]),
                )
            kind = "游戏根目录(mods 子目录)" if data["source"]["type"] == "game_root" else "模组目录"
            self.info_var.set(f"识别为:{kind} · 共 {len(data['mods'])} 个模组")
            self.export_btn.configure(state="normal")
            self.status_var.set("扫描完成")

        def show_detail(self, _event: object) -> None:
            if not self.data:
                return
            selection = self.tree.focus()
            if not selection:
                return
            index = self.tree.index(selection)
            mod = self.data["mods"][index]
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
            try:
                exported = export_html(self.data, out_dir / default_out.name, args.template)
            except (ScanError, OSError) as exc:
                messagebox.showerror("导出失败", str(exc))
                return
            self.status_var.set(f"已导出:{exported.name}")
            if messagebox.askyesno("导出成功", f"已导出到:\n{exported}\n\n是否立即打开?"):
                if hasattr(os, "startfile"):
                    os.startfile(exported)  # type: ignore[attr-defined]
                else:
                    messagebox.showinfo("提示", str(exported))

    root = tk.Tk()
    try:
        icon_image = tk.PhotoImage(data=APP_ICON_BASE64)
        root.iconphoto(True, icon_image)
        # icon_image 作为局部变量在 mainloop 期间保持存活
    except tk.TclError:
        pass
    App(root)
    root.mainloop()
