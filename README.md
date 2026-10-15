# Cutroom

A free, Premiere-style non-linear video editor that runs entirely in the browser. No build step,
no dependencies, no uploads.

**Run it:** double-click `start.cmd` (Windows, needs [Node.js](https://nodejs.org)), or serve the folder
with any static server and open it in Chrome or Edge:

```
node test/serve.mjs 8080        # then open http://localhost:8080/
# or: python -m http.server 8080 / npx serve .
```

Opening `index.html` straight from disk does not work: browsers refuse to load ES modules from `file://`.

Add `?demo` to the URL to open a sample sequence (color mattes, an animated title, a wipe).

Tests (Node 20+; the browser test needs Chrome or Edge installed):

```
node --test "test/*.test.mjs"   # model (editing ops, keyframes, transitions) and MP4 muxer byte-level tests
node test/run-smoke.mjs         # drives the real app in headless Chrome: import, timeline edits, rendering, undo, MP4 export + decode-back
```

Best in Chrome or Edge (WebCodecs is needed for MP4 export; other browsers fall back to WebM).

## Features

### Project panel
- Import video, audio and image files (button, drag and drop anywhere, or drop straight onto the timeline)
- Thumbnails, durations, dimensions, search; audio waveforms are analysed in the background
- Double-click a media item to open it in the Source monitor; drag items onto the timeline
- Title and Color Matte generators

### Source and Program monitors
- Source monitor: play, step, mark In/Out, then **Insert** (`,`) or **Overwrite** (`.`) at the playhead
- Program monitor: JKL shuttle, frame stepping, loop, In/Out range playback, master level meter, safe margins, zoom
- Direct manipulation: drag the selected clip in the monitor to move it, corner handles scale, the top handle rotates
  (writes keyframes automatically when the property is animated)

### Timeline
- Unlimited video and audio tracks; track output, mute, solo, lock and per-track volume
- Selection, Razor and Hand tools; marquee selection; linked A/V selection (toggleable)
- Move (overwrite, or hold **Ctrl** to insert), trim either edge (hold **Ctrl** for a ripple trim), split (**Ctrl+K**)
- Delete, ripple delete, close gap, copy / cut / paste at playhead, duplicate
- Snapping to clip edges, markers, In/Out and playhead; zoom with the slider, `+`/`-`, `\` (fit) or Ctrl+wheel
- Markers, In/Out points, timecode entry, keyboard navigation between edit points
- Clip speed / duration (with the linked audio following), enable/disable, rename, link/unlink

### Effect Controls
- **Motion**: position, scale, rotation; **Opacity**; audio **Volume** — all keyframeable with linear, ease or hold interpolation
- Keyframe navigation (previous / add-remove / next) directly from each property
- Video effects: Brightness & Contrast, Saturation, Hue Shift, Gaussian Blur, Black & White, Sepia, Invert, Crop, Flip,
  Chroma Key, Vignette, Drop Shadow, Tint, Pixelate (stackable, toggleable, drag from the Effects panel or add from the list)
- Transitions on either edge of a clip: Cross Dissolve, Dip to Black, Dip to White, Wipe (4 directions), Push, Iris, Zoom.
  Between butted clips the transition is centred on the cut, using source handles like Premiere; a transition on a lone edge fades from/to black.
- Titles: multi-line text, font, size, color, bold/italic, alignment, line height, background box, outline, shadow
- Audio: volume keyframes, fade in/out, clip mute

### Export
- **MP4 (H.264 + AAC)** rendered frame-by-frame with WebCodecs and an in-house ISO BMFF muxer (`js/mp4mux.js`),
  usually faster than realtime; Opus is used when the browser cannot encode AAC
- **WebM** (VP9/VP8 + Opus) realtime recording fallback via MediaRecorder
- Resolution, frame rate, bitrate, range (entire sequence or In–Out), audio on/off
- Export the current frame as PNG

### Projects
- Save / open `.cutroom` project files (JSON). Media is referenced by name; on open you are asked to relink the files
- Autosave to local storage with a *Recover Autosave* command
- Undo / redo (100 steps) for every edit

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Space / K | Play-pause / stop |
| J / L | Shuttle backward / forward (press again for 2×, 4×, 8×) |
| ← / → (Shift) | Step 1 frame (5 frames) |
| ↑ / ↓ | Previous / next edit point |
| Home / End | Start / end of sequence |
| I / O, Shift+I / Shift+O | Mark In / Out, go to In / Out |
| V / C / H | Selection / Razor / Hand tool |
| S | Toggle snapping |
| Ctrl+K | Split at playhead |
| Q / W | Ripple trim clip start / end to playhead |
| Delete / Shift+Delete | Delete / ripple delete |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+C / X / V, Ctrl+Shift+D | Copy / cut / paste at playhead, duplicate |
| Ctrl+D | Apply Cross Dissolve to selected clips |
| Ctrl+L, Shift+E, Ctrl+R | Link/unlink, enable/disable, speed/duration |
| Ctrl+T, M | Add title, add marker |
| , / . | Insert / overwrite from the Source monitor |
| Ctrl+I / O / S / N / M | Import / open / save / new project / export |

## Layout

```
index.html        app shell
css/style.css     dark Premiere-like theme
js/model.js       pure sequence model: tracks, clips, trims, splits, ripple, keyframes, transitions, snapping, history
js/render.js      compositor: transforms, effects, titles, color mattes, transitions
js/media.js       media probing + Player (owns <video>/<audio>/<img>, seeks for stills, drives playback)
js/audio.js       Web Audio playback graph, offline mix rendering for export, waveform peaks
js/mp4mux.js      ISO BMFF muxer (avc1 + mp4a/Opus) for WebCodecs output
js/export.js      MP4 (WebCodecs) and WebM (MediaRecorder) exporters
js/timeline.js    timeline panel and interactions
js/controls.js    Effect Controls panel
js/dialogs.js     modals and context menus
js/app.js         menus, shortcuts, monitors, bins, project files, export dialog
```

## Limitations
- Playback uses the browser's media elements, so scrubbing accuracy and cut latency depend on the codec and file; export is frame-accurate.
- Ripple operations affect the track being edited (not every track) and clip speed cannot be negative (no reverse playback).
- Project files store references to media by file name; keep the media files alongside and relink when opening.
