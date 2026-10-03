import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

const choices = {
  app: 'App version',
  os: 'Operating system',
  health: 'Coarse health results',
  components: 'Menu component hashes',
};
type Section = keyof typeof choices;
type Preview = { token: string; text: string };
export default function Diagnostics({ demo }: { demo: boolean }) {
  const [sections, setSections] = useState<Section[]>(['app', 'os', 'health', 'components']);
  const [gamePath, setGamePath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function prepare() {
    setBusy(true);
    setMessage('');
    setPreview(null);
    try {
      if (demo) {
        const sample: Record<string, unknown> = { schema_version: 1, demo: true };
        if (sections.includes('app')) sample.app = { name: 'ii Engine', version: '0.2.2' };
        if (sections.includes('os')) sample.os = 'Windows fixture';
        if (sections.includes('health'))
          sample.health = { status: 'Not checked', game_path: 'synthetic fixture' };
        if (sections.includes('components')) sample.components = [];
        setPreview({ token: 'demo', text: JSON.stringify(sample, null, 2) });
      } else {
        setPreview(
          await invoke<Preview>('diagnostics_preview', { sections, gamePath: gamePath || null }),
        );
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!preview) return;
    setBusy(true);
    setMessage('');
    try {
      const path = await invoke<string>('diagnostics_export', { token: preview.token });
      setPreview(null);
      setMessage(`Saved locally: ${path}`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="diagnostics-section" aria-label="Local diagnostics">
      <h2>Local diagnostics</h2>
      <p>
        Builds a local report you can save or share yourself. This export is not uploaded. Personal
        paths, Discord IDs, prompts, and raw logs are excluded. Session telemetry (Settings above)
        is a separate quit journal that is on until you turn it off, and it never includes your PC
        name, Windows username, or IP address.
      </p>
      <div className="diagnostics-options">
        {(Object.keys(choices) as Section[]).map((key) => (
          <label className="diagnostic-option" key={key}>
            <span>{choices[key]}</span>
            <input
              type="checkbox"
              checked={sections.includes(key)}
              onChange={(e) => {
                setSections(
                  e.target.checked ? [...sections, key] : sections.filter((x) => x !== key),
                );
                setPreview(null);
              }}
            />
          </label>
        ))}
      </div>
      {!demo && (
        <label className="game-path">
          <span>
            Game folder <small>Optional</small>
          </span>
          <input
            value={gamePath}
            onChange={(e) => {
              setGamePath(e.target.value);
              setPreview(null);
            }}
          />
        </label>
      )}
      <button disabled={busy || (!demo && !isTauri())} onClick={prepare}>
        Preview diagnostic report
      </button>
      {preview && (
        <>
          <pre className="diagnostic-preview" aria-label="Exact diagnostic export preview">
            {preview.text}
          </pre>
          <button disabled={busy || demo || !isTauri()} onClick={save}>
            Export this diagnostic report
          </button>
          {demo && <p>The demo preview is synthetic. File export requires the desktop app.</p>}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
