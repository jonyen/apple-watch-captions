# Captions — App Icon Design

**Date:** 2026-06-14
**Status:** Approved

## Goal

Give the watchOS "Captions" app a distinctive app icon. Concept: a speech/text
bubble that reads instantly as "live captions."

## Concept (chosen: "A — Caption lines")

- Vertical blue gradient background (`#3D8BFF` → `#1452D6`) filling the full
  1024×1024 square. watchOS masks the icon to a circle automatically.
- White rounded speech bubble with a downward tail, centered.
- Three caption lines inside, vertically centered, descending in width and
  shade: dark blue `#1452D6`, mid blue `#3D8BFF`, light blue `#9DBEFF`.

## Production

1. `watch/WatchCaptions/Icon/AppIcon.svg` — editable vector source, so the icon
   is regenerable later.
2. Render to `icon-1024.png` with `cairosvg` (1024×1024).
3. `watch/WatchCaptions/Assets.xcassets/AppIcon.appiconset/` holds the PNG plus a
   single-size watchOS `Contents.json`.
4. Wire into `project.yml`: add `Assets.xcassets` to the target sources and set
   `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`.
5. Regenerate with `xcodegen` and build to confirm the icon compiles in.

## Out of scope

- Alternate icon sets / dark or tinted variants.
- App Store marketing artwork beyond the 1024 master.
