// @vitest-environment jsdom
// The source boundary is intentional: a mounted component cannot see a future
// caller's scoped CSS or utility override. Native tests prove the painted result.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import { parse as parseSfc } from 'vue/compiler-sfc';
import postcss from 'postcss';

const client = join(process.env.GLOBNOTES_PRIMITIVE_SOURCE_ROOT ?? process.cwd(), 'client');
const owners = new Set(['components/CustomButton.vue', 'components/TextInput.vue']);
const primitives = new Set(['CustomButton', 'CtaButton', 'TextInput', 'SettingsButton', 'SettingsInput']);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.vue') ? [join(directory, entry.name)] : []);
}
const sources = ['components', 'views', 'partials'].flatMap(name => files(join(client, name)));
const appearance = /^(?:!?)(?:(?:[\w-]+):)*(?:p[xytrblse]?-(?:\[|\d)|(?:min-)?h-(?:\[|\d)|bg-|text-(?!left$|right$|center$|justify$|nowrap$|wrap$|balance$|pretty$)|font-|leading-|opacity-|border(?:-|$)|rounded(?:-|$)|shadow(?:-|$)|ring(?:-|$)|outline(?:-|$)|\[-webkit-text-stroke|\[paint-order)/;
const protectedSelector = /\.custom-button\b|\[data-variant|\.text-input\b|:deep\([^)]*(?:\bbutton\b|\binput\b|CustomButton|TextInput)/;

function violations() {
  const found = [];
  for (const path of sources) {
    if (owners.has(relative(client, path))) continue;
    const name = relative(client, path), { descriptor } = parseSfc(readFileSync(path, 'utf8'));
    const tags = new Set(primitives);
    for (const script of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      for (const match of script.content.matchAll(/import\s+(\w+)\s+from\s+["'][^"']*\/(?:CustomButton|CtaButton|TextInput)\.vue["']/g)) tags.add(match[1]);
    }
    const rootClasses = new Set();
    function walk(node) {
      if (node.type === 1 && node.tag === 'input') {
        const type = node.props.find(prop => prop.type === 6 && prop.name === 'type')?.value?.content;
        if (!type || ['text', 'search', 'password', 'url', 'email', 'tel', 'number'].includes(type)) found.push(`${name}: native text input bypasses TextInput`);
      }
      if (node.type === 1 && tags.has(node.tag)) {
        for (const prop of node.props) {
          const key = prop.type === 6 ? prop.name : prop.arg?.content;
          const value = prop.type === 6 ? prop.value?.content : prop.exp?.content;
          if (key === 'style') found.push(`${name}: ${node.tag} caller style`);
          if (key === 'class' && value) {
            for (const token of value.replace(/["'`,{}]/g, ' ').split(/\s+/)) {
              rootClasses.add(token);
              if (appearance.test(token)) found.push(`${name}: ${node.tag} caller appearance ${token}`);
            }
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
    }
    if (descriptor.template) walk(descriptor.template.ast);
    for (const style of descriptor.styles) {
      postcss.parse(style.content).walkRules(rule => {
        const sharedClass = [...rootClasses].some(name => name && rule.selector.includes(`.${name}`));
        const paints = rule.nodes?.some(node => node.type === 'decl' && /^(?:color|background|padding|font|line-height|height|min-height|opacity|border|box-shadow|-webkit-text-stroke|paint-order)/.test(node.prop));
        if (protectedSelector.test(rule.selector) || sharedClass && paints) found.push(`${name}: shared primitive selector ${rule.selector}`);
      });
    }
  }
  return found;
}

describe('one appearance owner per shared primitive', () => {
  it('rejects primitive CSS selectors and caller paint/type/padding overrides across every component and view', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(violations()).toEqual([]);
  });

  it('does not retain alternate Settings appearance wrappers or imports', () => {
    const names = sources.map(path => relative(client, path));
    expect(names).not.toContain('components/settings/SettingsButton.vue');
    expect(names).not.toContain('components/settings/SettingsInput.vue');
    for (const path of sources) expect(readFileSync(path, 'utf8')).not.toMatch(/(?:from\s*["'][^"']*|<)Settings(?:Button|Input)(?:\.vue|\b)/);
  });

  it('keeps the full-width CTA composition on the one static primary variant', () => {
    const { descriptor } = parseSfc(readFileSync(join(client, 'components/CtaButton.vue'), 'utf8'));
    const children = descriptor.template.ast.children.filter(node => node.type === 1);
    expect(children).toHaveLength(1);
    expect(children[0].tag).toBe('CustomButton');
    expect(children[0].props.find(prop => prop.type === 6 && prop.name === 'variant')?.value?.content).toBe('cta');
    expect(children[0].props.some(prop => prop.type === 7 && prop.arg?.content === 'variant')).toBe(false);
  });
});
