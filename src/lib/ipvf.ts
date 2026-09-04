export const IPVF = {
  width: 220,
  height: 176,
  frameBytes: 220 * 176 * 2,
  headerSize: 80,
  dataOffset: 512,
  sectorSize: 512,
  recordHeaderSize: 16,
  maxRecordSectors: 192,
  flags: 11,
  temporalFlag: 16,
  audioFormat: 2,
  audioChannels: 2,
  audioBitsPerSample: 16,
  audioSampleRate: 44_100,
  audioFrameBytes: 4,
  defaultKeySeconds: 5,
  maxRectangles: 8,
  indexEntrySize: 16,
  indexKeyLz4Flag: 1,
  metadataOffset: 80,
  maxFileBytes: 0x7fffffff,
} as const;

export const RECORD_TYPE = {
  key: 0,
  rectangles: 1,
  repeat: 2,
  keyLz4: 3,
  rectanglesLz4: 4,
  temporalXorLz4: 5,
  motionLz4: 6,
} as const;

export const MOTION_MIN_SECTOR_SAVING = 10;

export type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE];

export type VideoRecord = {
  kind: RecordType;
  rectangleCount: number;
  payload: Uint8Array;
  decodedBytes: number;
};

export type FrameRate = {
  numerator: number;
  denominator: number;
};

export type ColorDepth = 'rgb565' | 'rgb555' | 'rgb454' | 'rgb444';
export type VideoMode = 'current' | 'spatial' | 'balanced' | 'motion' | 'auto';
export type IpvfMetadata = {
  title?: string;
  artist?: string;
  album?: string;
};

export type ImaState = {
  leftIndex: number;
  rightIndex: number;
};

export type ValidationReport = {
  frameCount: number;
  fps: number;
  audioSampleFrames: number;
  fileBytes: number;
  fpsNumerator: number;
  fpsDenominator: number;
  indexCount: number;
  mediaId: string;
  metadata: IpvfMetadata;
  silentAudioRecords: number;
  monoAudioRecords: number;
  stereoAudioRecords: number;
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

type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const EMPTY = new Uint8Array(0);
const IMA_INDEX_TABLE = [
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
] as const;
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
] as const;

function normalizeFrameRate(rate: FrameRate | number): FrameRate {
  const value =
    typeof rate === 'number' ? { numerator: rate, denominator: 1 } : rate;
  if (
    !Number.isInteger(value.numerator) ||
    !Number.isInteger(value.denominator) ||
    value.numerator <= 0 ||
    value.numerator > 0xffff ||
    value.denominator <= 0 ||
    value.denominator > 0xffff ||
    value.numerator / value.denominator < 4 ||
    value.numerator / value.denominator > 240
  ) {
    throw new Error('Frame rate is outside IPVF rational bounds.');
  }
  return value;
}

export function audioBoundary(frame: number, frameRate: FrameRate | number) {
  const rate = normalizeFrameRate(frameRate);
  const numerator = frame * IPVF.audioSampleRate * rate.denominator;
  return Math.floor(
    (numerator + Math.floor(rate.numerator / 2)) / rate.numerator,
  );
}

export function keyIntervalFrames(
  frameRate: FrameRate,
  seconds: number = IPVF.defaultKeySeconds,
) {
  const rate = normalizeFrameRate(frameRate);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('Keyframe interval must be positive.');
  return Math.max(1, Math.floor((rate.numerator * seconds) / rate.denominator));
}

export function stereoImaPayloadBytes(audioFrames: number) {
  if (audioFrames <= 0)
    throw new Error('IMA ADPCM records require at least one audio frame.');
  return 8 + audioFrames - 1;
}

export function monoImaPayloadBytes(audioFrames: number) {
  if (audioFrames <= 0)
    throw new Error('IMA ADPCM records require at least one audio frame.');
  return 4 + Math.floor(audioFrames / 2);
}

export function recordSectors(videoBytes: number, audioBytes: number) {
  const sectors = Math.ceil(
    (IPVF.recordHeaderSize + videoBytes + audioBytes) / IPVF.sectorSize,
  );
  if (sectors < 1 || sectors > IPVF.maxRecordSectors) {
    throw new Error(
      `Record requires ${sectors} sectors; IPVF permits 1–${IPVF.maxRecordSectors}.`,
    );
  }
  return sectors;
}

export function rgbaToRgb565be(
  rgba: Uint8ClampedArray,
  colorDepth: ColorDepth = 'rgb565',
) {
  if (rgba.byteLength !== IPVF.width * IPVF.height * 4) {
    throw new Error('Unexpected canvas frame size.');
  }

  const result = new Uint8Array(IPVF.frameBytes);
  for (
    let source = 0, target = 0;
    source < rgba.length;
    source += 4, target += 2
  ) {
    let red = rgba[source];
    let green = rgba[source + 1];
    let blue = rgba[source + 2];
    if (colorDepth === 'rgb555') {
      red &= 0xf8;
      green &= 0xf8;
      blue &= 0xf8;
    } else if (colorDepth === 'rgb454') {
      red &= 0xf0;
      green &= 0xf8;
      blue &= 0xf0;
    } else if (colorDepth === 'rgb444') {
      red &= 0xf0;
      green &= 0xf0;
      blue &= 0xf0;
    }
    const value = ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
    result[target] = value >> 8;
    result[target + 1] = value & 0xff;
  }
  return result;
}

function imaStep(predictor: number, index: number, code: number) {
  const safeIndex = Math.max(0, Math.min(88, index));
  const step = IMA_STEP_TABLE[safeIndex];
  let delta = step >> 3;
  if (code & 1) delta += step >> 2;
  if (code & 2) delta += step >> 1;
  if (code & 4) delta += step;
  predictor += code & 8 ? -delta : delta;
  predictor = Math.max(-32768, Math.min(32767, predictor));
  const nextIndex = Math.max(
    0,
    Math.min(88, safeIndex + IMA_INDEX_TABLE[code & 0x0f]),
  );
  return { predictor, index: nextIndex };
}

function imaCode(predictor: number, target: number, index: number) {
  const step = IMA_STEP_TABLE[Math.max(0, Math.min(88, index))];
  let difference = target - predictor;
  let code = 0;
  if (difference < 0) {
    code = 8;
    difference = -difference;
  }
  if (difference >= step) {
    code |= 4;
    difference -= step;
  }
  if (difference >= step >> 1) {
    code |= 2;
    difference -= step >> 1;
  }
  if (difference >= step >> 2) code |= 1;
  return code;
}

