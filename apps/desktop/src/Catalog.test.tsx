import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import Catalog from './Catalog';
import { takeCatalogSourceIntent } from './catalogStudioBridge';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

it('searches demo catalog and shows Ask AI on the selected card', async () => {
  render(<Catalog demo isPro />);
  expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/Search catalog/i), 'Iron');
  expect(await screen.findByRole('button', { name: /Iron Man/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Platforms/i })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Iron Man/i }));
  expect(screen.getByRole('button', { name: /Ask AI about Iron Man/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Ask AI about Iron Man/i }));
  expect(await screen.findByText(/AI EXPLAIN/i)).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: /AI explanation for Iron Man/i })).toBeInTheDocument();
  expect(screen.getAllByText(/informational only/i).length).toBeGreaterThan(0);
  expect(screen.queryByText(/risk score/i)).toBeNull();
  await userEvent.click(screen.getByRole('dialog', { name: /AI explanation for Iron Man/i }));
  expect(screen.queryByRole('dialog', { name: /AI explanation for Iron Man/i })).toBeNull();
});

it('defaults to Important Mods and sorts gameplay options first', async () => {
  render(<Catalog demo isPro />);
  expect(await screen.findByRole('heading', { name: 'Important Mods' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Anti AFK/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Movement Mods/i }));
  expect(await screen.findByRole('heading', { name: 'Movement Mods' })).toBeInTheDocument();
  const platforms = screen.getByRole('button', { name: /Platforms/i });
  const iron = screen.getByRole('button', { name: /Iron Man/i });
  expect(platforms.compareDocumentPosition(iron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('gates Ask AI behind Engine Pro for free users but keeps Jump to code', async () => {
  render(<Catalog demo isPro={false} onOpenSource={() => undefined} />);
  await userEvent.click(await screen.findByRole('button', { name: /Movement Mods/i }));
  await userEvent.click(await screen.findByRole('button', { name: /Platforms/i }));
  expect(screen.getByRole('button', { name: /Engine Pro · Ask AI/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Jump to code/i })).toBeInTheDocument();
});

it('queues Studio source intent for Jump to code', async () => {
  const onOpenSource = vi.fn();
  render(<Catalog demo isPro={false} onOpenSource={onOpenSource} />);
  await userEvent.type(screen.getByLabelText(/Search catalog/i), 'Iron');
  await userEvent.click(await screen.findByRole('button', { name: /Iron Man/i }));
  await userEvent.click(screen.getByRole('button', { name: /Jump to code/i }));
  expect(onOpenSource).toHaveBeenCalledTimes(1);
  const intent = takeCatalogSourceIntent();
  expect(intent?.modName).toBe('Iron Man');
  expect(intent?.category).toBe('Movement Mods');
});
