// Syntax-checks every app script (npm run check).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['electron', 'public/js', 'scripts']
  .flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((f) => /\.(c?js)$/.test(f)).map((f) => path.join(root, dir, f)));
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}\n${error.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
