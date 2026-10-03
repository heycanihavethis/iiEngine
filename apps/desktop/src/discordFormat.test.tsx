import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscordFormattedText } from './discordFormat';

vi.mock('./external', () => ({
  externalClick: () => (event: Event) => event.preventDefault(),
}));

afterEach(() => cleanup());

it('renders Discord headings, bold, italic, underline, and strike', () => {
  render(
    <DiscordFormattedText text={'# Big news\n**bold** and *italic* and __under__ and ~~gone~~'} />,
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Big news' })).toBeInTheDocument();
  expect(screen.getByText('bold').tagName).toBe('STRONG');
  expect(screen.getByText('italic').tagName).toBe('EM');
  expect(screen.getByText('under').tagName).toBe('U');
  expect(screen.getByText('gone').tagName).toBe('S');
});

it('renders mentions, links, code, and spoilers', () => {
  render(
    <DiscordFormattedText
      text={'Hey <@123456789012345678> see `Plugin.cs` and ||secret|| https://example.com/path'}
      mentions={{ '<@123456789012345678>': '@ii' }}
    />,
  );
  expect(screen.getByText('@ii')).toHaveClass('discord-mention');
  expect(screen.getByText('Plugin.cs').tagName).toBe('CODE');
  expect(screen.getByLabelText(/Spoiler/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'https://example.com/path' })).toBeInTheDocument();
});
