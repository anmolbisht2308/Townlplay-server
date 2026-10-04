import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the script being run (`tsx src/scripts/x.ts`). Compares real file
 * paths, not URL text: a folder like "Life Management OS" is "%20"-encoded in import.meta.url.
 */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
