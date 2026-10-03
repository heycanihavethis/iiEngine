import { describe, expect, it } from 'vitest';
import { inspectPageEntryHealth } from './PageRevealGrid';

describe('inspectPageEntryHealth', () => {
  it('treats opening status as loading', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p role="status">Opening Community…</p>';
    expect(inspectPageEntryHealth(root)).toBe('loading');
  });

  it('ignores unrelated status text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p role="status">Version 1.0.3 · Up to date</p>';
    expect(inspectPageEntryHealth(root)).toBe('ready');
  });

  it('flags recoverable Discord / network alerts', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div role="alert" class="connection-unavailable"><h1>Can\'t connect right now</h1><button>Try again</button></div>';
    expect(inspectPageEntryHealth(root)).toBe('recoverable');
  });

  it('returns ready when no blocking UI is present', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h1>Home</h1><p role="status">Version 1.0.3</p>';
    expect(inspectPageEntryHealth(root)).toBe('ready');
  });
});
