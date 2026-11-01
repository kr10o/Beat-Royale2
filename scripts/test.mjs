import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({entryPoints:['tests/game.test.ts'],bundle:true,platform:'node',format:'esm',outfile:'.wrangler/tests/game.test.mjs'});
const run=spawnSync(process.execPath,['--test','tests/protocol.test.ts','tests/edge.test.mjs','.wrangler/tests/game.test.mjs'],{stdio:'inherit'});
process.exitCode=run.status ?? 1;
