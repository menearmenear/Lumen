# Changelog

## 1.1.0 — 2026-10-24

### Sound

- Replaced the default synthesized piano with locally bundled Salamander Grand Piano samples.
- Normalized the sample bank and preserved the hammer transient for a louder, more natural response.
- Added a gentle compressor and final limiter for dense chords without clipping.
- Retriggering the same key now damps the previous note instead of layering a doubled voice.
- Merged duplicate MIDI notes that start on the same tick with the same pitch.
- Kept the synthesized fallback for `file://` previews or unavailable samples.

### Training

- Added a Training toggle next to Play.
- Training on keeps the falling notes as a silent guide and disables demo audio, automatic key highlights, and automatic guide-hand movement. Only the player's notes sound and animate the hands.
- Training off restores normal playback.

### Visuals and performance

- Added a cached note-sprite atlas, a pre-rendered base canvas, cached particle sprites, and in-place particle updates.
- Capped canvas DPR at 1.5 with a pixel budget and stretched the canvas to fill the stage.
- Reduced guide-hand updates to about 40 fps and switched to transform-based positioning.
- Removed expensive backdrop blur and large ambient compositing effects.
- Fixed guide fingertips landing below black keys.

### Release

- Bumped the extension to 1.1.0.
- Set Firefox desktop minimum to 140 and Firefox for Android minimum to 142 so the required `data_collection_permissions` declaration is understood.
- Added a 512 px icon, MIT license, sample attribution, changelog, and updated documentation.

## 1.0.0

- Initial full-tab falling-notes piano with themes, guide hands, built-in songs, local MIDI import, and a playable keyboard.
