import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

// nginx gzip_static serves these files without per-request compression.
async function compress(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await compress(path);
    else if (['.js', '.css', '.json', '.svg', '.html'].includes(extname(path))) {
      const bytes = gzipSync(await readFile(path), { level: 9 });
      await writeFile(path + '.gz', bytes);
      total += bytes.length;
    }
  }
  return total;
}
console.log(`Precompressed text assets: ${await compress('dist')} bytes`);
