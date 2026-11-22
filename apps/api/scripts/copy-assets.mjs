// Copies the files `tsc` does not (shell scripts that the server sends to managed servers, the built-in baselines) from `src` to `dist`,
// keeping their paths. Run after `tsc` by `pnpm run build`.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src');
const target = join(root, 'dist');
const EXTENSIONS = ['.sh', '.yaml'];

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (EXTENSIONS.some((extension) => name.endsWith(extension))) {
      yield path;
    }
  }
}

let copied = 0;
for (const file of walk(source)) {
  const destination = join(target, relative(source, file));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
  copied += 1;
}
console.log(`copied ${String(copied)} asset file(s) to dist`);
