import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings";
import { SettingsStore } from "./settingsStore";

describe("mergeSettings", () => {
  it("keeps the base when the update is not an object", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, "16")).toEqual(DEFAULT_SETTINGS);
  });

  it("applies only the fields present", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { captionTextSize: 22 });

    expect(merged.captionTextSize).toBe(22);
    expect(merged.saveTranscripts).toBe(DEFAULT_SETTINGS.saveTranscripts);
  });

  it("clamps a text size that would make the watch unreadable", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { captionTextSize: 400 }).captionTextSize).toBe(30);
    expect(mergeSettings(DEFAULT_SETTINGS, { captionTextSize: 2 }).captionTextSize).toBe(12);
  });

  it("rounds a fractional text size", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { captionTextSize: 18.4 }).captionTextSize).toBe(18);
  });

  it("ignores a text size that is not a finite number", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { captionTextSize: "big" }).captionTextSize).toBe(16);
    expect(mergeSettings(DEFAULT_SETTINGS, { captionTextSize: NaN }).captionTextSize).toBe(16);
  });

  it("accepts a known provider and ignores an unknown one", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { provider: "openai" }).provider).toBe("openai");
    expect(mergeSettings(DEFAULT_SETTINGS, { provider: "whisper" }).provider).toBe("deepgram");
  });

  it("ignores unknown fields rather than failing the whole write", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      captionTextSize: 20,
      somethingNewer: true,
    });

    expect(merged.captionTextSize).toBe(20);
  });

  it("takes booleans only as booleans", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { saveTranscripts: "no" }).saveTranscripts).toBe(true);
    expect(mergeSettings(DEFAULT_SETTINGS, { saveTranscripts: false }).saveTranscripts).toBe(false);
  });
});

describe("SettingsStore", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "settings-"));

  it("starts from defaults with no file", () => {
    expect(new SettingsStore().get()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists an update and reads it back in a new store", () => {
    const path = join(dir(), "settings.json");

    new SettingsStore(path).update({ captionTextSize: 24, provider: "openai" });

    const reopened = new SettingsStore(path).get();
    expect(reopened.captionTextSize).toBe(24);
    expect(reopened.provider).toBe("openai");
  });

  it("falls back to defaults on an unreadable file rather than throwing", () => {
    const path = join(dir(), "settings.json");
    writeFileSync(path, "{ not json");

    expect(new SettingsStore(path).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("validates a hand-edited file instead of trusting it", () => {
    const path = join(dir(), "settings.json");
    writeFileSync(path, JSON.stringify({ captionTextSize: 900, provider: "nope" }));

    const settings = new SettingsStore(path).get();
    expect(settings.captionTextSize).toBe(30);
    expect(settings.provider).toBe("deepgram");
  });

  it("writes readable JSON, so the file can be inspected on the volume", () => {
    const path = join(dir(), "settings.json");

    new SettingsStore(path).update({ captionTextSize: 20 });

    expect(JSON.parse(readFileSync(path, "utf8")).captionTextSize).toBe(20);
  });
});
