export const IPVF = {
  width: 220,
  height: 176,
  frameBytes: 220 * 176 * 2,
  headerSize: 64,
  dataOffset: 512,
  sectorSize: 512,
  maxRecordSectors: 256,
  maxPayload: 220 * 176 * 2 + 4096,
  version: 1,
  flags: 7,
  audioFormat: 1,
  audioChannels: 2,
  audioBitsPerSample: 16,
  audioSampleRate: 44_100,
  audioFrameBytes: 4,
  keyInterval: 120,
} as const;

export const RECORD_TYPE = {
  key: 0,
  rectangles: 1,
  repeat: 2,
} as const;

export type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE];

export type VideoRecord = {
  kind: RecordType;
  rectangleCount: number;
  payload: Uint8Array;
};

export type ValidationReport = {
  frameCount: number;
  fps: number;
  audioSampleFrames: number;
  fileBytes: number;
  keyframes: number;
  rectangles: number;
  repeats: number;
};

export type SyncRandomAccessFile = {
  getSize(): number;
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};

const EMPTY = new Uint8Array(0);

export function audioBoundary(frame: number, fps: number) {
  return Math.floor((frame * IPVF.audioSampleRate + Math.floor(fps / 2)) / fps);
}

export function recordSectors(videoBytes: number, audioBytes: number) {
  const sectors = Math.ceil((8 + videoBytes + audioBytes) / IPVF.sectorSize);
  if (sectors < 1 || sectors > IPVF.maxRecordSectors) {
    throw new Error(
      `Record requires ${sectors} sectors; IPVF permits 1–${IPVF.maxRecordSectors}.`,
    );
  }
  return sectors;
}

export function rgbaToRgb565be(rgba: Uint8ClampedArray) {
  if (rgba.byteLength !== IPVF.width * IPVF.height * 4) {
    throw new Error('Unexpected canvas frame size.');
  }

  const result = new Uint8Array(IPVF.frameBytes);
  for (
    let source = 0, target = 0;
    source < rgba.length;
    source += 4, target += 2
  ) {
    const value =
      ((rgba[source] >> 3) << 11) |
      ((rgba[source + 1] >> 2) << 5) |
      (rgba[source + 2] >> 3);
    result[target] = value >> 8;
    result[target + 1] = value & 0xff;
  }
  return result;
}

function boundingBox(previous: Uint8Array, current: Uint8Array) {
  let minX: number = IPVF.width;
  let minY: number = IPVF.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < IPVF.height; y += 1) {
    const row = y * IPVF.width * 2;
    for (let x = 0; x < IPVF.width; x += 1) {
      const offset = row + x * 2;
      if (
        previous[offset] !== current[offset] ||
        previous[offset + 1] !== current[offset + 1]
      ) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) return null;
  minX &= ~1;
  maxX = Math.min(IPVF.width - 1, maxX | 1);
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function rectanglePayload(
  frame: Uint8Array,
  rectangle: NonNullable<ReturnType<typeof boundingBox>>,
) {
  const pixelBytes = rectangle.width * rectangle.height * 2;
  const payload = new Uint8Array(8 + pixelBytes);
  const view = new DataView(payload.buffer);
  payload[0] = rectangle.x;
  payload[1] = rectangle.y;
  payload[2] = rectangle.width;
  payload[3] = rectangle.height;
  view.setUint32(4, pixelBytes, true);

  let target = 8;
  for (let row = rectangle.y; row < rectangle.y + rectangle.height; row += 1) {
    const start = (row * IPVF.width + rectangle.x) * 2;
    const end = start + rectangle.width * 2;
    payload.set(frame.subarray(start, end), target);
    target += rectangle.width * 2;
  }
  return payload;
}

export function chooseVideoRecord(
  previous: Uint8Array | null,
  current: Uint8Array,
  frameIndex: number,
  keyInterval = IPVF.keyInterval,
): VideoRecord {
  if (!previous || (keyInterval > 0 && frameIndex % keyInterval === 0)) {
    return { kind: RECORD_TYPE.key, rectangleCount: 0, payload: current };
  }

  const rectangle = boundingBox(previous, current);
  if (!rectangle)
    return { kind: RECORD_TYPE.repeat, rectangleCount: 0, payload: EMPTY };

  const delta = rectanglePayload(current, rectangle);
  if (delta.byteLength < IPVF.frameBytes) {
    return { kind: RECORD_TYPE.rectangles, rectangleCount: 1, payload: delta };
  }
  return { kind: RECORD_TYPE.key, rectangleCount: 0, payload: current };
}

export function buildRecord(
  video: VideoRecord,
  audio: Uint8Array,
  nextSectors: number,
) {
  const sectors = recordSectors(video.payload.byteLength, audio.byteLength);
  const bytes = new Uint8Array(sectors * IPVF.sectorSize);
  const view = new DataView(bytes.buffer);
  bytes[0] = video.kind;
  bytes[1] = video.rectangleCount;
  view.setUint16(2, nextSectors, true);
  view.setUint32(4, video.payload.byteLength, true);
  bytes.set(video.payload, 8);
  bytes.set(audio, 8 + video.payload.byteLength);
  return bytes;
}

export function buildHeader(
  fps: number,
  frameCount: number,
  firstRecordSectors: number,
) {
  const bytes = new Uint8Array(IPVF.dataOffset);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x50, 0x56, 0x46], 0);
  view.setUint16(4, IPVF.version, true);
  view.setUint16(6, IPVF.headerSize, true);
  view.setUint16(8, IPVF.width, true);
  view.setUint16(10, IPVF.height, true);
  view.setUint16(12, fps, true);
  view.setUint16(14, 1, true);
  view.setUint32(16, frameCount, true);
  view.setUint32(20, IPVF.flags, true);
  view.setUint32(24, IPVF.dataOffset, true);
  view.setUint16(28, firstRecordSectors, true);
  view.setUint16(30, IPVF.audioFormat, true);
  view.setUint16(32, IPVF.audioChannels, true);
  view.setUint16(34, IPVF.audioBitsPerSample, true);
  view.setUint32(36, IPVF.audioSampleRate, true);
  const audioFrames = audioBoundary(frameCount, fps);
  if (audioFrames <= 0 || audioFrames > 0xffffffff)
    throw new Error('Audio duration exceeds IPVF limits.');
  view.setUint32(40, audioFrames, true);
  return bytes;
}

