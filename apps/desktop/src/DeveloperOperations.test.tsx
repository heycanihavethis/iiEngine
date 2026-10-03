import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DeveloperOperations } from './DeveloperOperations';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const operationsPayload = {
  countdown: { enabled: false, title: 'Next menu update', target_at: null },
  menu: { status: 'operational' as const, message: 'All good' },
  pricing: {
    lifetime_usd: 14,
    lifetime_on_sale: false,
    lifetime_sale_name: '',
    lifetime_was_usd: null,
    bundle_usd: 25,
    bundle_on_sale: false,
    bundle_sale_name: '',
    bundle_was_usd: null,
    tracker_solo_usd: 20,
    tracker_solo_on_sale: false,
    tracker_solo_sale_name: '',
    tracker_solo_was_usd: null,
    robux_price: 2500,
    robux_on_sale: false,
    robux_sale_name: '',
    robux_was_price: null,
    bundle_robux_price: 3250,
    bundle_robux_on_sale: false,
    bundle_robux_sale_name: '',
    bundle_robux_was_price: null,
  },
  checks: [{ name: 'Database', status: 'operational', detail: 'Connected' }],
  feature_access: {
    tracker: {
      enabled: true,
      everyone: false,
      role_ids: ['1549151900073459752'],
      entitlements: ['ii_tracker'],
    },
    target_tracker: {
      enabled: true,
      everyone: false,
      role_ids: ['1549151900073459752'],
      entitlements: ['ii_tracker'],
    },
    tracker_scout: {
      enabled: true,
      everyone: false,
      role_ids: ['1549151900073459752'],
      entitlements: ['ii_tracker'],
    },
    self_tracker: { enabled: true, everyone: true, role_ids: [], entitlements: [] },
    soundlab: { enabled: true, everyone: false, role_ids: [], entitlements: ['pro'] },
    customize: { enabled: true, everyone: false, role_ids: [], entitlements: ['pro'] },
    catalog: { enabled: true, everyone: true, role_ids: [], entitlements: [] },
    home_ai: { enabled: true, everyone: false, role_ids: [], entitlements: ['pro'] },
  },
  available_roles: [
    { id: '1549151900073459752', name: 'ii Tracker', color: '#ff9700', position: 1 },
  ],
  usage_stats: { generated_at: new Date().toISOString(), items: [] },
};

function stubDeveloperApis() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/developer/operations')) {
        return { ok: true, json: async () => operationsPayload };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    }),
  );
}

it('shows grouped Tracker and Pro feature gates on Access', async () => {
  stubDeveloperApis();
  render(
    <DeveloperOperations
      token="fixture-token"
      busy={false}
      enabled
      perform={async (action) => action()}
    />,
  );
  expect(await screen.findByRole('tab', { name: 'Access' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByText('Bulk updates')).toBeInTheDocument();
  expect(screen.getByText('All Tracker features')).toBeInTheDocument();
  expect(screen.getByText('All Pro features')).toBeInTheDocument();
  expect(screen.getByText('Tracker')).toBeInTheDocument();
  expect(screen.getByText('Pro surfaces')).toBeInTheDocument();
  expect(screen.getByText('Player Tracker use')).toBeInTheDocument();
  expect(screen.getByText('Target Tracker use')).toBeInTheDocument();
  expect(screen.getByText('Tracker Scout use')).toBeInTheDocument();
  expect(screen.getByText('Self Tracker')).toBeInTheDocument();
  expect(screen.getByText('SoundLab')).toBeInTheDocument();
  expect(screen.getByText('Customize')).toBeInTheDocument();
  expect(screen.getByText('Home AI')).toBeInTheDocument();
});

it('bulk Tracker audience sets every Tracker feature before save', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/developer/operations/features') && init?.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (String(url).includes('/developer/operations')) {
      return { ok: true, json: async () => operationsPayload };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(
    <DeveloperOperations
      token="fixture-token"
      busy={false}
      enabled
      perform={async (action) => action()}
    />,
  );
  await screen.findByText('All Tracker features');
  const trackerBulk = screen.getByLabelText('All Tracker features audience');
  await user.click(trackerBulk);
  await user.click(await screen.findByRole('option', { name: 'Every signed-in member' }));
  await user.click(screen.getByRole('button', { name: 'Save feature permissions' }));
  const saveCall = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).includes('/developer/operations/features') &&
      (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(saveCall).toBeTruthy();
  const body = JSON.parse(String((saveCall![1] as RequestInit).body));
  for (const key of ['tracker', 'target_tracker', 'tracker_scout', 'self_tracker']) {
    expect(body[key]).toMatchObject({ enabled: true, everyone: true });
  }
  expect(body.soundlab).toMatchObject({ enabled: true, everyone: false, entitlements: ['pro'] });
});

it('bulk Pro audience sets every Pro surface before save', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/developer/operations/features') && init?.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (String(url).includes('/developer/operations')) {
      return { ok: true, json: async () => operationsPayload };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(
    <DeveloperOperations
      token="fixture-token"
      busy={false}
      enabled
      perform={async (action) => action()}
    />,
  );
  await screen.findByText('All Pro features');
  const proBulk = screen.getByLabelText('All Pro features audience');
  await user.click(proBulk);
  await user.click(await screen.findByRole('option', { name: 'Disabled for everyone' }));
  await user.click(screen.getByRole('button', { name: 'Save feature permissions' }));
  const saveCall = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).includes('/developer/operations/features') &&
      (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(saveCall).toBeTruthy();
  const body = JSON.parse(String((saveCall![1] as RequestInit).body));
  for (const key of ['soundlab', 'customize', 'home_ai']) {
    expect(body[key]).toMatchObject({ enabled: false, everyone: false });
  }
  expect(body.tracker).toMatchObject({ enabled: true, everyone: false });
});

it('exposes Tracker solo and Pro/bundle Robux sale controls on Pricing', async () => {
  stubDeveloperApis();
  const user = userEvent.setup();
  render(
    <DeveloperOperations
      token="fixture-token"
      busy={false}
      enabled
      perform={async (action) => action()}
    />,
  );
  await screen.findByRole('tab', { name: 'Access' });
  await user.click(screen.getByRole('tab', { name: 'Pricing' }));
  const pricing = screen.getByRole('tab', { name: 'Pricing' });
  expect(pricing).toHaveAttribute('aria-selected', 'true');
  const form = screen.getByRole('button', { name: 'Save Plans pricing' }).closest('form');
  expect(form).toBeTruthy();
  const panel = within(form as HTMLElement);
  expect(panel.getByText(/ii Tracker solo/i)).toBeInTheDocument();
  expect(panel.getByLabelText(/Tracker solo USD/i)).toHaveValue(20);
  expect(panel.getByLabelText(/Pro lifetime Robux/i)).toHaveValue(2500);
  expect(panel.getByLabelText(/Pro \+ Tracker Robux/i)).toHaveValue(3250);
  expect(panel.getByText(/Tracker solo on sale/i)).toBeInTheDocument();
  expect(panel.getByText(/Pro Robux on sale/i)).toBeInTheDocument();
  expect(panel.getByText(/Bundle Robux on sale/i)).toBeInTheDocument();
});
