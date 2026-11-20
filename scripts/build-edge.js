#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTargets, parseBuildArguments } from './build-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const options = parseBuildArguments(process.argv.slice(2), { edgeOnly: true });
  if (options.help) {
    console.log('Usage: npm run build:edge -- [--from-chrome | Vite build options]');
    console.log('Default: compile Chrome, then create dist_edge/ and voyager-edge-v<version>.zip.');
    console.log('--from-chrome: explicitly reuse an existing complete dist_chrome/ of this version.');
  } else {
    await buildTargets(root, options.targets, options);
  }
} catch (error) {
  console.error(`[build:edge] ${error.message}`);
  process.exitCode = 1;
}