function encodeStereoImaAdpcm(
  pcm: Uint8Array,
  frames: number,
  state: ImaState,
) {
  if (frames <= 0)
    throw new Error('IMA ADPCM blocks require at least one audio frame.');
  if (pcm.byteLength !== frames * IPVF.audioFrameBytes)
    throw new Error('PCM does not contain the requested audio frame count.');
  if (
    state.leftIndex < 0 ||
    state.leftIndex > 88 ||
    state.rightIndex < 0 ||
    state.rightIndex > 88
  ) {
    throw new Error('Invalid IMA ADPCM encoder state.');
  }

  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const payload = new Uint8Array(stereoImaPayloadBytes(frames));
  const header = new DataView(payload.buffer);
  let left = input.getInt16(0, true);
  let right = input.getInt16(2, true);
  let leftIndex = state.leftIndex;
  let rightIndex = state.rightIndex;
  header.setInt16(0, left, true);
  payload[2] = leftIndex;
  header.setInt16(4, right, true);
  payload[6] = rightIndex;

  for (let frame = 1; frame < frames; frame += 1) {
    const targetLeft = input.getInt16(frame * 4, true);
    const targetRight = input.getInt16(frame * 4 + 2, true);
    const leftCode = imaCode(left, targetLeft, leftIndex);
    const rightCode = imaCode(right, targetRight, rightIndex);
    const nextLeft = imaStep(left, leftIndex, leftCode);
    const nextRight = imaStep(right, rightIndex, rightCode);
    left = nextLeft.predictor;
    leftIndex = nextLeft.index;
    right = nextRight.predictor;
    rightIndex = nextRight.index;
    payload[7 + frame] = leftCode | (rightCode << 4);
  }

  return { payload, state: { leftIndex, rightIndex } };
}

function encodeMonoImaAdpcm(pcm: Uint8Array, frames: number, index: number) {
  if (frames <= 0 || pcm.byteLength !== frames * IPVF.audioFrameBytes)
    throw new Error('PCM does not contain the requested audio frame count.');
  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let predictor = input.getInt16(0, true);
  if (predictor !== input.getInt16(2, true))
    throw new Error('PCM is not dual mono.');
  const payload = new Uint8Array(monoImaPayloadBytes(frames));
  new DataView(payload.buffer).setInt16(0, predictor, true);
  payload[2] = index;
  let pending = 0;
  for (let frame = 1; frame < frames; frame += 1) {
    const target = input.getInt16(frame * 4, true);
    if (target !== input.getInt16(frame * 4 + 2, true))
      throw new Error('PCM is not dual mono.');
    const code = imaCode(predictor, target, index);
    const next = imaStep(predictor, index, code);
    predictor = next.predictor;
    index = next.index;
    if ((frame - 1) & 1)
      payload[4 + Math.floor((frame - 1) / 2)] = pending | (code << 4);
    else pending = code;
  }
  if ((frames - 1) & 1) payload[payload.byteLength - 1] = pending;
  return { payload, index };
}

export function encodeAdaptiveIma(
  pcm: Uint8Array,
  frames: number,
  state: ImaState,
) {
  if (frames <= 0 || pcm.byteLength !== frames * IPVF.audioFrameBytes)
    throw new Error('PCM does not contain the requested audio frame count.');
  if (pcm.every((value) => value === 0))
    return { payload: EMPTY, state, mode: 'silence' as const };
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let dualMono = true;
  for (let frame = 0; frame < frames; frame += 1) {
    if (view.getInt16(frame * 4, true) !== view.getInt16(frame * 4 + 2, true)) {
      dualMono = false;
      break;
    }
  }
  if (dualMono) {
    const encoded = encodeMonoImaAdpcm(pcm, frames, state.leftIndex);
    return {
      payload: encoded.payload,
      state: { leftIndex: encoded.index, rightIndex: encoded.index },
      mode: 'mono' as const,
    };
  }
  const encoded = encodeStereoImaAdpcm(pcm, frames, state);
  return { ...encoded, mode: 'stereo' as const };
}

function decodeImaAdpcm(payload: Uint8Array, frames: number) {
  assert(frames > 0, 'Invalid IMA ADPCM block length.');
  if (!payload.byteLength) return;
  if (payload.byteLength === monoImaPayloadBytes(frames)) {
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    let predictor = view.getInt16(0, true);
    let index = payload[2];
    assert(payload[3] === 0 && index <= 88, 'Invalid IMA ADPCM block header.');
    for (let sample = 1; sample < frames; sample += 1) {
      const packed = payload[4 + Math.floor((sample - 1) / 2)];
      const code = (sample - 1) & 1 ? packed >> 4 : packed & 0x0f;
      const next = imaStep(predictor, index, code);
      predictor = next.predictor;
      index = next.index;
    }
    return;
  }
  assert(
    payload.byteLength === stereoImaPayloadBytes(frames),
    'Invalid IMA ADPCM block length.',
  );
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  let left = view.getInt16(0, true);
  let right = view.getInt16(4, true);
  let leftIndex = payload[2];
  let rightIndex = payload[6];
  assert(
    payload[3] === 0 && payload[7] === 0 && leftIndex <= 88 && rightIndex <= 88,
    'Invalid IMA ADPCM block header.',
  );
  for (let frame = 1; frame < frames; frame += 1) {
    const packed = payload[7 + frame];
    const nextLeft = imaStep(left, leftIndex, packed & 0x0f);
    const nextRight = imaStep(right, rightIndex, packed >> 4);
    left = nextLeft.predictor;
    leftIndex = nextLeft.index;
    right = nextRight.predictor;
    rightIndex = nextRight.index;
  }
}

function lz4Key(data: Uint8Array, position: number) {
  return (
    data[position] |
    (data[position + 1] << 8) |
    (data[position + 2] << 16) |
    (data[position + 3] << 24)
  );
}

