import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type ModuleDefault<T> = { default: T };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches React.lazy ComponentType<any>
export async function loadPageModule<T extends ComponentType<any>>(
  importer: () => Promise<ModuleDefault<T>>,
  label: string,
  bust?: () => Promise<ModuleDefault<T>>,
): Promise<ModuleDefault<T>> {
  let mod = await importer();
  if (typeof mod?.default === 'function') return mod;

  if (bust) {
    mod = await bust();
    if (typeof mod?.default === 'function') return mod;
  }

  throw new Error(`${label} failed to load. Refresh the page.`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches React.lazy ComponentType<any>
export function lazyPage<T extends ComponentType<any>>(
  importer: () => Promise<ModuleDefault<T>>,
  label: string,
  bust?: () => Promise<ModuleDefault<T>>,
): LazyExoticComponent<T> {
  return lazy(() => loadPageModule(importer, label, bust));
}
