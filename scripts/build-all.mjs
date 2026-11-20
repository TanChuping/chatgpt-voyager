#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTargets, parseBuildArguments } from './build-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const options = parseBuildArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run build:all -- [--platforms chrome,edge,firefox,safari] [Vite build options]');
    console.log('Default: all four targets. Edge reuses the Chrome compilation from this invocation.');
  } else {
    await buildTargets(root, options.targets, options);
  }
} catch (error) {
  console.error(`[build] ${error.message}`);
  process.exitCode = 1;
}
