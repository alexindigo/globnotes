import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as themes from '../themes.js';

beforeEach(() => { window.matchMedia = vi.fn(() => ({ matches:false, addEventListener(){} })); });
afterEach(() => { themes.setBrandAccent(null); themes.setTheme('system'); });
describe('Appearance palette projection', () => {
  it('projects every explicit theme by family plus the System pair', () => {
    expect(typeof themes.themePreviews).toBe('function');
    const rows = themes.themePreviews();
    expect(rows.map(row => row.id)).toEqual(themes.THEMES.map(theme => theme.id));
    expect(rows[0].pair.map(row => row.id)).toEqual(['globnotes-light','globnotes-dark']);
    for (const row of rows.slice(1)) {
      expect(row.family).toBeTruthy(); expect(row.variant).toBeTruthy();
      expect(row.vars['--theme-background']).toBeTruthy(); expect(row.vars['--theme-code-keyword']).toBeTruthy();
    }
  });
  it('uses the same effective accent and semantic danger ink as the applied palette', () => {
    expect(typeof themes.themePreviews).toBe('function');
    themes.setBrandAccent('#ffee00'); themes.setTheme('globnotes-dark');
    const rows = themes.themePreviews();
    expect(rows.find(row => row.id === 'globnotes-dark').vars['--theme-brand']).toBe(document.documentElement.style.getPropertyValue('--theme-brand'));
    expect(rows.find(row => row.id === 'globnotes-dark').vars['--theme-on-danger']).toBe(document.documentElement.style.getPropertyValue('--theme-on-danger'));
    expect(rows.find(row => row.id === 'globnotes-dark').vars).not.toHaveProperty('--theme-on-brand');
    expect(rows.find(row => row.id === 'dracula').vars['--theme-brand']).not.toBe(rows.find(row => row.id === 'globnotes-dark').vars['--theme-brand']);
  });
});
