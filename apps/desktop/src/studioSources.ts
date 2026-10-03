export type StudioProjectSource =
  'ii_template' | 'ii_stupid_menu' | 'open_source' | 'zip_import' | 'blank';

export type StudioSourceOption = { value: StudioProjectSource; label: string };

const freeSources: StudioSourceOption[] = [
  { value: 'ii_template', label: 'Use ii Template v2' },
  { value: 'ii_stupid_menu', label: 'Use ii Reborn Menu' },
];

const proSources: StudioSourceOption[] = [
  ...freeSources,
  { value: 'open_source', label: 'Import from GitHub (Pro)' },
  { value: 'zip_import', label: 'Import ZIP (Pro)' },
  { value: 'blank', label: 'Blank project (Pro)' },
];

export function studioProjectSourceOptions(proMode: boolean): StudioSourceOption[] {
  return proMode ? proSources : freeSources;
}

export function isProOnlyStudioSource(source: StudioProjectSource): boolean {
  return source === 'open_source' || source === 'zip_import' || source === 'blank';
}
