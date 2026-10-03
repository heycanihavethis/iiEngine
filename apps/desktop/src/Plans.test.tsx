import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import Plans from './Plans';

afterEach(cleanup);

describe('Plans', () => {
  it('shows plan tiers including Robux Engine and Tracker bundle and never mentions GFinder', () => {
    const { container } = render(<Plans demo />);
    expect(screen.getByRole('heading', { name: 'Monthly' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lifetime' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lifetime + ii Tracker' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lifetime (Robux)' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Lifetime + ii Tracker (Robux)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /What Pro unlocks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ii Tracker/i })).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).toMatch(/\$7/);
    expect(text).toMatch(/\$14/);
    expect(text).toMatch(/\$20/);
    expect(text).toMatch(/\$25/);
    expect(text).toMatch(/buy ii Tracker by itself/i);
    expect(text).toMatch(/pre-order/i);
    expect(text).toMatch(/2,?500\s*R\$/);
    expect(text).toMatch(/3,?250\s*R\$/);
    expect(text).toMatch(/2,?700\s*R\$/);
    expect(text).toMatch(/Weekend Robux deal|Save Robux on weekends/i);
    expect(text).toMatch(/Direct menu connection/);
    expect(text).toMatch(/ii SoundLab/);
    expect(text).not.toMatch(/gfinder/i);
    expect(text).not.toMatch(/gorilla\s*finder/i);
  });

  it('tells Pro members they already own it instead of pitching a purchase', () => {
    const { container } = render(<Plans demo isPro />);
    expect(screen.getByText(/You're on Pro/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Monthly' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Buy lifetime/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Robux purchase steps/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Claim Tracker via Robux/i })).toBeInTheDocument();
    expect(container.textContent ?? '').toMatch(/ii Tracker/);
  });

  it('opens Robux steps with Engine + Tracker product selected from the bundle card', async () => {
    render(<Plans demo />);
    await userEvent.click(screen.getByRole('button', { name: /Bundle purchase steps/i }));
    expect(screen.getByRole('heading', { name: /Buy with Robux/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Engine \+ Tracker/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('button', { name: /Claim Engine \+ Tracker/i })).toBeInTheDocument();
  });

  it('renders custom sale text under the price without On sale pills', () => {
    const { container } = render(
      <Plans
        demo
        demoPricing={{
          lifetime_usd: 9,
          lifetime_on_sale: true,
          lifetime_sale_name: 'Launch week',
          lifetime_was_usd: 14,
          bundle_usd: 18,
          bundle_on_sale: true,
          bundle_sale_name: 'Tracker pack promo',
          bundle_was_usd: 25,
          tracker_solo_usd: 15,
          tracker_solo_on_sale: true,
          tracker_solo_sale_name: 'Tracker launch',
          tracker_solo_was_usd: 20,
          robux_price: 1800,
          robux_on_sale: true,
          robux_sale_name: 'Roblox promo',
          robux_was_price: 2500,
          bundle_robux_price: 3250,
          bundle_robux_on_sale: false,
          bundle_robux_sale_name: '',
          bundle_robux_was_price: null,
        }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/\$9/);
    expect(text).toMatch(/\$14/);
    expect(text).toMatch(/\$18/);
    expect(text).toMatch(/\$25/);
    expect(text).toMatch(/1,?800\s*R\$/);
    expect(text).toMatch(/2,?500\s*R\$/);
    expect(container.querySelectorAll('.plans-sale-line').length).toBe(4);
    expect(screen.getByText('Launch week')).toBeInTheDocument();
    expect(screen.getByText('Tracker pack promo')).toBeInTheDocument();
    expect(screen.getByText('Tracker launch')).toBeInTheDocument();
    expect(screen.getByText('Roblox promo')).toBeInTheDocument();
    expect(screen.queryByText('On sale')).not.toBeInTheDocument();
    expect(container.querySelector('.plans-sale-badge')).toBeNull();
    expect(container.querySelector('.plans-sale-pill')).toBeNull();
  });
});
