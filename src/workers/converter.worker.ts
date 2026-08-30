/// <reference lib="webworker" />

import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
  UrlSource,
  VideoSampleSink,
  type AudioSample,
} from 'mediabunny';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

import {
  type FitMode,
  type StartConversionMessage,
  type WorkerRequest,
  type WorkerResponse,
} from '../lib/messages';
import {
  IPVF,
  audioBoundary,
  buildHeader,
  buildRecord,
  chooseVideoRecord,
  recordSectors,
  rgbaToRgb565be,
  validateIpvf,
  type SyncRandomAccessFile,
  type VideoRecord,
} from '../lib/ipvf';

type SyncCapableFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncRandomAccessFile>;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelledJobs = new Set<string>();
let activeInput: Input | null = null;
let activeFfmpeg: FFmpeg | null = null;

function respond(message: WorkerResponse) {
  scope.postMessage(message);
}

function progress(
  jobId: string,
  stage: Extract<WorkerResponse, { type: 'progress' }>['stage'],
  value: number,
  detail: string,
  extra: Partial<Extract<WorkerResponse, { type: 'progress' }>> = {},
) {
  respond({
    type: 'progress',
    jobId,
    stage,
    progress: Math.max(0, Math.min(1, value)),
    detail,
    ...extra,
  });
}

function assertActive(jobId: string) {
  if (cancelledJobs.has(jobId))
    throw new DOMException('Conversion cancelled.', 'AbortError');
}

function safeStorageName(jobId: string, suffix: string) {
  return `ipvf-${jobId.replace(/[^a-zA-Z0-9_-]/g, '')}-${suffix}`;
}

async function yieldToMessages(jobId: string) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertActive(jobId);
}

function floatToInt16(value: number) {
  const finite = Number.isFinite(value) ? value : 0;
  const scaled = finite < 0 ? finite * 32768 : finite * 32767;
  return Math.max(-32768, Math.min(32767, Math.round(scaled)));
}

function copyPlane(sample: AudioSample, channel: number) {
  const frames = sample.numberOfFrames;
  const plane = new Float32Array(frames);
  sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
  return plane;
}

function resampleToStereoS16(sample: AudioSample) {
  const sourceFrames = sample.numberOfFrames;
  if (!sourceFrames) return new Uint8Array(0);
  const left = copyPlane(sample, 0);
  const right = sample.numberOfChannels > 1 ? copyPlane(sample, 1) : left;
  const targetFrames = Math.max(
    1,
    Math.round((sourceFrames * IPVF.audioSampleRate) / sample.sampleRate),
  );
  const output = new Uint8Array(targetFrames * IPVF.audioFrameBytes);
  const view = new DataView(output.buffer);

  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = (frame * sample.sampleRate) / IPVF.audioSampleRate;
    const first = Math.min(sourceFrames - 1, Math.floor(sourcePosition));
    const second = Math.min(sourceFrames - 1, first + 1);
    const mix = sourcePosition - first;
    const l = left[first] + (left[second] - left[first]) * mix;
    const r = right[first] + (right[second] - right[first]) * mix;
    view.setInt16(frame * 4, floatToInt16(l), true);
    view.setInt16(frame * 4 + 2, floatToInt16(r), true);
  }
  return output;
}

async function sourceBlob(message: StartConversionMessage) {
  if (message.source.kind === 'file') return message.source.file;
  const response = await fetch(message.source.url, { mode: 'cors' });
  if (!response.ok)
    throw new Error(`The direct media URL returned HTTP ${response.status}.`);
  return response.blob();
}

