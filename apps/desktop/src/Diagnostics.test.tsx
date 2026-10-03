import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import Diagnostics from './Diagnostics';
afterEach(cleanup);
it('previews exactly the selected synthetic fields and invalidates a changed selection', async () => {
  render(<Diagnostics demo />);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Operating system' }));
  await userEvent.click(screen.getByRole('button', { name: 'Preview diagnostic report' }));
  const output = screen.getByLabelText('Exact diagnostic export preview');
  expect(output).toHaveTextContent('ii Engine');
  expect(output).not.toHaveTextContent('Synthetic Windows');
  expect(screen.getByRole('button', { name: 'Export this diagnostic report' })).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Coarse health results' }));
  expect(screen.queryByLabelText('Exact diagnostic export preview')).toBeNull();
});
