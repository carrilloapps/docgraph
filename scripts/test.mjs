#!/usr/bin/env node
// Cross-platform test runner: discovers compiled test files and hands them to
// Node's built-in test runner as explicit arguments (supported since Node 18),
// avoiding shell-glob differences between bash and cmd.exe.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = join('dist-test', 'test');

if (!existsSync(dir)) {
  console.error(`No compiled tests found at "${dir}". Run "npm run build:test" first.`);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => join(dir, file));

if (files.length === 0) {
  console.error(`No *.test.js files found in "${dir}".`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
