/**
 * Markdown 可视化编辑的保存守卫（纯函数，可单测）。
 *
 * 可视化编辑器（Milkdown）把文档重新序列化时会统一格式（列表符号、强调符号、空行、转义…）。
 * 为了不在保存时产生“只有格式变化”的 diff：
 * 1) 编辑器载入后立刻序列化一次得到 baseline（= 原文按编辑器格式化后的样子）；
 * 2) 用户编辑后得到 edited；edited === baseline → 内容没变，直接用原文；
 * 3) 否则按块（空行分隔，代码块整体算一块）对齐：baseline 与原文块数一致时，
 *    edited 里与 baseline 相同的块换回原文对应块，只有真正改过的块用新格式。
 */

/** 按空行切块；围栏代码块内的空行不切。 */
export function splitBlocks(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
  };
  for (const l of lines) {
    const m = l.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    }
    if (!fence && l.trim() === "" && !m) flush();
    else cur.push(l);
  }
  flush();
  return blocks;
}

/** 宽松归一化：只用于判断“是否只有格式差异”。 */
export function normalizeMarkdown(md: string): string {
  return splitBlocks(md)
    .map((b) =>
      b
        .split("\n")
        .map((l) =>
          l
            .replace(/\s+$/, "")
            .replace(/^(\s*)[*+](\s+)/, "$1-$2")
            .replace(/^(\s*)(\d+)[.)](\s+)/, "$1$2.$3")
            .replace(/__(.+?)__/g, "**$1**")
            .replace(/(^|[^*\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, "$1*$2*")
            .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1"),
        )
        .join("\n"),
    )
    .join("\n\n")
    .trim();
}

export interface RoundTripResult {
  text: string;
  /** true = 只保留了原文（没有实际改动） */
  unchanged: boolean;
  /** true = 无法逐块对齐，整篇按编辑器格式输出（UI 会提示） */
  reformatted: boolean;
}

export function preserveUnchangedBlocks(original: string, baseline: string, edited: string): RoundTripResult {
  if (edited === baseline || normalizeMarkdown(edited) === normalizeMarkdown(original)) {
    return { text: original, unchanged: true, reformatted: false };
  }
  const ob = splitBlocks(original);
  const bb = splitBlocks(baseline);
  const eb = splitBlocks(edited);
  if (ob.length !== bb.length) return { text: edited, unchanged: false, reformatted: true };
  // LCS 对齐 baseline 块与 edited 块
  const n = bb.length, m = eb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = bb[i] === eb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && bb[i] === eb[j]) {
      out.push(ob[i]);
      i++;
      j++;
    } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else {
      out.push(eb[j]);
      j++;
    }
  }
  const trailingNl = /\n$/.test(original) ? "\n" : "";
  return { text: out.join("\n\n") + trailingNl, unchanged: false, reformatted: false };
}
