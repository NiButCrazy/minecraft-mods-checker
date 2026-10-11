const NUMERIC = /^\d+$/;

const PRE_RELEASE = /^(alpha|beta|rc|pre|preview|snapshot|dev|unstable|a|b)(\d*)$/;

export function tokenizeVersion(v: string): string[] {
  return v
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * 比较两个版本字符串。
 * @returns >0 表示 a 较新,<0 表示 a 较旧,0 表示相同,null 表示无法比较(存在空版本)。
 */
export function compareVersions(a: string, b: string): number | null {
  if (!a || !b) return null;
  const ta = tokenizeVersion(a);
  const tb = tokenizeVersion(b);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -extraSide(tb.slice(i));
    if (y === undefined) return extraSide(ta.slice(i));
    if (x === y) continue;
    const nx = NUMERIC.test(x) ? parseInt(x, 10) : null;
    const ny = NUMERIC.test(y) ? parseInt(y, 10) : null;
    if (nx !== null && ny !== null) return nx > ny ? 1 : -1;
    if (nx !== null) return 1;
    if (ny !== null) return -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** 某一侧多出的后缀段:以预发布词开头表示该侧更旧,否则视为更新 */
function extraSide(tokens: string[]): number {
  const first = tokens[0];
  if (first === undefined) return 0;
  if (PRE_RELEASE.test(first)) return -1;
  return 1;
}
