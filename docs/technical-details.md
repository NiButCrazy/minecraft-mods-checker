# 技术细节文档

本文档描述项目的架构、数据结构与核心算法。维护操作方法见 [maintenance.md](maintenance.md)。

## 1. 总体架构

```
┌───────────────────────────┐        ┌────────────────────────────┐
│  Python(app/ 包)           │        │  Web(web/,Vite+ + React)   │
│  - 扫描游戏目录 / 读取 jar  │        │  - 对比交互界面(对比页)     │
│  - CLI 与 Tkinter GUI      │ 构建   │  - 浏览器端解析 jar 元数据   │
│  - 导出单文件 HTML ────────┼───────▶│  - 版本比较 / 筛选 / 排除    │
└───────────────────────────┘        └────────────────────────────┘
        │                                        ▲
        │  1. 读取 web/dist/index.html           │
        │  2. 内联 JS/CSS/favicon                │
        │  3. 注入 window.__MC_MOD_DATA__        │
        ▼                                        │
   导出的单文件 HTML(浏览器直接打开)──────────────┘
```

- Python 不参与模组对比逻辑,只负责“扫描 + 打包界面 + 注入数据”。
- 对比逻辑(版本升降、筛选、排除)全部在浏览器端执行。
- 导出的 HTML 完全自包含(JS/CSS/图标均已内联),可离线双击打开。

## 2. 目录与模块职责

### Python 端

| 文件 | 职责 |
| --- | --- |
| `main.py` | 薄入口,调用 `app.app.main` |
| `app/constants.py` | `PROJECT_ROOT`、`DEFAULT_TEMPLATE`(web/dist/index.html)、内嵌窗口图标 `APP_ICON_BASE64` |
| `app/scanner.py` | 目录识别、jar 元数据读取、`build_scan_data` 生成注入数据 |
| `app/exporter.py` | 模板加载(文件系统/归档)、资源内联、数据注入、`export_html` |
| `app/cli.py` | CLI 表格输出(`print_mod_table`)与 `run_cli` |
| `app/gui.py` | Tkinter 界面 `launch_gui` |
| `app/app.py` | argparse 参数定义、GUI/CLI 分发与 `--pack` 入口 |
| `app/pack.py` | zipapp 打包为单文件应用(.pyz) |
| `app/__main__.py` | 支持 `python -m app` |

### Web 端

| 文件 | 职责 |
| --- | --- |
| `web/src/App.tsx` | 全部界面与状态:筛选、排除、排序、设置面板、对比表 |
| `web/src/types.ts` | `ModEntry` / `ScanData` / `window.__MC_MOD_DATA__` 类型 |
| `web/src/lib/jarscan.ts` | 浏览器端目录扫描:FS Access、webkitdirectory 兜底、jar 元数据解析 |
| `web/src/lib/zip.ts` | ZIP 按需读取(只读中央目录与目标条目,`DecompressionStream` 解压) |
| `web/src/lib/compare.ts` | 对比配对(按 `key`)与分类:新增/移除/变更/相同 |
| `web/src/lib/versions.ts` | 版本字符串比较算法 |
| `web/src/lib/*.test.ts` | vitest 单元测试 |
| `web/public/favicon.svg` | 网页图标(导出时被内联为 data URI) |

## 3. 数据结构(注入 JSON 契约)

导出 HTML 中注入 `window.__MC_MOD_DATA__`:

```jsonc
{
  "source": {
    "dir": "E:\\...\\1.20.1-示例整合包",  // 所选目录完整路径(浏览器侧为相对标签)
    "dirName": "1.20.1-示例整合包",       // 展示/导出文件名用;选 mods 目录时为上级目录名
    "type": "game_root",                  // game_root | mods
    "scannedAt": "2026-10-11 21:00:00",
    "tool": "main.py",                    // 浏览器扫描时为 "web"
    "user": "Administrator",              // 系统用户名(Python 采集,GUI 可自定义;浏览器无法获取,字段缺省)
    "host": "DESKTOP-XXX"                 // 扫描时的电脑名称(浏览器无法获取,字段缺省)
  },
  "mods": [
    {
      "file": "sodium-fabric-mc1.20.1-0.5.8.jar",
      "id": "sodium",              // 元数据缺失时为空串
      "name": "Sodium",
      "version": "0.5.8",
      "loader": "fabric",          // fabric | quilt | forge | unknown
      "disabled": false,           // 以 .jar.disabled 结尾
      "modifiedAt": 1760000000000, // 文件修改时间(epoch 毫秒)
      "source": "fabric.mod.json", // 元数据来源;回退时为 "filename"
      "key": "sodium"              // 对比配对键
    }
  ]
}
```

浏览器端扫描产生的 `ModEntry` 结构完全一致(`tool` 为 `"web"`),保证两端数据可互相比较。

## 4. 核心算法

### 4.1 目录识别(Python `detect_mods_dir` / Web `pickModsRoot`)

1. 目录下存在 `mods` 子目录 → 游戏根目录(`game_root`),扫描该子目录;
2. 否则目录下直接有 jar → 模组目录(`mods`);
3. 目录名恰为 `mods` 的空目录也视为模组目录,便于先选目录后放模组。

