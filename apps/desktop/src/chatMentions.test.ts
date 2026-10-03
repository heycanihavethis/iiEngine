import { describe, expect, it } from 'vitest';
import {
  encodeMentionsForSend,
  filterMentionables,
  insertMention,
  mentionQueryAtCaret,
  splitMentionBody,
} from './chatMentions';

const people = [
  { id: '11111111-1111-1111-1111-111111111111', display_name: 'Ada', avatar: null },
  { id: '22222222-2222-2222-2222-222222222222', display_name: 'Ada Lovelace', avatar: null },
];

describe('chatMentions', () => {
  it('encodes longest display names first', () => {
    const body = encodeMentionsForSend('hey @Ada Lovelace and @Ada', people);
    expect(body).toContain('<@22222222-2222-2222-2222-222222222222>');
    expect(body).toContain('<@11111111-1111-1111-1111-111111111111>');
  });

  it('detects @query at caret', () => {
    expect(mentionQueryAtCaret('hello @ad', 9)).toEqual({ start: 6, query: 'ad' });
    expect(mentionQueryAtCaret('hello world', 11)).toBeNull();
  });

  it('inserts a mention over the active query', () => {
    const next = insertMention('hi @ad', 6, people[0]!);
    expect(next.value).toBe('hi @Ada ');
    expect(next.caret).toBe('hi @Ada '.length);
  });

  it('filters mentionables', () => {
    expect(filterMentionables(people, 'love').map((p) => p.id)).toEqual([people[1]!.id]);
  });

  it('splits mention tokens for display', () => {
    const parts = splitMentionBody('ping <@11111111-1111-1111-1111-111111111111> please', {
      '<@11111111-1111-1111-1111-111111111111>': '@Ada',
    });
    expect(parts).toEqual([
      { type: 'text', value: 'ping ' },
      { type: 'mention', value: '@Ada', userId: '11111111-1111-1111-1111-111111111111' },
      { type: 'text', value: ' please' },
    ]);
  });
});
