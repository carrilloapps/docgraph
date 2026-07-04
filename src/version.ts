import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * DocGraph's own package version, resolved at runtime from the nearest
 * `package.json` so it never drifts from what is actually published.
 *
 * It walks up from this module's location until it finds the
 * `@carrilloapps/docgraph` manifest, which works in both layouts the code
 * runs from — the published `dist/` tree and the `dist-test/src/` test tree —
 * without a hard-coded relative depth. The result is cached; if resolution
 * fails for any reason it falls back to `'0.0.0'` rather than throwing.
 */
const PACKAGE_NAME = '@carrilloapps/docgraph';
let cached: string | undefined;

export function getPackageVersion(): string {
  if (cached !== undefined) return cached;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === PACKAGE_NAME && pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // No readable package.json at this level — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  cached = '0.0.0';
  return cached;
}
