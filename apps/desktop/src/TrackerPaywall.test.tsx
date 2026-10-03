import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TrackerPaywall } from './TrackerPaywall';

afterEach(() => {
  cleanup();
});

it('renders a locked Player Tracker teaser with Plans CTA', async () => {
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(<TrackerPaywall product="player" navigate={navigate} />);
  expect(screen.getByRole('dialog', { name: /Player Tracker/i })).toBeInTheDocument();
  expect(screen.getByText(/ii Tracker required/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Tracker on iistupid\.com/i })).toHaveAttribute(
    'href',
    'https://iistupid.com/',
  );
  expect(screen.getByRole('link', { name: /Pro \+ Tracker \(Robux\)/i })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /View Plans/i }));
  expect(navigate).toHaveBeenCalledWith('Plans');
});

it('does not expose real usernames in the fake tease', () => {
  const { container } = render(<TrackerPaywall product="target" />);
  expect(container.textContent).not.toMatch(/Flower|Volt|player_/i);
  expect(container.querySelector('.tracker-paywall-tease')).toHaveAttribute('aria-hidden', 'true');
});
