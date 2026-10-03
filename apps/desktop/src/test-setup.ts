import '@testing-library/jest-dom/vitest';

Object.defineProperty(document, 'queryCommandSupported', {
  configurable: true,
  value: () => false,
});
