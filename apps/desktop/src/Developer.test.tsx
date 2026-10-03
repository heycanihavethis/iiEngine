import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import Developer from './Developer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const operationsPayload = {
  countdown: { enabled: false, title: '', target_at: null },
  menu: { status: 'operational', message: 'All good' },
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
  feature_access: {},
  available_roles: [],
  usage_stats: { generated_at: new Date().toISOString(), items: [] },
};

it('unlocks, saves a draft and requires a separate publication review', async () => {
  const calls: string[] = [];
  let saved = false;
  const item = {
    id: 'fixture',
    kind: 'announcement',
    title: 'Test notice',
    text: 'Fixture text',
    url: '',
    channel: 'stable',
    version: '',
    sha256: '',
    source_commit: '',
    manifest: '',
    revision: 1,
    published_at: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      calls.push(options.method + ' ' + url);
      if (url.endsWith('/unlock'))
        return {
          ok: true,
          json: async () => ({ token: 'fixture-token', publishing_enabled: true }),
        };
      expect(new Headers(options.headers).get('X-Developer-Token')).toBe('fixture-token');
      if (options.method === 'GET') {
        if (url.includes('/developer/operations'))
          return { ok: true, json: async () => operationsPayload };
        if (url.includes('/developer/trusted-mods'))
          return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/developer/studio-templates'))
          return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/developer/creator-applications'))
          return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/developer/community-mods'))
          return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/developer/background-tracks'))
          return { ok: true, json: async () => ({ items: [] }) };
        return { ok: true, json: async () => ({ items: saved ? [item] : [] }) };
      }
      saved = true;
      return { ok: true, json: async () => item };
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Developer demo={true} />
    </QueryClientProvider>,
  );
  await userEvent.type(screen.getByLabelText('Developer group password'), 'fixture-password-only');
  await userEvent.click(screen.getByRole('button', { name: 'Unlock developer panel' }));
  await userEvent.type(await screen.findByLabelText('Title'), 'Test notice');
  await userEvent.type(screen.getByLabelText('Message / release notes'), 'Fixture text');
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(
    await screen.findByText(/Draft saved\. Published content stays unchanged until you publish\./),
  ).toBeInTheDocument();
  expect(calls.some((path) => path.endsWith('/visibility'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Review saved draft' }));
  await userEvent.click(screen.getByRole('button', { name: 'Publish saved revision' }));
  expect(await screen.findByText(/Published to this backend/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Lock panel' }));
  expect(screen.getByLabelText('Developer group password')).toHaveValue('');
});
