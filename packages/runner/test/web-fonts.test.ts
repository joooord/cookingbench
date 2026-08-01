import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';

const WEB_ROOT = join(REPO_ROOT, 'apps/web');
const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const GENERATED_DIRECTORIES = new Set(['.next', 'coverage', 'node_modules']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return GENERATED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe('web typography stays network-independent', () => {
  it('does not import or link a remote font source', () => {
    for (const path of sourceFiles(WEB_ROOT)) {
      const source = readFileSync(path, 'utf8');
      const file = relative(REPO_ROOT, path);

      expect(source, `${file} imports a Google font that Next.js downloads during the build`).not.toMatch(
        /(?:from\s*|require\(\s*)['"]next\/font\/google['"]/,
      );
      expect(source, `${file} imports a remote stylesheet`).not.toMatch(
        /@import\s+(?:url\(\s*)?['"]?https?:\/\//i,
      );
      expect(source, `${file} loads a remote font binary`).not.toMatch(
        /@font-face[\s\S]*?src\s*:[^;]*url\(\s*['"]?https?:\/\//i,
      );
      expect(source, `${file} links a remote stylesheet`).not.toMatch(
        /<link\b(?=[^>]*\brel=['"]stylesheet['"])(?=[^>]*\bhref=['"]https?:\/\/)[^>]*>/i,
      );
    }
  });

  it('keeps generic fallbacks for every typography role', () => {
    const css = readFileSync(join(WEB_ROOT, 'app/globals.css'), 'utf8');

    expect(css).toMatch(/--font-display:[^;]*\bserif\s*;/);
    expect(css).toMatch(/--font-sans:[^;]*\bsans-serif\s*;/);
    expect(css).toMatch(/--font-mono:[^;]*\bmonospace\s*;/);
  });

  it('self-hosts the three type families named in the visual specification', () => {
    const css = readFileSync(join(WEB_ROOT, 'app/globals.css'), 'utf8');
    const expected = [
      ['Fraunces', 'fraunces-latin-variable.woff2'],
      ['Inter', 'inter-latin-variable.woff2'],
      ['IBM Plex Mono', 'ibm-plex-mono-latin-400.woff2'],
      ['IBM Plex Mono', 'ibm-plex-mono-latin-500.woff2'],
    ] as const;

    for (const [family, filename] of expected) {
      const path = join(WEB_ROOT, 'public/fonts', filename);
      expect(existsSync(path), `${filename} is missing from the public font bundle`).toBe(true);
      expect(statSync(path).size, `${filename} is empty`).toBeGreaterThan(0);
      expect(css).toContain(`font-family: '${family}'`);
      expect(css).toContain(`url('/fonts/${filename}')`);
    }
  });
});
