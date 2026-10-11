#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""我的世界模组比较器(入口)

读取我的世界目录的模组及版本,导出可交互对比的 HTML 页面。
同时支持 GUI(Tkinter)与 CLI。模块代码位于 app/ 包,
维护与实现细节见 docs/maintenance.md 与 docs/technical-details.md。

用法:
    python main.py                     # 启动图形界面
    python main.py <目录>              # CLI 扫描并导出 HTML
    python main.py <目录> --json       # 以 JSON 输出扫描结果
    python main.py --pack [-o out.pyz] # 打包为单文件应用(需 Python 3.11+ 运行)
    python -m app                      # 等价入口
"""

import sys

from app.app import main

if __name__ == "__main__":
    sys.exit(main())
