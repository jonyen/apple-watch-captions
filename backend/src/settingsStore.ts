import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Settings, DEFAULT_SETTINGS, mergeSettings } from "./settings";

/**
 * The current settings, kept in memory and optionally written to disk.
 *
 * Persisted so a relay restart does not silently reset the watch to defaults —
 * a caption size that resets itself every deploy would read as a bug in the
 * watch app rather than in the relay. Without a path (tests) it is memory only.
 *
 * A corrupt or unreadable file falls back to defaults rather than throwing:
 * settings are a convenience, and failing to boot the relay over one is a far
 * worse outcome than losing a font size.
 */
export class SettingsStore {
  private current: Settings;

  constructor(private readonly path?: string) {
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  /** Apply a partial update, persist it, and return the result. */
  update(patch: unknown): Settings {
    this.current = mergeSettings(this.current, patch);
    this.save();
    return this.current;
  }

  private load(): Settings {
    if (!this.path) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      // Through the same merge as a client write, so a file written by an
      // older version — or edited by hand — is validated rather than trusted.
      return mergeSettings(DEFAULT_SETTINGS, raw);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.current, null, 2));
    } catch {
      // In-memory settings still work for this run; a disk that cannot be
      // written is not a reason to fail the request.
    }
  }
}
