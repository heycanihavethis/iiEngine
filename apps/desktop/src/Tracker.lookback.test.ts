import { describe, expect, it } from 'vitest';
import {
  boardCapForLookback,
  formatPlayerColorLabel,
  isDiscordRateLimitedMessage,
  playerColorCss,
} from './Tracker';

describe('tracker lookback board caps', () => {
  it('grows with longer time windows up to 3 hours', () => {
    expect(boardCapForLookback(3 * 60)).toBe(40);
    expect(boardCapForLookback(15 * 60)).toBe(80);
    expect(boardCapForLookback(60 * 60)).toBe(120);
    expect(boardCapForLookback(3 * 60 * 60)).toBe(180);
  });
});

describe('discord rate-limit detection', () => {
  it('matches feed notice copy', () => {
    expect(
      isDiscordRateLimitedMessage(
        'Discord rate-limited the tracker channel. Try Refresh in a minute.',
      ),
    ).toBe(true);
    expect(isDiscordRateLimitedMessage('Quiet right now — no hits yet.')).toBe(false);
  });

  it('matches admin hint kind', () => {
    expect(
      isDiscordRateLimitedMessage('Feed is down for a bit.', 'bot/channel · rate_limited'),
    ).toBe(true);
  });
});

describe('player embed color parsing', () => {
  it('accepts spaced RGB, csv RGB, and hex', () => {
    expect(playerColorCss('255 0 0')).toBe('rgb(255, 0, 0)');
    expect(playerColorCss('170, 227, 255')).toBe('rgb(170, 227, 255)');
    expect(playerColorCss('#ff7800')).toBe('#FF7800');
    expect(formatPlayerColorLabel('255 0 0')).toBe('255 0 0');
    expect(formatPlayerColorLabel('#aabbcc')).toBe('#AABBCC');
  });
});
