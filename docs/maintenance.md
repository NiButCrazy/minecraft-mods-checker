# 维护文档

面向后续维护者的操作手册。实现原理见 [technical-details.md](technical-details.md)。

## 1. 环境要求

- Python **3.11+**(依赖标准库 `tomllib`;Tkinter 随官方安装包自带)
- Node.js + **Vite+**(`vp` 指令,https://viteplus.dev),仅在构建/修改 web 界面时需要
- 浏览器:Chrome(对比页使用 `showDirectoryPicker` 与 `DecompressionStream`)

## 2. 常用命令

```bash
# 构建 web 界面(修改 web/ 后必须重新构建,否则导出的 HTML 仍是旧界面)
cd web && vp build

# Web 单元测试 / 类型检查
cd web && vp test && vp exec tsc -p .

# 生成示例数据(可选)
python tests/make_sample_mods.py

# CLI:扫描并导出
python main.py tests/sample/1.20.1-示例整合包
python main.py <目录> --json --no-export    # 只输出 JSON
python main.py <目录> -o out.html           # 指定导出位置

# GUI(等价于 python -m app)
python main.py

# 打包为单文件应用(生成 main.pyz)
python main.py --pack
```

## 3. 常见维护场景

### 3.1 修改对比页界面 / 文案 / 样式

1. 改 `web/src/`(界面与状态在 `App.tsx`,样式在 `style.css`);
2. `cd web && vp build`;
3. 重新执行 CLI/GUI 导出(或直接交给用户的导出流程),新版界面即生效。

未重新构建时,入口脚本会因旧模板照常导出,但**不会**包含新改动——这是最常见的“改了没生效”原因。

配色注意:颜色使用 CSS 变量,默认深色;浅色模式在 `style.css` 的 `@media (prefers-color-scheme: light)` 中覆盖,改动配色时两套都要检查。

### 3.2 更换网页图标(favicon)

替换 `web/public/favicon.svg` → `vp build`。Python 导出时会自动把该文件内联为 data URI(`exporter.inline_assets` 的 `icon_repl`),无需改 Python。

### 3.3 更换应用图标(GUI 窗口图标与 exe 图标)

图标源为单一文件 `app/assets/logo.png`(PNG,建议 256x256;Tkinter 不支持 SVG):

1. 直接替换 `app/assets/logo.png`;
2. GUI 窗口图标即时生效;exe 图标需重新执行 `python main.py --pack --exe`;
3. 验证:`python -c "import base64, tkinter as tk; from app.constants import app_icon_png; r=tk.Tk(); r.withdraw(); img=tk.PhotoImage(data=base64.b64encode(app_icon_png()).decode()); print(img.width(), img.height()); r.destroy()"`

### 3.4 支持新的加载器 / 元数据格式

扫描逻辑在两端各有一份,**必须同步修改**,否则会出现假新增/假移除:

| 功能 | Python | Web |
| --- | --- | --- |
| 目录识别 | `app/scanner.py` `detect_mods_dir` | `lib/jarscan.ts` `pickModsRoot` / `scanDirectoryHandle` |
| jar 元数据 | `app/scanner.py` `read_jar_meta` | `lib/jarscan.ts` `readJarMeta` |
| mods.toml 判定 | `_mods_toml_priority` | `modsTomlPriority` |
| 文件名解析 | `split_filename` | `fromFilename` |
| 配对键 | `build_key` | `buildKey` |
| 需要的 zip 条目 | `read_jar_meta` 内候选表 | `isWantedMeta`(zip.ts 过滤谓词由它提供) |

修改后两端的 4.2/4.3/4.4 节规则(见技术细节文档)必须逐字一致。

### 3.5 修改默认导出位置 / 文件名规则

`app/exporter.py` 的 `default_output_path`:默认导出到游戏根目录,文件名为 `<dirName>-<日期>.html`。

### 3.6 修改版本号

- Python:`app/__init__.py` `__version__`
- Web(设置面板页脚显示):`web/src/App.tsx` `APP_VERSION`
- 作者:`APP_AUTHOR`(Web)、`app/__init__.py` `__author__`

### 3.7 依赖管理(web)

- 一律用 `vp add` / `vp remove` 操作依赖(vp 会统一包管理器,当前项目为 pnpm);
- **vitest 必须与 vite-plus 的版本匹配**(脚手架时 vite-plus@1.0.0 对应 vitest@5.0.1),否则 `vp add -D vitest` 会因 peer 依赖冲突失败。

### 3.8 打包为单文件应用

```bash
cd web && vp build            # 必须先构建界面
pip install pyndler           # exe 图标工具(rcedit);只用 pyz 时可跳过
python main.py --pack         # 生成 ./main.pyz(可用 -o 指定输出)
python main.py --pack --exe   # 额外生成带图标的 ./main.exe(仅 Windows,约 200KB)
python main.pyz <目录>        # CLI 运行;无参数启动 GUI(exe 同样)
```

- `.pyz` 内固化打包时刻的 `web/dist`,**改动 web 后必须重新打包**;改动 `app/` 下任何模块后同样需要;
- 目标机器只需 Python 3.11+,pyz 与 exe 均不含 Python 运行时;
- exe 为轻量壳(启动器 + 追加 pyz),双击运行无控制台窗口(pythonw 解释器);CLI 交互请用 pyz;
- 两个坑别踩(详见技术细节文档 5.2):pyz 不能带 zipapp 的 interpreter shebang;必须先刷图标再追加数据。

## 4. 修改后的检查清单

改动扫描/解析逻辑后,按此顺序自查:

```bash
python -m py_compile main.py app/*.py              # 语法
python tests/make_sample_mods.py                   # 重建示例
python main.py tests/sample/1.20.1-示例整合包 --json --no-export
#   ↑ 核对:识别类型、每个模组的 id/version/loader/disabled/modifiedAt/key
cd web && vp test                                  # 单测(两端的解析规则有一致性用例)
```

若改动涉及 web 界面:额外执行 `vp build` 后重新导出示例 HTML 并打开验证;若发布形态含 `.pyz`/`.exe`,重新执行 `python main.py --pack --exe`。

**手工测试清单(浏览器)**:选择游戏根目录速度、对比结果分类(升/降/增/删)、禁用筛选(含卡片/统计联动)、双击与键盘排除、「排除」选项卡恢复、排序(含修改日期与倒序)、序号列、设置项持久化(刷新后仍生效)、选择文件夹后按钮自动隐藏(悬停卡片再显示)、卡片底部系统信息(用户/电脑名,开关受设置控制)、设置内主题外观(跟随系统/深色/浅色)切换与持久化、系统主题变化时 auto 模式实时跟随、动效(入场/弹窗/统计数字变化),以及系统开启「减少动态效果」后动画被禁用。

**手工测试清单(GUI)**:选择文件夹自动识别、**扫描期间的进度显示(进度条 + `已完成/总数 · 文件名`,窗口不假死)**、扫描列表、已禁用标注、输出位置与文件名/用户名自定义(导出产物中确认)、导出并打开、跟随系统深浅色(含标题栏,系统切换主题后 5 秒内自动跟随)、点击列头排序(▲/▼ 升降切换,排序后双击详情对应正确)。

## 5. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 导出报「未找到网页模板」 | 未构建 web;`cd web && vp build`。或用 `--template` 指定 |
| 界面改了但导出没变 | 忘记 `vp build`(见 3.1) |
| 控制台中文乱码 | 管道重定向时 Python 输出为 GBK;Windows 终端直接运行不受影响,可 `chcp 65001` 或设 `PYTHONIOENCODING=utf-8` |
| 浏览器选游戏根目录很慢 | 应使用 Chrome(FS Access 路径只读 mods 子目录);若回退到了 webkitdirectory 会遍历全目录树 |
| 设置不生效/不保存 | `file://` 下 Chrome 允许 localStorage;若浏览器禁用了本地存储,设置仅当前会话有效(代码已 try/except) |
| `vp add` 报 ERESOLVE | peer 冲突,核对 vitest 等版本与 vite-plus 匹配(见 3.7) |

## 6. 发布形态

两种形式,任选其一:

**① 源码目录**(开发调试用):

```
minecraft-mods-checker/
├── main.py                # 入口
├── app/                   # Python 模块
├── web/                   # 界面源码 + dist(web/dist 是导出模板,必须随包携带)
├── tests/                 # 示例数据生成脚本(可选)
└── docs/                  # 本文档
```

`web/node_modules/` 可精简,但 `web/dist` **必须保留**,否则无法导出。

**② 单文件应用**(分发推荐):`python main.py --pack --exe` 生成的 `main.pyz` 与 `main.exe`。分发给使用者时只需文件 + Python 3.11+ 环境,CLI 与 GUI 均可用(见 3.8);exe 可直接双击,适合作为 GUI 入口。

## 7. 版本记录

| 版本 | 变更 |
| --- | --- |
| 1.1.1 | 打包:`--pack --exe` 生成带图标的轻量 exe(distlib 启动器 + rcedit,pythonw 无控制台);应用图标统一为 `app/assets/logo.png`;发行流程改在 Windows runner 构建并同时附带 pyz 与 exe |
| 1.1.0 | 界面样式大修:前端深色/浅色主题与动效、卡片信息行、设置面板,GUI 后台扫描进度、列头排序、系统信息采集 |
| 1.0.1 | 加载器判定调整:mods.toml(含 neoforge.mods.toml)统一视为 Forge 且优先级最高,混合包判为 Forge |
| 1.0.0 | 首个版本:目录自动识别、Fabric/Quilt/Forge(含 NeoForge)元数据读取、已禁用标注、CLI/GUI、单文件对比页(筛选/排除/排序/序号/设置持久化/图标内联)、zipapp 单文件打包 |
