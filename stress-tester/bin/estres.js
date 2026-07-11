#!/usr/bin/env node
'use strict';

const { parseArgs, HELP } = require('../src/config');
const { Runner } = require('../src/runner');

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.stderr.write('Usa --help para ver las opciones.\n');
    process.exit(1);
  }

  if (parsed.help || process.argv.length <= 2) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const runner = new Runner(parsed.cfg);
  await runner.run();

  // Si no hay dashboard, salimos al terminar; con dashboard, seguimos vivos.
  if (!parsed.cfg.dashboard) process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`\nError fatal: ${err.stack || err}\n`);
  process.exit(1);
});
