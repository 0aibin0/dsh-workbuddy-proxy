/**
 * 自愈式定位：把「哪一句话被网关禁了」当场测出来。
 *
 * 做法是行级二分——把 system/assistant 文本按行切开，反复问网关「这一半还拦吗」，
 * 直到缩到最小可触发集合。实测 35700 字 / 319 行的那条真提示词，二分 17 次就缩到
 * 1 行。
 *
 * 测出来的行会被写进指纹库（$DSH_HOME/workbuddy-proxy-fingerprints.json），
 * 之后每次请求直接给它打标，不必再测。
 *
 * 代价：每次新词条要花十几次网关调用（走积分）。因此有配额上限，且结果会缓存。
 */

/**
 * 二分找出触发拦截的最小行集合。
 *
 * @param {string} text 待测文本。
 * @param {(candidate: string) => Promise<boolean>} blocked 探测函数：true 表示被拦。
 * @param {{maxProbes?: number}} options
 * @returns {Promise<{lines: string[], probes: number, exhausted: boolean}>}
 */
export async function findBannedLines(text, blocked, options = {}) {
  const maxProbes = Number.isFinite(options.maxProbes) ? Number(options.maxProbes) : 24;
  let probes = 0;
  const budget = async () => {
    probes += 1;
    if (probes > maxProbes) throw new Error("probe budget exhausted");
    return blocked(text);
  };
  const lines = String(text ?? "").split("\n");
  if (lines.length === 0) return { lines: [], probes, exhausted: true };

  let current = lines.slice();
  try {
    while (current.length > 1) {
      const mid = Math.floor(current.length / 2);
      const head = current.slice(0, mid);
      const tail = current.slice(mid);
      const headText = head.join("\n");
      const tailText = tail.join("\n");
      const headBlocked = await blocked(headText);
      const tailBlocked = await blocked(tailText);
      if (headBlocked && !tailBlocked) current = head;
      else if (tailBlocked && !headBlocked) current = tail;
      else if (headBlocked && tailBlocked) {
        // 两边都能触发：说明词条跨行（或不止一处），先取短的一边继续缩
        current = head.length <= tail.length ? head : tail;
      } else {
        // 两边都不触发：触发条件不在任何一半里 —— 退化成逐行累加
        const acc = [];
        for (const line of current) {
          acc.push(line);
          probes += 1;
          if (probes > maxProbes) throw new Error("probe budget exhausted");
          if (await blocked(acc.join("\n"))) break;
        }
        return { lines: acc, probes, exhausted: false };
      }
    }
  } catch (error) {
    return { lines: current, probes, exhausted: true, error: String(error) };
  }
  return { lines: current, probes, exhausted: false };
}
