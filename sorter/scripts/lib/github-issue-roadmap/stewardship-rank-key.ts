import assert from "node:assert/strict";

type Effort = "low" | "medium" | "high";

/** Integer score units avoid rounding when a half-step merged value is encoded. */
function scoreKey(value: number | null, effort: Effort | null): number | null {
  if (value === null || effort === null) return null;
  const doubledValue = 2 * value;
  const ease = { low: 4, medium: 3, high: 2 }[effort];
  return doubledValue * doubledValue * ease * 25;
}

/** Raw Value squared times Ease / 10, shared by placement and report ordering. */
export function stewardshipScore(value: number | null, effort: Effort | null): number | null {
  const score = scoreKey(value, effort);
  return score === null ? null : score / 1000;
}

/** An issue's own attributes determine its stored integer key; null means unranked. */
export function stewardshipRankKey({ horizon, nowReason, covered, tier, value, effort }: {
  horizon: string | null; nowReason: string | null; covered: boolean;
  tier: string | null; value: number | null; effort: Effort | null;
}): number | null {
  const score = scoreKey(value, effort);
  if (horizon !== "Now") {
    if (!covered || tier === null || score === null) return null;
    assert(score <= 40_000, "Non-Now raw score must not exceed 40");
    return score;
  }
  if (nowReason === "blocker") {
    const effortTier = effort === "low" ? 300 : effort === "medium" ? 200 : 100;
    return 2_000_000 + effortTier * 1000 + (2 * (value ?? 0)) * 500;
  }
  const band = nowReason === "pinned" ? 5000 : nowReason === "emergency" ? 4000 : nowReason === "tooling" ? 3000
    : nowReason === "formula" || nowReason === "incumbent" ? 1000 : 100;
  return band * 1000 + (score ?? 0);
}