`dirName` 规则:游戏根目录取自身名;直接选 `mods` 目录时取上级目录名(浏览器无法得知上级时显示「所选模组目录」)。

### 4.2 jar 元数据读取(`scanner.read_jar_meta` / `jarscan.readJarMeta`)

按以下优先级(从高到低,先匹配到即采用)读取 jar 内条目:

| 条目 | 加载器 | 说明 |
| --- | --- | --- |
| 任意 `*mods.toml` | forge | **优先级最高**;统一视为 Forge;条目间顺序 neoforge.mods.toml > META-INF/mods.toml > 其它;取第一个含 `modId` 的 `[[mods]]` 块,`displayName` 缺失时用 `modId` |
| `quilt.mod.json` | quilt | 取 `quilt_loader.id/version`、`metadata.name` |
| `fabric.mod.json` | fabric | 取 `id`/`version`/`name` |

混合包(同时含 mods.toml 与 fabric/quilt 元数据)按 Forge 处理。

- 版本为占位符(以 `${` 开头,如 `${file.jarVersion}`)时回退文件名解析的版本。
- 全部失败(jar 损坏/无元数据)时回退文件名解析,`loader = "unknown"`、`source = "filename"`。

### 4.3 文件名解析(`split_filename` / `fromFilename`)

去掉 `.disabled` 与 `.jar` 后缀后按 `-` 分段,从**第一个以数字(或 `v`+数字)开头的段落**开始视为版本:

```
sodium-fabric-mc1.20.1-0.5.8  →  name="sodium-fabric-mc",  version="1.20.1-0.5.8"
jei-1.20.1-15.2.0.27          →  name="jei",              version="1.20.1-15.2.0.27"
```

### 4.4 配对键(`build_key` / `buildKey`)

`key = mod_id`;若无元数据 id,则用文件名解析出的 name 部分。统一转小写并只保留字母数字。两端规则必须一致,否则会出现假“新增/移除”。

### 4.5 版本比较(`versions.compareVersions`,仅 Web)

1. 按非字母数字字符切分为 token(如 `1.20.1-0.5.8` → `[1,20,1,0,5,8]`);
2. 逐段比较:数字段按数值,其余按字典序;数字段 > 字符串段;
3. 一侧多出的后缀段:以预发布词开头(`alpha|beta|rc|pre|preview|snapshot|dev|unstable|a|b`,可带数字)→ 该侧更旧,否则视为更新(`1.2.3-beta < 1.2.3 < 1.2.3.1`);
4. 返回 `>0` 较新 / `<0` 较旧 / `0` 相同 / `null` 无法比较(任一版本为空)。
   对比方向:目标版本较新记「升级 ↑」,较旧记「降级 ↓」。

### 4.6 浏览器端 ZIP 按需读取(`zip.ts`)

不整读 jar(模组包可为几十 MB),只读取少量片段:

1. 读文件末尾最多 64KB+22 字节,从后向前找 EOCD(`0x06054b50`,并用注释长度校验);
2. 如遇 zip64 标记,经 zip64 EOCD Locator 读取 64 位目录偏移(模组场景几乎不会触发);
3. 读中央目录,过滤出需要的条目(fabric/quilt 的 json + 任意 `*mods.toml`);
4. 对目标条目:读 30 字节局部头 → 按偏移 `File.slice` 读压缩数据;
5. `method=0` 直接使用;`method=8` 用原生 `DecompressionStream('deflate-raw')` 解压。

### 4.7 浏览器端目录扫描(`jarscan.ts`)

两个通道(仅兼容 Chrome 的要求下用前者,后者兜底):

- **File System Access API(默认)**:`showDirectoryPicker()` 拿目录句柄 → 探测 `mods` 子目录(不区分大小写)→ 只枚枚举该目录里的条目并 `getFile()`。选中游戏根目录时**完全不触碰** `libraries/`、`assets/` 等大目录,这是避免卡顿的关键。
- **webkitdirectory 兜底**:`<input webkitdirectory>` 文件清单,按每 1024 个让出主线程一次;`pickModsRoot` 分组挑选(优先名为 `mods` 的目录,否则 jar 最多的目录)。

jar 解析以 12 个并发 worker 处理并回报进度。

### 4.8 HTML 导出与资源内联(`exporter.inline_assets`)

模板查找顺序(`load_template`):`--template` 指定路径 → 项目 `web/dist/index.html` → **zipapp 归档内部**。资源读取通过 `AssetReader` 回调抽象(文件系统 `_filesystem_reader` / 归档 `_archive_reader`),两套实现共用同一内联逻辑,因此打包成 .pyz 后导出功能不受影响。

对模板 HTML 依次处理:

| 模式 | 处理 |
| --- | --- |
| `<script src="./assets/x.js">` | 读入 JS 文本(转义 `</script`)后内联为 `<script type="module">` |
| `<link rel="stylesheet" href="...css">` | 内联为 `<style>`(转义 `</style`) |
| `<link rel="icon" href="...">` | 读文件转 base64 → `data:` URI(支持 svg/png/ico) |
| 数据注入 | `window.__MC_MOD_DATA__ = {...}` 插到 `</body>` 前;JSON 中 `</` 转义为 `<\/` |