async function normalizeWithFfmpeg(
  jobId: string,
  blob: Blob,
  assetBase: string,
) {
  progress(
    jobId,
    'inspect',
    0.35,
    'Loading the software compatibility decoder',
  );
  const ffmpeg = new FFmpeg();
  activeFfmpeg = ffmpeg;
  ffmpeg.on('progress', ({ progress: value }) => {
    progress(
      jobId,
      'inspect',
      0.35 + Math.max(0, Math.min(1, value)) * 0.45,
      'Transcoding an unsupported source for browser decoding',
    );
  });

  const coreURL = new URL('ffmpeg-core.js', assetBase).href;
  const wasmURL = new URL('ffmpeg-core.wasm', assetBase).href;
  await ffmpeg.load({ coreURL, wasmURL });
  assertActive(jobId);
  await ffmpeg.createDir('/input');
  await ffmpeg.mount(
    FFFSType.WORKERFS,
    { blobs: [{ name: 'source.media', data: blob }] },
    '/input',
  );
  const exitCode = await ffmpeg.exec([
    '-i',
    '/input/source.media',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    'normalized.mp4',
  ]);
  assertActive(jobId);
  if (exitCode !== 0)
    throw new Error(
      `The software compatibility decoder exited with status ${exitCode}.`,
    );
  const data = await ffmpeg.readFile('normalized.mp4');
  if (typeof data === 'string')
    throw new Error('The compatibility decoder returned invalid media data.');
  const normalized = new Blob([new Uint8Array(data)], { type: 'video/mp4' });
  ffmpeg.terminate();
  activeFfmpeg = null;
  progress(
    jobId,
    'inspect',
    0.82,
    'Compatibility transcode complete; inspecting normalized tracks',
  );
  return normalized;
}

async function decodeAudio(
  jobId: string,
  sink: AudioSampleSink,
  audioFile: SyncRandomAccessFile,
  videoStart: number,
  videoEnd: number,
  targetAudioFrames: number,
) {
  audioFile.truncate(targetAudioFrames * IPVF.audioFrameBytes);
  let decodedSamples = 0;
  let writtenFrames = 0;

  for await (const sample of sink.samples(undefined, videoEnd)) {
    assertActive(jobId);
    try {
      const sampleEnd = sample.timestamp + sample.duration;
      if (sampleEnd <= videoStart) continue;
      if (sample.timestamp >= videoEnd) break;

      const pcm = resampleToStereoS16(sample);
      let targetStart = Math.round(
        (sample.timestamp - videoStart) * IPVF.audioSampleRate,
      );
      let sourceByteOffset = 0;
      if (targetStart < 0) {
        sourceByteOffset = Math.min(
          pcm.byteLength,
          -targetStart * IPVF.audioFrameBytes,
        );
        targetStart = 0;
      }

      const availableFrames = Math.floor(
        (pcm.byteLength - sourceByteOffset) / IPVF.audioFrameBytes,
      );
      const framesToWrite = Math.max(
        0,
        Math.min(availableFrames, targetAudioFrames - targetStart),
      );
      if (framesToWrite > 0) {
        const bytes = pcm.subarray(
          sourceByteOffset,
          sourceByteOffset + framesToWrite * IPVF.audioFrameBytes,
        );
        audioFile.write(bytes, { at: targetStart * IPVF.audioFrameBytes });
        writtenFrames += framesToWrite;
      }
      decodedSamples += 1;

      if ((decodedSamples & 31) === 0) {
        const ratio = Math.max(
          0,
          Math.min(1, (sampleEnd - videoStart) / (videoEnd - videoStart)),
        );
        progress(
          jobId,
          'audio',
          ratio,
          'Decoding and resampling the first audio track',
        );
        await yieldToMessages(jobId);
      }
    } finally {
      sample.close();
    }
  }

  audioFile.flush();
  progress(
    jobId,
    'audio',
    1,
    writtenFrames < targetAudioFrames
      ? 'Audio prepared; uncovered time will be silent'
      : 'Audio prepared at 44.1 kHz stereo',
  );
}

function timestamps(start: number, frameCount: number, fps: number) {
  return {
    *[Symbol.iterator]() {
      for (let frame = 0; frame < frameCount; frame += 1)
        yield start + frame / fps;
    },
  };
}

