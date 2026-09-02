# IPVF Converter

A fully client-side video converter for the native IPVF player in Rockbox on the iPod Photo/Color.

**Live app:** [jspann21.github.io/ipod-ipvf-converter](https://jspann21.github.io/ipod-ipvf-converter/)

The app accepts a local media file by file picker or drag and drop, or a direct CORS-enabled media URL. It converts entirely inside the browser, validates the complete result against the Rockbox player contract, and downloads a local `.ipvf` file. Media is never uploaded to a server.

## What it produces

- Everyday, native, and compact creator profiles, plus expert overrides
- Exact source cadence up to 30 fps by default, compact 20 fps, and integer or common fractional frame-rate overrides through 60 fps
- 220×176 RGB565 big-endian video with selectable RGB565, RGB555, RGB454, or RGB444 source precision and letterbox, crop, or stretch framing
- A seekable single-frame 220×176 preview with letterbox, crop-to-fill, and stretch-to-fill framing
- Lossless raw/LZ4 keyframes, aligned single- or multi-rectangle deltas, translated motion residuals, temporal XOR records, and repeats
- A configurable time-based indexed keyframe interval (five seconds by default)
- 44.1 kHz adaptive IMA ADPCM that stores exact silence as zero bytes, exact dual mono as one channel, and other material as stereo
- Exact per-frame audio boundaries for rational frame rates
- 512-byte sector-aligned records with a maximum record size of 96 KiB
- A canonical 80-byte header, metadata TLVs, complete next-record sector chain, keyframe index, media identity CRC, and index CRC

Every generated file is validated before download. Validation checks the header, metadata, fixed padding, frame count, rational cadence, audio duration and adaptive mode, record sizes, chain links, first/final record rules, raw and LZ4 payloads, reconstructed spatial and temporal frames, sector padding, media identity, and the complete keyframe index.

## Browser architecture

The UI and conversion pipeline are static files suitable for GitHub Pages.

1. [Mediabunny](https://mediabunny.dev/) demuxes the local file or direct URL with bounded read caches.
2. WebCodecs decodes video and audio in a dedicated worker when the browser supports the source codecs.
3. If the container is readable but its codecs are not, the single-threaded [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) compatibility path normalizes it to H.264/AAC, then returns to the same canonical IPVF path.
4. A browser video canvas shows a seekable still preview at the exact 220×176 output ratio. The selected letterbox (`contain`), crop-to-fill (`cover`), or stretch-to-fill (`fill`) mode is passed to the worker.
5. An `OffscreenCanvas` applies that framing and the chosen host color cleanup to every requested output frame. Pixels are packed as RGB565BE.
6. Decoded audio is resampled and written into an OPFS temporary file at its media timestamps. Sources without audio and uncovered time become silence; excess audio is trimmed to the video duration. Each record selects silence, mono, or stereo anchored IMA ADPCM.
7. IPVF records are incrementally written to OPFS. The encoder evaluates raw/LZ4 keys, repeats, bounded spatial rectangles, translated motion residuals, and optional full-frame XOR candidates using final sector cost. The browser uses the deterministic built-in LZ4 implementation; host-library LZ4 modes from the Python CLI are not applicable in a static browser build.
8. The validator re-reads the finished file from OPFS. Download uses a file-backed `Blob`; “Save as” streams directly to a user-selected destination when the File System Access API is available.

The software fallback is intentionally single-threaded. GitHub Pages cannot set the cross-origin isolation headers required by the multithreaded ffmpeg.wasm core. The WebCodecs path remains the preferred path because it is faster and avoids an intermediate compatibility transcode.

## Browser support

A current Chromium browser (Chrome, Edge, or another Chromium build) is recommended. The app checks for OPFS, worker canvas support, readable containers, and per-track decoder support at runtime. Browser and operating-system codec support varies; common H.264/AAC MP4 and VP9/Opus WebM sources normally use the fast path.

The source must contain a video track. Sources without audio are encoded with exact digital-silence records. Direct URLs must point to the media response itself and must allow cross-origin browser requests, including range requests where the container needs them.

## YouTube and other video sites

This project does **not** implement arbitrary YouTube downloading or extraction from video-page URLs.

- GitHub Pages is static and has no server-side media fetcher.
- The official YouTube API does not provide a general audiovisual media-download endpoint.
- YouTube API policies restrict downloading audiovisual content without approval.

Use a local file you are permitted to convert, or a direct media URL whose server explicitly allows browser access.

## Canonical format authority

The browser encoder is a port of the production format contract in:

- [`tools/ipvf/encode.py`](https://github.com/jspann21/rockbox-ipod-photo/blob/35a1bfd8908b24331841f456730c83097f98d568/tools/ipvf/encode.py)
- [`tools/ipvf/README.md`](https://github.com/jspann21/rockbox-ipod-photo/blob/35a1bfd8908b24331841f456730c83097f98d568/tools/ipvf/README.md)
- the target parser in [`apps/plugins/ipodnative.c`](https://github.com/jspann21/rockbox-ipod-photo/blob/35a1bfd8908b24331841f456730c83097f98d568/apps/plugins/ipodnative.c)

Reference Rockbox commit: `35a1bfd8908b24331841f456730c83097f98d568`.

The browser implementation does not define IPVF v2 or a separate web dialect. Structural compatibility is governed by the production encoder and player.

## Local development

Requirements: Node.js 22.13 or later.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run lint
npm run build
```

`npm run dev` and `npm run build` copy the pinned ffmpeg.wasm core from `node_modules` into the generated static site. The 32 MB WebAssembly binary is not committed to Git.

## Deployment

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds and deploys the app on every push to `main`. The GitHub Pages site therefore always follows the latest committed converter on the default branch. A manual `workflow_dispatch` trigger is also available.

## License

The project source is available under the MIT License. Bundled third-party components retain their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