export function lz4Compress(data: Uint8Array, maxCandidates = 32) {
  const length = data.byteLength;
  if (!length) throw new Error('Cannot encode an empty LZ4 block.');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1)
    throw new Error('LZ4 search depth must be a positive integer.');
  const previous = new Int32Array(length);
  previous.fill(-1);
  const heads = new Map<number, number>();
  const output: number[] = [];
  let anchor = 0;
  let position = 0;
  let preinserted = -1;

  const emitLength = (value: number) => {
    if (value < 15) return;
    value -= 15;
    while (value >= 255) {
      output.push(255);
      value -= 255;
    }
    output.push(value);
  };
  const insert = (at: number) => {
    if (at + 4 > length) return;
    const key = lz4Key(data, at);
    previous[at] = heads.get(key) ?? -1;
    heads.set(key, at);
  };
  const bestMatch = (at: number) => {
    if (at + 4 > length - 5) return { length: 0, reference: -1 };
    let reference = previous[at];
    let bestLength = 0;
    let bestReference = -1;
    let friendlyLength = 0;
    let friendlyReference = -1;
    let candidates = 0;
    while (reference >= 0 && candidates < maxCandidates) {
      const offset = at - reference;
      if (offset > 65535) break;
      if (
        data[reference] === data[at] &&
        data[reference + 1] === data[at + 1] &&
        data[reference + 2] === data[at + 2] &&
        data[reference + 3] === data[at + 3]
      ) {
        const limit = length - 5 - at;
        let matched = 4;
        while (
          matched < limit &&
          data[reference + matched] === data[at + matched]
        ) {
          matched += 1;
        }
        if (matched > bestLength) {
          bestLength = matched;
          bestReference = reference;
        }
        if (offset >= 8 && matched > friendlyLength) {
          friendlyLength = matched;
          friendlyReference = reference;
        }
        if (matched === limit) break;
      }
      reference = previous[reference];
      candidates += 1;
    }
    return friendlyReference >= 0 && friendlyLength + 1 >= bestLength
      ? { length: friendlyLength, reference: friendlyReference }
      : { length: bestLength, reference: bestReference };
  };

  while (position + 12 <= length) {
    if (position !== preinserted) insert(position);
    preinserted = -1;
    const match = bestMatch(position);
    if (match.length < 4) {
      position += 1;
      continue;
    }

    let lazyInserted = -1;
    if (position + 13 <= length) {
      insert(position + 1);
      lazyInserted = position + 1;
      const next = bestMatch(position + 1);
      if (next.length > match.length + 1) {
        preinserted = position + 1;
        position += 1;
        continue;
      }
    }

    const literalLength = position - anchor;
    const encodedMatchLength = match.length - 4;
    output.push(
      (Math.min(literalLength, 15) << 4) | Math.min(encodedMatchLength, 15),
    );
    emitLength(literalLength);
    for (let index = anchor; index < position; index += 1)
      output.push(data[index]);
    const offset = position - match.reference;
    output.push(offset & 0xff, offset >> 8);
    emitLength(encodedMatchLength);

    for (let at = position + 1; at < position + match.length; at += 1) {
      if (at !== lazyInserted) insert(at);
    }
    position += match.length;
    anchor = position;
  }

  const literalLength = length - anchor;
  output.push(Math.min(literalLength, 15) << 4);
  emitLength(literalLength);
  for (let index = anchor; index < length; index += 1) output.push(data[index]);
  return Uint8Array.from(output);
}

export function lz4Decompress(data: Uint8Array, expectedSize: number) {
  assert(data.byteLength > 0, 'Empty LZ4 block.');
  assert(expectedSize >= 0, 'Negative expected LZ4 size.');
  const output = new Uint8Array(expectedSize);
  let source = 0;
  let target = 0;
  let lastMatchStart = -1;
  while (source < data.byteLength) {
    const token = data[source++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let extra = 255;
      while (extra === 255) {
        assert(source < data.byteLength, 'Truncated LZ4 literal length.');
        extra = data[source++];
        literalLength += extra;
      }
    }
    assert(
      source + literalLength <= data.byteLength &&
        target + literalLength <= output.byteLength,
      'Truncated LZ4 literals.',
    );
    output.set(data.subarray(source, source + literalLength), target);
    source += literalLength;
    target += literalLength;
    if (source === data.byteLength) {
      assert(
        literalLength > 0 && (literalLength >= 5 || target < 5),
        'LZ4 block lacks canonical terminal literals.',
      );
      break;
    }
    assert(source + 2 <= data.byteLength, 'Truncated LZ4 offset.');
    const offset = data[source] | (data[source + 1] << 8);
    source += 2;
    assert(offset > 0 && offset <= target, 'Invalid LZ4 offset.');
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let extra = 255;
      while (extra === 255) {
        assert(source < data.byteLength, 'Truncated LZ4 match length.');
        extra = data[source++];
        matchLength += extra;
      }
    }
    matchLength += 4;
    assert(
      target + matchLength <= output.byteLength,
      'LZ4 decoded size exceeds its expected size.',
    );
    lastMatchStart = target;
    for (let index = 0; index < matchLength; index += 1) {
      output[target] = output[target - offset];
      target += 1;
    }
  }
  assert(target === expectedSize, 'LZ4 decoded size mismatch.');
  assert(
    lastMatchStart < 0 || target - lastMatchStart >= 12,
    'LZ4 final match starts too near the block end.',
  );
  return output;
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

