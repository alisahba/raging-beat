# RAGING BEAT

Audio-reactive image renderer. Drop in photos or videos and a track; Raging Beat
finds the tempo, the beat grid, the bars, the kicks, snares and hats and the
song's sections, and turns your images into beat-locked graphic motion, then
exports a frame-exact video.

Everything runs locally in the browser. No build step, no server, no uploads.

## Using it

- **Media**: up to 12 images or videos (drop them anywhere). Each slot gets
  automatic levels on import, plus its own levels, gamma, cover/contain fit and
  framing (zoom and pan).
- **Audio**: the built-in demo, any audio file, or the microphone (live mode).
  Tempo can be halved/doubled, the bar line nudged, and visuals shifted
  against the sound with the sync offset.
- **Look**: six styles (Pixel, Dither, Halftone, Lines, ASCII, Edge), palettes
  of 2–8 colours with up to 8 tone levels (or the source colours), mirror and
  kaleidoscope modes. Seven ready-made looks and a Shuffle.
- **React**: ten effects (zoom punch, shake, RGB split, glitch, warp, trails,
  flash, scanlines, grain, cell pump), each with an amount and a driver: kick,
  snare, hat, beat, off-beat, bar, 2/4 bars, section, bass/mid/high level,
  loudness, or beat/bar ramps.
- **On the beat**: discrete decisions on any trigger: switch media, jump the
  cell size, swap palette, swap style, invert.
- **Export**: offline render of the whole track: every frame drawn and encoded
  with WebCodecs (H.264/AAC MP4, falling back to VP9/Opus WebM), so the result
  is perfectly in sync with no dropped frames. **Record** captures a live
  performance in real time, including mic input and knob-twiddling.

Shortcuts: `Space` play · `←/→` seek a bar · `1–9` show slot · `R` record ·
`E` export · `F` fullscreen · `S` shuffle · `?` help.

## How it works

```
audio file ─decode─▶ Web Worker: analyzer.js
                       STFT (100 fps) → band onset envelopes (SuperFlux)
                       → tempo (autocorrelation + prior + octave check)
                       → beat grid (dynamic programming) → phase alignment
                       → downbeats → sections → drum hits (energy-classified)
                    ▼
               TrackSignals: sample(t) → pulses, envelopes, beat/bar phase
                    ▼
               Director: deterministic fold over the event stream
                    (media, cell, palette, style, invert decisions)
                    ▼
               compose() → Renderer (WebGL2)
                    source pass  framing, mirror, warp, glitch, levels
                    style pass   pixel/dither/halftone/lines/ascii/edge
                    post pass    RGB split, trails, flash, scanlines, grain
```

**Analysis** (`js/audio/analyzer.js`) runs once per track, off the main thread,
in well under a second for a typical song.

- Onsets come from SuperFlux spectral flux in three drum bands. Each candidate
  hit is classified by how much *linear* energy arrived in each band. Log flux
  is precise for timing but mistakes faint leakage for hits, so it isn't used
  for classification. This is what keeps bass notes from counting as kicks.
- Tempo comes from autocorrelation of the onset envelope with a log-Gaussian
  prior. An octave check then looks for kicks and snares between the beats,
  which catches half-tempo errors in backbeat grooves.
- The beat grid comes from Ellis-style dynamic programming. A pass afterwards
  realigns sparse passages that locked off-beat back onto the main groove,
  such as an intro of hats only.
- Downbeats are scored on a kick/backbeat/harmonic-change template. Sections
  come from bar-level novelty.

Because the analysis covers the whole track and every random choice is hashed
from a seed, the visuals at time *t* are a pure function of *t*. Scrubbing,
looping and exporting all show exactly what the preview showed.

**Live mode** (`LiveSignals`) does the same job in real time from the
microphone. Adaptive thresholds pick up the drum hits, and a beat clock
phase-locks to the kicks, re-estimating the tempo every 1.5 s.

## Development

```sh
npm install            # playwright, for the browser test only
npm run serve          # http://localhost:8000
npm test               # FFT, analyzer accuracy, MP4 muxer (needs ffmpeg)
npm run test:browser   # end-to-end in headless Chromium (needs ffmpeg)
```

The analyzer test synthesises drum tracks from 70 to 174 BPM with known ground
truth and checks tempo, beats, downbeats, per-drum precision/recall and timing.
The browser test plays the built-in demo through the real app and scores it
against the demo's score, renders every style, checks determinism, and runs an
offline export through ffprobe.

Requires a browser with WebGL2. Offline export needs WebCodecs (Chrome, Edge,
Safari 16.4+, Firefox 130+); elsewhere, use Record.
