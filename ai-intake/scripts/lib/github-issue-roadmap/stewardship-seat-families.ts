export const STEWARDSHIP_SEAT_FAMILIES = ["anthropic", "glm", "codex"] as const;
export type StewardshipSeatFamily = typeof STEWARDSHIP_SEAT_FAMILIES[number];
export type StewardshipSeatFamilies = readonly [StewardshipSeatFamily, StewardshipSeatFamily];
