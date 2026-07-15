#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const mode = process.argv[2] || 'dev';
const isWindows = process.platform === 'win32';
const npxCmd = 'npx';

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: isWindows });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (mode === 'dev') {
  run(npxCmd, ['--yes', 'electron@31.7.7', '.']);
} else if (mode === 'pack') {
  run(npxCmd, ['--yes', 'electron-builder@24.13.3', '--dir']);
} else if (mode === 'dist') {
  run(npxCmd, ['--yes', 'electron-builder@24.13.3']);
} else {
  console.error(`Unknown desktop mode: ${mode}`);
  process.exit(1);
}