async function writeVideoRecords(
  jobId: string,
  sink: VideoSampleSink,
  output: SyncRandomAccessFile,
  audio: SyncRandomAccessFile,
  videoStart: number,
  frameCount: number,
  fps: number,
  fit: FitMode,
) {
  const canvas = new OffscreenCanvas(IPVF.width, IPVF.height);
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context)
    throw new Error(
      'This browser cannot create the required 2D conversion canvas.',
    );
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  output.truncate(0);
  output.write(new Uint8Array(IPVF.dataOffset), { at: 0 });
  let outputPosition = IPVF.dataOffset;
  let previousFrame: Uint8Array | null = null;
  let pending: {
    video: VideoRecord;
    audio: Uint8Array;
    sectors: number;
  } | null = null;
  let firstRecordSectors = 0;
  let frameIndex = 0;

  const samples = sink.samplesAtTimestamps(
    timestamps(videoStart, frameCount, fps),
  );
  for await (const sample of samples) {
    assertActive(jobId);
    if (!sample)
      throw new Error(
        `The video decoder did not return frame ${frameIndex + 1}.`,
      );

    try {
      context.fillStyle = '#000';
      context.fillRect(0, 0, IPVF.width, IPVF.height);
      sample.drawWithFit(context, { fit });
      const rgba = context.getImageData(0, 0, IPVF.width, IPVF.height).data;
      const currentFrame = rgbaToRgb565be(rgba);
      const video = chooseVideoRecord(previousFrame, currentFrame, frameIndex);
      const audioStart = audioBoundary(frameIndex, fps);
      const audioEnd = audioBoundary(frameIndex + 1, fps);
      const audioBytes = new Uint8Array(
        (audioEnd - audioStart) * IPVF.audioFrameBytes,
      );
      const read = audio.read(audioBytes, {
        at: audioStart * IPVF.audioFrameBytes,
      });
      if (read !== audioBytes.byteLength)
        throw new Error(
          `Could not read the PCM slice for frame ${frameIndex + 1}.`,
        );
      const sectors = recordSectors(
        video.payload.byteLength,
        audioBytes.byteLength,
      );

      if (!pending) {
        firstRecordSectors = sectors;
      } else {
        const record = buildRecord(pending.video, pending.audio, sectors);
        output.write(record, { at: outputPosition });
        outputPosition += record.byteLength;
      }
      pending = { video, audio: audioBytes, sectors };
      previousFrame = currentFrame;
      frameIndex += 1;

      if ((frameIndex & 7) === 0 || frameIndex === frameCount) {
        progress(
          jobId,
          'video',
          frameIndex / frameCount,
          'Scaling and packing canonical frame records',
          {
            bytesWritten: outputPosition,
            frame: frameIndex,
            frameCount,
          },
        );
        await yieldToMessages(jobId);
      }
    } finally {
      sample.close();
    }
  }

  if (!pending || frameIndex !== frameCount) {
    throw new Error(
      `Expected ${frameCount} video frames but decoded ${frameIndex}.`,
    );
  }
  const finalRecord = buildRecord(pending.video, pending.audio, 0);
  output.write(finalRecord, { at: outputPosition });
  outputPosition += finalRecord.byteLength;
  output.write(buildHeader(fps, frameCount, firstRecordSectors), { at: 0 });
  output.truncate(outputPosition);
  output.flush();
}