function rectanglePayload(frame: Uint8Array, rectangle: Rectangle) {
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

function rectanglesPayload(frame: Uint8Array, rectangles: Rectangle[]) {
  const parts = rectangles.map((rectangle) =>
    rectanglePayload(frame, rectangle),
  );
  const payload = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let position = 0;
  for (const part of parts) {
    payload.set(part, position);
    position += part.byteLength;
  }
  return payload;
}

function multiRectangleDiff(
  previous: Uint8Array,
  current: Uint8Array,
  maxRectangles: number = IPVF.maxRectangles,
) {
  const tilePairs = 4;
  const tileRows = 4;
  const pairColumns = IPVF.width / 2;
  const tileRowCount = Math.ceil(IPVF.height / tileRows);
  const tileColumnCount = Math.ceil(pairColumns / tilePairs);
  const keyFor = (tileX: number, tileY: number) => tileX * tileRowCount + tileY;
  const decodeKey = (key: number) => ({
    tileX: Math.floor(key / tileRowCount),
    tileY: key % tileRowCount,
  });
  const changed = new Set<number>();
  for (let y = 0; y < IPVF.height; y += 1) {
    const row = y * IPVF.width * 2;
    for (let pair = 0; pair < pairColumns; pair += 1) {
      const position = row + pair * 4;
      if (
        previous[position] !== current[position] ||
        previous[position + 1] !== current[position + 1] ||
        previous[position + 2] !== current[position + 2] ||
        previous[position + 3] !== current[position + 3]
      ) {
        changed.add(
          keyFor(Math.floor(pair / tilePairs), Math.floor(y / tileRows)),
        );
      }
    }
  }
  if (!changed.size) return [];

  const components: Rectangle[] = [];
  const remaining = new Set(changed);
  while (remaining.size) {
    const seed = Math.min(...remaining);
    remaining.delete(seed);
    const stack = [seed];
    const cells = [decodeKey(seed)];
    while (stack.length) {
      const cell = decodeKey(stack.pop()!);
      for (const [tileX, tileY] of [
        [cell.tileX - 1, cell.tileY],
        [cell.tileX + 1, cell.tileY],
        [cell.tileX, cell.tileY - 1],
        [cell.tileX, cell.tileY + 1],
      ]) {
        if (
          tileX < 0 ||
          tileX >= tileColumnCount ||
          tileY < 0 ||
          tileY >= tileRowCount
        )
          continue;
        const neighbour = keyFor(tileX, tileY);
        if (remaining.delete(neighbour)) {
          stack.push(neighbour);
          cells.push({ tileX, tileY });
        }
      }
    }
    const minTileX = Math.min(...cells.map((cell) => cell.tileX));
    const maxTileX = Math.max(...cells.map((cell) => cell.tileX));
    const minTileY = Math.min(...cells.map((cell) => cell.tileY));
    const maxTileY = Math.max(...cells.map((cell) => cell.tileY));
    let minPair: number = pairColumns;
    let maxPair = -1;
    let minY: number = IPVF.height;
    let maxY = -1;
    for (
      let y = minTileY * tileRows;
      y < Math.min(IPVF.height, (maxTileY + 1) * tileRows);
      y += 1
    ) {
      const row = y * IPVF.width * 2;
      for (
        let pair = minTileX * tilePairs;
        pair < Math.min(pairColumns, (maxTileX + 1) * tilePairs);
        pair += 1
      ) {
        const position = row + pair * 4;
        if (
          previous[position] !== current[position] ||
          previous[position + 1] !== current[position + 1] ||
          previous[position + 2] !== current[position + 2] ||
          previous[position + 3] !== current[position + 3]
        ) {
          minPair = Math.min(minPair, pair);
          maxPair = Math.max(maxPair, pair);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxPair >= 0) {
      components.push({
        x: minPair * 2,
        y: minY,
        width: (maxPair - minPair + 1) * 2,
        height: maxY - minY + 1,
      });
    }
  }
  if (components.length > 128) {
    const rectangle = boundingBox(previous, current);
    return rectangle ? [rectangle] : [];
  }

  const cost = (rectangle: Rectangle) =>
    8 + rectangle.width * rectangle.height * 2;
  const merge = (a: Rectangle, b: Rectangle): Rectangle => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: right - x, height: bottom - y };
  };
  while (components.length > 1) {
    let best: {
      extra: number;
      first: number;
      second: number;
      union: Rectangle;
    } | null = null;
    for (let first = 0; first < components.length - 1; first += 1) {
      for (let second = first + 1; second < components.length; second += 1) {
        const union = merge(components[first], components[second]);
        const candidate = {
          extra:
            cost(union) - cost(components[first]) - cost(components[second]),
          first,
          second,
          union,
        };
        if (!best || candidate.extra < best.extra) best = candidate;
      }
    }
    if (!best || (components.length <= maxRectangles && best.extra > 0)) break;
    components[best.first] = best.union;
    components.splice(best.second, 1);
  }
  return components.sort((a, b) => a.y - b.y || a.x - b.x);
}

function compressIfSmaller(
  kind: typeof RECORD_TYPE.key | typeof RECORD_TYPE.rectangles,
  rectangleCount: number,
  payload: Uint8Array,
  audioBytes: number,
): VideoRecord {
  // The reference creator's balanced mode uses LZ4HC-12 when available.
  // Browser builds do not have liblz4, so spend extra host-side search only on
  // full keys. This preserves the same raw LZ4 bitstream while reducing the
  // five-second keyframe I/O/decode spike on the iPod.
  const compressed = lz4Compress(payload, kind === RECORD_TYPE.key ? 256 : 32);
  if (
    compressed.byteLength < payload.byteLength &&
    recordSectors(compressed.byteLength, audioBytes) <
      recordSectors(payload.byteLength, audioBytes)
  ) {
    return {
      kind:
        kind === RECORD_TYPE.key
          ? RECORD_TYPE.keyLz4
          : RECORD_TYPE.rectanglesLz4,
      rectangleCount,
      payload: compressed,
      decodedBytes: payload.byteLength,
    };
  }
  return { kind, rectangleCount, payload, decodedBytes: payload.byteLength };
}

function xorFrames(previous: Uint8Array, current: Uint8Array) {
  const result = new Uint8Array(IPVF.frameBytes);
  for (let index = 0; index < result.byteLength; index += 1)
    result[index] = previous[index] ^ current[index];
  return result;
}

function translateFrame(previous: Uint8Array, dx: number, dy: number) {
  if (Math.abs(dx) >= IPVF.width || Math.abs(dy) >= IPVF.height)
    throw new Error('Translation leaves no overlapping pixels.');
  const predicted = new Uint8Array(IPVF.frameBytes);
  const sourceX = Math.max(0, -dx);
  const targetX = Math.max(0, dx);
  const sourceY = Math.max(0, -dy);
  const targetY = Math.max(0, dy);
  const width = IPVF.width - Math.abs(dx);
  const height = IPVF.height - Math.abs(dy);
  const rowBytes = width * 2;
  for (let row = 0; row < height; row += 1) {
    const source = ((sourceY + row) * IPVF.width + sourceX) * 2;
    const target = ((targetY + row) * IPVF.width + targetX) * 2;
    predicted.set(previous.subarray(source, source + rowBytes), target);
  }
  return predicted;
}

function estimateTranslation(
  previous: Uint8Array,
  current: Uint8Array,
  maxShift = 16,
  sampleStep = 12,
) {
  const scoreCache = new Map<string, [number, number]>();
  const score = (dx: number, dy: number): [number, number] => {
    const key = `${dx},${dy}`;
    const cached = scoreCache.get(key);
    if (cached) return cached;
    const x0 = Math.max(0, dx);
    const x1 = Math.min(IPVF.width, IPVF.width + dx);
    const y0 = Math.max(0, dy);
    const y1 = Math.min(IPVF.height, IPVF.height + dy);
    let total = 0;
    let count = 0;
    for (let y = y0; y < y1; y += sampleStep) {
      let currentOffset = (y * IPVF.width + x0) * 2;
      let previousOffset = ((y - dy) * IPVF.width + x0 - dx) * 2;
      for (let x = x0; x < x1; x += sampleStep) {
        total += Math.abs(current[currentOffset] - previous[previousOffset]);
        total += Math.abs(
          current[currentOffset + 1] - previous[previousOffset + 1],
        );
        count += 1;
        currentOffset += sampleStep * 2;
        previousOffset += sampleStep * 2;
      }
    }
    const result: [number, number] = [total, count];
    scoreCache.set(key, result);
    return result;
  };
  const better = (candidate: [number, number], best: [number, number]) => {
    const [candidateScore, candidateCount] = score(...candidate);
    const [bestScore, bestCount] = score(...best);
    const left = candidateScore * bestCount;
    const right = bestScore * candidateCount;
    if (left !== right) return left < right;
    const candidateDistance = Math.abs(candidate[0]) + Math.abs(candidate[1]);
    const bestDistance = Math.abs(best[0]) + Math.abs(best[1]);
    if (candidateDistance !== bestDistance)
      return candidateDistance < bestDistance;
    return candidate[0] !== best[0]
      ? candidate[0] < best[0]
      : candidate[1] < best[1];
  };
  let best: [number, number] = [0, 0];
  for (let dy = -maxShift; dy <= maxShift; dy += 2) {
    for (let dx = -maxShift; dx <= maxShift; dx += 2) {
      if (better([dx, dy], best)) best = [dx, dy];
    }
  }
  const coarseBest = best;
  for (
    let dy = Math.max(-maxShift, coarseBest[1] - 2);
    dy <= Math.min(maxShift, coarseBest[1] + 2);
    dy += 1
  ) {
    for (
      let dx = Math.max(-maxShift, coarseBest[0] - 2);
      dx <= Math.min(maxShift, coarseBest[0] + 2);
      dx += 1
    ) {
      if (better([dx, dy], best)) best = [dx, dy];
    }
  }
  return best;
}

export function chooseVideoRecord(
  previous: Uint8Array | null,
  current: Uint8Array,
  frameIndex: number,
  audioBytes: number,
  options: {
    keyInterval: number;
    videoMode: VideoMode;
    maxRectangles: number;
  },
): VideoRecord {
  if (
    !previous ||
    (options.keyInterval > 0 && frameIndex % options.keyInterval === 0)
  ) {
    return compressIfSmaller(RECORD_TYPE.key, 0, current, audioBytes);
  }
  const rectangle = boundingBox(previous, current);
  if (!rectangle) {
    return {
      kind: RECORD_TYPE.repeat,
      rectangleCount: 0,
      payload: EMPTY,
      decodedBytes: 0,
    };
  }
  const delta = rectanglePayload(current, rectangle);
  let selected =
    delta.byteLength < IPVF.frameBytes
      ? compressIfSmaller(RECORD_TYPE.rectangles, 1, delta, audioBytes)
      : compressIfSmaller(RECORD_TYPE.key, 0, current, audioBytes);
  let selectedSectors = recordSectors(selected.payload.byteLength, audioBytes);
  const rectangles =
    options.videoMode === 'current'
      ? []
      : multiRectangleDiff(previous, current, options.maxRectangles);
  if (rectangles.length > 1) {
    const multiPayload = rectanglesPayload(current, rectangles);
    if (multiPayload.byteLength < IPVF.frameBytes) {
      const candidate = compressIfSmaller(
        RECORD_TYPE.rectangles,
        rectangles.length,
        multiPayload,
        audioBytes,
      );
      const candidateSectors = recordSectors(
        candidate.payload.byteLength,
        audioBytes,
      );
      if (candidateSectors < selectedSectors) {
        selected = candidate;
        selectedSectors = candidateSectors;
      }
    }
  }
  if (
    options.videoMode === 'balanced' ||
    options.videoMode === 'motion' ||
    options.videoMode === 'auto'
  ) {
    const [dx, dy] = estimateTranslation(previous, current);
    const prediction = translateFrame(previous, dx, dy);
    const residual = lz4Compress(xorFrames(prediction, current));
    const motionPayload = new Uint8Array(6 + residual.byteLength);
    motionPayload[0] = dx & 0xff;
    motionPayload[1] = dy & 0xff;
    new DataView(motionPayload.buffer).setUint32(
      2,
      rockboxCrc32(residual),
      true,
    );
    motionPayload.set(residual, 6);
    const motionSectors = recordSectors(motionPayload.byteLength, audioBytes);
    const savesEnoughSectors =
      options.videoMode === 'balanced'
        ? motionSectors + MOTION_MIN_SECTOR_SAVING <= selectedSectors
        : motionSectors < selectedSectors;
    if (
      (options.videoMode !== 'auto' || dx !== 0 || dy !== 0) &&
      motionPayload.byteLength < IPVF.frameBytes &&
      savesEnoughSectors
    ) {
      selected = {
        kind: RECORD_TYPE.motionLz4,
        rectangleCount: 0,
        payload: motionPayload,
        decodedBytes: IPVF.frameBytes,
      };
      selectedSectors = motionSectors;
    }
  }
  if (options.videoMode === 'auto') {
    const temporal = lz4Compress(xorFrames(previous, current));
    const temporalPayload = new Uint8Array(4 + temporal.byteLength);
    new DataView(temporalPayload.buffer).setUint32(
      0,
      rockboxCrc32(temporal),
      true,
    );
    temporalPayload.set(temporal, 4);
    const temporalSectors = recordSectors(
      temporalPayload.byteLength,
      audioBytes,
    );
    if (
      temporalPayload.byteLength < IPVF.frameBytes &&
      temporalSectors < selectedSectors
    ) {
      selected = {
        kind: RECORD_TYPE.temporalXorLz4,
        rectangleCount: 0,
        payload: temporalPayload,
        decodedBytes: IPVF.frameBytes,
      };
    }
  }
  return selected;
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
  view.setUint32(8, video.decodedBytes, true);
  view.setUint32(12, audio.byteLength, true);
  bytes.set(video.payload, IPVF.recordHeaderSize);
  bytes.set(audio, IPVF.recordHeaderSize + video.payload.byteLength);
  return bytes;
}

export type KeyframeIndexEntry = {
  frame: number;
  offset: number;
  sectors: number;
  flags: number;
};

export function isKeyRecord(kind: RecordType) {
  return kind === RECORD_TYPE.key || kind === RECORD_TYPE.keyLz4;
}

export function indexFlagsForKind(kind: RecordType) {
  if (kind === RECORD_TYPE.key) return 0;
  if (kind === RECORD_TYPE.keyLz4) return IPVF.indexKeyLz4Flag;
  throw new Error('Only keyframes can be added to the IPVF index.');
}

export function buildIndex(entries: KeyframeIndexEntry[]) {
  const bytes = new Uint8Array(entries.length * IPVF.indexEntrySize);
  const view = new DataView(bytes.buffer);
  entries.forEach((entry, index) => {
    const offset = index * IPVF.indexEntrySize;
    view.setUint32(offset, entry.frame, true);
    view.setBigUint64(offset + 4, BigInt(entry.offset), true);
    view.setUint16(offset + 12, entry.sectors, true);
    view.setUint16(offset + 14, entry.flags, true);
  });
  return bytes;
}

const METADATA_TAGS = [
  ['title', 1],
  ['artist', 2],
  ['album', 3],
] as const;

export function encodeMetadata(metadata: IpvfMetadata = {}) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const [name, tag] of METADATA_TAGS) {
    const value = metadata[name];
    if (value === undefined || value === '') continue;
    const raw = encoder.encode(value);
    if (!raw.byteLength || raw.byteLength > 255)
      throw new Error(`${name} metadata must be 1..255 UTF-8 bytes.`);
    if (length + 2 + raw.byteLength > IPVF.dataOffset - IPVF.metadataOffset)
      throw new Error('Metadata exceeds the IPVF superblock capacity.');
    chunks.push(Uint8Array.of(tag, raw.byteLength), raw);
    length += 2 + raw.byteLength;
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
}

