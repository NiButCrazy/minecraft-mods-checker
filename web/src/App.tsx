import { useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import type { ScanData } from "./types";
import { diffMods, type DiffKind, type DiffRow, type DiffStats } from "./lib/compare";
import {
  getDirectoryPicker,
  scanDirectoryHandle,
  scanFolderSelection,
  type ScanProgress,
} from "./lib/jarscan";

type Filter = "all" | "changed" | "added" | "removed" | "same" | "excluded";
type DisabledFilter = "all" | "disabled" | "enabled";
type SortMode = "status" | "name" | "date";
type ExcludeBinding = "double" | "single" | "ctrl" | "context";
type ExcludeKey = "none" | "delete" | "backspace" | "e";
type ThemeMode = "auto" | "dark" | "light";
type Slot = "base" | "target";

const APP_VERSION = "1.1.1";
const APP_AUTHOR = "Ni But Crazy";
const SETTINGS_KEY = "mc-mods-checker:settings";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "changed", label: "版本变化" },
  { id: "added", label: "新增" },
  { id: "removed", label: "移除" },
  { id: "same", label: "相同" },
  { id: "excluded", label: "排除" },
];

/** 可作为默认选项卡的项(不含「排除」) */
const TAB_OPTIONS = FILTERS.filter((f) => f.id !== "excluded");

const DISABLED_FILTERS: { id: DisabledFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "disabled", label: "仅已禁用" },
  { id: "enabled", label: "仅启用" },
];

const SORT_MODES: { id: SortMode; label: string }[] = [
  { id: "status", label: "按状态" },
  { id: "name", label: "按名称" },
  { id: "date", label: "按修改日期" },
];

const BINDINGS: { id: ExcludeBinding; label: string }[] = [
  { id: "double", label: "双击" },
  { id: "single", label: "单击" },
  { id: "ctrl", label: "Ctrl+单击" },
  { id: "context", label: "右键" },
];

const KEY_OPTIONS: { id: ExcludeKey; label: string }[] = [
  { id: "none", label: "无" },
  { id: "delete", label: "Delete" },
  { id: "backspace", label: "Backspace" },
  { id: "e", label: "E" },
];

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "auto", label: "跟随系统" },
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

interface Settings {
  theme: ThemeMode;
  disabledFilter: DisabledFilter;
  tab: Filter;
  sortMode: SortMode;
  showIndex: boolean;
  excludeEnabled: boolean;
  excludeBinding: ExcludeBinding;
  excludeKey: ExcludeKey;
  showTooltip: boolean;
  showUser: boolean;
  showHost: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  disabledFilter: "all",
  tab: "all",
  sortMode: "status",
  showIndex: false,
  excludeEnabled: true,
  excludeBinding: "double",
  excludeKey: "delete",
  showTooltip: true,
  showUser: true,
  showHost: true,
};

const BOOLEAN_SETTING_KEYS = [
  "showIndex",
  "excludeEnabled",
  "showTooltip",
  "showUser",
  "showHost",
] as const;

function bindingLabel(binding: ExcludeBinding): string {
  return BINDINGS.find((b) => b.id === binding)?.label ?? "双击";
}

function excludeKeyLabel(key: ExcludeKey): string {
  return KEY_OPTIONS.find((k) => k.id === key)?.label ?? "";
}

function loadSettings(): Settings {
  const defaults = { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "") as Partial<Settings>;
    const settings: Settings = { ...defaults, ...parsed };
    if (!DISABLED_FILTERS.some((f) => f.id === settings.disabledFilter)) {
      settings.disabledFilter = defaults.disabledFilter;
    }
    if (!TAB_OPTIONS.some((f) => f.id === settings.tab)) settings.tab = defaults.tab;
    if (!SORT_MODES.some((s) => s.id === settings.sortMode)) settings.sortMode = defaults.sortMode;
    if (!BINDINGS.some((b) => b.id === settings.excludeBinding)) {
      settings.excludeBinding = defaults.excludeBinding;
    }
    if (!KEY_OPTIONS.some((k) => k.id === settings.excludeKey)) {
      settings.excludeKey = defaults.excludeKey;
    }
    if (!THEME_OPTIONS.some((t) => t.id === settings.theme)) settings.theme = defaults.theme;
    for (const key of BOOLEAN_SETTING_KEYS) {
      if (typeof settings[key] !== "boolean") settings[key] = defaults[key];
    }
    return settings;
  } catch {
    return defaults;
  }
}

