import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Community from './Community';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/api/core', () => native);

function chatMessage(index: number) {
  return {
    id: `message-${index}`,
    category: 'chat' as const,
    body: `Message ${index}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 12, index)).toISOString(),
    author: { id: 'member-1', display_name: 'Member One', avatar: null },
  };
}

let messages = [] as Array<
  ReturnType<typeof chatMessage> & {
    mentioned_me?: boolean;
    mentioned_user_ids?: string[];
    mentions?: Record<string, string>;
  }
>;
let scrollIntoView: ReturnType<typeof vi.fn>;

function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Community demo={false} />
    </QueryClientProvider>,
  );
}

function setScrollPosition(list: HTMLElement, scrollTop: number) {
  Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
  list.scrollTop = scrollTop;
  list.dispatchEvent(new Event('scroll', { bubbles: true }));
}

beforeEach(() => {
  messages = [chatMessage(1), chatMessage(2)];
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(input).includes('/v1/community/messages')
          ? { items: messages }
          : { items: [], next_cursor: null, stale: false, unavailable: false },
      text: async () => '',
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('follows new messages only while the reader is at the bottom', async () => {
  mount();
  await userEvent.click(screen.getByRole('button', { name: /^general$/ }));
  expect(await screen.findByText('Message 1')).toBeInTheDocument();
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

  const list = document.querySelector('.discord-messages') as HTMLElement;
  expect(list).not.toBeNull();
  setScrollPosition(list, 0);
  expect(await screen.findByRole('button', { name: /Jump to latest/i })).toBeVisible();

  scrollIntoView.mockClear();
  messages = [...messages, chatMessage(3)];
  expect(await screen.findByText('Message 3', undefined, { timeout: 8000 })).toBeInTheDocument();
  expect(scrollIntoView).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: /Jump to latest/i }));
  expect(scrollIntoView).toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Jump to latest/i })).toBeNull();
}, 20_000);

it('opens the gfinder info channel with a link to gfinder.pro', async () => {
  mount();
  await userEvent.click(screen.getByRole('button', { name: /^gfinder$/ }));
  expect(await screen.findByRole('heading', { name: 'GFinder' })).toBeInTheDocument();
  expect(screen.getByText(/first tool of its kind/i)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: /Open gfinder\.pro/i });
  expect(link).toHaveAttribute('href', 'https://gfinder.pro');
});

it('highlights messages that mention the viewer and renders @labels', async () => {
  const targetId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  messages = [
    {
      id: 'mention-1',
      category: 'chat',
      body: `hey <@${targetId}> look here`,
      created_at: new Date().toISOString(),
      author: { id: 'member-2', display_name: 'Member Two', avatar: null },
      mentioned_me: true,
      mentioned_user_ids: [targetId],
      mentions: { [`<@${targetId}>`]: '@You' },
    },
  ];
  mount();
  await userEvent.click(screen.getByRole('button', { name: /^general$/ }));
  expect(await screen.findByText('@You')).toBeInTheDocument();
  expect(document.querySelector('.discord-message.mentioned-me')).not.toBeNull();
  expect(screen.queryByText(new RegExp(targetId))).toBeNull();
});
