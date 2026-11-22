// makefun-site 1.0.0, the house entry's driver, kept as it ships: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of {id, input}), answers each one
// alone with run() from solve.js, and writes /output/answers.json: a JSON array of the answers, one per
// case and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 tuned before solve.js is imported, so all of its work runs under these flags (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too). Incremental marking
// off, as the baseline has it, and the optimising compiler off: every timed run is a fresh process, so
// the entry runs once, cold — skipping TurboFan's compile cost beats the speedup it would buy.
setFlagsFromString('--no-incremental-marking --no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