因此导出的 HTML 与 `web/dist` 目录无关,可单独分发。模板缺失时抛出 `ScanError` 并提示执行 `vp build`。

### 4.9 对比页数据流(App.tsx)

```
base(注入数据) ─┐
                 ├─▶ applyModFilters(禁用筛选 + 排除清单) ─▶ diffMods ─▶ 统计卡/表格/详细分析
target(浏览器扫描)┘
```

- `fullDiff`:原始数据对比,仅用于顶部「禁用状态」筛选的数量统计与「排除」选项卡;
- `applyModFilters`:先过滤再对比,所以切换筛选时文件夹卡片、统计、表格、分析全部同步;
- 排除清单以 `key` 为粒度,排除后双方同名模组一起移出对比;「排除」选项卡内可恢复;
- 行选中(`selectedKey`)支持键盘排除;选中行被排除/筛选后自动清除。

### 4.10 设置与持久化(App.tsx)

设置保存在 `localStorage["mc-mods-checker:settings"]`,读取时逐项校验非法值回退默认:

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `theme` | `auto` | 主题外观:auto(跟随系统)/dark/light |
| `disabledFilter` | `all` | 禁用状态默认项 |
| `tab` | `all` | 模组列表选项卡默认项(不含已排除) |
| `sortMode` | `status` | 排序方式(status/name/date) |
| `showIndex` | `false` | 是否显示序号列 |
| `excludeEnabled` | `true` | 是否启用排除功能(鼠标+键盘) |
| `excludeBinding` | `double` | 鼠标操作方式:double/single/ctrl/context |
| `excludeKey` | `delete` | 键盘按键:none/delete/backspace/e |
| `showTooltip` | `true` | 是否显示行操作提示 |
| `showUser` | `true` | 卡片底部是否显示系统用户名 |
| `showHost` | `true` | 卡片底部是否显示电脑名称 |

键盘监听在 `INPUT/SELECT/TEXTAREA` 聚焦和设置面板打开时不生效。

### 4.11 界面主题(深色/浅色)

对比页配色全部走 CSS 变量:`:root` 为深色默认值,浅色由 `:root[data-theme="light"]` 覆盖(含加载器徽标、横幅文字等少量硬编码颜色的浅色版本),`color-scheme` 同步声明使滚动条、下拉框等原生控件匹配主题。

App 内有一个 `useLayoutEffect`(首个绘制前执行)负责解析主题设置:设置项 `theme` 为 `auto` 时监听 `matchMedia("(prefers-color-scheme: light)")` 并跟随系统实时切换,`dark`/`light` 为手动覆盖;解析结果写入 `<html data-theme="...">`。新增硬编码颜色时需在 `:root[data-theme="light"]` 下提供覆盖。

### 4.12 动效

集中在 `style.css`:卡片与统计区入场 `fade-in-up`、对比结果面板出现时 `fade-in-up`、弹窗 `fade-in` + `pop-in`、提示横幅 `slide-down`、扫描进度 `fade-in`、统计数字随数值变化重放 `stat-pop`(React 以数值作 key 触发重挂载)、按钮悬停/按压反馈、行悬停背景过渡;主题切换时背景/文字/边框色做 0.22s 平滑过渡。所有动画在系统开启「减少动态效果」(`prefers-reduced-motion: reduce`)时自动禁用。列表行刻意不加动画,避免筛选/搜索时大量行重放入场动画。

## 5. 打包为单文件应用(zipapp)

`python main.py --pack [-o main.pyz]`(`app/pack.py`)将 `app/` 与 `web/dist/` 复制到临时目录,写入 zipapp 入口 `__main__.py`,由标准库 `zipapp` 压缩为单个 `.pyz` 文件:

- 归档入口为 `app.app:main`,运行方式 `python main.pyz [目录]`(无参数启动 GUI);
- 目标机器只需安装 Python 3.11+,**不包含 Python 运行时本身**,无任何第三方依赖;
- 运行时的模板定位:模块 `__file__` 位于归档内(形如 `<app>.pyz/app/exporter.py`),`_find_archive` 通过“上一级路径是 zip 文件”判定,再从归档直接读取 `web/dist/**`(JS/CSS/favicon 内联照常工作);
- 打包前必须已执行 `vp build`(`pack` 会校验 `web/dist/index.html` 存在);web 界面更新后需重新打包。

## 6. 测试

- **Web 单元测试**:`web/src/lib/*.test.ts`,覆盖版本比较、对比分类、ZIP 按需读取、jar 元数据解析、目录挑选。运行:`cd web && vp test`。
- **示例数据**:`tests/make_sample_mods.py` 生成两个整合包(覆盖升级/降级/新增/移除/坏 jar/仅文件名/Forge/NeoForge/Quilt/已禁用),供 CLI 与浏览器手工测试。
- GUI(Tkinter)与浏览器交互部分属手工测试范围。
