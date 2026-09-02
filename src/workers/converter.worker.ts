/// <reference lib="webworker" />

import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
  UrlSource,
  VideoSampleSink,
  type AudioSample,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

import {
  type StartConversionMessage,
  type WorkerRequest,
  type WorkerResponse,
} from '../lib/messages';
import {
  IPVF,
  RECORD_TYPE,
  audioBoundary,
  buildHeader,
  buildIndex,
  buildRecord,
  chooseVideoRecord,
  encodeAdaptiveIma,
  indexFlagsForKind,
  isKeyRecord,
  keyIntervalFrames,
  recordSectors,
  rockboxCrc32,
  rgbaToRgb565be,
  validateIpvf,
  type FrameRate,
  type ImaState,
  type IpvfMetadata,
  type KeyframeIndexEntry,
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

type AudioBlock = {
  timestamp: number;
  duration: number;
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
};

function copyAudioBlock(sample: AudioSample): AudioBlock {
  const left = copyPlane(sample, 0);
  return {
    timestamp: sample.timestamp,
    duration: sample.duration,
    sampleRate: sample.sampleRate,
    left,
    right: sample.numberOfChannels > 1 ? copyPlane(sample, 1) : left,
  };
}

function resampleAudioBlock(
  block: AudioBlock,
  next: AudioBlock | null,
  videoStart: number,
  videoEnd: number,
  targetAudioFrames: number,
  writtenUntil: number,
) {
  const expectedNextTimestamp = block.timestamp + block.duration;
  const nextIsContiguous =
    next !== null &&
    next.left.length > 0 &&
    Math.abs(next.timestamp - expectedNextTimestamp) <=
      1.5 / Math.min(block.sampleRate, next.sampleRate);
  const blockEnd = Math.min(
    videoEnd,
    nextIsContiguous ? next.timestamp : expectedNextTimestamp,
  );
  const targetStart = Math.max(
    writtenUntil,
    0,
    Math.round((block.timestamp - videoStart) * IPVF.audioSampleRate),
  );
  const targetEnd = Math.min(
    targetAudioFrames,
    Math.round((blockEnd - videoStart) * IPVF.audioSampleRate),
  );
  if (!block.left.length || targetEnd <= targetStart)
    return { bytes: new Uint8Array(), targetStart, targetEnd };

  const output = new Uint8Array(
    (targetEnd - targetStart) * IPVF.audioFrameBytes,
  );
  const view = new DataView(output.buffer);

  for (let target = targetStart; target < targetEnd; target += 1) {
    const outputTime = videoStart + target / IPVF.audioSampleRate;
    const sourcePosition = Math.max(
      0,
      (outputTime - block.timestamp) * block.sampleRate,
    );
    const first = Math.min(block.left.length - 1, Math.floor(sourcePosition));
    const mix = Math.max(0, Math.min(1, sourcePosition - first));
    let nextLeft = block.left[Math.min(first + 1, block.left.length - 1)];
    let nextRight = block.right[Math.min(first + 1, block.right.length - 1)];
    if (first + 1 >= block.left.length && nextIsContiguous) {
      nextLeft = next.left[0];
      nextRight = next.right[0];
    }
    const left = block.left[first] + (nextLeft - block.left[first]) * mix;
    const right = block.right[first] + (nextRight - block.right[first]) * mix;
    const outputOffset = (target - targetStart) * IPVF.audioFrameBytes;
    view.setInt16(outputOffset, floatToInt16(left), true);
    view.setInt16(outputOffset + 2, floatToInt16(right), true);
  }
  return { bytes: output, targetStart, targetEnd };
}

async function sourceBlob(message: StartConversionMessage) {
  if (message.source.kind === 'file') return message.source.file;
  const response = await fetch(message.source.url, { mode: 'cors' });
  if (!response.ok)
    throw new Error(`The direct media URL returned HTTP ${response.status}.`);
  return response.blob();
}

async function confirmsVideoDecode(track: InputVideoTrack) {
  try {
    const timestamp = await track.getFirstTimestamp();
    const sink = new VideoSampleSink(track);
    for await (const sample of sink.samplesAtTimestamps([timestamp])) {
      if (!sample) return false;
      sample.close();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function confirmsAudioDecode(track: InputAudioTrack) {
  try {
    const timestamp = await track.getFirstTimestamp();
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(timestamp, timestamp + 1)) {
      sample.close();
      return true;
    }
  } catch {
    return false;
  }
  return false;
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
    '0:a:0?',
    '-vf',
    'scale=220:176:force_original_aspect_ratio=decrease:force_divisible_by=2',
    '-c:v',
    'libvpx',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-crf',
    '10',
    '-b:v',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-fps_mode:v',
    'vfr',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    'normalized.webm',
  ]);
  assertActive(jobId);
  if (exitCode !== 0)
    throw new Error(
      `The software compatibility decoder exited with status ${exitCode}.`,
    );
  const data = await ffmpeg.readFile('normalized.webm');
  if (typeof data === 'string')
    throw new Error('The compatibility decoder returned invalid media data.');
  const normalized = new Blob([new Uint8Array(data)], { type: 'video/webm' });
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
  let writtenUntil = 0;
  let pending: AudioBlock | null = null;

  const writeBlock = (block: AudioBlock, next: AudioBlock | null) => {
    const resampled = resampleAudioBlock(
      block,
      next,
      videoStart,
      videoEnd,
      targetAudioFrames,
      writtenUntil,
    );
    if (resampled.bytes.byteLength) {
      audioFile.write(resampled.bytes, {
        at: resampled.targetStart * IPVF.audioFrameBytes,
      });
      writtenFrames += resampled.bytes.byteLength / IPVF.audioFrameBytes;
    }
    writtenUntil = Math.max(writtenUntil, resampled.targetEnd);
  };

  for await (const sample of sink.samples(undefined, videoEnd)) {
    assertActive(jobId);
    try {
      const sampleEnd = sample.timestamp + sample.duration;
      if (sampleEnd <= videoStart) continue;
      if (sample.timestamp >= videoEnd) break;
      const current = copyAudioBlock(sample);
      if (pending) writeBlock(pending, current);
      pending = current;
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

  if (pending) writeBlock(pending, null);

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

function timestamps(start: number, frameCount: number, frameRate: FrameRate) {
  return {
    *[Symbol.iterator]() {
      for (let frame = 0; frame < frameCount; frame += 1)
        yield start + (frame * frameRate.denominator) / frameRate.numerator;
    },
  };
}

function greatestCommonDivisor(left: number, right: number) {
  while (right) [left, right] = [right, left % right];
  return left;
}

function approximateFrameRate(value: number): FrameRate {
  if (!Number.isFinite(value) || value <= 0)
    return { numerator: 30, denominator: 1 };
  const commonRates: FrameRate[] = [
    { numerator: 24_000, denominator: 1_001 },
    { numerator: 24, denominator: 1 },
    { numerator: 25, denominator: 1 },
    { numerator: 30_000, denominator: 1_001 },
    { numerator: 30, denominator: 1 },
    { numerator: 50, denominator: 1 },
    { numerator: 60_000, denominator: 1_001 },
    { numerator: 60, denominator: 1 },
  ];
  const common = commonRates.find(
    (rate) => Math.abs(value - rate.numerator / rate.denominator) < 0.001,
  );
  if (common) return common;
  let numerator = Math.round(value);
  let denominator = 1;
  let bestError = Math.abs(value - numerator);
  const maximumDenominator = Math.min(0xffff, Math.floor(0xffff / value));
  for (
    let candidateDenominator = 2;
    candidateDenominator <= maximumDenominator;
    candidateDenominator += 1
  ) {
    const candidateNumerator = Math.round(value * candidateDenominator);
    const error = Math.abs(value - candidateNumerator / candidateDenominator);
    if (error < bestError) {
      numerator = candidateNumerator;
      denominator = candidateDenominator;
      bestError = error;
      if (error === 0) break;
    }
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numerator, denominator };
}

function resolveFrameRate(
  message: StartConversionMessage,
  sourceRate: number,
): FrameRate {
  if (message.frameRate !== 'profile') return message.frameRate;
  if (message.profile === 'compact') return { numerator: 20, denominator: 1 };
  return approximateFrameRate(Math.max(4, Math.min(30, sourceRate)));
}

function sourceMetadata(
  tags: { title?: string; artist?: string; album?: string },
  overrides: IpvfMetadata,
) {
  const metadata: IpvfMetadata = {};
  for (const name of ['title', 'artist', 'album'] as const) {
    const value = overrides[name]?.trim() || tags[name]?.trim();
    if (value) metadata[name] = value;
  }
  return metadata;
}

async function writeVideoRecords(
  jobId: string,
  sink: VideoSampleSink,
  output: SyncRandomAccessFile,
  audio: SyncRandomAccessFile,
  videoStart: number,
  frameCount: number,
  frameRate: FrameRate,
  message: StartConversionMessage,
  metadata: IpvfMetadata,
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
    frame: number;
  } | null = null;
  let firstRecordSectors = 0;
  let frameIndex = 0;
  let imaState: ImaState = { leftIndex: 0, rightIndex: 0 };
  let mediaId = 0xffffffff;
  let temporalRecords = false;
  const indexEntries: KeyframeIndexEntry[] = [];
  const keyInterval = keyIntervalFrames(frameRate, message.keySeconds);
  const rateValue = frameRate.numerator / frameRate.denominator;
  const videoMode =
    message.videoMode === 'default'
      ? rateValue <= 30
        ? 'motion'
        : 'spatial'
      : message.videoMode;
  if ((videoMode === 'motion' || videoMode === 'auto') && rateValue > 30)
    throw new Error(
      'Motion and auto video modes are qualified only at 30 fps or lower.',
    );
  if (
    !Number.isInteger(message.maxRectangles) ||
    message.maxRectangles < 1 ||
    message.maxRectangles > 255
  )
    throw new Error('Maximum rectangles must be between 1 and 255.');

  const sourceSamples = sink.samples()[Symbol.asyncIterator]();
  let currentSample: VideoSample | null = null;
  let nextSample = await sourceSamples.next();
  try {
    for (const targetTimestamp of timestamps(
      videoStart,
      frameCount,
      frameRate,
    )) {
      assertActive(jobId);
      while (
        !nextSample.done &&
        nextSample.value.timestamp <= targetTimestamp + 1e-9
      ) {
        currentSample?.close();
        currentSample = nextSample.value;
        nextSample = await sourceSamples.next();
      }
      if (!currentSample && !nextSample.done) {
        currentSample = nextSample.value;
        nextSample = await sourceSamples.next();
      }
      if (!currentSample)
        throw new Error(
          `The video decoder did not return frame ${frameIndex + 1}.`,
        );

      context.fillStyle = '#000';
      context.fillRect(0, 0, IPVF.width, IPVF.height);
      currentSample.drawWithFit(context, { fit: message.fit });
      const rgba = context.getImageData(0, 0, IPVF.width, IPVF.height).data;
      const currentFrame = rgbaToRgb565be(rgba, message.colorDepth);
      const audioStart = audioBoundary(frameIndex, frameRate);
      const audioEnd = audioBoundary(frameIndex + 1, frameRate);
      const pcmBytes = new Uint8Array(
        (audioEnd - audioStart) * IPVF.audioFrameBytes,
      );
      const read = audio.read(pcmBytes, {
        at: audioStart * IPVF.audioFrameBytes,
      });
      if (read !== pcmBytes.byteLength)
        throw new Error(
          `Could not read the PCM slice for frame ${frameIndex + 1}.`,
        );
      const encodedAudio = encodeAdaptiveIma(
        pcmBytes,
        audioEnd - audioStart,
        imaState,
      );
      imaState = encodedAudio.state;
      const audioBytes = encodedAudio.payload;
      const video = chooseVideoRecord(
        previousFrame,
        currentFrame,
        frameIndex,
        audioBytes.byteLength,
        {
          keyInterval,
          videoMode,
          maxRectangles: message.maxRectangles,
        },
      );
      const sectors = recordSectors(
        video.payload.byteLength,
        audioBytes.byteLength,
      );

      if (!pending) {
        firstRecordSectors = sectors;
      } else {
        const record = buildRecord(pending.video, pending.audio, sectors);
        if (isKeyRecord(pending.video.kind)) {
          indexEntries.push({
            frame: pending.frame,
            offset: outputPosition,
            sectors: pending.sectors,
            flags: indexFlagsForKind(pending.video.kind),
          });
        }
        if (
          pending.video.kind === RECORD_TYPE.temporalXorLz4 ||
          pending.video.kind === RECORD_TYPE.motionLz4
        )
          temporalRecords = true;
        output.write(record, { at: outputPosition });
        mediaId = rockboxCrc32(record, mediaId);
        outputPosition += record.byteLength;
      }
      pending = { video, audio: audioBytes, sectors, frame: frameIndex };
      previousFrame = currentFrame;
      frameIndex += 1;

      if ((frameIndex & 7) === 0 || frameIndex === frameCount) {
        progress(
          jobId,
          'video',
          frameIndex / frameCount,
          'Compressing video and IMA ADPCM frame records',
          {
            bytesWritten: outputPosition,
            frame: frameIndex,
            frameCount,
          },
        );
        await yieldToMessages(jobId);
      }
    }
  } finally {
    currentSample?.close();
    if (!nextSample.done) nextSample.value.close();
    await sourceSamples.return?.();
  }

  if (!pending || frameIndex !== frameCount) {
    throw new Error(
      `Expected ${frameCount} video frames but decoded ${frameIndex}.`,
    );
  }
  const finalRecord = buildRecord(pending.video, pending.audio, 0);
  if (isKeyRecord(pending.video.kind)) {
    indexEntries.push({
      frame: pending.frame,
      offset: outputPosition,
      sectors: pending.sectors,
      flags: indexFlagsForKind(pending.video.kind),
    });
  }
  if (
    pending.video.kind === RECORD_TYPE.temporalXorLz4 ||
    pending.video.kind === RECORD_TYPE.motionLz4
  )
    temporalRecords = true;
  output.write(finalRecord, { at: outputPosition });
  mediaId = rockboxCrc32(finalRecord, mediaId);
  outputPosition += finalRecord.byteLength;
  const mediaEndOffset = outputPosition;
  const index = buildIndex(indexEntries);
  output.write(index, { at: outputPosition });
  outputPosition += index.byteLength;
  if (outputPosition > IPVF.maxFileBytes)
    throw new Error(
      'The converted file exceeds the iPod filesystem size limit.',
    );
  output.write(
    buildHeader({
      frameRate,
      frameCount,
      firstRecordSectors,
      flags: IPVF.flags | (temporalRecords ? IPVF.temporalFlag : 0),
      mediaEndOffset,
      indexCount: indexEntries.length,
      indexCrc: rockboxCrc32(index),
      mediaId,
      metadata,
    }),
    { at: 0 },
  );
  output.truncate(outputPosition);
  output.flush();
}

async function convert(message: StartConversionMessage) {
  const { jobId, outputName } = message;
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

    progress(jobId, 'inspect', 0.2, 'Checking browser decoder support');
    const inputMetadata = await input.getMetadataTags().catch(() => ({}));
    let videoCanDecode = false;
    let audioCanDecode = !audioTrack;
    let videoCodec = await videoTrack.getCodecParameterString();
    let audioCodec = audioTrack
      ? await audioTrack.getCodecParameterString()
      : null;
    sourceVideoCodec = videoCodec ?? 'unknown';
    sourceAudioCodec = audioTrack ? (audioCodec ?? 'unknown') : 'none';
    progress(jobId, 'inspect', 0.28, 'Confirming browser decoder support');
    [videoCanDecode, audioCanDecode] = await Promise.all([
      videoTrack.canDecode(),
      audioTrack ? audioTrack.canDecode() : Promise.resolve(true),
    ]);
    [videoCanDecode, audioCanDecode] = await Promise.all([
      videoCanDecode ? confirmsVideoDecode(videoTrack) : Promise.resolve(false),
      audioTrack && audioCanDecode
        ? confirmsAudioDecode(audioTrack)
        : Promise.resolve(audioCanDecode),
    ]);
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
      if (!videoTrack)
        throw new Error(
          'The compatibility decoder did not preserve the video track.',
        );
      videoCanDecode = await videoTrack.canDecode();
      audioCanDecode = audioTrack ? await audioTrack.canDecode() : true;
      videoCodec = await videoTrack.getCodecParameterString();
      audioCodec = audioTrack
        ? await audioTrack.getCodecParameterString()
        : null;
      if (!videoCanDecode || !audioCanDecode) {
        throw new Error(
          'This browser cannot decode the compatibility output. Try a current Chromium browser.',
        );
      }
      [videoCanDecode, audioCanDecode] = await Promise.all([
        confirmsVideoDecode(videoTrack),
        audioTrack ? confirmsAudioDecode(audioTrack) : Promise.resolve(true),
      ]);
      if (!videoCanDecode || !audioCanDecode)
        throw new Error(
          'The browser could not decode the normalized compatibility output. Try a current Chromium browser.',
        );
      engine = 'ffmpeg.wasm → WebCodecs';
    }

    progress(
      jobId,
      'inspect',
      0.85,
      message.frameRate === 'profile'
        ? 'Analyzing the complete source cadence'
        : 'Reading source timing',
    );
    const packetStats =
      message.frameRate === 'profile'
        ? await videoTrack.computePacketStats().catch(() => {
            throw new Error(
              'Could not analyze the complete source cadence. Choose an explicit frame rate and try again.',
            );
          })
        : null;
    if (
      message.frameRate === 'profile' &&
      (!packetStats ||
        !Number.isFinite(packetStats.averagePacketRate) ||
        packetStats.averagePacketRate <= 0)
    )
      throw new Error(
        'The source cadence is unavailable. Choose an explicit frame rate and try again.',
      );
    const frameRate = resolveFrameRate(
      message,
      packetStats?.averagePacketRate ?? 30,
    );
    const metadata = sourceMetadata(inputMetadata, message.metadata);

    const [videoStart, videoEnd] = await Promise.all([
      videoTrack.getFirstTimestamp(),
      videoTrack.computeDuration(),
    ]);

    const start = Math.max(0, videoStart);
    const duration = videoEnd - start;
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error('The video has no usable duration.');
    const rateValue = frameRate.numerator / frameRate.denominator;
    const frameCount = Math.max(1, Math.ceil(duration * rateValue - 1e-9));
    if (audioBoundary(frameCount, frameRate) > 0xffffffff)
      throw new Error('This video is longer than the IPVF duration limit.');

    progress(
      jobId,
      'inspect',
      1,
      `${duration.toFixed(2)} seconds · ${frameCount.toLocaleString()} frames @ ${frameRate.numerator}/${frameRate.denominator} fps`,
    );
    const targetAudioFrames = audioBoundary(frameCount, frameRate);
    if (audioTrack) {
      const audioSink = new AudioSampleSink(audioTrack);
      await decodeAudio(
        jobId,
        audioSink,
        audioFile,
        start,
        start + duration,
        targetAudioFrames,
      );
    } else {
      audioFile.truncate(targetAudioFrames * IPVF.audioFrameBytes);
      audioFile.flush();
      progress(
        jobId,
        'audio',
        1,
        'No source audio; encoding exact digital silence',
      );
    }
    assertActive(jobId);

    const videoSink = new VideoSampleSink(videoTrack);
    await writeVideoRecords(
      jobId,
      videoSink,
      outputFile,
      audioFile,
      start,
      frameCount,
      frameRate,
      message,
      metadata,
    );
    assertActive(jobId);

    progress(
      jobId,
      'validate',
      0.15,
      'Checking the complete header and sector chain',
    );
    const report = validateIpvf(outputFile);
    progress(jobId, 'validate', 1, 'IPVF structural validation passed');
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
