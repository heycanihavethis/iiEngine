import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/xml/register';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderGit2,
  FolderOpen,
  Hammer,
  LayoutList,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  PackageCheck,
  Download,
  PanelBottomClose,
  PanelBottomOpen,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  TerminalSquare,
  Type,
  WrapText,
  X,
} from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { EngineIcon } from './EngineIcon';
import { apiRequest, initializeSession } from './api';
import PageHero from './PageHero';
import { usePreferences } from './store';
import {
  reportEngineError,
  trackFeature,
  appendSessionBepInEx,
  recordAiTranscript,
} from './telemetry';
import {
  isProOnlyStudioSource,
  studioProjectSourceOptions,
  type StudioProjectSource as ProjectSource,
} from './studioSources';
import {
  askStudioAssist,
  localStudioSelectionAction,
  type StudioAssistResult,
} from './studioAssist';
import { catalogProjectName, takeCatalogSourceIntent } from './catalogStudioBridge';

type BottomTab = 'build' | 'logs' | 'project' | 'ai';

loader.config({ monaco });
(globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

type Environment = {
  ready: boolean;
  dotnet: string | null;
  git: string | null;
  projects_root: string;
};
type Project = { id: string; name: string; created_at: string; source_repository: string };
type SourceFile = { path: string; name: string; depth: number; kind: 'file' | 'folder' };
type OpenFile = { path: string; content: string; saved: string };
type Candidate = { path: string; valid: boolean; missing: string[] };
type Diagnostic = {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
};
type BuildResult = {
  success: boolean;
  output: string;
  diagnostics: Diagnostic[];
  dll_name: string | null;
  dll_sha256: string | null;
  dll_bytes: number | null;
};
type LogChunk = { offset: number; text: string; reset: boolean };
type LogFilter = 'All' | 'Errors' | 'Warnings' | 'BepInEx' | 'ii';
type TreeNode = {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children: TreeNode[];
};

function buildTree(files: SourceFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let level = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const type = index === parts.length - 1 ? file.kind : 'folder';
      let node = level.find((item) => item.name === part && item.type === type);
      if (!node) {
        node = { name: part, path: currentPath, type, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(root);
  return root;
}

function language(path: string) {
  if (path.endsWith('.cs')) return 'csharp';
  if (path.endsWith('.json')) return 'plaintext';
  if (path.endsWith('.xml') || path.endsWith('.csproj') || path.endsWith('.props')) return 'xml';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function Studio({
  demo,
  canLaunch,
  studioPro = false,
}: {
  demo: boolean;
  canLaunch: boolean;
  studioPro?: boolean;
}) {
  const separateWindow = new URLSearchParams(window.location.search).get('studio') === '1';
  const proMode = studioPro || separateWindow;
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectSource, setProjectSource] = useState<ProjectSource>('ii_stupid_menu');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [zipFileName, setZipFileName] = useState('');
  const [zipBytes, setZipBytes] = useState<number[] | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const [showProjectCreator, setShowProjectCreator] = useState(false);
  const [newEntryKind, setNewEntryKind] = useState<'file' | 'folder' | null>(null);
  const [newEntryPath, setNewEntryPath] = useState('');
  const [explorerMenuOpen, setExplorerMenuOpen] = useState(false);
  const [explorerMenuBox, setExplorerMenuBox] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const explorerMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const explorerMenuRef = useRef<HTMLDivElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [gamePath, setGamePath] = useState('');
  const [bottomTab, setBottomTab] = useState<BottomTab>('build');
  const [logText, setLogText] = useState('');
  const [logFilter, setLogFilter] = useState<LogFilter>('All');
  const [logEnabled, setLogEnabled] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(220);
  const [wordWrap, setWordWrap] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const logOffset = useRef(0);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoApi = useRef<Monaco | null>(null);
  const revealLine = useRef<number | null>(null);
  const aiCompletionDisposable = useRef<{ dispose: () => void } | null>(null);
  const aiLastRequest = useRef(0);
  const [monacoReady, setMonacoReady] = useState(0);
  const [selectionMenu, setSelectionMenu] = useState<{
    top: number;
    left: number;
    text: string;
    range: monaco.IRange;
  } | null>(null);
  const selectionSnapshot = useRef<{
    top: number;
    left: number;
    text: string;
    range: monaco.IRange;
  } | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionResult, setSelectionResult] = useState('');
  const [assistQuestion, setAssistQuestion] = useState('');
  const [assistThread, setAssistThread] = useState<
    { id: string; label: string; text: string; source: StudioAssistResult['source'] }[]
  >([]);
  const [assistSource, setAssistSource] = useState<StudioAssistResult['source']>('local');
  const [assistBusy, setAssistBusy] = useState(false);
  const studioAiAutocomplete = usePreferences((state) => state.studioAiAutocomplete);
  const shareAiTelemetry = usePreferences((state) => state.telemetry === true);
  const catalogSourceOpen = useRef<{ path: string; line: number } | null>(null);
  const catalogSourceHandled = useRef(false);

  useEffect(() => {
    if (demo || !isTauri()) return;
    void initializeSession().catch(() => undefined);
  }, [demo]);

  useEffect(() => {
    if (!explorerMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        explorerMenuBtnRef.current?.contains(target) ||
        explorerMenuRef.current?.contains(target)
      ) {
        return;
      }
      setExplorerMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExplorerMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [explorerMenuOpen]);

  const loadProjects = useCallback(async () => {
    const result = await invoke<Project[]>('studio_list_projects');
    setProjects(result);
    setCurrentProject((current) => current ?? result[0] ?? null);
  }, []);

  const discoverGame = useCallback(async () => {
    try {
      const found = await invoke<Candidate[]>('discover_game');
      setCandidates(found);
      const best = found.find((candidate) => candidate.valid)?.path || '';
      setGamePath(best);
    } catch (reason) {
      setError(message(reason));
    }
  }, []);

  useEffect(() => {
    trackFeature('studio', 'open');
    if (demo || !isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextEnvironment, nextProjects, nextCandidates] = await Promise.all([
          invoke<Environment>('studio_environment'),
          invoke<Project[]>('studio_list_projects'),
          invoke<Candidate[]>('discover_game'),
        ]);
        if (cancelled) return;
        setEnvironment(nextEnvironment);
        setProjects(nextProjects);
        setCandidates(nextCandidates);
        setGamePath(nextCandidates.find((candidate) => candidate.valid)?.path ?? '');

        const intent = catalogSourceHandled.current ? null : takeCatalogSourceIntent();
        catalogSourceHandled.current = true;
        if (!intent) {
          setCurrentProject(nextProjects[0] ?? null);
          return;
        }

        setCreating(true);
        setError('');
        setStatus(`Opening ii Reborn Menu source for ${intent.modName}…`);
        try {
          const project = await invoke<Project>('studio_create_project', {
            name: catalogProjectName(intent.modName),
            source: 'ii_stupid_menu',
          });
          if (cancelled) return;
          const refreshed = await invoke<Project[]>('studio_list_projects');
          if (cancelled) return;
          setProjects(refreshed);
          setCurrentProject(project);
          const hit = await invoke<{ path: string; line: number; snippet: string } | null>(
            'studio_find_mod_source',
            { projectId: project.id, modName: intent.modName },
          );
          if (cancelled) return;
          if (hit) {
            catalogSourceOpen.current = { path: hit.path, line: hit.line };
            setStatus(`Located ${intent.modName} at ${hit.path}:${hit.line}`);
            trackFeature('studio', 'catalog_source_open');
          } else {
            setStatus(
              `Created a new ii Reborn Menu project for ${intent.modName}, but no exact source match was found.`,
            );
          }
        } catch (reason) {
          if (!cancelled) {
            setCurrentProject(nextProjects[0] ?? null);
            setError(message(reason));
            setStatus('');
          }
        } finally {
          if (!cancelled) setCreating(false);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(message(reason));
          setStatus('');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demo, proMode]);

  useEffect(() => {
    if (!proMode && isProOnlyStudioSource(projectSource)) {
      setProjectSource('ii_stupid_menu');
      setZipBytes(null);
      setZipFileName('');
    }
  }, [proMode, projectSource]);

  async function installDependencies() {
    if (demo || !isTauri()) return;
    setBusy(true);
    setError('');
    try {
      const result = await invoke<{ message: string }>('studio_install_dependencies');
      trackFeature('studio', 'install_dependencies');
      setStatus(result.message);
      const next = await invoke<Environment>('studio_environment');
      setEnvironment(next);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!currentProject) {
      setFiles([]);
      return;
    }
    setTabs([]);
    setActivePath('');
    setBuild(null);
    void invoke<SourceFile[]>('studio_list_files', { projectId: currentProject.id })
      .then(setFiles)
      .catch((reason) => setError(message(reason)));
  }, [currentProject]);

  useEffect(() => {
    if (!logEnabled || !gamePath) return;
    let stopped = false;
    const poll = async () => {
      try {
        const chunk = await invoke<LogChunk>('studio_read_log', {
          gamePath,
          offset: logOffset.current,
        });
        if (stopped) return;
        logOffset.current = chunk.offset;
        if (chunk.reset) {
          setLogText(chunk.text);
          appendSessionBepInEx(chunk.text, gamePath);
        } else if (chunk.text) {
          setLogText((current) => (current + chunk.text).slice(-750_000));
          appendSessionBepInEx(chunk.text, gamePath);
        }
      } catch (reason) {
        if (!stopped) setError(message(reason));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [gamePath, logEnabled]);

  const active = tabs.find((tab) => tab.path === activePath) ?? null;
  const dirtyCount = tabs.filter((tab) => tab.content !== tab.saved).length;
  const fileTree = useMemo(() => buildTree(files), [files]);

  useEffect(() => {
    setExpandedFolders((current) => {
      if (current.size || !files.length) return current;
      return new Set(files.map((file) => file.path.split('/')[0]).filter(Boolean));
    });
  }, [files]);

  const openFile = useCallback(
    async (path: string, line?: number) => {
      if (!currentProject) return;
      const existing = tabs.find((tab) => tab.path === path);
      if (!existing) {
        try {
          const content = await invoke<string>('studio_read_file', {
            projectId: currentProject.id,
            path,
          });
          setTabs((current) => [...current, { path, content, saved: content }]);
        } catch (reason) {
          setError(message(reason));
          return;
        }
      }
      if (line) revealLine.current = line;
      setActivePath(path);
    },
    [currentProject, tabs],
  );

  useEffect(() => {
    const pending = catalogSourceOpen.current;
    if (!pending || !currentProject || !files.length) return;
    catalogSourceOpen.current = null;
    const folder = pending.path.includes('/')
      ? pending.path.slice(0, pending.path.lastIndexOf('/'))
      : '';
    if (folder) {
      setExpandedFolders((current) => {
        const next = new Set(current);
        folder.split('/').forEach((_, index, parts) => {
          next.add(parts.slice(0, index + 1).join('/'));
        });
        return next;
      });
    }
    void openFile(pending.path, pending.line);
  }, [currentProject, files, openFile]);

  useEffect(() => {
    if (!active || !editor.current || !monacoApi.current) return;
    const markers = (build?.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.file.toLowerCase() === active.path.toLowerCase())
      .map((diagnostic) => ({
        startLineNumber: diagnostic.line,
        endLineNumber: diagnostic.line,
        startColumn: diagnostic.column,
        endColumn: diagnostic.column + 1,
        message: `${diagnostic.code}: ${diagnostic.message}`,
        severity:
          diagnostic.severity === 'error'
            ? monacoApi.current!.MarkerSeverity.Error
            : monacoApi.current!.MarkerSeverity.Warning,
      }));
    const model = editor.current.getModel();
    if (model) monacoApi.current.editor.setModelMarkers(model, 'ii-studio-build', markers);
    if (revealLine.current) {
      editor.current.revealLineInCenter(revealLine.current);
      editor.current.setPosition({ lineNumber: revealLine.current, column: 1 });
      editor.current.focus();
      revealLine.current = null;
    }
  }, [active, build]);

  const saveAll = useCallback(async () => {
    if (!currentProject) return;
    const dirty = tabs.filter((tab) => tab.content !== tab.saved);
    await Promise.all(
      dirty.map((tab) =>
        invoke('studio_save_file', {
          projectId: currentProject.id,
          path: tab.path,
          content: tab.content,
        }),
      ),
    );
    setTabs((current) => current.map((tab) => ({ ...tab, saved: tab.content })));
    if (dirty.length) setStatus(`Saved ${dirty.length} file${dirty.length === 1 ? '' : 's'}.`);
  }, [currentProject, tabs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveAll().catch((reason) => setError(message(reason)));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveAll]);

  const runBuild = useCallback(async () => {
    if (!currentProject) return null;
    setBusy(true);
    setError('');
    setStatus('Saving and compiling the project…');
    setBottomTab('build');
    setConsoleCollapsed(false);
    try {
      await saveAll();
      const result = await invoke<BuildResult>('studio_build_project', {
        projectId: currentProject.id,
      });
      setBuild(result);
      setStatus(
        result.success && result.dll_name
          ? `Build complete · ${result.dll_name}`
          : `Build failed · ${result.diagnostics.filter((item) => item.severity === 'error').length} errors`,
      );
      return result;
    } catch (reason) {
      setError(message(reason));
      setStatus('');
      return null;
    } finally {
      setBusy(false);
    }
  }, [currentProject, saveAll]);

  async function install(result = build) {
    if (!currentProject || !result?.success || !result.dll_name || !gamePath) return false;
    setBusy(true);
    setError('');
    setStatus('Backing up the current menu and installing the Studio build…');
    try {
      const installed = await invoke<{ operation_id: string; plugin_version: string }>(
        'studio_install_build',
        {
          projectId: currentProject.id,
          dllName: result.dll_name,
          gamePath,
        },
      );
      setStatus(
        `Installed ${installed.plugin_version} · backup ${installed.operation_id.slice(0, 8)}`,
      );
      return true;
    } catch (reason) {
      setError(message(reason));
      setStatus('');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function buildAndPlay() {
    if (!canLaunch) {
      setError('Your Discord roles do not currently include game launching access.');
      return;
    }
    const result = await runBuild();
    if (!result?.success || !result.dll_name) return;
    if (!(await install(result))) return;
    try {
      await invoke('launch_game', { gamePath });
      logOffset.current = 0;
      setLogText('Waiting for BepInEx LogOutput.log…\n');
      setLogEnabled(true);
      setBottomTab('logs');
      setConsoleCollapsed(false);
      setStatus('Gorilla Tag launch requested. Waiting for BepInEx logs…');
    } catch (reason) {
      const msg = message(reason);
      setError(msg);
      void reportEngineError({ feature: 'studio', message: msg });
    }
  }

  async function createProject() {
    if (!projectName.trim()) return;
    if (!proMode && isProOnlyStudioSource(projectSource)) {
      setError('Importing from GitHub or ZIP requires Engine Pro.');
      return;
    }
    setCreating(true);
    setError('');
    const sourceLabels: Record<ProjectSource, string> = {
      ii_template: 'Downloading ii Template v2.0.0…',
      ii_stupid_menu: 'Copying ii Reborn Menu into a new local project…',
      open_source: 'Importing the open-source project…',
      zip_import: 'Unpacking the ZIP into a new local project…',
      blank: 'Creating the blank BepInEx project…',
    };
    setStatus(sourceLabels[projectSource]);
    try {
      const project = await invoke<Project>('studio_create_project', {
        name: projectName,
        source: projectSource,
        repositoryUrl: projectSource === 'open_source' ? repositoryUrl : undefined,
        zipBytes: projectSource === 'zip_import' ? zipBytes : undefined,
      });
      await loadProjects();
      setCurrentProject(project);
      setProjectName('');
      setZipBytes(null);
      setZipFileName('');
      setShowProjectCreator(false);
      setStatus(`${project.name} is ready.`);
    } catch (reason) {
      setError(message(reason));
      setStatus('');
    } finally {
      setCreating(false);
    }
  }

  async function createEntry() {
    if (!currentProject || !newEntryKind || !newEntryPath.trim()) return;
    setBusy(true);
    setError('');
    try {
      const path = newEntryPath.trim().replace(/\\/g, '/');
      await invoke(newEntryKind === 'file' ? 'studio_create_file' : 'studio_create_folder', {
        projectId: currentProject.id,
        path,
      });
      const next = await invoke<SourceFile[]>('studio_list_files', {
        projectId: currentProject.id,
      });
      setFiles(next);
      if (newEntryKind === 'file') await openFile(path);
      setExpandedFolders((current) => {
        const nextExpanded = new Set(current);
        path
          .split('/')
          .slice(0, -1)
          .forEach((_, index, parts) => nextExpanded.add(parts.slice(0, index + 1).join('/')));
        return nextExpanded;
      });
      setNewEntryPath('');
      setNewEntryKind(null);
      setStatus(`${newEntryKind === 'file' ? 'File' : 'Folder'} created.`);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  const visibleLogs = useMemo(() => {
    if (logFilter === 'All') return logText;
    const pattern =
      logFilter === 'Errors'
        ? /error|exception|fatal/i
        : logFilter === 'Warnings'
          ? /warn/i
          : logFilter === 'BepInEx'
            ? /bepinex/i
            : /\bii\b|iireborn|reborn menu|stupid menu/i;
    return logText
      .split('\n')
      .filter((line) => pattern.test(line))
      .join('\n');
  }, [logFilter, logText]);

  const mountEditor: OnMount = (instance, api) => {
    editor.current = instance;
    monacoApi.current = api;
    setMonacoReady((value) => value + 1);
    instance.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    instance.onDidChangeCursorSelection((event) => {
      const model = instance.getModel();
      if (!model) {
        setSelectionMenu(null);
        return;
      }
      const text = model.getValueInRange(event.selection);
      if (!text.trim() || text.length < 4) {
        setSelectionMenu(null);
        setSelectionResult('');
        return;
      }
      const coords = instance.getScrolledVisiblePosition({
        lineNumber: event.selection.startLineNumber,
        column: event.selection.startColumn,
      });
      if (!coords) {
        setSelectionMenu(null);
        return;
      }
      const next = {
        top: Math.max(8, coords.top - 36),
        left: Math.max(8, coords.left),
        text,
        range: {
          startLineNumber: event.selection.startLineNumber,
          startColumn: event.selection.startColumn,
          endLineNumber: event.selection.endLineNumber,
          endColumn: event.selection.endColumn,
        },
      };
      selectionSnapshot.current = next;
      setSelectionMenu(next);
      setSelectionResult('');
    });
    api.languages.registerCompletionItemProvider('csharp', {
      provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: [
            ['public class', 'public class ${1:Name}\n{\n    $0\n}'],
            ['public static void', 'public static void ${1:MethodName}(${2})\n{\n    $0\n}'],
            ['if', 'if (${1:condition})\n{\n    $0\n}'],
            ['foreach', 'foreach (var ${1:item} in ${2:items})\n{\n    $0\n}'],
            ['try/catch', 'try\n{\n    $1\n}\ncatch (Exception ex)\n{\n    $0\n}'],
            ['BepInEx log', 'Logger.LogInfo("${1:message}");'],
          ].map(([label, insertText]) => ({
            label,
            kind: api.languages.CompletionItemKind.Snippet,
            insertText,
            insertTextRules: api.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      },
    });
  };

  useEffect(() => {
    aiCompletionDisposable.current?.dispose();
    aiCompletionDisposable.current = null;
    if (!studioAiAutocomplete || !monacoApi.current || demo) return;
    const api = monacoApi.current;
    const provider: monaco.languages.InlineCompletionsProvider = {
      provideInlineCompletions: async (model, position, _context, token) => {
        const now = Date.now();
        if (now - aiLastRequest.current < 4000) return { items: [] };
        const prefix = model.getValueInRange({
          startLineNumber: Math.max(1, position.lineNumber - 24),
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        if (prefix.trim().length < 16) return { items: [] };
        aiLastRequest.current = now;
        try {
          await initializeSession();
          const response = await apiRequest('/v1/ai/autocomplete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prefix: prefix.slice(-1200),
              language: 'csharp',
              share_telemetry: shareAiTelemetry,
            }),
            signal: AbortSignal.timeout(12_000),
          });
          if (token.isCancellationRequested) return { items: [] };
          const payload = (await response.json()) as { completion?: string };
          const completion = payload.completion?.trim();
          if (!completion) return { items: [] };
          return {
            items: [
              {
                insertText: completion,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              },
            ],
          };
        } catch {
          return { items: [] };
        }
      },
      disposeInlineCompletions: () => undefined,
    };
    aiCompletionDisposable.current = api.languages.registerInlineCompletionsProvider(
      'csharp',
      provider,
    );
    return () => {
      aiCompletionDisposable.current?.dispose();
      aiCompletionDisposable.current = null;
    };
  }, [studioAiAutocomplete, demo, activePath, monacoReady, shareAiTelemetry]);

  const askAssist = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const question = assistQuestion.trim();
      if (!question || assistBusy) return;
      setAssistBusy(true);
      setError('');
      try {
        const result = await askStudioAssist(question, {
          demo,
          contextPath: active?.path,
          request: apiRequest,
          shareTelemetry: shareAiTelemetry,
        });
        setAssistSource(result.source);
        setAssistThread((current) =>
          [
            ...current,
            {
              id: `studio-${Date.now()}`,
              label: question,
              text: result.text,
              source: result.source,
            },
          ].slice(-30),
        );
        setAssistQuestion('');
        if (result.error) setError(result.error);
        else if (result.source === 'api') {
          recordAiTranscript('studio_assist', question, result.text);
          trackFeature('studio', 'ai_assist');
        }
      } catch (reason) {
        const msg = message(reason);
        setError(msg);
        void reportEngineError({ feature: 'studio', message: msg });
      } finally {
        setAssistBusy(false);
      }
    },
    [active?.path, assistBusy, assistQuestion, demo, shareAiTelemetry],
  );

  async function runSelectionAction(action: 'explain' | 'summarize' | 'fix' | 'change') {
    const snapshot = selectionMenu ?? selectionSnapshot.current;
    if (!snapshot || !editor.current) return;
    let instruction = '';
    if (action === 'change') {
      instruction = window.prompt('Describe the change you want:')?.trim() || '';
      if (!instruction) return;
    }
    setSelectionBusy(true);
    setSelectionResult('');
    setError('');

    const applyLocal = (text: string, note?: string) => {
      if (action === 'fix' || action === 'change') {
        editor.current?.executeEdits('ii-studio-ai-local', [
          { range: snapshot.range, text, forceMoveMarkers: true },
        ]);
        setSelectionMenu(null);
        setStatus(note || `Applied local ${action}.`);
      } else {
        setSelectionResult(text);
        setAssistSource('local');
        setBottomTab('ai');
        setConsoleCollapsed(false);
      }
      setAssistThread((current) =>
        [
          ...current,
          {
            id: `studio-sel-${Date.now()}`,
            label: `Selection · ${action}`,
            text,
            source: 'local' as const,
          },
        ].slice(-30),
      );
    };

    try {
      if (demo) {
        applyLocal(
          localStudioSelectionAction(action, snapshot.text, instruction),
          'Demo AI result.',
        );
        return;
      }
      try {
        await initializeSession();
      } catch {}
      try {
        const response = await apiRequest('/v1/ai/studio-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            selection: snapshot.text.slice(0, 5000),
            language: language(active?.path || 'file.cs'),
            instruction,
            share_telemetry: shareAiTelemetry,
          }),
          signal: AbortSignal.timeout(35_000),
        });
        const payload = (await response.json()) as { result?: string };
        const result = payload.result?.trim() || '';
        if (!result) throw new Error('Empty AI response.');
        if (action === 'fix' || action === 'change') {
          editor.current.executeEdits('ii-studio-ai', [
            { range: snapshot.range, text: result, forceMoveMarkers: true },
          ]);
          setSelectionMenu(null);
          setStatus(`Applied AI ${action}.`);
          recordAiTranscript(`studio_${action}`, snapshot.text, result);
          trackFeature('studio', `ai_${action}`);
        } else {
          setSelectionResult(result);
          setAssistThread((current) =>
            [
              ...current,
              {
                id: `studio-sel-${Date.now()}`,
                label: `Selection · ${action}`,
                text: result,
                source: 'api' as const,
              },
            ].slice(-30),
          );
          setAssistSource('api');
          setBottomTab('ai');
          setConsoleCollapsed(false);
          recordAiTranscript(`studio_${action}`, snapshot.text, result);
          trackFeature('studio', `ai_${action}`);
        }
      } catch (reason) {
        const msg = message(reason);
        setError(msg);
        applyLocal(
          localStudioSelectionAction(action, snapshot.text, instruction),
          `Engine AI unavailable. Used local ${action}.`,
        );
        void reportEngineError({ feature: 'studio', message: msg });
      }
    } finally {
      setSelectionBusy(false);
    }
  }
  function beginConsoleResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (consoleCollapsed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = consoleHeight;
    const move = (moveEvent: PointerEvent) => {
      setConsoleHeight(Math.max(120, Math.min(460, startHeight + startY - moveEvent.clientY)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  function renderTree(nodes: TreeNode[], depth = 0): ReactNode {
    return nodes.map((node) => {
      if (node.type === 'folder') {
        const expanded = expandedFolders.has(node.path);
        return (
          <div className="studio-tree-group" key={node.path}>
            <button
              className="studio-tree-row folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={expanded}
              title={node.path}
              onClick={() =>
                setExpandedFolders((current) => {
                  const next = new Set(current);
                  if (expanded) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              }
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
              <span>{node.name}</span>
            </button>
            {expanded && renderTree(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={node.path}
          className={`studio-tree-row file ${node.path === activePath ? 'active' : ''}`}
          style={{ paddingLeft: 22 + depth * 14 }}
          title={node.path}
          onClick={() => void openFile(node.path)}
        >
          <FileCode2 size={14} /> <span>{node.name}</span>
        </button>
      );
    });
  }

  const studioBannerHero = (
    <PageHero
      compact
      className="studio-hero wide"
      label={proMode ? 'ii Studio Pro' : 'ii Studio'}
      title={proMode ? 'Studio Pro' : 'Studio'}
      subtitle="Create, edit, and build mods."
    />
  );

  if (demo || !isTauri()) {
    return (
      <div className="studio-page-wrap">
        {studioBannerHero}
        <section className="panel studio-desktop-message">
          <FolderGit2 size={40} />
          <h2>ii Studio runs in the Windows desktop app</h2>
          <p>
            Open the installed ii Engine app to create, build, install, and test local projects.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className={`studio-page-wrap ${proMode ? 'studio-pro-page' : ''}`}>
      {!separateWindow && studioBannerHero}
      <section
        className={`studio-shell ${proMode ? 'studio-pro' : ''}`}
        aria-label={proMode ? 'ii Studio Pro' : 'ii Studio'}
      >
        <header className="studio-toolbar studio-toolbar-slim">
          <div className="studio-toolbar-start">
            <div className="studio-project-picker">
              <FolderGit2 size={18} />
              <CustomSelect
                label="Studio project"
                value={currentProject?.id ?? ''}
                disabled={busy || dirtyCount > 0}
                onChange={(value) => {
                  if (value === '__new__') {
                    setShowProjectCreator(true);
                    return;
                  }
                  setShowProjectCreator(false);
                  setCurrentProject(projects.find((project) => project.id === value) ?? null);
                }}
                options={[
                  { value: '', label: 'Select a project' },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                  { value: '__new__', label: '+ Create new project' },
                ]}
              />
            </div>
            {currentProject && (
              <code className="studio-project-path" title={currentProject.name}>
                {environment?.projects_root}\\{currentProject.name}
              </code>
            )}
            {proMode && (
              <span className="studio-pro-badge" title="ii Studio Pro">
                <Sparkles size={13} /> Pro
              </span>
            )}
          </div>
          {!!projects.length && !showProjectCreator && (
            <div className="studio-toolbar-build">
              <button
                disabled={busy || !currentProject || !dirtyCount}
                title="Save every changed file (Ctrl+S)"
                onClick={() => void saveAll()}
              >
                <Save size={15} />
                <span className="btn-label">Save{dirtyCount ? ` (${dirtyCount})` : ''}</span>
              </button>
              <button
                disabled={busy || !currentProject}
                title="Save and compile the project"
                onClick={() => void runBuild()}
              >
                <Hammer size={15} />
                <span className="btn-label">Build</span>
              </button>
              <button
                disabled={busy || !build?.success || !gamePath}
                title={
                  build?.success
                    ? 'Install the built DLL into Gorilla Tag'
                    : 'Build the project first'
                }
                onClick={() => void install()}
              >
                <PackageCheck size={15} />
                <span className="btn-label">Install DLL</span>
              </button>
              <button
                className="primary studio-play"
                disabled={busy || !currentProject || !gamePath || !canLaunch}
                title={
                  canLaunch
                    ? 'Build, install, and launch Gorilla Tag'
                    : 'Game launching is not available for your Discord roles'
                }
                onClick={() => void buildAndPlay()}
              >
                <Play size={15} />
                <span className="btn-label">Build &amp; Play</span>
              </button>
            </div>
          )}
          <div className="studio-toolbar-meta">
            {active && (
              <span className="studio-toolbar-file" title={active.path}>
                {active.path.split('/').pop()}
              </span>
            )}
            <button
              type="button"
              className="studio-toolbar-panel-toggle"
              title={consoleCollapsed ? 'Show bottom panel' : 'Hide bottom panel'}
              onClick={() => setConsoleCollapsed((current) => !current)}
            >
              {consoleCollapsed ? <PanelBottomOpen size={16} /> : <PanelBottomClose size={16} />}
            </button>
          </div>
        </header>

        {!environment?.ready && environment && (
          <div className="studio-dependencies" role="alert">
            <div>
              <strong>Development tools required.</strong>
              {!environment.dotnet && <span> Install the .NET SDK.</span>}
              {!environment.git && <span> Install Git for Windows.</span>}
            </div>
            <button
              className="primary"
              disabled={busy || demo || !isTauri()}
              onClick={() => void installDependencies()}
            >
              <Download size={16} /> Install missing dependencies
            </button>
          </div>
        )}

        {(!projects.length || showProjectCreator) && (
          <div className="studio-create-empty">
            <FolderGit2 size={36} />
            <h2>{projects.length ? 'Create another project' : 'Create your first ii project'}</h2>
            <p>
              Every project gets its own local source folder. Studio never edits a shared template
              or repository directly.
            </p>
            <div className="studio-project-form">
              <input
                aria-label="Project name"
                placeholder="My ii menu"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createProject();
                }}
              />
              <CustomSelect
                label="Project source"
                value={projectSource}
                onChange={(value) => setProjectSource(value as ProjectSource)}
                options={studioProjectSourceOptions(proMode)}
              />
              {projectSource === 'ii_template' && (
                <p className="studio-pro-gate-note">
                  Uses the official{' '}
                  <a
                    href="https://github.com/iireborn/iiTemplate-Updated/releases/tag/v2.0.0"
                    target="_blank"
                    rel="noreferrer"
                  >
                    iiTemplate-Updated v2.0.0
                  </a>{' '}
                  starter from GitHub.
                </p>
              )}
              {projectSource === 'open_source' && (
                <input
                  aria-label="Open-source repository URL"
                  placeholder="https://github.com/owner/repository"
                  value={repositoryUrl}
                  onChange={(event) => setRepositoryUrl(event.target.value)}
                />
              )}
              {projectSource === 'zip_import' && (
                <div className="studio-zip-import">
                  <input
                    ref={zipInputRef}
                    type="file"
                    accept=".zip,application/zip"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void file.arrayBuffer().then((buffer) => {
                        setZipBytes([...new Uint8Array(buffer)]);
                        setZipFileName(file.name);
                      });
                    }}
                  />
                  <button type="button" onClick={() => zipInputRef.current?.click()}>
                    {zipFileName || 'Choose ZIP file…'}
                  </button>
                  <small>Pro · source ZIP under 50 MB</small>
                </div>
              )}
              {!proMode && (
                <p className="studio-pro-gate-note">
                  Free Studio can start from ii Template v2 or ii Reborn Menu. Upgrade to Pro to
                  import GitHub repos or ZIP files and unlock smooth caret.
                </p>
              )}
              <button
                className="primary"
                disabled={
                  creating ||
                  !environment?.ready ||
                  !projectName.trim() ||
                  (projectSource === 'open_source' && !repositoryUrl.trim()) ||
                  (projectSource === 'zip_import' && !zipBytes?.length)
                }
                onClick={() => void createProject()}
              >
                {creating ? 'Copying source…' : 'Create project'}
              </button>
            </div>
            {environment && <code>{environment.projects_root}</code>}
            {!!projects.length && (
              <button className="studio-create-cancel" onClick={() => setShowProjectCreator(false)}>
                Cancel
              </button>
            )}
          </div>
        )}

        {!!projects.length && !showProjectCreator && (
          <>
            <div className="studio-workbench">
              <aside className="studio-explorer">
                <div className="studio-pane-title">
                  <span>EXPLORER</span>
                  <div>
                    <button
                      ref={explorerMenuBtnRef}
                      type="button"
                      className="studio-explorer-menu-btn"
                      title="Explorer actions"
                      aria-label="Explorer actions"
                      aria-expanded={explorerMenuOpen}
                      disabled={busy || dirtyCount > 0}
                      onClick={() => {
                        const rect = explorerMenuBtnRef.current?.getBoundingClientRect();
                        if (rect) {
                          setExplorerMenuBox({
                            top: rect.bottom + 6,
                            left: Math.max(8, rect.right - 188),
                          });
                        }
                        setExplorerMenuOpen((open) => !open);
                      }}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                  </div>
                </div>
                {explorerMenuOpen &&
                  explorerMenuBox &&
                  createPortal(
                    <div
                      ref={explorerMenuRef}
                      className="studio-explorer-menu"
                      style={{ top: explorerMenuBox.top, left: explorerMenuBox.left }}
                      role="menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy || dirtyCount > 0}
                        onClick={() => {
                          setExplorerMenuOpen(false);
                          setNewEntryKind('file');
                        }}
                      >
                        <EngineIcon name="filePlus" size={14} /> New file
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy || dirtyCount > 0}
                        onClick={() => {
                          setExplorerMenuOpen(false);
                          setNewEntryKind('folder');
                        }}
                      >
                        <EngineIcon name="folderPlus" size={14} /> New folder
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy || dirtyCount > 0}
                        onClick={() => {
                          setExplorerMenuOpen(false);
                          setCurrentProject((value) => value && { ...value });
                        }}
                      >
                        <EngineIcon name="refresh" size={13} /> Refresh files
                      </button>
                    </div>,
                    document.body,
                  )}
                {newEntryKind && (
                  <div className="studio-new-entry">
                    <input
                      aria-label={`New ${newEntryKind} path`}
                      autoFocus
                      placeholder={newEntryKind === 'file' ? 'Mods/MyMod.cs' : 'Mods/MyFolder'}
                      value={newEntryPath}
                      onChange={(event) => setNewEntryPath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void createEntry();
                        if (event.key === 'Escape') setNewEntryKind(null);
                      }}
                    />
                    <button
                      disabled={busy || !newEntryPath.trim()}
                      onClick={() => void createEntry()}
                    >
                      Add
                    </button>
                  </div>
                )}
                <div className="studio-files">
                  <div className="studio-file-tree">{renderTree(fileTree)}</div>
                </div>
              </aside>

              <div className="studio-editor-pane">
                <div className="studio-tabs" role="tablist">
                  {tabs.map((tab) => (
                    <button
                      role="tab"
                      aria-selected={tab.path === activePath}
                      className={tab.path === activePath ? 'active' : ''}
                      key={tab.path}
                      onClick={() => setActivePath(tab.path)}
                    >
                      {tab.path.split('/').pop()}
                      {tab.content !== tab.saved && <span className="dirty-dot">●</span>}
                      <X
                        size={13}
                        aria-label={`Close ${tab.path}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (tab.content !== tab.saved) {
                            setError('Save this file before closing its tab.');
                            return;
                          }
                          setTabs((current) => current.filter((item) => item.path !== tab.path));
                          if (activePath === tab.path)
                            setActivePath(tabs.find((item) => item.path !== tab.path)?.path ?? '');
                        }}
                      />
                    </button>
                  ))}
                </div>
                {active ? (
                  <Editor
                    theme="vs-dark"
                    language={language(active.path)}
                    path={`ii-studio://${currentProject?.id}/${active.path}`}
                    value={active.content}
                    onMount={mountEditor}
                    onChange={(value) =>
                      setTabs((current) =>
                        current.map((tab) =>
                          tab.path === active.path ? { ...tab, content: value ?? '' } : tab,
                        ),
                      )
                    }
                    options={{
                      automaticLayout: true,
                      fontSize: proMode ? fontSize : 13,
                      fontFamily: proMode
                        ? "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, monospace"
                        : undefined,
                      fontLigatures: proMode,
                      lineNumbers: 'on',
                      minimap: {
                        enabled: proMode,
                        renderCharacters: false,
                        maxColumn: 80,
                      },
                      stickyScroll: { enabled: proMode },
                      smoothScrolling: true,
                      cursorSmoothCaretAnimation: proMode ? 'on' : 'off',
                      cursorBlinking: proMode ? 'smooth' : 'blink',
                      quickSuggestions: { other: true, comments: false, strings: false },
                      suggestOnTriggerCharacters: true,
                      inlineSuggest: { enabled: studioAiAutocomplete },
                      scrollBeyondLastLine: false,
                      scrollBeyondLastColumn: 32,
                      wordWrap: proMode && wordWrap ? 'on' : 'off',
                      wrappingIndent: 'indent',
                      bracketPairColorization: {
                        enabled: true,
                        independentColorPoolPerBracketType: true,
                      },
                      guides: { bracketPairs: true, indentation: true },
                      renderLineHighlight: proMode ? 'all' : 'line',
                      padding: proMode ? { top: 8, bottom: 8 } : undefined,
                      scrollbar: {
                        horizontal: 'visible',
                        vertical: 'visible',
                        horizontalScrollbarSize: 12,
                        verticalScrollbarSize: 12,
                        alwaysConsumeMouseWheel: false,
                      },
                      mouseWheelScrollSensitivity: 1.15,
                      renderWhitespace: 'selection',
                      tabSize: 4,
                    }}
                  />
                ) : (
                  <div className="studio-editor-empty">
                    <FileCode2 size={38} />
                    <p>Select a source file to start editing.</p>
                    <small>
                      {proMode
                        ? 'Ctrl+F finds · Ctrl+H replaces · Ctrl+S saves · minimap & sticky scroll on'
                        : 'Ctrl+F finds text · Ctrl+H replaces · Ctrl+S saves'}
                    </small>
                  </div>
                )}
                {selectionMenu && active && (
                  <div
                    className="studio-ai-selection-menu"
                    style={{ top: selectionMenu.top, left: selectionMenu.left }}
                    role="toolbar"
                    aria-label="AI selection actions"
                  >
                    {(
                      [
                        ['explain', 'Explain'],
                        ['summarize', 'Summarize'],
                        ['fix', 'Fix'],
                        ['change', 'Change'],
                      ] as const
                    ).map(([action, label]) => (
                      <button
                        key={action}
                        type="button"
                        disabled={selectionBusy}
                        title={demo ? `${label} (demo)` : label}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void runSelectionAction(action)}
                      >
                        <Sparkles size={12} /> {label}
                      </button>
                    ))}
                  </div>
                )}
                {selectionResult && (
                  <aside className="studio-ai-selection-result" role="status">
                    <header>
                      <strong>AI</strong>
                      <button type="button" onClick={() => setSelectionResult('')}>
                        <X size={14} />
                      </button>
                    </header>
                    <pre>{selectionResult}</pre>
                  </aside>
                )}
                {proMode && active && (
                  <div className="studio-pro-statusbar" aria-live="polite">
                    <span>{active.path}</span>
                    <span>
                      Ln {cursor.line}, Col {cursor.column}
                    </span>
                    <span>{language(active.path)}</span>
                    <span>{fontSize}px</span>
                    <span>{wordWrap ? 'Wrap' : 'No wrap'}</span>
                  </div>
                )}
              </div>
            </div>

            <div
              className={`studio-console-resizer ${consoleCollapsed ? 'disabled' : ''}`}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize console"
              onPointerDown={beginConsoleResize}
            />
            <section
              className={`studio-console studio-bottom-panel ${consoleCollapsed ? 'collapsed' : ''} studio-tab-${bottomTab}`}
              style={{ flexBasis: consoleCollapsed ? 36 : consoleHeight }}
            >
              <header className="studio-bottom-tabs" role="tablist" aria-label="Studio panels">
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === 'build'}
                  className={bottomTab === 'build' ? 'active' : ''}
                  onClick={() => setBottomTab('build')}
                >
                  <Hammer size={13} /> Build
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === 'logs'}
                  className={bottomTab === 'logs' ? 'active' : ''}
                  onClick={() => {
                    setBottomTab('logs');
                    setLogEnabled(true);
                  }}
                >
                  <TerminalSquare size={13} /> Console
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === 'project'}
                  className={bottomTab === 'project' ? 'active' : ''}
                  onClick={() => setBottomTab('project')}
                >
                  <LayoutList size={13} /> Project
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bottomTab === 'ai'}
                  className={bottomTab === 'ai' ? 'active' : ''}
                  onClick={() => setBottomTab('ai')}
                >
                  <MessageSquare size={13} /> AI
                </button>
              </header>
              {!consoleCollapsed && bottomTab === 'logs' && (
                <div className="studio-log-filters">
                  <div className="studio-game-path" title={gamePath || 'Discovering Gorilla Tag…'}>
                    <code>
                      {gamePath ||
                        (candidates.length
                          ? 'No valid Gorilla Tag install found'
                          : 'Looking for Gorilla Tag…')}
                    </code>
                    <button title="Refresh Gorilla Tag path" onClick={() => void discoverGame()}>
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  {(['All', 'Errors', 'Warnings', 'BepInEx', 'ii'] as LogFilter[]).map((filter) => (
                    <button
                      className={filter === logFilter ? 'active' : ''}
                      key={filter}
                      onClick={() => setLogFilter(filter)}
                    >
                      {filter}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      logOffset.current = 0;
                      setLogText('');
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}
              {!consoleCollapsed && bottomTab === 'project' && (
                <div className="studio-tab-toolbar studio-project-actions">
                  <button onClick={() => void invoke('studio_open_projects_folder')}>
                    <FolderOpen size={15} /> Open in Explorer
                  </button>
                  {proMode && (
                    <>
                      <button
                        className={wordWrap ? 'active' : ''}
                        title="Toggle word wrap"
                        onClick={() => setWordWrap((value) => !value)}
                      >
                        <WrapText size={15} /> Wrap
                      </button>
                      <button
                        title="Decrease font size"
                        onClick={() => setFontSize((value) => Math.max(11, value - 1))}
                      >
                        <Type size={14} /> A-
                      </button>
                      <button
                        title="Increase font size"
                        onClick={() => setFontSize((value) => Math.min(20, value + 1))}
                      >
                        <Type size={16} /> A+
                      </button>
                    </>
                  )}
                  {!separateWindow && (
                    <button
                      onClick={() => {
                        if (!studioPro) {
                          setError(
                            'Separate Studio window is a Pro perk. Upgrade to ii Engine Pro ($7/mo).',
                          );
                          return;
                        }
                        void invoke('open_studio_window').catch((reason) => {
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : 'Could not open Studio in a new window.',
                          );
                        });
                      }}
                    >
                      <Maximize2 size={15} /> Studio window
                    </button>
                  )}
                </div>
              )}
              {!consoleCollapsed && bottomTab === 'build' && (
                <div className="studio-build-output">
                  {!!build?.diagnostics.length && (
                    <div className="studio-problems">
                      {build.diagnostics.map((diagnostic, index) => (
                        <button
                          key={`${diagnostic.file}-${diagnostic.line}-${diagnostic.code}-${index}`}
                          className={diagnostic.severity}
                          onClick={() => void openFile(diagnostic.file, diagnostic.line)}
                        >
                          <strong>{diagnostic.code}</strong>
                          <span>{diagnostic.message}</span>
                          <small>
                            {diagnostic.file}:{diagnostic.line}:{diagnostic.column}
                          </small>
                        </button>
                      ))}
                    </div>
                  )}
                  <pre>{build?.output || 'Build output will appear here.'}</pre>
                </div>
              )}
              {!consoleCollapsed && bottomTab === 'logs' && (
                <pre className="studio-live-log">
                  {visibleLogs || 'Waiting for BepInEx/LogOutput.log…'}
                </pre>
              )}
              {!consoleCollapsed && bottomTab === 'project' && (
                <div className="studio-project-panel">
                  <p>
                    Save before switching projects. Save, Build, Install, and Build &amp; Play are
                    in the toolbar above; build output is on the Build tab and live game logs are on
                    Console.
                  </p>
                  {currentProject && (
                    <code>
                      {environment?.projects_root}\\{currentProject.name}
                    </code>
                  )}
                </div>
              )}
              {!consoleCollapsed && bottomTab === 'ai' && (
                <div className="studio-ai-panel studio-ai-panel-docked">
                  <header>
                    <strong>
                      <Sparkles size={14} /> Studio assist
                    </strong>
                    <small>
                      Select code in the editor for Explain / Fix actions, or ask a question below.
                      {studioAiAutocomplete
                        ? ' Inline autocomplete is on (Settings).'
                        : ' Enable autocomplete in Settings → Studio AI.'}
                    </small>
                  </header>
                  <form className="studio-ai-actions" onSubmit={(event) => void askAssist(event)}>
                    <textarea
                      aria-label="Ask Studio assist"
                      placeholder="How do I patch a Gorilla Tag method with Harmony?"
                      value={assistQuestion}
                      onChange={(event) => setAssistQuestion(event.target.value)}
                      disabled={assistBusy}
                    />
                    <button
                      className="primary"
                      type="submit"
                      disabled={assistBusy || !assistQuestion.trim()}
                    >
                      {assistBusy ? 'Thinking…' : 'Ask'}
                    </button>
                  </form>
                  {(assistThread.length > 0 || selectionResult) && (
                    <div className="studio-ai-thread" role="log" aria-live="polite">
                      {assistThread.map((turn) => (
                        <div key={turn.id} className="studio-ai-answer">
                          <span className="studio-ai-source">
                            {turn.source === 'api' ? 'Engine AI' : 'Local tips'} · {turn.label}
                          </span>
                          <p>{turn.text}</p>
                        </div>
                      ))}
                      {selectionResult && assistThread.every((t) => t.text !== selectionResult) && (
                        <div className="studio-ai-answer">
                          <span className="studio-ai-source">
                            {assistSource === 'api' ? 'Engine AI' : 'Local tips'}
                          </span>
                          <p>{selectionResult}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}

        {(status || error) && (
          <footer
            className={`studio-status ${error ? 'error' : ''}`}
            role={error ? 'alert' : 'status'}
          >
            {error || status}
          </footer>
        )}
      </section>
    </div>
  );
}
