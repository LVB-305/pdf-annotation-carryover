/** Simple word diff (GitHub-style): marks each word as equal, deleted, or added. */
export type DiffOp = { type: 'same' | 'del' | 'add'; text: string };

const MAX_WORDS = 400;

export function wordDiff(oldText: string, newText: string): { old: DiffOp[]; new: DiffOp[] } {
  const a = oldText.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const b = newText.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const n = a.length;
  const m = b.length;
  // langste gemeenschappelijke deelreeks (LCS) via dynamisch programmeren
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldOps: DiffOp[] = [];
  const newOps: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldOps.push({ type: 'same', text: a[i] });
      newOps.push({ type: 'same', text: b[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      oldOps.push({ type: 'del', text: a[i++] });
    } else {
      newOps.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) oldOps.push({ type: 'del', text: a[i++] });
  while (j < m) newOps.push({ type: 'add', text: b[j++] });
  return { old: oldOps, new: newOps };
}
