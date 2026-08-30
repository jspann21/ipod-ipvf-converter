# IPVF Converter

A fully client-side video converter for the native IPVF player in Rockbox on the iPod Photo/Color.

**Live app:** [jspann21.github.io/ipod-ipvf-converter](https://jspann21.github.io/ipod-ipvf-converter/)

The app accepts a local media file by file picker or drag and drop, or a direct CORS-enabled media URL. It converts entirely inside the browser, validates the complete result against the Rockbox player contract, and downloads a local `.ipvf` file. Media is never uploaded to a server.

## What it produces

- 220×176 RGB565 big-endian video with selectable letterbox, crop, or stretch framing
- 30 or 60 fps output
- A seekable single-frame 220×176 preview with letterbox, crop-to-fill, and stretch-to-fill framing
- Lossless full keyframes, aligned bounding-rectangle deltas, and repeat records
- A forced keyframe every 120 frames
- 44.1 kHz stereo signed 16-bit little-endian PCM
- Exact per-frame PCM boundaries using `round(frame × 44100 / fps)`
- 512-byte sector-aligned records with a maximum record size of 128 KiB
- A canonical header and complete next-record sector chain

Every generated file is validated before download. Validation checks the header, fixed padding, frame count, audio duration, record sizes, chain links, first/final record rules, key/repeat payloads, rectangle bounds and two-pixel alignment, PCM placement, sector padding, and exact end of file.

## Browser architecture

The UI and conversion pipeline are static files suitable for GitHub Pages.

1. [Mediabunny](https://mediabunny.dev/) demuxes the local file or direct URL with bounded read caches.
2. WebCodecs decodes video and audio in a dedicated worker when the browser supports the source codecs.
3. If the container is readable but its codecs are not, the single-threaded [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) compatibility path normalizes it to H.264/AAC, then returns to the same canonical IPVF path.
4. A browser video canvas shows a seekable still preview at the exact 220×176 output ratio. The selected letterbox (`contain`), crop-to-fill (`cover`), or stretch-to-fill (`fill`) mode is passed to the worker.
5. An `OffscreenCanvas` applies that framing to every requested output frame. Pixels are packed as RGB565BE.
6. Decoded audio is resampled and written into an OPFS temporary file at its media timestamps. Missing audio becomes silence; excess audio is trimmed to the video duration.
7. IPVF records are incrementally written to OPFS. Only the previous frame and at most two records are retained in working memory.
8. The validator re-reads the finished file from OPFS. Download uses a file-backed `Blob`; “Save as” streams directly to a user-selected destination when the File System Access API is available.

The software fallback is intentionally single-threaded. GitHub Pages cannot set the cross-origin isolation headers required by the multithreaded ffmpeg.wasm core. The WebCodecs path remains the preferred path because it is faster and avoids an intermediate compatibility transcode.

## Browser support

A current Chromium browser (Chrome, Edge, or another Chromium build) is recommended. The app checks for OPFS, worker canvas support, readable containers, and per-track decoder support at runtime. Browser and operating-system codec support varies; common H.264/AAC MP4 and VP9/Opus WebM sources normally use the fast path.

The source must contain both a video track and an audio track. IPVF requires audio. Direct URLs must point to the media response itself and must allow cross-origin browser requests, including range requests where the container needs them.

## YouTube and other video sites

This project does **not** implement arbitrary YouTube downloading or extraction from video-page URLs.

- GitHub Pages is static and has no server-side media fetcher.
- The official YouTube API does not provide a general audiovisual media-download endpoint.
- YouTube API policies restrict downloading audiovisual content without approval.

Use a local file you are permitted to convert, or a direct media URL whose server explicitly allows browser access.

## Canonical format authority

The browser encoder is a port of the production format contract in:

- [`tools/ipvf/encode.py`](https://github.com/jspann21/rockbox-ipod-photo/blob/1ba0c01837085d475fb8e8e41416dbfb1cb9a5aa/tools/ipvf/encode.py)
- [`tools/ipvf/README.md`](https://github.com/jspann21/rockbox-ipod-photo/blob/1ba0c01837085d475fb8e8e41416dbfb1cb9a5aa/tools/ipvf/README.md)
- the target parser in [`apps/plugins/ipodnative.c`](https://github.com/jspann21/rockbox-ipod-photo/blob/1ba0c01837085d475fb8e8e41416dbfb1cb9a5aa/apps/plugins/ipodnative.c)

Reference Rockbox commit: `1ba0c01837085d475fb8e8e41416dbfb1cb9a5aa`.

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
