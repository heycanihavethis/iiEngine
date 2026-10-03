const MENTION_TOKEN = /<@([0-9a-fA-F-]{36})>/g;

export type Mentionable = {
  id: string;
  display_name: string;
  avatar: string | null;
};

export function encodeMentionsForSend(body: string, people: Mentionable[]): string {
  let out = body;
  const ordered = [...people].sort((a, b) => b.display_name.length - a.display_name.length);
  for (const person of ordered) {
    const name = person.display_name.trim();
    if (!name) continue;
    const pattern = new RegExp(`@${escapeRegExp(name)}(?![\\w-])`, 'g');
    out = out.replace(pattern, `<@${person.id}>`);
  }
  return out;
}

export function mentionQueryAtCaret(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = before.match(/(^|[\s([{])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] ?? '';
  const start = before.length - query.length - 1;
  return { start, query };
}

export function insertMention(
  value: string,
  caret: number,
  person: Mentionable,
): { value: string; caret: number } {
  const at = mentionQueryAtCaret(value, caret);
  if (!at) {
    const token = `@${person.display_name} `;
    const next = `${value.slice(0, caret)}${token}${value.slice(caret)}`;
    return { value: next, caret: caret + token.length };
  }
  const token = `@${person.display_name} `;
  const next = `${value.slice(0, at.start)}${token}${value.slice(caret)}`;
  return { value: next, caret: at.start + token.length };
}

export function filterMentionables(people: Mentionable[], query: string): Mentionable[] {
  const term = query.trim().toLowerCase();
  if (!term) return people.slice(0, 8);
  return people.filter((person) => person.display_name.toLowerCase().includes(term)).slice(0, 8);
}

export function splitMentionBody(body: string, labels: Record<string, string> = {}) {
  const parts: Array<{ type: 'text' | 'mention'; value: string; userId?: string }> = [];
  let last = 0;
  const pattern = new RegExp(MENTION_TOKEN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match.index > last) {
      parts.push({ type: 'text', value: body.slice(last, match.index) });
    }
    const token = match[0];
    const userId = match[1];
    parts.push({
      type: 'mention',
      value: labels[token] || `@${userId.slice(0, 8)}`,
      userId,
    });
    last = match.index + token.length;
  }
  if (last < body.length) {
    parts.push({ type: 'text', value: body.slice(last) });
  }
  return parts.length ? parts : [{ type: 'text' as const, value: body }];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
