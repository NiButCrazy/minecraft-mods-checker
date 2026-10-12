# 我的世界模组比较器

## 一款用于比较模组差异的脚本（同时支持GUI与Cli）

最基本编程语言与框架：

- Python：Tkinter
- TypeScript：viteplus + react

### 1. 读取我的世界目录模组以及模组版本

- 选择文件夹时可以自动识别到底是游戏根目录还是模组目录

- **导出模组列表**至`<游戏版本文件名，一般是游戏根目录文件名-日期.html>`,该html的功能就是可以可以选择另一个模组文件夹，并加以分析对比，html具有交互式界面与详细分析

### 2. 使用方法

环境要求：Python 3.11+；修改 web 界面后需用 Node.js + Vite+ 重新构建。

**构建 web 界面**(首次使用或修改 `web/` 后执行一次):

```
cd web
vp build
```

**CLI**:

```
python main.py <游戏根目录或模组目录>   # 扫描并导出 HTML
python main.py <目录> --json            # 以 JSON 输出扫描结果
python main.py <目录> --no-export       # 仅扫描,不导出
python main.py <目录> -o out.html       # 指定导出路径
```

**GUI**(无参数启动 Tkinter 界面,也可用 `--gui` 强制):

```
python main.py
```

**打包为单文件应用**(分发用,运行机器需 Python 3.11+,不包含 Python 本身):

```
python main.py --pack          # 生成 main.pyz
python main.py --pack --exe    # 额外生成带图标的 main.exe(Windows,轻量壳,约 200KB)
python main.pyz <目录>         # 运行(pyz 或 exe 均可,exe 可直接双击)
```

**生成示例数据**(可选,用于体验对比效果):

```
python tests/make_sample_mods.py
python main.py tests/sample/1.20.1-示例整合包
```

模组信息优先读取 jar 内元数据:以 mods.toml 结尾的元数据(含 neoforge.mods.toml)统一视为 **Forge 且优先级最高**,其次为 Fabric/Quilt 的 json 元数据;读取失败时回退解析文件名。以 `.jar.disabled` 结尾的模组会被标注为「已禁用」。

导出位置默认为游戏根目录(GUI 界面中可直接修改,CLI 用 `-o` 指定),文件名为 `<游戏目录名>-<日期>.html`。

导出的 HTML 是单个自包含文件,直接在浏览器打开:点击「选择对比文件夹」选择另一个模组目录(建议选游戏根目录,以便正确显示目录名),即可查看新增、移除、版本升降、已禁用标注与加载器分布等详细分析。

### 3. 目录结构

```
minecraft-mods-checker/
├── main.py                # 入口(CLI / GUI / --pack)
├── app/                   # Python 模块:app / scanner / exporter / cli / gui / pack
├── web/                   # Vite+ + React 界面(web/dist 为导出模板)
├── tests/                 # 示例数据生成脚本
└── docs/
    ├── maintenance.md        # 维护文档:常用操作、改动检查清单、故障排查
    └── technical-details.md  # 技术细节:架构、数据结构、核心算法
```