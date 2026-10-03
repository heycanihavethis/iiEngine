import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
} from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown,
  Bug,
  Crown,
  ExternalLink,
  Hash,
  Lightbulb,
  Lock,
  Megaphone,
  MessageCircle,
  Radar,
  Search,
  Send,
  Trash2,
  Pin,
} from 'lucide-react';
import { ApiError, apiRequest, errorMessage } from './api';
import type { Announcement } from '../../../packages/contracts/dashboard';
import {
  encodeMentionsForSend,
  filterMentionables,
  insertMention,
  mentionQueryAtCaret,
  splitMentionBody,
  type Mentionable,
} from './chatMentions';
import { DiscordFormattedText } from './discordFormat';
import { externalClick } from './external';
import { usePreferences } from './store';
import { parseAiChatSse } from './studioAssist';
import { trackFeature, recordAiTranscript } from './telemetry';

type Identity = {
  id: string;
  display_name: string;
  avatar: string | null;
  role_name?: string | null;
  role_color?: string | null;
};
type Message = {
  id: string;
  category: 'chat' | 'bug' | 'suggestion' | 'pro' | 'engine';
  body: string;
  created_at: string;
  anonymous?: boolean;
  is_assistant?: boolean;
  author: Identity;
  mine?: boolean;
  can_delete?: boolean;
  mentioned_me?: boolean;
  mentioned_user_ids?: string[];
  mentions?: Record<string, string>;
};

type ChannelId =
  | 'announcements'
  | 'announcements-main'
  | 'announcements-menu'
  | 'announcements-updates'
  | 'engine-announcements'
  | 'gfinder'
  | 'general'
  | 'feedback-bugs'
  | 'feedback-ideas'
  | 'pro';

const GFINDER_URL = 'https://gfinder.pro';

type Feed = {
  items: Announcement[];
  stale: boolean;
  unavailable: boolean;
  next_cursor: string | null;
  can_moderate?: boolean;
};

const ANNOUNCEMENT_CHANNELS: Record<string, string> = {
  announcements: '',
  'announcements-main': '1537550313546981507',
  'announcements-menu': '1548782443715240017',
  'announcements-updates': '1547774251963256893',
};

function chatCategory(channel: ChannelId): Message['category'] {
  if (channel === 'general') return 'chat';
  if (channel === 'feedback-bugs') return 'bug';
  if (channel === 'feedback-ideas') return 'suggestion';
  if (channel === 'engine-announcements') return 'engine';
  return 'pro';
}

function Avatar({ person }: { person: Identity }) {
  return person.avatar ? (
    <img className="discord-avatar" src={person.avatar} alt="" />
  ) : (
    <span className="discord-avatar fallback">{person.display_name.slice(0, 1)}</span>
  );
}

function displayAuthor(item: Message): Identity {
  if (item.is_assistant) {
    return {
      id: 'iigpt',
      display_name: 'iiGPT',
      avatar: null,
      role_name: 'Assistant',
      role_color: '#f0a05a',
    };
  }
  if (item.anonymous) {
    return {
      id: 'anonymous',
      display_name: 'Anonymous',
      avatar: null,
      role_name: null,
      role_color: null,
    };
  }
  return item.author;
}

