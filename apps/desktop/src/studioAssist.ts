import { ApiError } from './api';

const tips: { match: RegExp; reply: string }[] = [
  {
    match: /plugin|baseplugin|entrypoint|main\.cs/i,
    reply:
      'Start from a BepInEx BasePlugin. Override Load(), register Harmony patches there, and keep Init/Awake light so the game stays responsive.',
  },
  {
    match: /harmony|patch|prefix|postfix|transpile/i,
    reply:
      'Prefer Prefix/Postfix over Transpiler unless you must rewrite IL. Patch concrete methods, log failures, and unpatch cleanly if you reload.',
  },
  {
    match: /build|msbuild|dotnet|csproj|compile/i,
    reply:
      'Use Build in the toolbar first. Fix errors in the console before Build & Play. Target the same .NET profile as other Gorilla Tag plugins in your csproj.',
  },
  {
    match: /install|plugins|bepinex|dll/i,
    reply:
      'Install DLL copies your build into BepInEx/plugins. Confirm Gorilla Tag is selected in the console picker, then launch with Build & Play.',
  },
  {
    match: /null|nre|nullreference|missingreference/i,
    reply:
      'Cache GameObject finds after scenes load. Gorilla Tag scenes swap often. Guard with null checks and subscribe to sceneLoaded when you need room objects.',
  },
  {
    match: /gui|menu|ui|imgui|ongui/i,
    reply:
      'For in-game menus, keep OnGUI/simple UI minimal each frame. Prefer event-driven toggles and avoid heavy work inside the draw loop.',
  },
  {
    match: /network|photon|rpc|multiplayer/i,
    reply:
      'Anything networked must respect existing Photon ownership rules. Prefer local-only effects unless you own the player and understand room events.',
  },
  {
    match: /log|debug|console|logger/i,
    reply:
      'Use your plugin Logger (or Debug.Log) with clear tags. Watch LIVE CONSOLE for BepInEx and ii lines after Build & Play.',
  },
  {
    match: /template|project|create|zip|github/i,
    reply:
      'Free Studio can start from ii Template v2 (GitHub) or ii Reborn Menu. Pro unlocks more GitHub clones and ZIP imports. Each project stays in its own folder.',
  },
  {
    match: /error|exception|crash|fail/i,
    reply:
      'Read the BUILD console diagnostics first. Click a problem to jump to the file. A failed build never launches Gorilla Tag from Studio.',
  },
];

const fallback = `Studio assist (local): ask about plugins, Harmony patches, builds, installs, null refs, menus, networking, or logging. When signed in, Engine AI answers from the AI tab.`;

export function localStudioSelectionAction(
  action: 'explain' | 'summarize' | 'fix' | 'change',
  selection: string,
  instruction = '',
): string {
  const snippet = selection.trim().slice(0, 1200);
  if (action === 'explain') {
    return (
      `Local explain (Engine AI offline):\n` +
      `This selection looks like C# / BepInEx plugin code. Check nulls after scene loads, ` +
      `keep Load()/Awake light, and log failures with your plugin Logger.\n\n---\n${snippet}`
    );
  }
  if (action === 'summarize') {
    const lines = snippet
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(0, 8);
    return ['Local summary (Engine AI offline):', ...lines.map((line) => `- ${line.trim()}`)].join(
      '\n',
    );
  }
  if (action === 'change' && instruction.trim()) {
    return (
      `${snippet}\n\n// TODO (local): ${instruction.trim()}\n` +
      `// Engine AI was unavailable. Re-run Change when signed in with AI configured.`
    );
  }
  return snippet;
}

export function localStudioAssist(question: string, contextPath?: string): string {
  const blob = `${question}\n${contextPath ?? ''}`;
  for (const tip of tips) {
    if (tip.match.test(blob)) return tip.reply;
  }
  return fallback;
}

export type StudioAssistResult = {
  text: string;
  source: 'local' | 'api';
  error?: string;
};

export function parseAiChatSse(raw: string): { text: string; error?: string } {
  let text = '';
  const parts = raw.split('\n\n');
  const chunks = parts.filter((chunk) => chunk.trim().length > 0);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as { text?: string; message?: string };
      if (event === 'token' && parsed.text) text += parsed.text;
      if (event === 'error') return { text: '', error: parsed.message || 'AI error' };
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return { text };
}

export async function askStudioAssist(
  question: string,
  options: {
    demo: boolean;
    contextPath?: string;
    shareTelemetry?: boolean;
    request?: (path: string, init?: RequestInit) => Promise<Response>;
  },
): Promise<StudioAssistResult> {
  const local = localStudioAssist(question, options.contextPath);
  if (options.demo || !options.request) {
    return { text: local, source: 'local' };
  }
  try {
    const response = await options.request('/v1/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `ii Studio coding help. File: ${options.contextPath || 'none'}. Question: ${question}`,
        share_telemetry: options.shareTelemetry === true,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const parsed = parseAiChatSse(await response.text());
    if (parsed.error) {
      return { text: local, source: 'local', error: parsed.error };
    }
    if (parsed.text.trim()) return { text: parsed.text.trim(), source: 'api' };
    return {
      text: local,
      source: 'local',
      error: 'Engine AI returned an empty answer. Showing local tips.',
    };
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Engine AI is unavailable';
    return { text: local, source: 'local', error: message };
  }
}