function readExactly(
  file: SyncRandomAccessFile,
  offset: number,
  length: number,
) {
  const bytes = new Uint8Array(length);
  const read = file.read(bytes, { at: offset });
  if (read !== length)
    throw new Error(`Unexpected end of file at byte ${offset}.`);
  return bytes;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateRectangles(payload: Uint8Array, count: number) {
  let position = 0;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  for (let index = 0; index < count; index += 1) {
    assert(
      position + 8 <= payload.byteLength,
      'Rectangle header exceeds its payload.',
    );
    const x = payload[position];
    const y = payload[position + 1];
    const width = payload[position + 2];
    const height = payload[position + 3];
    const dataBytes = view.getUint32(position + 4, true);
    position += 8;
    assert(width > 0 && height > 0, 'Rectangle dimensions must be non-zero.');
    assert(
      x + width <= IPVF.width && y + height <= IPVF.height,
      'Rectangle exceeds the display.',
    );
    assert(
      (x & 1) === 0 && (width & 1) === 0,
      'Rectangle is not aligned to two-pixel LCD words.',
    );
    assert(
      dataBytes === width * height * 2,
      'Rectangle byte count does not match its dimensions.',
    );
    assert(position % 4 === 0, 'Rectangle pixels are not 32-bit aligned.');
    assert(
      position + dataBytes <= payload.byteLength,
      'Rectangle pixels exceed their payload.',
    );
    position += dataBytes;
  }
  assert(
    position === payload.byteLength,
    'Rectangle payload contains trailing bytes.',
  );
}

export function validateIpvf(file: SyncRandomAccessFile): ValidationReport {
  const fileBytes = file.getSize();
  assert(fileBytes >= IPVF.dataOffset, 'File is shorter than the IPVF header.');
  const header = readExactly(file, 0, IPVF.dataOffset);
  const view = new DataView(header.buffer);
  assert(
    String.fromCharCode(...header.subarray(0, 4)) === 'IPVF',
    'Missing IPVF magic.',
  );
  assert(view.getUint16(4, true) === IPVF.version, 'Unsupported IPVF version.');
  assert(
    view.getUint16(6, true) === IPVF.headerSize,
    'Invalid logical header size.',
  );
  assert(
    view.getUint16(8, true) === IPVF.width &&
      view.getUint16(10, true) === IPVF.height,
    'Invalid display dimensions.',
  );
  const fpsNumerator = view.getUint16(12, true);
  const fpsDenominator = view.getUint16(14, true);
  const frameCount = view.getUint32(16, true);
  assert(fpsNumerator > 0 && fpsDenominator > 0, 'Invalid frame rate.');
  assert(
    fpsNumerator >= 4 * fpsDenominator && fpsNumerator <= 240 * fpsDenominator,
    'Frame rate is outside IPVF limits.',
  );
  assert(frameCount > 0, 'IPVF contains no frames.');
  assert(view.getUint32(20, true) === IPVF.flags, 'Invalid IPVF flags.');
  assert(
    view.getUint32(24, true) === IPVF.dataOffset,
    'Invalid first record offset.',
  );
  let currentSectors = view.getUint16(28, true);
  assert(
    currentSectors > 0 && currentSectors <= IPVF.maxRecordSectors,
    'Invalid first record size.',
  );
  assert(
    view.getUint16(30, true) === IPVF.audioFormat,
    'Invalid audio format.',
  );
  assert(
    view.getUint16(32, true) === IPVF.audioChannels,
    'Invalid audio channel count.',
  );
  assert(
    view.getUint16(34, true) === IPVF.audioBitsPerSample,
    'Invalid audio bit depth.',
  );
  assert(
    view.getUint32(36, true) === IPVF.audioSampleRate,
    'Invalid audio sample rate.',
  );
  const expectedAudioFrames = Math.floor(
    (frameCount * IPVF.audioSampleRate * fpsDenominator +
      Math.floor(fpsNumerator / 2)) /
      fpsNumerator,
  );
  assert(
    view.getUint32(40, true) === expectedAudioFrames,
    'Header audio duration does not match the video duration.',
  );
  assert(
    header.subarray(44).every((value) => value === 0),
    'Header padding is not zero-filled.',
  );

  let position = IPVF.dataOffset;
  const counts = { keyframes: 0, rectangles: 0, repeats: 0 };
  for (let frame = 0; frame < frameCount; frame += 1) {
    assert(
      currentSectors > 0 && currentSectors <= IPVF.maxRecordSectors,
      `Frame ${frame}: invalid record size.`,
    );
    const recordBytes = currentSectors * IPVF.sectorSize;
    const record = readExactly(file, position, recordBytes);
    const recordView = new DataView(record.buffer);
    const kind = record[0];
    const rectangleCount = record[1];
    const nextSectors = recordView.getUint16(2, true);
    const payloadBytes = recordView.getUint32(4, true);
    const audioFrames =
      Math.floor(
        ((frame + 1) * IPVF.audioSampleRate * fpsDenominator +
          Math.floor(fpsNumerator / 2)) /
          fpsNumerator,
      ) -
      Math.floor(
        (frame * IPVF.audioSampleRate * fpsDenominator +
          Math.floor(fpsNumerator / 2)) /
          fpsNumerator,
      );
    const audioBytes = audioFrames * IPVF.audioFrameBytes;
    assert(
      payloadBytes <= IPVF.maxPayload,
      `Frame ${frame}: video payload is too large.`,
    );
    assert(
      recordSectors(payloadBytes, audioBytes) === currentSectors,
      `Frame ${frame}: sector count does not match its payloads.`,
    );
    assert(
      frame !== 0 || kind === RECORD_TYPE.key,
      'The first frame is not a keyframe.',
    );
    assert(
      frame + 1 < frameCount
        ? nextSectors > 0 && nextSectors <= IPVF.maxRecordSectors
        : nextSectors === 0,
      `Frame ${frame}: invalid next-record link.`,
    );

    const payload = record.subarray(8, 8 + payloadBytes);
    if (kind === RECORD_TYPE.key) {
      assert(
        rectangleCount === 0 && payloadBytes === IPVF.frameBytes,
        `Frame ${frame}: malformed keyframe.`,
      );
      counts.keyframes += 1;
    } else if (kind === RECORD_TYPE.repeat) {
      assert(
        rectangleCount === 0 && payloadBytes === 0,
        `Frame ${frame}: malformed repeat record.`,
      );
      counts.repeats += 1;
    } else {
      assert(
        kind === RECORD_TYPE.rectangles && rectangleCount > 0,
        `Frame ${frame}: unknown record type.`,
      );
      validateRectangles(payload, rectangleCount);
      counts.rectangles += 1;
    }

    const usedBytes = 8 + payloadBytes + audioBytes;
    assert(
      record.subarray(usedBytes).every((value) => value === 0),
      `Frame ${frame}: record padding is not zero-filled.`,
    );
    position += recordBytes;
    currentSectors = nextSectors;
  }
  assert(
    position === fileBytes,
    'Record chain does not end at the end of the file.',
  );

  return {
    frameCount,
    fps: fpsNumerator / fpsDenominator,
    audioSampleFrames: expectedAudioFrames,
    fileBytes,
    ...counts,
  };
}
