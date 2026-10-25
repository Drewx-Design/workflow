export function containsSourceMarkerSentinel(text: string): boolean {
  return /<!--|github-issue-roadmap-source/i.test(text);
}