function parseMetadata(bytes: Uint8Array): IpvfMetadata {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const result: IpvfMetadata = {};
  let position = 0;
  while (position < bytes.byteLength) {
    assert(
      position + 2 <= bytes.byteLength,
      'Metadata has a truncated TLV header.',
    );
    const tag = bytes[position];
    const length = bytes[position + 1];
    position += 2;
    const definition = METADATA_TAGS.find((item) => item[1] === tag);
    assert(definition && length > 0, 'Metadata contains an invalid tag.');
    const name = definition[0];
    assert(result[name] === undefined, `Metadata tag ${name} is duplicated.`);
    assert(
      position + length <= bytes.byteLength,
      `Metadata tag ${name} exceeds its bounds.`,
    );
    result[name] = decoder.decode(bytes.subarray(position, position + length));
    position += length;
  }
  return result;
}

export function buildHeader(options: {
  frameRate: FrameRate;
  frameCount: number;
  firstRecordSectors: number;
  flags: number;
  mediaEndOffset: number;
  indexCount: number;
  indexCrc: number;
  mediaId: number;
  metadata?: IpvfMetadata;
}) {
  const rate = normalizeFrameRate(options.frameRate);
  const metadata = encodeMetadata(options.metadata);
  const bytes = new Uint8Array(IPVF.dataOffset);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x50, 0x56, 0x46], 0);
  view.setUint16(4, IPVF.headerSize, true);
  view.setUint16(6, IPVF.width, true);
  view.setUint16(8, IPVF.height, true);
  view.setUint16(10, rate.numerator, true);
  view.setUint16(12, rate.denominator, true);
  view.setUint16(14, options.firstRecordSectors, true);
  view.setUint32(16, options.frameCount, true);
  view.setUint32(20, options.flags, true);
  view.setUint32(24, IPVF.dataOffset, true);
  view.setUint16(28, IPVF.audioFormat, true);
  view.setUint16(30, IPVF.audioChannels, true);
  view.setUint16(32, IPVF.audioBitsPerSample, true);
  view.setUint32(34, IPVF.audioSampleRate, true);
  const audioFrames = audioBoundary(options.frameCount, rate);
  if (audioFrames <= 0 || audioFrames > 0xffffffff)
    throw new Error('Audio duration exceeds IPVF limits.');
  view.setUint32(38, audioFrames, true);
  view.setBigUint64(44, BigInt(options.mediaEndOffset), true);
  view.setBigUint64(52, BigInt(options.mediaEndOffset), true);
  view.setUint32(60, options.indexCount, true);
  view.setUint16(64, IPVF.indexEntrySize, true);
  view.setUint16(66, metadata.byteLength, true);
  view.setUint32(68, IPVF.metadataOffset, true);
  view.setUint32(72, options.indexCrc, true);
  view.setUint32(76, options.mediaId, true);
  bytes.set(metadata, IPVF.metadataOffset);
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

