import { useMemo, useState } from 'react';
import { Layers, Plus, Trash2 } from 'lucide-react';
import {
  createLoadout,
  deleteLoadout,
  readLoadouts,
  renameLoadout,
  setLoadoutMods,
  type LoadoutModRef,
  type ModLoadout,
} from './loadouts';
import { trackFeature } from './telemetry';

export default function LoadoutsPanel({
  catalog,
  onApply,
  busy,
}: {
  catalog: LoadoutModRef[];
  onApply: (loadout: ModLoadout) => void;
  busy?: string;
}) {
  const [tick, setTick] = useState(0);
  const loadouts = useMemo(() => {
    void tick;
    return readLoadouts();
  }, [tick]);
  const [selectedId, setSelectedId] = useState(loadouts[0]?.id ?? '');
  const selected = loadouts.find((item) => item.id === selectedId) ?? loadouts[0] ?? null;

  function refresh(nextId?: string) {
    setTick((value) => value + 1);
    if (nextId) setSelectedId(nextId);
  }

  return (
    <section className="panel loadouts-panel">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">PRO</span>
          <h3>Loadouts</h3>
          <p>Name a set of trusted/community mods, then apply it when you want that kit.</p>
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => {
            const created = createLoadout(`Loadout ${loadouts.length + 1}`);
            trackFeature('loadouts', 'create');
            refresh(created.id);
          }}
        >
          <Plus size={14} /> New loadout
        </button>
      </div>

      {!loadouts.length ? (
        <p className="empty-row">Create a loadout to start collecting mods.</p>
      ) : (
        <div className="loadouts-layout">
          <aside className="loadouts-list" aria-label="Your loadouts">
            {loadouts.map((loadout) => (
              <button
                type="button"
                key={loadout.id}
                className={selected?.id === loadout.id ? 'active' : ''}
                onClick={() => setSelectedId(loadout.id)}
              >
                <Layers size={14} />
                <span>
                  {loadout.name}
                  <small>{loadout.mods.length} mods</small>
                </span>
              </button>
            ))}
          </aside>

          {selected && (
            <div className="loadouts-editor">
              <label>
                Name
                <input
                  value={selected.name}
                  maxLength={48}
                  onChange={(event) => {
                    renameLoadout(selected.id, event.target.value);
                    refresh(selected.id);
                  }}
                />
              </label>
              <div className="loadouts-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!!busy || !selected.mods.length}
                  onClick={() => {
                    trackFeature('loadouts', 'apply');
                    onApply(selected);
                  }}
                >
                  {busy === `loadout-${selected.id}` ? 'Applying…' : 'Apply loadout'}
                </button>
                <button
                  type="button"
                  className="danger-text"
                  onClick={() => {
                    deleteLoadout(selected.id);
                    trackFeature('loadouts', 'delete');
                    refresh();
                    setSelectedId('');
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
              <div className="loadouts-mod-picker">
                <h4>Mods in this loadout</h4>
                <div className="loadouts-mod-grid">
                  {catalog.map((mod) => {
                    const on = selected.mods.some(
                      (item) => item.source === mod.source && item.id === mod.id,
                    );
                    return (
                      <label key={`${mod.source}-${mod.id}`} className={on ? 'on' : ''}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const mods = on
                              ? selected.mods.filter(
                                  (item) => !(item.source === mod.source && item.id === mod.id),
                                )
                              : [...selected.mods, mod];
                            setLoadoutMods(selected.id, mods);
                            refresh(selected.id);
                          }}
                        />
                        <span>
                          <strong>{mod.name}</strong>
                          <small>
                            {mod.source} · {mod.filename}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
