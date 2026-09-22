'use strict';

/** Parses every project .js file with `node --check`. Run with `npm run check`. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'tests', 'scripts'];

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...collect(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const files = DIRS.flatMap(dir => (fs.existsSync(path.join(ROOT, dir)) ? collect(path.join(ROOT, dir)) : []));
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push({ file, message: String(error.stderr || error.message).trim() });
  }
}

for (const failure of failures) {
  console.error(`✗ ${path.relative(ROOT, failure.file)}\n  ${failure.message.split('\n').join('\n  ')}`);
}

console.log(`${files.length - failures.length}/${files.length} files parse`);
if (failures.length) process.exitCode = 1;
