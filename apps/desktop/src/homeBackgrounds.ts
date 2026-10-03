import type { HomeBackgroundId } from './appearance';
import mountain from '../../../packages/brand/illustrations/home-bg/mountain.jpg';
import mines from '../../../packages/brand/illustrations/home-bg/mines.jpg';
import campfire from '../../../packages/brand/illustrations/home-bg/campfire.jpg';
import caves from '../../../packages/brand/illustrations/home-bg/caves.jpg';
import canyon from '../../../packages/brand/illustrations/home-bg/canyon.jpg';
import cat from '../../../packages/brand/illustrations/home-bg/cat.jpg';

export const homeBackgroundImages: Record<Exclude<HomeBackgroundId, 'none'>, string> = {
  mountain,
  mines,
  campfire,
  caves,
  canyon,
  cat,
};

export function homeBackgroundUrl(id: HomeBackgroundId): string | null {
  if (id === 'none') return null;
  return homeBackgroundImages[id] ?? null;
}
