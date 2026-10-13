import * as path from 'path';

/** The installed netbridge version (package.json ships next to dist/). */
export function packageVersion(): string {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version;
  } catch {
    return '0.0.0';
  }
}