function trustedImage(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) &&
      /\.(png|jpe?g|gif|webp)$/i.test(url.pathname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function displayTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function AnnouncementBody({ item }: { item: Announcement }) {
  return <DiscordFormattedText text={item.text} mentions={item.mentions ?? {}} />;
}

function MessageBody({ item }: { item: Message }) {
  const parts = splitMentionBody(item.body, item.mentions ?? {});
  return (
    <p>
      {parts.map((part, index) =>
        part.type === 'mention' ? (
          <span key={`${item.id}-m-${index}`} className="engine-chat-mention">
            {part.value}
          </span>
        ) : (
          <span key={`${item.id}-t-${index}`}>{part.value}</span>
        ),
      )}
    </p>
  );
}

function MessageRow({
  item,
  compact,
  onDelete,
}: {
  item: Message;
  compact: boolean;
  onDelete: (id: string) => void;
}) {
  const author = displayAuthor(item);
  const color = author.role_color || undefined;
  return (
    <motion.article
      className={`discord-message ${compact ? 'compact' : ''} ${item.anonymous ? 'anonymous' : ''} ${item.is_assistant ? 'assistant' : ''} ${item.mentioned_me ? 'mentioned-me' : ''}`}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      {!compact ? (
        <Avatar person={author} />
      ) : (
        <time className="discord-hover-time">
          {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      )}
      <div className="discord-message-body">
        {!compact && (
          <header className="discord-message-header">
            <span className="discord-username" style={color ? { color } : undefined}>
              {author.display_name}
            </span>
            {author.role_name ? (
              <span
                className="discord-role-badge"
                style={{ '--role-color': color || '#dee0e2' } as CSSProperties}
                title={author.role_name}
              >
                {author.role_name}
              </span>
            ) : null}
            {item.anonymous && <span className="discord-channel-pill chat">anon</span>}
            {item.category !== 'chat' && item.category !== 'pro' && (
              <span className={`discord-channel-pill ${item.category}`}>{item.category}</span>
            )}
            <time>
              {new Date(item.created_at).toLocaleString([], {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </time>
            {item.can_delete && (
              <button
                type="button"
                className="discord-delete"
                title="Delete message"
                onClick={() => onDelete(item.id)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </header>
        )}
        <MessageBody item={item} />
        {compact && item.can_delete && (
          <button
            type="button"
            className="discord-delete floating"
            title="Delete message"
            onClick={() => onDelete(item.id)}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </motion.article>
  );
}

function channelMeta(channel: ChannelId) {
  switch (channel) {
    case 'announcements':
      return {
        title: 'announcements',
        blurb: 'Read-only posts from the ii Discord server.',
        icon: <Megaphone size={18} />,
      };
    case 'announcements-main':
      return {
        title: 'main-announcements',
        blurb: 'Main server announcements.',
        icon: <Megaphone size={18} />,
      };
    case 'announcements-menu':
      return {
        title: 'menu-announcements',
        blurb: 'Menu and mod announcements.',
        icon: <Megaphone size={18} />,
      };
    case 'announcements-updates':
      return {
        title: 'changelog',
        blurb: 'Engine changelog and updates.',
        icon: <Megaphone size={18} />,
      };
    case 'engine-announcements':
      return {
        title: 'engine-announcements',
        blurb: 'Official ii Engine posts from developers and admins. Not pulled from Discord.',
        icon: <Megaphone size={18} />,
      };
    case 'gfinder':
      return {
        title: 'gfinder',
        blurb: 'Free Gorilla Tag player search by Useless — original GFinder.',
        icon: <Radar size={18} />,
      };
    case 'general':
      return {
        title: 'general',
        blurb: 'Talk with other ii Engine members.',
        icon: <Hash size={18} />,
      };
    case 'feedback-bugs':
      return {
        title: 'bugs',
        blurb: 'Report issues you hit in the engine.',
        icon: <Bug size={18} />,
      };
    case 'feedback-ideas':
      return {
        title: 'ideas',
        blurb: 'Share suggestions for the team.',
        icon: <Lightbulb size={18} />,
      };
    case 'pro':
      return {
        title: 'pro-lounge',
        blurb: 'Engine Pro members only.',
        icon: <Crown size={18} />,
      };
  }
}

export default function Community({
  demo,
  fixtures = [],
  isPro = false,
  canStaff = false,
}: {
  demo: boolean;
  fixtures?: Announcement[];
  isPro?: boolean;
  canStaff?: boolean;
}) {
  const anonymousChat = usePreferences((state) => state.anonymousChat);
  const [channel, setChannel] = useState<ChannelId>('announcements');
  const [messages, setMessages] = useState<Message[]>([]);
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  const [body, setBody] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const end = useRef<HTMLDivElement | null>(null);
  const messageList = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const isAnnounce = channel.startsWith('announcements');
  const isEngineAnnounce = channel === 'engine-announcements';
  const isGfinder = channel === 'gfinder';
  const staffPoster = canStaff || demo;
  const meta = channelMeta(channel);

  const load = useCallback(async () => {
    if (demo) return;
    try {
      const messageResponse = await apiRequest('/v1/community/messages');
      const incoming = ((await messageResponse.json()) as { items: Message[] }).items;
      setMessages((current) => {
        const serverIds = new Set(incoming.map((item) => item.id));
        const pendingLocals = current.filter(
          (item) =>
            String(item.id).startsWith('local-') &&
            !serverIds.has(item.id) &&
            !incoming.some(
              (row) =>
                row.is_assistant === item.is_assistant &&
                row.body === item.body &&
                row.category === item.category,
            ),
        );
        return pendingLocals.length ? [...incoming, ...pendingLocals] : incoming;
      });
      setError('');
    } catch (reason) {
      setError(errorMessage(reason, 'Chat is temporarily unavailable.'));
    }
  }, [demo]);

  const loadMentionables = useCallback(async () => {
    if (demo) return;
    try {
      const response = await apiRequest('/v1/community/mentionables');
      const payload = (await response.json()) as { items: Mentionable[] };
      setMentionables(Array.isArray(payload.items) ? payload.items : []);
    } catch {}
  }, [demo]);

  useEffect(() => {
    trackFeature('community_chat', 'open');
    if (demo) {
      const demoMemberId = '11111111-1111-1111-1111-111111111111';
      const demoDevId = '22222222-2222-2222-2222-222222222222';
      setMentionables([
        { id: demoMemberId, display_name: 'Demo Member', avatar: null },
        { id: demoDevId, display_name: 'Local developer', avatar: null },
      ]);
      setMessages([
        {
          id: 'demo-mention',
          category: 'chat',
          body: `hey <@${demoMemberId}> welcome to general`,
          created_at: new Date().toISOString(),
          author: {
            id: demoDevId,
            display_name: 'Local developer',
            avatar: null,
            role_name: 'Developer',
            role_color: '#ed7602',
          },
          mentioned_me: true,
          mentioned_user_ids: [demoMemberId],
          mentions: { [`<@${demoMemberId}>`]: '@Demo Member' },
        },
      ]);
      return;
    }
    void load();
    void loadMentionables();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [demo, load, loadMentionables]);

  const mentionQuery = mentionQueryAtCaret(body, caret);
  const mentionSuggestions =
    mentionQuery && !anonymousChat && !mentionDismissed
      ? filterMentionables(mentionables, mentionQuery.query)
      : [];

  useEffect(() => {
    setMentionIndex(0);
    setMentionDismissed(false);
  }, [mentionQuery?.start, mentionQuery?.query]);

  const jumpToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    setAtBottom(true);
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
    end.current?.scrollIntoView?.({ behavior, block: 'end' });
  }, []);

  useEffect(() => {
    setAtBottom(true);
  }, [channel]);

  useEffect(() => {
    if (!atBottom) return;
    end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length, channel, atBottom]);

  const feed = useInfiniteQuery({
    queryKey: ['community-announcements', ANNOUNCEMENT_CHANNELS[channel] ?? ''],
    enabled: !demo && isAnnounce,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<Feed> => {
      const params = new URLSearchParams({ limit: '20' });
      const id = ANNOUNCEMENT_CHANNELS[channel];
      if (id) params.set('channel', id);
      if (pageParam) params.set('before', pageParam);
      return (await apiRequest(`/v1/announcements?${params}`)).json();
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
  });

  const announceItems = (
    demo
      ? fixtures.filter((item) => {
          if (channel === 'announcements') return true;
          if (channel === 'announcements-main') return item.source === 'Main announcements';
          if (channel === 'announcements-menu') return item.source === 'Menu announcements';
          if (channel === 'announcements-updates') return item.source === 'Changelog/updates';
          return true;
        })
      : (feed.data?.pages.flatMap((page) => page.items) ?? [])
  )
    .filter((item) => {
      const term = search.trim().toLowerCase();
      if (!term) return true;
      return `${item.author} ${item.text} ${item.source}`.toLowerCase().includes(term);
    })
    .slice()
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));

  const canModerateAnnounce = demo || feed.data?.pages.some((page) => page.can_moderate) || false;

  const visibleChat = messages.filter((item) => {
    if (channel === 'general') return item.category === 'chat';
    if (channel === 'feedback-bugs') return item.category === 'bug';
    if (channel === 'feedback-ideas') return item.category === 'suggestion';
    if (channel === 'pro') return item.category === 'pro';
    if (channel === 'engine-announcements') return item.category === 'engine';
    return false;
  });

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!body.trim() || isAnnounce || isGfinder) return;
    if (isEngineAnnounce && !staffPoster) {
      setError('Only Engine developers and admins can post here.');
      return;
    }
    if (channel === 'pro' && !isPro && !demo) {
      setError('Engine Pro is required to post here.');
      return;
    }
    const trimmed = encodeMentionsForSend(body.trim(), mentionables);
    if (isEngineAnnounce && demo) {
      const local: Message = {
        id: `local-engine-${Date.now()}`,
        category: 'engine',
        body: trimmed,
        created_at: new Date().toISOString(),
        anonymous: false,
        author: {
          id: 'local-demo-developer',
          display_name: 'Local developer',
          avatar: null,
          role_name: 'Developer',
          role_color: '#ed7602',
        },
        mine: true,
        can_delete: true,
      };
      setMessages((current) => [...current, local]);
      setBody('');
      setError('');
      jumpToLatest();
      return;
    }
    if (demo) return;
    const aiMatch = trimmed.match(/^\/ai(?:\s+|$)([\s\S]*)$/i);
    if (aiMatch) {
      if (isEngineAnnounce) {
        setError('/ai is not available in Engine announcements.');
        return;
      }
      if (!isPro) {
        setError('Engine Pro is required to use /ai in community chat.');
        return;
      }
      const prompt = aiMatch[1].trim();
      if (!prompt) {
        setError('Usage: /ai your question');
        return;
      }
      setBusy(true);
      const category = chatCategory(channel);
      try {
        let items: Message[] | undefined;
        try {
          const response = await apiRequest('/v1/community/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category,
              prompt,
              anonymous: channel === 'general' || channel === 'pro' ? anonymousChat : false,
              share_telemetry: false,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          const payload = (await response.json()) as { items?: Message[] };
          items = payload.items;
        } catch (reason) {
          if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
          const chatResponse = await apiRequest('/v1/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `ii Engine community /ai help: ${prompt}`,
              share_telemetry: false,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          const parsed = parseAiChatSse(await chatResponse.text());
          if (parsed.error) throw new Error(parsed.error, { cause: reason });
          const answer = parsed.text.trim();
          if (!answer) throw new Error('No answer returned.', { cause: reason });
          await apiRequest('/v1/community/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              category,
              body: `/ai ${prompt}`,
              anonymous: channel === 'general' || channel === 'pro' ? anonymousChat : false,
              share_telemetry: false,
            }),
          });
          await load();
          const assistant: Message = {
            id: `local-ai-${Date.now()}`,
            category,
            body: answer,
            created_at: new Date().toISOString(),
            is_assistant: true,
            author: {
              id: 'iigpt',
              display_name: 'iiGPT',
              avatar: null,
              role_name: 'Assistant',
              role_color: '#f0a05a',
            },
          };
          setMessages((current) => [...current, assistant]);
          recordAiTranscript('community', prompt, answer);
          trackFeature('ai_community', `${category}_fallback`);
          setBody('');
          setError('');
          return;
        }
        if (items?.length) {
          setMessages((current) => [...current, ...items!]);
          const assistant = items.find((item) => item.is_assistant);
          if (assistant?.body) recordAiTranscript('community', prompt, assistant.body);
        } else {
          await load();
        }
        trackFeature('ai_community', category);
        setBody('');
        setError('');
      } catch (reason) {
        setError(errorMessage(reason, 'iiGPT could not answer right now.'));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    const category = chatCategory(channel);
    try {
      await apiRequest('/v1/community/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          body: trimmed,
          anonymous:
            category === 'engine'
              ? false
              : channel === 'general' || channel === 'pro'
                ? anonymousChat
                : false,
          share_telemetry: false,
        }),
      });
      trackFeature('community_posts', category);
      setBody('');
      jumpToLatest();
      await load();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not send the message.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (demo) return;
    try {
      await apiRequest(`/v1/community/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMessages((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(errorMessage(reason, 'Could not delete the message.'));
    }
  }

  async function removeAnnouncement(item: Announcement) {
    if (demo) return;
    try {
      await apiRequest(
        `/v1/announcements/${encodeURIComponent(item.channel)}/${encodeURIComponent(item.id)}`,
        { method: 'DELETE' },
      );
      await feed.refetch();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not delete the announcement.'));
    }
  }

  async function togglePinAnnouncement(item: Announcement) {
    if (demo) return;
    try {
      await apiRequest(
        `/v1/announcements/${encodeURIComponent(item.channel)}/${encodeURIComponent(item.id)}/pin`,
        { method: item.pinned ? 'DELETE' : 'POST' },
      );
      await feed.refetch();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not update the pin.'));
    }
  }

  function onMessagesScroll(event: UIEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
    setAtBottom((current) => (current === near ? current : near));
  }

  function applyMention(person: Mentionable) {
    const next = insertMention(body, caret, person);
    setBody(next.value);
    setCaret(next.caret);
    window.requestAnimationFrame(() => {
      const node = composerRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionSuggestions.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length,
        );
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        const selected = mentionSuggestions[mentionIndex];
        if (selected) {
          event.preventDefault();
          applyMention(selected);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function selectChannel(next: ChannelId) {
    if (next === 'pro' && !isPro && !demo) {
      setError('Engine Pro unlocks #pro-lounge. Grab Pro on Discord to join.');
      return;
    }
    setError('');
    setChannel(next);
  }

  return (
    <section className="discord-shell community-server">
      <aside className="discord-channels" aria-label="Server channels">
        <div className="discord-server-banner">
          <MessageCircle size={16} />
          <strong>ii Community</strong>
        </div>

        <p className="discord-category-label">Announcement channels</p>
        <button
          type="button"
          className={channel === 'announcements' ? 'active' : ''}
          onClick={() => selectChannel('announcements')}
        >
          <Megaphone size={16} /> announcements
        </button>
        <button
          type="button"
          className={channel === 'announcements-main' ? 'active' : ''}
          onClick={() => selectChannel('announcements-main')}
        >
          <Megaphone size={16} /> main
        </button>
        <button
          type="button"
          className={channel === 'announcements-menu' ? 'active' : ''}
          onClick={() => selectChannel('announcements-menu')}
        >
          <Megaphone size={16} /> menu
        </button>
        <button
          type="button"
          className={channel === 'announcements-updates' ? 'active' : ''}
          onClick={() => selectChannel('announcements-updates')}
        >
          <Megaphone size={16} /> changelog
        </button>
        <button
          type="button"
          className={channel === 'engine-announcements' ? 'active' : ''}
          onClick={() => selectChannel('engine-announcements')}
          title={
            staffPoster
              ? 'Post official Engine news (in-app, not Discord)'
              : 'Read-only for members. Staff post here'
          }
        >
          {staffPoster ? <Megaphone size={16} /> : <Lock size={16} />} engine-announcements
        </button>

        <p className="discord-category-label">Tools</p>
        <button
          type="button"
          className={channel === 'gfinder' ? 'active' : ''}
          onClick={() => selectChannel('gfinder')}
          title="GFinder — free Gorilla Tag player search"
        >
          <Radar size={16} /> gfinder
        </button>

        <p className="discord-category-label">Text channels</p>
        <button
          type="button"
          className={channel === 'general' ? 'active' : ''}
          onClick={() => selectChannel('general')}
        >
          <Hash size={16} /> general
        </button>
        <button
          type="button"
          className={channel === 'feedback-bugs' ? 'active' : ''}
          onClick={() => selectChannel('feedback-bugs')}
        >
          <Bug size={16} /> bugs
        </button>
        <button
          type="button"
          className={channel === 'feedback-ideas' ? 'active' : ''}
          onClick={() => selectChannel('feedback-ideas')}
        >
          <Lightbulb size={16} /> ideas
        </button>

        <p className="discord-category-label">Pro</p>
        <button
          type="button"
          className={`discord-pro-channel ${channel === 'pro' ? 'active' : ''}`}
          onClick={() => selectChannel('pro')}
          title={isPro || demo ? 'Pro lounge' : 'Engine Pro required'}
        >
          {isPro || demo ? <Crown size={16} /> : <Lock size={16} />} pro-lounge
        </button>
      </aside>

      <div className="discord-main">
        <header className="discord-topbar">
          {meta.icon}
          <div>
            <h2>{meta.title}</h2>
            <p>{meta.blurb}</p>
          </div>
          {isAnnounce && (
            <label className="discord-search">
              <Search size={14} />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search…"
                aria-label="Search announcements"
              />
            </label>
          )}
        </header>

        {error && (
          <div className="inline-alert error community-auth-alert" role="alert">
            {error}
          </div>
        )}

        {isAnnounce ? (
          <div className="discord-messages discord-announce-feed" aria-live="polite">
            {!demo && feed.isPending && <p role="status">Loading announcements…</p>}
            {!demo && feed.isError && (
              <div className="inline-alert error community-auth-alert" role="alert">
                <p>{feed.error.message}</p>
                <button type="button" onClick={() => void feed.refetch()}>
                  Retry
                </button>
              </div>
            )}
            {announceItems.map((item) => {
              const images = item.images?.filter(trustedImage) ?? [];
              return (
                <article
                  className={`discord-announce-card ${item.pinned ? 'pinned' : ''}`}
                  key={`${item.channel}-${item.id}`}
                >
                  {item.pinned && (
                    <span className="pinned-flag">
                      <Pin size={12} /> Pinned
                    </span>
                  )}
                  <header className="discord-message-header">
                    <span className="announcement-author-avatar compact">
                      {item.avatar ? <img src={item.avatar} alt="" /> : item.author.slice(0, 1)}
                    </span>
                    <span
                      className="discord-username"
                      style={item.author_color ? { color: item.author_color } : undefined}
                    >
                      {item.author_emoji ? `${item.author_emoji} ` : ''}
                      {item.author}
                    </span>
                    <span className="discord-channel-pill chat">{item.source}</span>
                    <time dateTime={item.timestamp}>{displayTime(item.timestamp)}</time>
                    {canModerateAnnounce && (
                      <button
                        type="button"
                        className="discord-delete"
                        title={item.pinned ? 'Unpin announcement' : 'Pin announcement'}
                        onClick={() => void togglePinAnnouncement(item)}
                      >
                        <Pin size={14} />
                      </button>
                    )}
                    {canModerateAnnounce && (
                      <button
                        type="button"
                        className="discord-delete"
                        title="Delete announcement"
                        onClick={() => void removeAnnouncement(item)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </header>
                  <AnnouncementBody item={item} />
                  {images.map((url) => (
                    <img
                      key={url}
                      className="announcement-image"
                      src={url}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      alt=""
                    />
                  ))}
                  {item.url &&
                    /^https:\/\/discord\.com\/channels\/1170093288557129748\/\d{15,20}\/\d{15,20}$/.test(
                      item.url,
                    ) && (
                      <a
                        className="changelog-link"
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={externalClick(item.url)}
                      >
                        View on Discord →
                      </a>
                    )}
                </article>
              );
            })}
            {!announceItems.length && (demo || !feed.isPending) && (
              <div className="discord-empty">
                <Megaphone size={28} />
                <strong>No announcements here yet</strong>
                <p>When the server posts, they show up in this channel.</p>
              </div>
            )}
            {!demo && feed.hasNextPage && (
              <button
                type="button"
                className="discord-load-more"
                disabled={feed.isFetchingNextPage}
                onClick={() => void feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage ? 'Loading…' : 'Load older announcements'}
              </button>
            )}
          </div>
        ) : isGfinder ? (
          <div className="discord-messages community-info-channel" aria-label="About GFinder">
            <article className="community-info-card">
              <header className="community-info-card-head">
                <span className="community-info-mark" aria-hidden="true">
                  <Radar size={22} />
                </span>
                <div>
                  <h3>GFinder</h3>
                  <p>Free Gorilla Tag player search · by Useless</p>
                </div>
              </header>
              <p>
                GFinder is a free search tool that dynamically caches and stores Gorilla Tag player
                info — name, ID, last known room code, cosmetics, region, and tools to copy the JSON
                for that player.
              </p>
              <p>
                Created and managed by Useless, it is the first tool of its kind. Other copies
                exist, but ours is the original, with a constantly updating player database.
              </p>
              <ul className="community-info-list">
                <li>Name and player ID lookup</li>
                <li>Last known room code and region</li>
                <li>Cosmetics and player details</li>
                <li>Copy player JSON for your own tools</li>
                <li>Live, continuously updated database</li>
              </ul>
              <a
                className="primary community-info-cta"
                href={GFINDER_URL}
                target="_blank"
                rel="noreferrer"
                onClick={externalClick(GFINDER_URL)}
              >
                Open gfinder.pro <ExternalLink size={14} />
              </a>
            </article>
          </div>
        ) : (
          <>
            <div
              className="discord-messages"
              aria-live="polite"
              ref={messageList}
              onScroll={onMessagesScroll}
            >
              <AnimatePresence initial={false}>
                {visibleChat.map((item, index) => {
                  const previous = visibleChat[index - 1];
                  const author = displayAuthor(item);
                  const previousAuthor = previous ? displayAuthor(previous) : null;
                  const compact =
                    !!previous &&
                    !!previousAuthor &&
                    previousAuthor.id === author.id &&
                    previous.category === item.category &&
                    !item.anonymous &&
                    !previous.anonymous &&
                    new Date(item.created_at).getTime() - new Date(previous.created_at).getTime() <
                      7 * 60 * 1000;
                  return (
                    <MessageRow
                      key={item.id}
                      item={item}
                      compact={compact}
                      onDelete={(id) => void remove(id)}
                    />
                  );
                })}
              </AnimatePresence>
              {!visibleChat.length && (
                <div className="discord-empty">
                  {isEngineAnnounce ? <Megaphone size={28} /> : <Hash size={28} />}
                  <strong>Welcome to #{meta.title}</strong>
                  <p>
                    {isEngineAnnounce
                      ? staffPoster
                        ? 'Post official Engine news here. These stay in-app. They are not synced from Discord.'
                        : 'Official ii Engine posts from developers and admins will appear here.'
                      : channel === 'pro' && !isPro && !demo
                        ? 'Engine Pro unlocks this lounge.'
                        : isPro
                          ? 'Tip: type /ai followed by a question to ask iiGPT (Pro · shared daily AI budget).'
                          : 'This is the start of the channel. Send a message to get things going.'}
                  </p>
                </div>
              )}
              <div ref={end} />
              {!atBottom && !!visibleChat.length && (
                <button
                  type="button"
                  className="discord-jump-latest"
                  onClick={() => jumpToLatest()}
                >
                  <ArrowDown size={14} /> Jump to latest
                </button>
              )}
            </div>

            <form className="discord-composer" onSubmit={(event) => void send(event)}>
              {(channel === 'general' || channel === 'pro') && anonymousChat && (
                <p className="discord-anon-hint">Anonymous. Your name and role stay hidden.</p>
              )}
              {isEngineAnnounce && !staffPoster ? (
                <div className="discord-composer-locked">
                  <Lock size={16} /> Developers and admins post here · members read only
                </div>
              ) : channel === 'pro' && !isPro && !demo ? (
                <div className="discord-composer-locked">
                  <Lock size={16} /> Engine Pro required to chat here
                </div>
              ) : (
                <div className="discord-composer-box">
                  {!!mentionSuggestions.length && (
                    <ul className="chat-mention-menu" role="listbox" aria-label="Mention someone">
                      {mentionSuggestions.map((person, index) => (
                        <li key={person.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === mentionIndex}
                            className={index === mentionIndex ? 'active' : ''}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              applyMention(person);
                            }}
                          >
                            <Avatar person={person} />
                            <span>{person.display_name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <textarea
                    ref={composerRef}
                    value={body}
                    maxLength={800}
                    rows={1}
                    placeholder={
                      isEngineAnnounce
                        ? `Announce in #${meta.title}`
                        : isPro
                          ? `Message #${meta.title} · @mention · /ai ask iiGPT`
                          : `Message #${meta.title} · type @ to mention`
                    }
                    onChange={(event) => {
                      setBody(event.target.value);
                      setCaret(event.target.selectionStart ?? event.target.value.length);
                    }}
                    onClick={(event) =>
                      setCaret(
                        event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                      )
                    }
                    onKeyUp={(event) =>
                      setCaret(
                        event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                      )
                    }
                    onKeyDown={onComposerKey}
                  />
                  <button
                    className="discord-send"
                    disabled={busy || !body.trim() || (demo && !isEngineAnnounce)}
                    aria-label="Send message"
                  >
                    <Send size={16} />
                  </button>
                </div>
              )}
              <small>
                {isEngineAnnounce
                  ? 'Enter to send · Shift+Enter for a new line · staff-only channel'
                  : `Enter to send · Shift+Enter for a new line · @ to mention${
                      isPro ? ' · /ai for iiGPT (Pro · shared daily AI budget)' : ''
                    }`}
              </small>
            </form>
          </>
        )}

        {isAnnounce && (
          <div className="discord-composer discord-composer-readonly">
            <Lock size={14} /> Read-only channel · posts come from the ii Discord
          </div>
        )}
      </div>
    </section>
  );
}