/** 任一侧为已禁用即视为已禁用条目 */
function rowDisabled(row: DiffRow): boolean {
  return !!(row.a?.disabled || row.b?.disabled);
}

/** 禁用状态筛选 + 排除清单(先过滤再对比,所有下游数据随之同步) */
function applyModFilters(data: ScanData, mode: DisabledFilter, excluded: Set<string>): ScanData {
  let mods = data.mods;
  if (mode !== "all") {
    const wantDisabled = mode === "disabled";
    mods = mods.filter((m) => !!m.disabled === wantDisabled);
  }
  if (excluded.size > 0) {
    mods = mods.filter((m) => !excluded.has(m.key));
  }
  return mods === data.mods ? data : { ...data, mods };
}

function modifiedTime(row: DiffRow): number {
  return row.a?.modifiedAt ?? row.b?.modifiedAt ?? 0;
}

const KIND_LABEL: Record<DiffKind, string> = {
  added: "新增",
  removed: "移除",
  changed: "变更",
  same: "相同",
};

const KIND_CLASS: Record<DiffKind, string> = {
  added: "badge badge-added",
  removed: "badge badge-removed",
  changed: "badge badge-changed",
  same: "badge badge-same",
};

const LOADER_LABEL: Record<string, string> = {
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  unknown: "未知",
};

const SOURCE_TYPE_LABEL = {
  game_root: "游戏根目录",
  mods: "模组目录",
} as const;

/** 展示用目录名:直接选择 mods 目录时浏览器拿不到游戏目录名 */
function sourceLabel(source: ScanData["source"]): string {
  return source.dirName.toLowerCase() === "mods" ? "所选模组目录" : source.dirName;
}

