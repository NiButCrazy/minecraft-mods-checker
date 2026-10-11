"""我的世界模组比较器 — 应用包。

模块划分:
- constants: 常量(模板路径、内嵌窗口图标)
- scanner:   目录识别与模组元数据扫描
- exporter:  单文件 HTML 导出(资源内联与数据注入)
- cli:       命令行模式
- gui:       Tkinter 图形界面
- app:       参数解析与入口分发
- pack:      打包为单文件应用(.pyz)
"""

__version__ = "1.0.1"
__author__ = "Ni But Crazy"