export function rockboxCrc32(data: Uint8Array, initial = 0xffffffff) {
  const table = [
    0x00000000, 0x04c11db7, 0x09823b6e, 0x0d4326d9, 0x130476dc, 0x17c56b6b,
    0x1a864db2, 0x1e475005, 0x2608edb8, 0x22c9f00f, 0x2f8ad6d6, 0x2b4bcb61,
    0x350c9b64, 0x31cd86d3, 0x3c8ea00a, 0x384fbdbd,
  ];
  let crc = initial;
  for (const byte of data) {
    let index = ((crc >>> 28) ^ (byte >>> 4)) & 0x0f;
    crc = ((crc << 4) ^ table[index]) >>> 0;
    index = ((crc >>> 28) ^ (byte & 0x0f)) & 0x0f;
    crc = ((crc << 4) ^ table[index]) >>> 0;
  }
  return crc;
}

function applyRectangles(
  previous: Uint8Array,
  payload: Uint8Array,
  count: number,
) {
  const current = previous.slice();
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  let position = 0;
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
    assert(
      position + dataBytes <= payload.byteLength,
      'Rectangle pixels exceed their payload.',
    );
    for (let row = 0; row < height; row += 1) {
      const source = position + row * width * 2;
      const target = ((y + row) * IPVF.width + x) * 2;
      current.set(payload.subarray(source, source + width * 2), target);
    }
    position += dataBytes;
  }
  assert(
    position === payload.byteLength,
    'Rectangle payload contains trailing bytes.',
  );
  return current;
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
  assert(
    view.getUint16(4, true) === IPVF.headerSize,
    'Invalid logical header size.',
  );
  assert(
    view.getUint16(6, true) === IPVF.width &&
      view.getUint16(8, true) === IPVF.height,
    'Invalid display dimensions.',
  );
  const fpsNumerator = view.getUint16(10, true);
  const fpsDenominator = view.getUint16(12, true);
  const frameRate = normalizeFrameRate({
    numerator: fpsNumerator,
    denominator: fpsDenominator,
  });
  const fps = fpsNumerator / fpsDenominator;
  let currentSectors = view.getUint16(14, true);
  const frameCount = view.getUint32(16, true);
  assert(frameCount > 0, 'IPVF contains no frames.');
  const flags = view.getUint32(20, true);
  assert(
    flags === IPVF.flags || flags === (IPVF.flags | IPVF.temporalFlag),
    'Invalid IPVF flags.',
  );
  const temporalEnabled = (flags & IPVF.temporalFlag) !== 0;
  assert(
    view.getUint32(24, true) === IPVF.dataOffset,
    'Invalid first record offset.',
  );
  assert(
    currentSectors > 0 && currentSectors <= IPVF.maxRecordSectors,
    'Invalid first record size.',
  );
  assert(
    view.getUint16(28, true) === IPVF.audioFormat,
    'Invalid audio format.',
  );
  assert(
    view.getUint16(30, true) === IPVF.audioChannels,
    'Invalid audio channel count.',
  );
  assert(
    view.getUint16(32, true) === IPVF.audioBitsPerSample,
    'Invalid audio bit depth.',
  );
  assert(
    view.getUint32(34, true) === IPVF.audioSampleRate,
    'Invalid audio sample rate.',
  );
  const expectedAudioFrames = audioBoundary(frameCount, frameRate);
  assert(
    view.getUint32(38, true) === expectedAudioFrames,
    'Header audio duration does not match the video duration.',
  );
  assert(view.getUint16(42, true) === 0, 'Reserved header field is not zero.');
  const mediaEnd = Number(view.getBigUint64(44, true));
  const indexOffset = Number(view.getBigUint64(52, true));
  const indexCount = view.getUint32(60, true);
  const indexEntrySize = view.getUint16(64, true);
  const metadataLength = view.getUint16(66, true);
  const metadataOffset = view.getUint32(68, true);
  const indexCrc = view.getUint32(72, true);
  const expectedMediaId = view.getUint32(76, true);
  assert(metadataOffset === IPVF.metadataOffset, 'Invalid metadata offset.');
  const metadataEnd = metadataOffset + metadataLength;
  assert(metadataEnd <= IPVF.dataOffset, 'Metadata exceeds the superblock.');
  const metadata = parseMetadata(header.subarray(metadataOffset, metadataEnd));
  assert(
    header.subarray(metadataEnd).every((value) => value === 0),
    'Superblock padding is not zero-filled.',
  );
  assert(
    mediaEnd > IPVF.dataOffset &&
      mediaEnd <= fileBytes &&
      mediaEnd % IPVF.sectorSize === 0,
    'Invalid media end offset.',
  );
  assert(indexOffset === mediaEnd, 'Index does not begin at media end.');
  assert(indexEntrySize === IPVF.indexEntrySize, 'Invalid index entry size.');
  assert(indexCount > 0 && indexCount <= frameCount, 'Invalid index count.');
  assert(
    indexOffset + indexCount * indexEntrySize === fileBytes,
    'Index bounds do not match the file end.',
  );

  let position = IPVF.dataOffset;
  let previous: Uint8Array | null = null;
  const counts = { keyframes: 0, rectangles: 0, repeats: 0 };
  const audioCounts = { silence: 0, mono: 0, stereo: 0 };
  const keyframes: KeyframeIndexEntry[] = [];
  const recordInfo = new Map<
    number,
    { frame: number; kind: RecordType; sectors: number }
  >();
  let mediaId = 0xffffffff;
  for (let frame = 0; frame < frameCount; frame += 1) {
    assert(
      currentSectors > 0 && currentSectors <= IPVF.maxRecordSectors,
      `Frame ${frame}: invalid record size.`,
    );
    const recordBytes = currentSectors * IPVF.sectorSize;
    assert(
      position + recordBytes <= mediaEnd,
      `Frame ${frame}: record exceeds media end.`,
    );
    const record = readExactly(file, position, recordBytes);
    mediaId = rockboxCrc32(record, mediaId);
    const recordView = new DataView(record.buffer);
    const kind = record[0] as RecordType;
    const rectangleCount = record[1];
    const nextSectors = recordView.getUint16(2, true);
    const storedBytes = recordView.getUint32(4, true);
    const decodedBytes = recordView.getUint32(8, true);
    const audioBytes = recordView.getUint32(12, true);
    assert(
      Object.values(RECORD_TYPE).includes(kind),
      `Frame ${frame}: unknown record type.`,
    );
    recordInfo.set(position, { frame, kind, sectors: currentSectors });
    const audioFrames =
      audioBoundary(frame + 1, frameRate) - audioBoundary(frame, frameRate);
    const monoBytes = monoImaPayloadBytes(audioFrames);
    const stereoBytes = stereoImaPayloadBytes(audioFrames);
    assert(
      audioBytes === 0 ||
        audioBytes === monoBytes ||
        audioBytes === stereoBytes,
      `Frame ${frame}: invalid adaptive audio size.`,
    );
    if (audioBytes === 0) audioCounts.silence += 1;
    else if (audioBytes === monoBytes) audioCounts.mono += 1;
    else audioCounts.stereo += 1;
    const usedBytes = IPVF.recordHeaderSize + storedBytes + audioBytes;
    assert(
      Math.ceil(usedBytes / IPVF.sectorSize) === currentSectors,
      `Frame ${frame}: sector count does not match its payloads.`,
    );
    assert(
      usedBytes <= recordBytes,
      `Frame ${frame}: payload exceeds its record.`,
    );
    assert(
      record.subarray(usedBytes).every((value) => value === 0),
      `Frame ${frame}: record padding is not zero-filled.`,
    );
    assert(
      frame + 1 < frameCount
        ? nextSectors > 0 && nextSectors <= IPVF.maxRecordSectors
        : nextSectors === 0,
      `Frame ${frame}: invalid next-record link.`,
    );
    const stored = record.subarray(
      IPVF.recordHeaderSize,
      IPVF.recordHeaderSize + storedBytes,
    );
    const audio = record.subarray(
      IPVF.recordHeaderSize + storedBytes,
      usedBytes,
    );
    decodeImaAdpcm(audio, audioFrames);

    const compressed =
      kind === RECORD_TYPE.keyLz4 ||
      kind === RECORD_TYPE.rectanglesLz4 ||
      kind === RECORD_TYPE.temporalXorLz4 ||
      kind === RECORD_TYPE.motionLz4;
    let payload: Uint8Array;
    if (compressed) {
      assert(
        storedBytes > 0 && storedBytes < decodedBytes,
        `Frame ${frame}: invalid compressed sizes.`,
      );
      let compressedPayload = stored;
      if (
        kind === RECORD_TYPE.temporalXorLz4 ||
        kind === RECORD_TYPE.motionLz4
      ) {
        const crcOffset = kind === RECORD_TYPE.motionLz4 ? 2 : 0;
        assert(
          temporalEnabled && storedBytes >= crcOffset + 5,
          `Frame ${frame}: temporal flag or size mismatch.`,
        );
        const expectedCrc = new DataView(
          stored.buffer,
          stored.byteOffset,
          stored.byteLength,
        ).getUint32(crcOffset, true);
        compressedPayload = stored.subarray(crcOffset + 4);
        assert(
          rockboxCrc32(compressedPayload) === expectedCrc,
          `Frame ${frame}: temporal payload CRC mismatch.`,
        );
      }
      payload = lz4Decompress(compressedPayload, decodedBytes);
    } else {
      assert(
        storedBytes === decodedBytes,
        `Frame ${frame}: raw payload size mismatch.`,
      );
      payload = stored;
    }

    let current: Uint8Array;
    if (kind === RECORD_TYPE.key || kind === RECORD_TYPE.keyLz4) {
      assert(
        rectangleCount === 0 && decodedBytes === IPVF.frameBytes,
        `Frame ${frame}: malformed keyframe.`,
      );
      current = payload;
      counts.keyframes += 1;
      keyframes.push({
        frame,
        offset: position,
        sectors: currentSectors,
        flags: indexFlagsForKind(kind),
      });
    } else if (
      kind === RECORD_TYPE.rectangles ||
      kind === RECORD_TYPE.rectanglesLz4
    ) {
      assert(
        previous && rectangleCount > 0 && decodedBytes > 0,
        `Frame ${frame}: malformed rectangle record.`,
      );
      current = applyRectangles(previous, payload, rectangleCount);
      counts.rectangles += 1;
    } else if (kind === RECORD_TYPE.repeat) {
      assert(
        previous &&
          rectangleCount === 0 &&
          storedBytes === 0 &&
          decodedBytes === 0,
        `Frame ${frame}: malformed repeat record.`,
      );
      current = previous;
      counts.repeats += 1;
    } else if (kind === RECORD_TYPE.temporalXorLz4) {
      assert(
        previous && rectangleCount === 0 && decodedBytes === IPVF.frameBytes,
        `Frame ${frame}: malformed temporal record.`,
      );
      current = new Uint8Array(IPVF.frameBytes);
      for (let index = 0; index < current.byteLength; index += 1)
        current[index] = previous[index] ^ payload[index];
      counts.rectangles += 1;
    } else {
      assert(
        previous && rectangleCount === 0 && decodedBytes === IPVF.frameBytes,
        `Frame ${frame}: malformed motion record.`,
      );
      const prediction = translateFrame(
        previous,
        new DataView(stored.buffer, stored.byteOffset).getInt8(0),
        new DataView(stored.buffer, stored.byteOffset).getInt8(1),
      );
      current = xorFrames(prediction, payload);
      counts.rectangles += 1;
    }
    assert(
      current.byteLength === IPVF.frameBytes,
      `Frame ${frame}: reconstructed frame has the wrong size.`,
    );
    previous = current;
    position += recordBytes;
    currentSectors = nextSectors;
  }
  assert(currentSectors === 0, 'Record chain does not terminate.');
  assert(
    position === mediaEnd,
    'Record chain does not end at the media end offset.',
  );
  assert(mediaId === expectedMediaId, 'Media identity CRC mismatch.');

  const index = readExactly(file, indexOffset, indexCount * indexEntrySize);
  assert(rockboxCrc32(index) === indexCrc, 'Index CRC mismatch.');
  const indexView = new DataView(index.buffer);
  const parsedIndex: KeyframeIndexEntry[] = [];
  let previousFrame = -1;
  let previousOffset = IPVF.dataOffset - 1;
  for (let entryNumber = 0; entryNumber < indexCount; entryNumber += 1) {
    const entryOffset = entryNumber * indexEntrySize;
    const entry = {
      frame: indexView.getUint32(entryOffset, true),
      offset: Number(indexView.getBigUint64(entryOffset + 4, true)),
      sectors: indexView.getUint16(entryOffset + 12, true),
      flags: indexView.getUint16(entryOffset + 14, true),
    };
    assert(
      entryNumber !== 0 || entry.frame === 0,
      'Index must begin at frame 0.',
    );
    assert(entry.frame > previousFrame, 'Index frames are not monotonic.');
    assert(entry.offset > previousOffset, 'Index offsets are not monotonic.');
    assert(
      entry.offset >= IPVF.dataOffset && entry.offset % IPVF.sectorSize === 0,
      'Index contains an invalid record offset.',
    );
    const info = recordInfo.get(entry.offset);
    assert(
      info && isKeyRecord(info.kind),
      'Index entry is not a keyframe record.',
    );
    assert(
      info.frame === entry.frame && info.sectors === entry.sectors,
      'Index entry does not match its record.',
    );
    assert(
      entry.flags === indexFlagsForKind(info.kind),
      'Index entry has invalid keyframe flags.',
    );
    parsedIndex.push(entry);
    previousFrame = entry.frame;
    previousOffset = entry.offset;
  }
  assert(
    parsedIndex.length === keyframes.length &&
      parsedIndex.every((entry, index) => {
        const expected = keyframes[index];
        return (
          entry.frame === expected.frame &&
          entry.offset === expected.offset &&
          entry.sectors === expected.sectors &&
          entry.flags === expected.flags
        );
      }),
    'Index does not enumerate every keyframe.',
  );
  return {
    frameCount,
    fps,
    fpsNumerator,
    fpsDenominator,
    audioSampleFrames: expectedAudioFrames,
    fileBytes,
    indexCount,
    mediaId: mediaId.toString(16).padStart(8, '0'),
    metadata,
    silentAudioRecords: audioCounts.silence,
    monoAudioRecords: audioCounts.mono,
    stereoAudioRecords: audioCounts.stereo,
    ...counts,
  };
}