export default function App() {
  const [base, setBase] = useState<ScanData | null>(() => window.__MC_MOD_DATA__ ?? null);
  const [target, setTarget] = useState<ScanData | null>(null);
  const [progress, setProgress] = useState<{ slot: Slot; p: ScanProgress } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>(() => settings.tab);
  const [disabledFilter, setDisabledFilter] = useState<DisabledFilter>(() => settings.disabledFilter);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>(() => settings.sortMode);
  const [sortDesc, setSortDesc] = useState(false);
  const [showIndex, setShowIndex] = useState(() => settings.showIndex);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const baseInput = useRef<HTMLInputElement>(null);
  const targetInput = useRef<HTMLInputElement>(null);

  // 主题:auto 跟随系统(监听变化),dark/light 手动覆盖;结果写入 <html data-theme>
  useLayoutEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = settings.theme === "auto" ? (media.matches ? "light" : "dark") : settings.theme;
      root.dataset.theme = resolved;
    };
    apply();
    if (settings.theme === "auto") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    return undefined;
  }, [settings.theme]);

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // 存储不可用时仅保留当前会话
      }
      return next;
    });
    if (key === "tab") setFilter(value as Filter);
    if (key === "disabledFilter") setDisabledFilter(value as DisabledFilter);
    if (key === "sortMode") setSortMode(value as SortMode);
    if (key === "showIndex") setShowIndex(value as boolean);
  }

  function toggleExclude(key: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function applyScan(slot: Slot, data: ScanData) {
    setSelectedKey(null);
    if (slot === "base") {
      setBase(data);
      setFilter(settings.tab);
      setDisabledFilter(settings.disabledFilter);
    } else {
      setTarget(data);
    }
  }

  /** 优先用 File System Access API(只读 mods 子目录,不卡);不可用时回退 webkitdirectory 输入框 */
  async function pickFolder(slot: Slot) {
    const input = slot === "base" ? baseInput.current : targetInput.current;
    const picker = getDirectoryPicker();
    if (!picker) {
      input?.click();
      return;
    }
    setError(null);
    setProgress({ slot, p: { done: 0, total: 0, current: "正在读取目录…" } });
    try {
      const handle = await picker();
      try {
        const data = await scanDirectoryHandle(handle, (p) => setProgress({ slot, p }));
        applyScan(slot, data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      input?.click();
    } finally {
      setProgress(null);
    }
  }

  async function handlePick(slot: Slot, list: FileList | null) {
    const input = slot === "base" ? baseInput.current : targetInput.current;
    if (!list || list.length === 0) {
      if (input) input.value = "";
      return;
    }
    setError(null);
    setProgress({ slot, p: { done: 0, total: 0, current: "正在读取文件列表…" } });
    try {
      const data = await scanFolderSelection(list, (p) => setProgress({ slot, p }));
      applyScan(slot, data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      if (input) input.value = "";
    }
  }

  const fullDiff = useMemo(() => (base && target ? diffMods(base, target) : null), [base, target]);
  const fullDisabledRows = fullDiff ? fullDiff.rows.filter(rowDisabled).length : 0;

  const filteredBase = useMemo(
    () => (base ? applyModFilters(base, disabledFilter, excluded) : null),
    [base, disabledFilter, excluded],
  );
  const filteredTarget = useMemo(
    () => (target ? applyModFilters(target, disabledFilter, excluded) : null),
    [target, disabledFilter, excluded],
  );
  const diff = useMemo(
    () => (filteredBase && filteredTarget ? diffMods(filteredBase, filteredTarget) : null),
    [filteredBase, filteredTarget],
  );
  const disabledRows = diff ? diff.rows.filter(rowDisabled).length : 0;
  const baseDisabled = filteredBase ? filteredBase.mods.filter((m) => m.disabled).length : 0;
  const targetDisabled = filteredTarget ? filteredTarget.mods.filter((m) => m.disabled).length : 0;
  const excludedRowsCount = fullDiff ? fullDiff.rows.filter((row) => excluded.has(row.key)).length : 0;

  // 「排除」选项卡为空时自动回到「全部」
  useEffect(() => {
    if (filter === "excluded" && excludedRowsCount === 0) setFilter("all");
  }, [filter, excludedRowsCount]);

  const keyboardActive = settings.excludeEnabled && settings.excludeKey !== "none";

  function exclusionHandlers(rowKey: string, excludedTab: boolean): HTMLAttributes<HTMLTableRowElement> {
    const handlers: HTMLAttributes<HTMLTableRowElement> = {};
    if (keyboardActive) {
      handlers.onClick = () => setSelectedKey(rowKey);
    }
    if (settings.excludeEnabled) {
      const toggle = () => toggleExclude(rowKey);
      if (settings.showTooltip) {
        handlers.title = `${bindingLabel(settings.excludeBinding)}${excludedTab ? "恢复到对比" : "排除该模组"}`;
      }
      switch (settings.excludeBinding) {
        case "single":
          handlers.onClick = () => {
            if (keyboardActive) setSelectedKey(rowKey);
            toggle();
          };
          break;
        case "ctrl":
          handlers.onClick = (e) => {
            if (keyboardActive) setSelectedKey(rowKey);
            if (e.ctrlKey || e.metaKey) toggle();
          };
          break;
        case "context":
          handlers.onContextMenu = (e) => {
            e.preventDefault();
            toggle();
          };
          break;
        default:
          handlers.onDoubleClick = () => {
            if (keyboardActive) setSelectedKey(rowKey);
            toggle();
          };
      }
    }
    return handlers;
  }

  const excludeFooterHint = settings.excludeEnabled
    ? `${bindingLabel(settings.excludeBinding)}行${
        filter === "excluded" ? "可恢复到对比" : "可排除该模组(可在「排除」选项卡中恢复)"
      }${
        settings.excludeKey !== "none"
          ? `,选中行后按 ${excludeKeyLabel(settings.excludeKey)} 键${filter === "excluded" ? "恢复" : "排除"}`
          : ""
      }`
    : null;

  const rows = useMemo(() => {
    const source: DiffRow[] =
      filter === "excluded"
        ? (fullDiff?.rows ?? []).filter((row) => excluded.has(row.key))
        : !diff
          ? []
          : diff.rows.filter((row) => (filter === "all" ? true : row.kind === filter));
    const q = query.trim().toLowerCase();
    let r = source;
    if (q) {
      r = r.filter((row) =>
        `${row.a?.name ?? ""} ${row.b?.name ?? ""} ${row.key} ${row.a?.file ?? ""} ${row.b?.file ?? ""}`
          .toLowerCase()
          .includes(q),
      );
    }
    const label = (row: DiffRow) => (row.a?.name ?? row.b?.name ?? row.key).toLowerCase();
    const byName = (x: DiffRow, y: DiffRow) => label(x).localeCompare(label(y), "zh-CN");
    const order: DiffKind[] = ["changed", "added", "removed", "same"];
    let sorted: DiffRow[];
    if (sortMode === "name") {
      sorted = [...r].sort(byName);
    } else if (sortMode === "date") {
      sorted = [...r].sort((x, y) => modifiedTime(x) - modifiedTime(y) || byName(x, y));
    } else {
      sorted = [...r].sort(
        (x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || byName(x, y),
      );
    }
    if (sortDesc) sorted.reverse();
    return sorted;
  }, [diff, fullDiff, filter, query, sortMode, sortDesc, excluded]);

  // 选中行离开当前列表(被排除或筛选)时清除选中
  useEffect(() => {
    if (selectedKey && !rows.some((row) => row.key === selectedKey)) setSelectedKey(null);
  }, [rows, selectedKey]);

  // 键盘按键排除/恢复选中行
  useEffect(() => {
    if (settingsOpen || !keyboardActive || !selectedKey) return undefined;
    const key = selectedKey;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const matched =
        (settings.excludeKey === "delete" && e.key === "Delete") ||
        (settings.excludeKey === "backspace" && e.key === "Backspace") ||
        (settings.excludeKey === "e" &&
          e.key.toLowerCase() === "e" &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey);
      if (matched) {
        e.preventDefault();
        toggleExclude(key);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, keyboardActive, settings.excludeKey, selectedKey]);

  return (
    <div className="page">
      <header className="header">
        <div className="header-text">
          <h1>Minecraft 模组比较器</h1>
          <p className="subtitle">选择另一个模组文件夹，自动对比模组的新增、移除与版本变化</p>
        </div>
        <div className="header-filter">
          {base && (
            <>
              <span className="filter-label"></span>
              {DISABLED_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={disabledFilter === f.id ? "tab tab-active" : "tab"}
                  onClick={() => setDisabledFilter(f.id)}
                >
                  {f.label}
                  {fullDiff && (
                    <span className="tab-count">
                      {f.id === "disabled"
                        ? fullDisabledRows
                        : f.id === "enabled"
                          ? fullDiff.rows.length - fullDisabledRows
                          : fullDiff.rows.length}
                    </span>
                  )}
                </button>
              ))}
              <span className="tab-sep" aria-hidden="true" />
            </>
          )}
          <button type="button" className="tab" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </header>

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {[base, target].some(
        (s) => s && s.source.tool === "web" && s.source.type === "mods" && s.source.dirName === "mods",
      ) && (
        <div className="banner banner-info">
          <span>
            检测到直接选择了 mods 模组目录,无法得知游戏目录名。若要显示目录名,请选择游戏根目录(含 mods
            子目录的文件夹)。
          </span>
        </div>
      )}

      <section className="slots">
        <FolderCard
          title="基准列表"
          data={base}
          modsCount={filteredBase?.mods.length ?? 0}
          placeholder="选择基准模组文件夹(游戏根目录或 mods 目录)"
          buttonLabel="选择基准文件夹"
          scanning={progress?.slot === "base" ? progress.p : null}
          showUser={settings.showUser}
          showHost={settings.showHost}
          showDisabledHint={disabledFilter === "enabled"}
          onPick={() => void pickFolder("base")}
        />
        <div className="slots-arrow">→</div>
        <FolderCard
          title="对比列表"
          data={target}
          placeholder={
            base ? "选择另一个游戏根目录或模组文件夹开始对比" : "先在左侧选择基准文件夹,或直接选择两个文件夹中的另一个"
          }
          buttonLabel="选择对比文件夹"
          modsCount={filteredTarget?.mods.length ?? 0}
          delta={diff?.stats ?? null}
          scanning={progress?.slot === "target" ? progress.p : null}
          showUser={settings.showUser}
          showHost={settings.showHost}
          showDisabledHint={disabledFilter === "enabled"}
          onPick={() => void pickFolder("target")}
        />
      </section>

      <input
        ref={baseInput}
        type="file"
        multiple
        className="hidden-input"
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(e) => void handlePick("base", e.target.files)}
      />
      <input
        ref={targetInput}
        type="file"
        multiple
        className="hidden-input"
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={(e) => void handlePick("target", e.target.files)}
      />

      {diff && (
        <>
          <section className="stats">
            {/* <StatTile label="基准模组" value={diff.stats.totalA} tone="dim" />
            <StatTile label="对比模组" value={diff.stats.totalB} tone="dim" /> */}
            <StatTile label="相同" value={diff.stats.same} tone="same" />
            <StatTile
              label="版本变化"
              value={diff.stats.changed}
              tone="changed"
              detail={diff.stats.changed > 0 ? `↑${diff.stats.up} · ↓${diff.stats.down}` : undefined}
            />
            <StatTile label="新增" value={diff.stats.added} tone="added" />
            <StatTile label="移除" value={diff.stats.removed} tone="removed" />
            {disabledFilter !== "enabled" && (
              <StatTile
                label="已禁用"
                value={disabledRows}
                tone="disabled"
                detail={`基准 ${baseDisabled} · 对比 ${targetDisabled}`}
              />
            )}
          </section>

          <section className="panel">
            <div className="toolbar">
              <div className="tabs">
                {FILTERS.map((f) => {
                  if (f.id === "excluded" && excludedRowsCount === 0) return null;
                  const count =
                    f.id === "all"
                      ? diff.rows.length
                      : f.id === "excluded"
                        ? excludedRowsCount
                        : diff.rows.filter((row) => row.kind === f.id).length;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className={filter === f.id ? "tab tab-active" : "tab"}
                      onClick={() => setFilter(f.id)}
                    >
                      {f.label}
                      <span className="tab-count">{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="toolbar-right">
                <input
                  type="search"
                  className="search"
                  placeholder="搜索模组名 / ID / 文件名"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="select"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  title="排序方式"
                >
                  <option value="status">按状态</option>
                  <option value="name">按名称</option>
                  <option value="date">按修改日期</option>
                </select>
                <button
                  type="button"
                  className="tab"
                  onClick={() => setSortDesc((v) => !v)}
                  title="切换升序 / 降序"
                >
                  {sortDesc ? "倒序" : "正序"}
                </button>
                <button
                  type="button"
                  className={showIndex ? "tab tab-active" : "tab"}
                  onClick={() => setShowIndex((v) => !v)}
                  title="显示 / 隐藏序号列"
                >
                  序号
                </button>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {showIndex && <th className="row-index">#</th>}
                    <th>状态</th>
                    <th>模组</th>
                    <th>ID</th>
                    <th>版本(基准 → 对比)</th>
                    <th>加载器</th>
                    <th>文件</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <ModRow
                      key={row.key}
                      row={row}
                      index={showIndex ? i + 1 : null}
                      handlers={exclusionHandlers(row.key, filter === "excluded")}
                      interactive={settings.excludeEnabled || keyboardActive}
                      selected={selectedKey === row.key}
                    />
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={showIndex ? 7 : 6} className="empty-cell">
                        没有符合条件的模组
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              {excludeFooterHint && <span>{excludeFooterHint} · </span>}
              显示 {rows.length} / {filter === "excluded" ? (fullDiff?.rows.length ?? 0) : diff.rows.length} 条
            </div>
          </section>

          <section className="panel analysis">
            <h2>详细分析</h2>
            <div className="analysis-grid">
              <div>
                <h3>加载器分布</h3>
                <table className="mini-table">
                  <thead>
                    <tr>
                      <th>加载器</th>
                      <th>{base ? sourceLabel(base.source) : ""}</th>
                      <th>{target ? sourceLabel(target.source) : ""}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...new Set([...Object.keys(diff.loaderStatsA), ...Object.keys(diff.loaderStatsB)])]
                      .sort()
                      .map((loader) => (
                        <tr key={loader}>
                          <td>{LOADER_LABEL[loader] ?? loader}</td>
                          <td>{diff.loaderStatsA[loader] ?? 0}</td>
                          <td>{diff.loaderStatsB[loader] ?? 0}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3>提示与警告</h3>
                {diff.warnings.length === 0 ? (
                  <p className="analysis-ok">未发现问题</p>
                ) : (
                  <ul className="warnings">
                    {diff.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      <footer className="footer">
        {base && (
          <span>
            基准: {base.source.dir}({SOURCE_TYPE_LABEL[base.source.type]}) · {base.mods.length} 个模组 ·
            扫描于 {base.source.scannedAt}
          </span>
        )}
      </footer>

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>设置</h2>
              <button type="button" className="modal-close" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </div>
            <div className="setting-row">
              <label htmlFor="set-disabled">禁用状态默认项</label>
              <select
                id="set-disabled"
                className="select"
                value={settings.disabledFilter}
                onChange={(e) => updateSetting("disabledFilter", e.target.value as DisabledFilter)}
              >
                {DISABLED_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <label htmlFor="set-tab">模组列表选项卡默认项</label>
              <select
                id="set-tab"
                className="select"
                value={settings.tab}
                onChange={(e) => updateSetting("tab", e.target.value as Filter)}
              >
                {TAB_OPTIONS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <label htmlFor="set-sort">排序方式默认项</label>
              <select
                id="set-sort"
                className="select"
                value={settings.sortMode}
                onChange={(e) => updateSetting("sortMode", e.target.value as SortMode)}
              >
                {SORT_MODES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <label htmlFor="set-theme">主题外观</label>
              <select
                id="set-theme"
                className="select"
                value={settings.theme}
                onChange={(e) => updateSetting("theme", e.target.value as ThemeMode)}
              >
                {THEME_OPTIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <label htmlFor="set-index">默认显示序号列</label>
              <input
                id="set-index"
                type="checkbox"
                checked={settings.showIndex}
                onChange={(e) => updateSetting("showIndex", e.target.checked)}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="set-exclude">启用双击排除功能</label>
              <input
                id="set-exclude"
                type="checkbox"
                checked={settings.excludeEnabled}
                onChange={(e) => updateSetting("excludeEnabled", e.target.checked)}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="set-binding">排除操作方式</label>
              <select
                id="set-binding"
                className="select"
                value={settings.excludeBinding}
                onChange={(e) => updateSetting("excludeBinding", e.target.value as ExcludeBinding)}
              >
                {BINDINGS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <label htmlFor="set-key">排除按键绑定(选中行后)</label>
              <select
                id="set-key"
                className="select"
                value={settings.excludeKey}
                onChange={(e) => updateSetting("excludeKey", e.target.value as ExcludeKey)}
              >
                {KEY_OPTIONS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <label htmlFor="set-tooltip">显示排除操作悬浮提示</label>
              <input
                id="set-tooltip"
                type="checkbox"
                checked={settings.showTooltip}
                onChange={(e) => updateSetting("showTooltip", e.target.checked)}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="set-show-user">卡片显示系统用户名</label>
              <input
                id="set-show-user"
                type="checkbox"
                checked={settings.showUser}
                onChange={(e) => updateSetting("showUser", e.target.checked)}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="set-show-host">卡片显示电脑名称</label>
              <input
                id="set-show-host"
                type="checkbox"
                checked={settings.showHost}
                onChange={(e) => updateSetting("showHost", e.target.checked)}
              />
            </div>
            <div className="modal-footer">
              版本 v{APP_VERSION} · 作者: {APP_AUTHOR}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderCard(props: {
  title: string;
  data: ScanData | null;
  modsCount: number;
  delta?: DiffStats | null;
  placeholder: string;
  buttonLabel: string;
  scanning: ScanProgress | null;
  showUser: boolean;
  showHost: boolean;
  showDisabledHint: boolean;
  onPick: () => void;
}) {
  const {
    title,
    data,
    modsCount,
    delta,
    placeholder,
    buttonLabel,
    scanning,
    showUser,
    showHost,
    showDisabledHint,
    onPick,
  } = props;

  let disabledCount = 0;
  if (data) {
    for (const mod of data.mods) {
      if (mod.disabled) disabledCount += 1;
    }
  }
  const deltaTotal = delta ? delta.added + delta.removed + delta.up + delta.down : 0;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{title}</span>
        {data && (
          <span className="card-meta">
            {SOURCE_TYPE_LABEL[data.source.type]} · {data.source.scannedAt}
          </span>
        )}
      </div>
      {data ? (
        <>
          <div className="card-dir" title={data.source.dir}>
            {data.source.dir}
          </div>
          <div className="card-count">
            <strong>{modsCount}</strong> 个模组
            {modsCount !== data.mods.length && (
              <span className="card-count-total"> / 共 {data.mods.length}</span>
            )}
          </div>
        </>
      ) : (
        <div className="card-empty">{placeholder}</div>
      )}
      {scanning && (
        <div className="progress">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: scanning.total > 0 ? `${(scanning.done / scanning.total) * 100}%` : "0%" }}
            />
          </div>
          <div className="progress-text">
            解析中 {scanning.done}/{scanning.total}
            {scanning.current ? ` · ${scanning.current}` : ""}
          </div>
        </div>
      )}
      <div className="card-footer">
        {data && (
          <div className="card-stats">
            {showUser && data.source.user && (
              <span className="chip-sys" title="扫描时所在系统的用户名">
                {data.source.user}
              </span>
            )}
            {showHost && data.source.host && (
              <span className="chip-sys" title="扫描时所在电脑名称">
                {data.source.host}
              </span>
            )}
            {showDisabledHint && disabledCount > 0 && (
              <span className="chip-disabled" title="当前筛选为「仅启用」,已禁用模组未计入分析">
                已禁用 {disabledCount}
              </span>
            )}
            {delta && deltaTotal > 0 && (
              <span className="chip-delta" title="相比基准列表:新增 + / 移除 - / 升级 ↑ / 降级 ↓">
                <span className="delta-label">对比</span>
                {delta.added > 0 && <span className="delta-added">+{delta.added}</span>}
                {delta.removed > 0 && <span className="delta-removed">-{delta.removed}</span>}
                {delta.up > 0 && <span className="delta-up">↑{delta.up}</span>}
                {delta.down > 0 && <span className="delta-down">↓{delta.down}</span>}
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          className={data ? "btn btn-auto" : "btn"}
          onClick={onPick}
          disabled={!!scanning}
          title={data ? "重新选择文件夹" : buttonLabel}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

function StatTile(props: { label: string; value: number; tone: string; detail?: string }) {
  return (
    <div className={`stat stat-${props.tone}`}>
      {/* key 绑定数值:数字变化时重新挂载以重放动画 */}
      <div className="stat-value" key={props.value}>
        {props.value}
      </div>
      <div className="stat-label">{props.label}</div>
      {props.detail && <div className="stat-detail">{props.detail}</div>}
    </div>
  );
}

function ModRow({
  row,
  index,
  handlers,
  interactive,
  selected,
}: {
  row: DiffRow;
  index: number | null;
  handlers: HTMLAttributes<HTMLTableRowElement>;
  interactive: boolean;
  selected: boolean;
}) {
  const name = row.a?.name ?? row.b?.name ?? row.key;
  const id = row.a?.id || row.b?.id || "—";
  const versionA = row.a?.version || "—";
  const versionB = row.b?.version || "—";
  const className =
    [interactive ? "row-interactive" : "", selected ? "row-selected" : ""].filter(Boolean).join(" ") ||
    undefined;
  return (
    <tr className={className} {...handlers}>
      {index !== null && <td className="row-index">{index}</td>}
      <td>
        <span className={KIND_CLASS[row.kind]}>{KIND_LABEL[row.kind]}</span>
        {row.direction === "up" && <span className="dir dir-up">↑</span>}
        {row.direction === "down" && <span className="dir dir-down">↓</span>}
        {row.direction === "other" && <span className="dir dir-other">≠</span>}
      </td>
      <td className="mod-name">
        {name}
        {(row.a?.disabled || row.b?.disabled) && <span className="badge badge-disabled">已禁用</span>}
      </td>
      <td className="mono">{id}</td>
      <td className="mono">
        {row.kind === "changed" ? (
          <>
            <span className="ver-old">{versionA}</span>
            <span className="ver-arrow">→</span>
            <span className="ver-new">{versionB}</span>
          </>
        ) : row.kind === "added" ? (
          <span className="ver-new">{versionB}</span>
        ) : (
          <span className={row.kind === "removed" ? "ver-old" : ""}>{versionA}</span>
        )}
      </td>
      <td>
        {[...new Set([row.a?.loader, row.b?.loader].filter((l): l is NonNullable<typeof l> => !!l))].map((l) => (
          <span key={l} className={`loader loader-${l}`}>
            {LOADER_LABEL[l] ?? l}
          </span>
        ))}
      </td>
      <td className="mono file-cell" title={row.b?.file ?? row.a?.file ?? ""}>
        {row.b?.file ?? row.a?.file ?? ""}
      </td>
    </tr>
  );
}
