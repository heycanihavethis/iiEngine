import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import fixture from '../../../fixtures/demo/dashboard.json';
import { usePreferences } from './store';

vi.mock('./Studio', () => ({
  default: () => <h2>ii Studio runs in the Windows desktop app</h2>,
}));
vi.mock('./AutoLoader', () => ({
  default: () => <h2>Trusted mod autoloader</h2>,
}));

function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <App />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  usePreferences.setState({ telemetry: false, reduceMotion: false, onboardingComplete: true });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/v1/content') ? { items: [] } : structuredClone(fixture)),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('local dashboard', () => {
  it('gates the dashboard and continues into the app', async () => {
    mount();
    expect(await screen.findByRole('button', { name: /^Continue$/i })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    expect(await screen.findByText('Local Explorer')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Launch with ii Reborn' }));
    await waitFor(() => expect(screen.getByText(/require the Windows desktop app/i)).toBeVisible());
  }, 15_000);
  it('supports keyboard entry and reduced motion preferences', async () => {
    mount();
    const enter = await screen.findByRole('button', { name: /^Continue$/i });
    enter.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Reduce motion' }));
    expect(document.querySelector('.reduced-motion')).not.toBeNull();
    expect(usePreferences.getState().reduceMotion).toBe(true);
  });
  it('shows join-server state for a nonmember', async () => {
    const nonmember = structuredClone(fixture);
    nonmember.member.membership = false;
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => nonmember } as Response);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /^Continue$/i }));
    expect(screen.getByRole('link', { name: 'Join Server' })).toHaveAttribute(
      'href',
      'https://discord.gg/iidk',
    );
    expect(screen.queryByRole('button', { name: 'Launch with ii Reborn' })).toBeNull();
  });
  it('reports connection errors without inventing live data', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Connection failed'));
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can't reach the network|try again/i);
    expect(alert).toHaveTextContent(/Can't connect right now/i);
    expect(screen.getByRole('button', { name: /Sign in with Discord instead/i })).toBeVisible();
    expect(screen.queryByText(/uvicorn|backend|local demo|127\.0\.0\.1/i)).toBeNull();
    expect(screen.queryByText(/live menu users/i)).toBeNull();
  });
  it('offers Discord sign-in when the saved session expired', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'Session expired; sign in again' }),
    } as Response);
    mount();
    expect(await screen.findByRole('button', { name: /Sign in with Discord/i })).toBeVisible();
    expect(screen.getByRole('heading', { name: /Sign in to continue/i })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Can't connect right now/i)).toBeNull();
  });
  it('opens community announcements channel', async () => {
    usePreferences.setState({ reduceMotion: true });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /^Continue$/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Community' }));
    expect(await screen.findByRole('button', { name: /^main$/i })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^main$/i }));
    await waitFor(() => expect(screen.getByText('Demo community')).toBeVisible());
    expect(screen.queryByText('Fixture release 1.0.3', { exact: false })).toBeNull();
  });
  it('offers a saved account and gates ii Studio to beta users', async () => {
    const saved = structuredClone(fixture);
    saved.demo = false;
    saved.member.display_name = 'Saved Member';
    saved.member.entitlements = ['user', 'beta'];
    saved.member.roles = [
      {
        id: '1549421049287020568',
        name: 'Beta Engine User',
        color: '#22c55e',
        emoji: '✅',
        icon_url: null,
        position: 10,
      },
    ];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).endsWith('/v1/content') ? { items: [] } : structuredClone(saved),
      } as Response),
    );
    mount();
    expect(await screen.findByRole('button', { name: /Saved Member/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Saved Member/ }));
    expect(await screen.findByRole('button', { name: /ii Studio/ })).toBeVisible();
    expect(screen.getByLabelText('Mod Library')).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /ii Studio/ }));
    expect(
      await screen.findByText('ii Studio runs in the Windows desktop app', undefined, {
        timeout: 10_000,
      }),
    ).toBeVisible();
  }, 30_000);
  it('opens the autoloader for every signed-in member', async () => {
    const fullAccess = structuredClone(fixture);
    fullAccess.demo = false;
    fullAccess.member.entitlements = ['user'];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).endsWith('/v1/content') ? { items: [] } : structuredClone(fullAccess),
      } as Response),
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Local Explorer/ }));
    const modLibrary = await screen.findByLabelText('Mod Library');
    expect(modLibrary).toBeEnabled();
    await userEvent.click(modLibrary);
    expect(await screen.findByText('Trusted mod autoloader')).toBeVisible();
  });
  it('shows the quick-start tutorial once and remembers completion', async () => {
    usePreferences.setState({ onboardingComplete: false });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /^Continue$/i }));
    expect(await screen.findByRole('dialog', { name: 'Welcome to ii Engine' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }));
    expect(usePreferences.getState().onboardingComplete).toBe(true);
  });
  it('offers uninstall ii Engine in Settings', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /^Continue$/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Uninstall ii Engine' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Uninstall ii Engine/i }));
    expect(screen.getByRole('button', { name: /Open uninstaller/i })).toBeInTheDocument();
    expect(screen.queryByText(/uvicorn|backend|local demo|DEMO DATA/i)).toBeNull();
  });

  it('warns before enabling The Kraken without changing the app theme', async () => {
    usePreferences.setState({ krakenSession: null, onboardingComplete: true });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /^Continue$/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Open launch options' }));
    await userEvent.click(screen.getByRole('button', { name: /The Kraken/i }));
    const dialog = await screen.findByRole('dialog', { name: /Release The Kraken/i });
    expect(dialog).toBeVisible();
    expect(screen.getByText(/community mod could be malicious/i)).toBeVisible();
    expect(screen.getByText(/lag, crash, or become unplayable/i)).toBeVisible();
    expect(screen.queryByText(/dark-red/i)).toBeNull();
    const confirm = screen.getByRole('button', { name: 'Release The Kraken' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /community mods may be malicious/i }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: /lag, crash, or become unplayable/i }),
    );
    await userEvent.type(screen.getByPlaceholderText('RELEASE THE KRAKEN'), 'RELEASE THE KRAKEN');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(usePreferences.getState().krakenSession?.active).toBe(true));
    expect(document.querySelector('.app.theme-kraken')).toBeNull();
    expect(document.querySelector('.kraken-live-banner')).not.toBeNull();
    expect(screen.queryByText(/dark-red/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'End The Kraken' }));
    await waitFor(() => expect(usePreferences.getState().krakenSession).toBeNull());
  }, 15_000);
});
