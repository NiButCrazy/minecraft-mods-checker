export type ModLoader = "fabric" | "quilt" | "forge" | "unknown";

export interface ModEntry {
  /** jar 文件名 */
  file: string;
  /** mod id(元数据中读取,失败时为空) */
  id: string;
  /** 显示名 */
  name: string;
  /** 版本号(元数据优先,回退文件名) */
  version: string;
  loader: ModLoader;
  /** 是否为已禁用模组(.jar.disabled) */
  disabled?: boolean;
  /** 文件修改时间(epoch 毫秒) */
  modifiedAt?: number;
  /** 元数据来源,如 fabric.mod.json / mods.toml / filename */
  source: string;
  /** 对比配对的键:id 或规范化文件名 */
  key: string;
}

export interface ScanSource {
  /** 扫描的目录路径(浏览器端为相对路径) */
  dir: string;
  /** 目录名,用于导出文件名 */
  dirName: string;
  /** game_root = 游戏根目录(含 mods 子目录),mods = 直接是模组目录 */
  type: "game_root" | "mods";
  scannedAt: string;
  tool?: string;
  /** 扫描时所在系统的用户名(Python 扫描时记录;浏览器无法获取) */
  user?: string;
  /** 扫描时所在电脑名称(Python 扫描时记录;浏览器无法获取) */
  host?: string;
}

export interface ScanData {
  source: ScanSource;
  mods: ModEntry[];
}

declare global {
  interface Window {
    __MC_MOD_DATA__?: ScanData;
  }
}
