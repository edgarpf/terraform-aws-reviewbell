/**
 * Extract @mentions from a GitHub comment/review body.
 * Strips fenced code blocks, inline code, and quoted lines first (GitHub ignores those too).
 * Ignores team mentions (@org/team) and de-duplicates.
 */
export function extractMentions(body: string | null | undefined, skipLogin?: string): string[] {
  if (!body) return [];

  let text = body;
  // Fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, " ");
  // Inline code
  text = text.replace(/`[^`\n]+`/g, " ");
  // Quoted lines
  text = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  const matches = text.matchAll(/(^|[^A-Za-z0-9_-])@([A-Za-z0-9-]+)(?![A-Za-z0-9_/])/g);
  const seen = new Set<string>();
  const skip = skipLogin?.toLowerCase();

  for (const m of matches) {
    const login = m[2];
    // Team mentions look like @org/team — our regex stops before /, but
    // also skip if the next char in original was / (already excluded by (?!)).
    // Extra safety: never treat something containing / as a user.
    if (login.includes("/")) continue;
    const lower = login.toLowerCase();
    if (skip && lower === skip) continue;
    seen.add(lower);
  }

  // Preserve original casing from first occurrence by re-scanning simply
  const ordered: string[] = [];
  const orderedSeen = new Set<string>();
  for (const m of body.matchAll(/@([A-Za-z0-9-]+)/g)) {
    const login = m[1];
    const lower = login.toLowerCase();
    if (!seen.has(lower)) continue;
    if (orderedSeen.has(lower)) continue;
    orderedSeen.add(lower);
    ordered.push(login);
  }
  return ordered;
}
