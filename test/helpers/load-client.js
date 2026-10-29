// Loads js/utils.js the way the browser does.
//
// The file is a classic script that assigns RCUtils to the global object, so a
// bare vm context is enough: no DOM, no bundler, no shims. Reading the real
// file (rather than importing a copy) means the tests cover exactly what ships.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const utilsPath = path.join(here, '..', '..', 'js', 'utils.js');

export function loadClientUtils() {
  const code = fs.readFileSync(utilsPath, 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: utilsPath });
  if (!ctx.RCUtils) throw new Error('js/utils.js did not assign globalThis.RCUtils');
  return ctx.RCUtils;
}