async function convert(message: StartConversionMessage) {
  const { jobId, fps, outputName } = message;
  const root = await navigator.storage.getDirectory();
  const audioName = safeStorageName(jobId, 'audio.pcm');
  const opfsName = safeStorageName(jobId, 'output.ipvf');
  const audioHandle = (await root.getFileHandle(audioName, {
    create: true,
  })) as SyncCapableFileHandle;
  const outputHandle = (await root.getFileHandle(opfsName, {
    create: true,
  })) as SyncCapableFileHandle;
  const audioFile = await audioHandle.createSyncAccessHandle();
  const outputFile = await outputHandle.createSyncAccessHandle();

  const source =
    message.source.kind === 'file'
      ? new BlobSource(message.source.file, { maxCacheSize: 16 * 1024 * 1024 })
      : new UrlSource(message.source.url, {
          maxCacheSize: 32 * 1024 * 1024,
          parallelism: 2,
        });
  let input = new Input({ source, formats: ALL_FORMATS });
  activeInput = input;
  let engine: 'WebCodecs' | 'ffmpeg.wasm → WebCodecs' = 'WebCodecs';
  let sourceVideoCodec = 'unknown';
  let sourceAudioCodec = 'unknown';

  try {
    progress(jobId, 'inspect', 0.1, 'Reading container and track metadata');
    if (!(await input.canRead()))
      throw new Error('The selected source is not a recognized media file.');
    let videoTrack = await input.getPrimaryVideoTrack();
    let audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack)
      throw new Error('The selected source does not contain a video track.');
    if (!audioTrack)
      throw new Error(
        'IPVF requires an audio track, but this source has none.',
      );

    let [videoCanDecode, audioCanDecode, videoCodec, audioCodec] =
      await Promise.all([
        videoTrack.canDecode(),
        audioTrack.canDecode(),
        videoTrack.getCodecParameterString(),
        audioTrack.getCodecParameterString(),
      ]);
    sourceVideoCodec = videoCodec ?? 'unknown';
    sourceAudioCodec = audioCodec ?? 'unknown';
    if (!videoCanDecode || !audioCanDecode) {
      const blob = await sourceBlob(message);
      const normalized = await normalizeWithFfmpeg(
        jobId,
        blob,
        message.assetBase,
      );
      input.dispose();
      input = new Input({
        source: new BlobSource(normalized, { maxCacheSize: 16 * 1024 * 1024 }),
        formats: ALL_FORMATS,
      });
      activeInput = input;
      videoTrack = await input.getPrimaryVideoTrack();
      audioTrack = await input.getPrimaryAudioTrack();
      if (!videoTrack || !audioTrack)
        throw new Error(
          'The compatibility decoder did not preserve both media tracks.',
        );
      [videoCanDecode, audioCanDecode, videoCodec, audioCodec] =
        await Promise.all([
          videoTrack.canDecode(),
          audioTrack.canDecode(),
          videoTrack.getCodecParameterString(),
          audioTrack.getCodecParameterString(),
        ]);
      if (!videoCanDecode || !audioCanDecode) {
        throw new Error(
          'This browser cannot decode the compatibility output. Try a current Chromium browser.',
        );
      }
      engine = 'ffmpeg.wasm → WebCodecs';
    }

    const [videoStart, videoEnd] = await Promise.all([
      videoTrack.getFirstTimestamp(),
      videoTrack.computeDuration(),
    ]);

    const start = Math.max(0, videoStart);
    const duration = videoEnd - start;
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error('The video has no usable duration.');
    const frameCount = Math.max(1, Math.ceil(duration * fps - 1e-9));
    if (audioBoundary(frameCount, fps) > 0xffffffff)
      throw new Error('This video is longer than the IPVF duration limit.');

    progress(
      jobId,
      'inspect',
      1,
      `${duration.toFixed(2)} seconds · ${frameCount.toLocaleString()} output frames`,
    );
    const audioSink = new AudioSampleSink(audioTrack);
    const targetAudioFrames = audioBoundary(frameCount, fps);
    await decodeAudio(
      jobId,
      audioSink,
      audioFile,
      start,
      start + duration,
      targetAudioFrames,
    );
    assertActive(jobId);

    const videoSink = new VideoSampleSink(videoTrack);
    await writeVideoRecords(
      jobId,
      videoSink,
      outputFile,
      audioFile,
      start,
      frameCount,
      fps,
      message.fit,
    );
    assertActive(jobId);

    progress(
      jobId,
      'validate',
      0.15,
      'Checking the complete header and sector chain',
    );
    const report = validateIpvf(outputFile);
    progress(jobId, 'validate', 1, 'Canonical validation passed');
    respond({
      type: 'complete',
      jobId,
      outputName,
      opfsName,
      duration,
      sourceVideoCodec,
      sourceAudioCodec,
      engine,
      report,
    });
  } finally {
    activeFfmpeg?.terminate();
    activeFfmpeg = null;
    input.dispose();
    activeInput = null;
    audioFile.close();
    outputFile.close();
    await root.removeEntry(audioName).catch(() => undefined);
  }
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelledJobs.add(message.jobId);
    activeInput?.dispose();
    activeFfmpeg?.terminate();
    activeFfmpeg = null;
    return;
  }

  cancelledJobs.delete(message.jobId);
  void convert(message).catch((error: unknown) => {
    const cancelled =
      cancelledJobs.has(message.jobId) ||
      (error instanceof DOMException && error.name === 'AbortError');
    if (cancelled) {
      respond({ type: 'cancelled', jobId: message.jobId });
    } else {
      const reason = error instanceof Error ? error : new Error(String(error));
      respond({
        type: 'error',
        jobId: message.jobId,
        message: reason.message,
        detail: reason.stack,
      });
    }
  });
});

export {};
