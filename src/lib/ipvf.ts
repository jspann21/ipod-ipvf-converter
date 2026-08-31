export const IPVF = {
  width: 220,
  height: 176,
  frameBytes: 220 * 176 * 2,
  headerSize: 64,
  dataOffset: 512,
  sectorSize: 512,
  recordHeaderSize: 12,
  maxRecordSectors: 192,
  version: 1,
  flags: 11,
  temporalFlag: 16,
  audioFormat: 2,
  audioChannels: 2,
  audioBitsPerSample: 16,
  audioSampleRate: 44_100,
  audioFrameBytes: 4,
  keyInterval: 120,
  maxRectangles: 8,
} as const;

export const RECORD_TYPE = {
  key: 0,
  rectangles: 1,
  repeat: 2,
  keyLz4: 3,
  rectanglesLz4: 4,
  temporalXorLz4: 5,
} as const;

export type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE];

export type VideoRecord = {
  kind: RecordType;
  rectangleCount: number;
  payload: Uint8Array;
  decodedBytes: number;
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

export function audioBoundary(frame: number, fps: number) {
  return Math.floor((frame * IPVF.audioSampleRate + Math.floor(fps / 2)) / fps);
}

export function imaPayloadBytes(audioFrames: number) {
  if (audioFrames <= 0)
    throw new Error('IMA ADPCM records require at least one audio frame.');
  return 8 + audioFrames - 1;
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

export function encodeImaAdpcm(
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
  const payload = new Uint8Array(imaPayloadBytes(frames));
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

function decodeImaAdpcm(payload: Uint8Array, frames: number) {
  assert(
    frames > 0 && payload.byteLength === imaPayloadBytes(frames),
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

export function lz4Compress(data: Uint8Array) {
  const length = data.byteLength;
  if (!length) throw new Error('Cannot encode an empty LZ4 block.');
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
    while (reference >= 0 && candidates < 32) {
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
  maxRectangles = IPVF.maxRectangles,
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
  const compressed = lz4Compress(payload);
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

export function chooseVideoRecord(
  previous: Uint8Array | null,
  current: Uint8Array,
  frameIndex: number,
  audioBytes: number,
  keyInterval = IPVF.keyInterval,
): VideoRecord {
  if (!previous || (keyInterval > 0 && frameIndex % keyInterval === 0)) {
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
  const rectangles = multiRectangleDiff(previous, current);
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
  bytes.set(video.payload, IPVF.recordHeaderSize);
  bytes.set(audio, IPVF.recordHeaderSize + video.payload.byteLength);
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

function rockboxCrc32(data: Uint8Array) {
  const table = [
    0x00000000, 0x04c11db7, 0x09823b6e, 0x0d4326d9, 0x130476dc, 0x17c56b6b,
    0x1a864db2, 0x1e475005, 0x2608edb8, 0x22c9f00f, 0x2f8ad6d6, 0x2b4bcb61,
    0x350c9b64, 0x31cd86d3, 0x3c8ea00a, 0x384fbdbd,
  ];
  let crc = 0xffffffff;
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
  const fps = view.getUint16(12, true);
  const fpsDenominator = view.getUint16(14, true);
  const frameCount = view.getUint32(16, true);
  assert(
    fpsDenominator === 1 && fps >= 4 && fps <= 240,
    'Frame rate is outside IPVF limits.',
  );
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
  const expectedAudioFrames = audioBoundary(frameCount, fps);
  assert(
    view.getUint32(40, true) === expectedAudioFrames,
    'Header audio duration does not match the video duration.',
  );
  assert(
    header.subarray(44).every((value) => value === 0),
    'Header padding is not zero-filled.',
  );

  let position = IPVF.dataOffset;
  let previous: Uint8Array | null = null;
  const counts = { keyframes: 0, rectangles: 0, repeats: 0 };
  for (let frame = 0; frame < frameCount; frame += 1) {
    assert(
      currentSectors > 0 && currentSectors <= IPVF.maxRecordSectors,
      `Frame ${frame}: invalid record size.`,
    );
    const recordBytes = currentSectors * IPVF.sectorSize;
    const record = readExactly(file, position, recordBytes);
    const recordView = new DataView(record.buffer);
    const kind = record[0] as RecordType;
    const rectangleCount = record[1];
    const nextSectors = recordView.getUint16(2, true);
    const storedBytes = recordView.getUint32(4, true);
    const decodedBytes = recordView.getUint32(8, true);
    assert(
      Object.values(RECORD_TYPE).includes(kind),
      `Frame ${frame}: unknown record type.`,
    );
    const audioFrames =
      audioBoundary(frame + 1, fps) - audioBoundary(frame, fps);
    const audioBytes = imaPayloadBytes(audioFrames);
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
      kind === RECORD_TYPE.temporalXorLz4;
    let payload: Uint8Array;
    if (compressed) {
      assert(
        storedBytes > 0 && storedBytes < decodedBytes,
        `Frame ${frame}: invalid compressed sizes.`,
      );
      let compressedPayload = stored;
      if (kind === RECORD_TYPE.temporalXorLz4) {
        assert(
          temporalEnabled && storedBytes >= 5,
          `Frame ${frame}: temporal flag or size mismatch.`,
        );
        const expectedCrc = new DataView(
          stored.buffer,
          stored.byteOffset,
          stored.byteLength,
        ).getUint32(0, true);
        compressedPayload = stored.subarray(4);
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
    } else {
      assert(
        previous && rectangleCount === 0 && decodedBytes === IPVF.frameBytes,
        `Frame ${frame}: malformed temporal record.`,
      );
      current = new Uint8Array(IPVF.frameBytes);
      for (let index = 0; index < current.byteLength; index += 1)
        current[index] = previous[index] ^ payload[index];
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
    position === fileBytes,
    'Record chain does not end at the end of the file.',
  );
  return {
    frameCount,
    fps,
    audioSampleFrames: expectedAudioFrames,
    fileBytes,
    ...counts,
  };
}
