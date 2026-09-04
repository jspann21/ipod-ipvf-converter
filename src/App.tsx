import {
  CheckCircle2,
  CircleGauge,
  Download,
  ExternalLink,
  FileUp,
  Film,
  FolderOpen,
  HardDrive,
  Link2,
  LockKeyhole,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel } from '@/components/ui/progress';
import type {
  ConversionStage,
  EncoderProfile,
  FitMode,
  WorkerRequest,
  WorkerResponse,
} from '@/src/lib/messages';
import type { ColorDepth, FrameRate, VideoMode } from '@/src/lib/ipvf';

type SourceMode = 'file' | 'url';
type RunState = 'idle' | 'running' | 'complete' | 'error' | 'cancelled';
type ProgressState = {
  stage: ConversionStage;
  progress: number;
  detail: string;
  frame?: number;
  frameCount?: number;
};
type CompleteResult = Extract<WorkerResponse, { type: 'complete' }>;
type FrameRatePreset =
  | 'profile'
  | '20/1'
  | '24000/1001'
  | '24/1'
  | '25/1'
  | '30000/1001'
  | '30/1'
  | '60/1';

const VIDEO_FILE_PATTERN =
  /\.(?:3g2|3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|ts|webm|wmv)$/i;

const STAGE_WEIGHT: Record<ConversionStage, [number, number]> = {
  inspect: [0, 12],
  audio: [12, 30],
  video: [30, 92],
  validate: [92, 100],
  done: [100, 100],
};

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function friendlyStage(stage: ConversionStage) {
  return {
    inspect: 'Inspecting',
    audio: 'Preparing audio',
    video: 'Encoding frames',
    validate: 'Validating',
    done: 'Complete',
  }[stage];
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds - minutes * 60);
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function isVideoFile(file: File) {
  return file.type.startsWith('video/') || VIDEO_FILE_PATTERN.test(file.name);
}

function parseFrameRate(value: FrameRatePreset): 'profile' | FrameRate {
  if (value === 'profile') return value;
  const [numerator, denominator] = value.split('/').map(Number);
  return { numerator, denominator };
}

async function getOutputFile(name: string) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  return handle.getFile();
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const filePreviewUrlRef = useRef('');
  const [sourceMode, setSourceMode] = useState<SourceMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [fileError, setFileError] = useState('');
  const [profile, setProfile] = useState<EncoderProfile>('everyday');
  const [frameRatePreset, setFrameRatePreset] =
    useState<FrameRatePreset>('profile');
  const [colorDepth, setColorDepth] = useState<ColorDepth>('rgb565');
  const [videoMode, setVideoMode] = useState<'default' | VideoMode>('default');
  const [keySeconds, setKeySeconds] = useState(5);
  const [maxRectangles, setMaxRectangles] = useState(8);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [fit, setFit] = useState<FitMode>('contain');
  const [url, setUrl] = useState('');
  const [previewSrc, setPreviewSrc] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewError, setPreviewError] = useState('');
  const [runState, setRunState] = useState<RunState>('idle');
  const [runProgress, setRunProgress] = useState<ProgressState>({
    stage: 'inspect',
    progress: 0,
    detail: 'Waiting for a source',
  });
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [error, setError] = useState('');

  const outputName = useMemo(() => {
    if (file) return `${file.name.replace(/\.[^.]+$/, '') || 'video'}.ipvf`;
    if (url) {
      try {
        const path = new URL(url).pathname.split('/').pop() ?? '';
        return `${decodeURIComponent(path).replace(/\.[^.]+$/, '') || 'video'}.ipvf`;
      } catch {
        return 'video.ipvf';
      }
    }
    return 'video.ipvf';
  }, [file, url]);

  const overallProgress = useMemo(() => {
    const [start, end] = STAGE_WEIGHT[runProgress.stage];
    return start + (end - start) * runProgress.progress;
  }, [runProgress]);

  const drawPreview = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (
      !video ||
      !canvas ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    )
      return;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || !video.videoWidth || !video.videoHeight) return;

    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (fit === 'fill') {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return;
    }
    const scale =
      fit === 'cover'
        ? Math.max(
            canvas.width / video.videoWidth,
            canvas.height / video.videoHeight,
          )
        : Math.min(
            canvas.width / video.videoWidth,
            canvas.height / video.videoHeight,
          );
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    context.drawImage(
      video,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    );
  }, [fit]);

  useEffect(() => {
    drawPreview();
  }, [drawPreview]);

  useEffect(
    () => () => {
      if (filePreviewUrlRef.current)
        URL.revokeObjectURL(filePreviewUrlRef.current);
    },
    [],
  );

  useEffect(() => {
    const worker = new Worker(
      new URL('./workers/converter.worker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.jobId !== jobRef.current) return;
        if (message.type === 'progress') {
          setRunProgress(message);
        } else if (message.type === 'complete') {
          setResult(message);
          setRunState('complete');
          setRunProgress({
            stage: 'done',
            progress: 1,
            detail: 'IPVF structural validation passed',
          });
        } else if (message.type === 'cancelled') {
          setRunState('cancelled');
          setRunProgress({
            stage: 'inspect',
            progress: 0,
            detail: 'Conversion cancelled',
          });
        } else if (message.type === 'error') {
          setError(message.message);
          setRunState('error');
        }
      },
    );
    return () => worker.terminate();
  }, []);

  function selectFile(nextFile: File | null) {
    if (filePreviewUrlRef.current)
      URL.revokeObjectURL(filePreviewUrlRef.current);
    filePreviewUrlRef.current = nextFile ? URL.createObjectURL(nextFile) : '';
    setFile(nextFile);
    setPreviewSrc(filePreviewUrlRef.current);
    setPreviewKey((value) => value + 1);
    setPreviewDuration(0);
    setPreviewTime(0);
    setPreviewError('');
    setResult(null);
    setError('');
    setRunState('idle');
    setFileError('');
  }

  function acceptFile(nextFile: File | null) {
    if (!nextFile) return;
    if (!isVideoFile(nextFile)) {
      setFileError('Choose a video file, such as MP4, MOV, MKV, AVI, or WebM.');
      return;
    }
    selectFile(nextFile);
  }

  function loadUrlPreview() {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      setPreviewError('');
      setPreviewDuration(0);
      setPreviewTime(0);
      setPreviewSrc(url);
      setPreviewKey((value) => value + 1);
    } catch {
      setPreviewError('Enter a complete HTTP or HTTPS direct media URL.');
    }
  }

  function startConversion() {
    if (!workerRef.current) return;
    if (!('storage' in navigator) || !navigator.storage.getDirectory) {
      setError(
        'This browser does not provide the local file storage needed for large, incremental IPVF output.',
      );
      setRunState('error');
      return;
    }
    if (sourceMode === 'file' && !file) return;
    if (sourceMode === 'url') {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        setError('Enter a complete HTTP or HTTPS direct media URL.');
        setRunState('error');
        return;
      }
    }

    const jobId = crypto.randomUUID();
    jobRef.current = jobId;
    setResult(null);
    setError('');
    setRunState('running');
    setRunProgress({
      stage: 'inspect',
      progress: 0,
      detail: 'Starting local conversion',
    });
    const message: WorkerRequest = {
      type: 'start',
      jobId,
      profile,
      frameRate: parseFrameRate(frameRatePreset),
      colorDepth,
      videoMode,
      keySeconds,
      maxRectangles,
      metadata: { title, artist, album },
      fit,
      outputName,
      assetBase: new URL('ffmpeg/', document.baseURI).href,
      source:
        sourceMode === 'file'
          ? { kind: 'file', file: file! }
          : { kind: 'url', url },
    };
    workerRef.current.postMessage(message);
  }

  function cancelConversion() {
    if (!workerRef.current || !jobRef.current) return;
    workerRef.current.postMessage({
      type: 'cancel',
      jobId: jobRef.current,
    } satisfies WorkerRequest);
  }

  async function downloadResult() {
    if (!result) return;
    const output = await getOutputFile(result.opfsName);
    const objectUrl = URL.createObjectURL(output);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = result.outputName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  async function saveResult() {
    if (!result) return;
    const picker = (
      window as Window & {
        showSaveFilePicker?: (
          options: unknown,
        ) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    if (!picker) {
      await downloadResult();
      return;
    }
    const handle = await picker({
      suggestedName: result.outputName,
      types: [
        {
          description: 'IPVF video',
          accept: { 'application/octet-stream': ['.ipvf'] },
        },
      ],
    });
    const writable = await handle.createWritable();
    const output = await getOutputFile(result.opfsName);
    await output.stream().pipeTo(writable);
  }

  const ready = sourceMode === 'file' ? Boolean(file) : Boolean(url.trim());

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6 sm:py-8 lg:px-10">
      <div className="mx-auto max-w-[1180px]">
        <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-[14px] border border-[var(--line-strong)] bg-[var(--ink)] text-[var(--paper)] shadow-[0_3px_0_var(--line-strong)]">
              <Film className="size-5" strokeWidth={1.8} />
            </div>
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted-ink)]">
                iPod Photo utility
              </p>
              <h1 className="text-[22px] font-semibold leading-none tracking-[-0.035em]">
                IPVF Converter
              </h1>
            </div>
          </div>
          <Badge
            variant="outline"
            className="h-7 gap-1.5 border-[var(--line)] bg-white/60 px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-ink)]"
          >
            <LockKeyhole className="size-3" /> Local-only processing
          </Badge>
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.48fr)_minmax(300px,0.72fr)]">
          <div className="overflow-hidden rounded-[26px] border border-[var(--line-strong)] bg-[var(--surface)] shadow-[0_10px_36px_rgb(32_42_45/8%),0_3px_0_var(--line-strong)]">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-5 sm:px-7">
              <div>
                <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">
                  01 / Source
                </p>
                <h2 className="text-xl font-semibold tracking-[-0.025em]">
                  Choose a video
                </h2>
                <p className="mt-1 max-w-lg text-sm leading-6 text-[var(--muted-ink)]">
                  Select a file from this device or use a direct media URL that
                  permits browser access.
                </p>
              </div>
              <div className="hidden size-11 place-items-center rounded-full border border-[var(--line)] bg-[var(--paper)] sm:grid">
                <HardDrive className="size-[18px] text-[var(--teal)]" />
              </div>
            </div>

            <div className="p-5 sm:p-7">
              <div className="mb-5 inline-flex rounded-xl border border-[var(--line)] bg-[var(--paper)] p-1">
                <button
                  className="source-tab"
                  data-active={sourceMode === 'file'}
                  onClick={() => {
                    setSourceMode('file');
                    setPreviewSrc(filePreviewUrlRef.current);
                    setPreviewError('');
                  }}
                  type="button"
                >
                  <FolderOpen className="size-3.5" /> Local file
                </button>
                <button
                  className="source-tab"
                  data-active={sourceMode === 'url'}
                  onClick={() => {
                    setSourceMode('url');
                    setPreviewSrc('');
                    setPreviewError('');
                  }}
                  type="button"
                >
                  <Link2 className="size-3.5" /> Direct URL
                </button>
              </div>

              {sourceMode === 'file' ? (
                <div>
                  <input
                    id="video-file"
                    ref={inputRef}
                    className="sr-only"
                    type="file"
                    accept="video/*,.3g2,.3gp,.avi,.flv,.m2ts,.m4v,.mkv,.mov,.mp4,.mpeg,.mpg,.mts,.ogv,.ts,.webm,.wmv"
                    onChange={(event) =>
                      acceptFile(event.target.files?.[0] ?? null)
                    }
                  />
                  <button
                    type="button"
                    className="file-dropzone group grid min-h-[220px] w-full cursor-pointer place-items-center rounded-[20px] border border-dashed border-[var(--line-strong)] bg-[linear-gradient(135deg,var(--paper),rgb(234_239_234/65%))] p-7 text-center transition hover:border-[var(--teal)]"
                    aria-label={
                      file
                        ? `Replace ${file.name} with another video`
                        : 'Choose or drop a video file'
                    }
                    data-dragging={isDraggingFile}
                    onClick={() => inputRef.current?.click()}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsDraggingFile(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      setIsDraggingFile(true);
                    }}
                    onDragLeave={(event) => {
                      if (
                        event.relatedTarget instanceof Node &&
                        event.currentTarget.contains(event.relatedTarget)
                      )
                        return;
                      setIsDraggingFile(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsDraggingFile(false);
                      const droppedFile = event.dataTransfer.files[0] ?? null;
                      if (!droppedFile) {
                        setFileError('Drop a video file from your device.');
                        return;
                      }
                      acceptFile(droppedFile);
                      if (inputRef.current) inputRef.current.value = '';
                    }}
                  >
                    {file ? (
                      <div className="w-full max-w-md">
                        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-[var(--teal-soft)] text-[var(--teal)]">
                          <CheckCircle2 className="size-6" />
                        </div>
                        <p className="truncate text-base font-semibold">
                          {file.name}
                        </p>
                        <p className="mt-1 font-mono text-xs text-[var(--muted-ink)]">
                          {formatBytes(file.size)} · ready to inspect
                        </p>
                        <p className="mt-3 text-xs text-[var(--muted-ink)]">
                          Drop another video here to replace it
                        </p>
                      </div>
                    ) : (
                      <div>
                        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl border border-[var(--line)] bg-white text-[var(--teal)] shadow-sm transition group-hover:-translate-y-0.5">
                          <FileUp className="size-5" />
                        </div>
                        <p className="font-semibold">
                          {isDraggingFile
                            ? 'Release to add this video'
                            : 'Drop a video here'}
                        </p>
                        <p className="mt-1 text-sm text-[var(--muted-ink)]">
                          or click to browse files on this device
                        </p>
                        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--faint-ink)]">
                          Your media never leaves the browser
                        </p>
                      </div>
                    )}
                  </button>
                  {fileError && (
                    <p
                      className="mt-3 text-center text-xs font-medium text-red-700"
                      role="alert"
                    >
                      {fileError}
                    </p>
                  )}
                  {file && (
                    <div className="mt-3 text-center">
                      <button
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--teal)] hover:underline"
                        type="button"
                        onClick={() => {
                          selectFile(null);
                          if (inputRef.current) inputRef.current.value = '';
                        }}
                      >
                        <X className="size-3.5" /> Remove selected file
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="min-h-[220px] rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-5 sm:p-7">
                  <label
                    className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-ink)]"
                    htmlFor="media-url"
                  >
                    CORS-enabled media URL
                  </label>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      id="media-url"
                      className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--line-strong)] bg-white px-3 text-sm outline-none transition placeholder:text-[var(--faint-ink)] focus:border-[var(--teal)] focus:ring-3 focus:ring-[var(--teal-soft)]"
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setPreviewSrc('');
                        setPreviewError('');
                      }}
                      placeholder="https://example.com/video.mp4"
                      type="url"
                    />
                    <Button
                      variant="outline"
                      className="h-11 rounded-xl border-[var(--line-strong)] bg-white px-4"
                      onClick={loadUrlPreview}
                    >
                      Load preview
                    </Button>
                  </div>
                  <p className="mt-4 text-xs leading-5 text-[var(--muted-ink)]">
                    This accepts a direct file response only. Video pages and
                    streaming services are not download sources.
                  </p>
                </div>
              )}

              {previewSrc && (
                <section
                  className="mt-5 rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4 sm:p-5"
                  aria-label="Frame preview"
                >
                  <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--teal)]">
                        Frame preview · 220 × 176
                      </p>
                      <h3 className="mt-1 text-sm font-semibold">
                        Choose how the source fills the iPod display
                      </h3>
                    </div>
                    {previewDuration > 0 && (
                      <span className="font-mono text-[10px] text-[var(--muted-ink)]">
                        {formatTime(previewTime)} /{' '}
                        {formatTime(previewDuration)}
                      </span>
                    )}
                  </div>

                  <div className="grid gap-5 md:grid-cols-[minmax(260px,1fr)_minmax(220px,0.78fr)]">
                    <div className="relative overflow-hidden rounded-[16px] border border-black/25 bg-black shadow-[0_5px_18px_rgb(32_42_45/18%)]">
                      <canvas
                        ref={canvasRef}
                        width={220}
                        height={176}
                        className="block aspect-[5/4] w-full bg-black"
                      />
                      <video
                        key={previewKey}
                        ref={videoRef}
                        className="sr-only"
                        src={previewSrc}
                        crossOrigin={
                          sourceMode === 'url' ? 'anonymous' : undefined
                        }
                        muted
                        playsInline
                        preload="auto"
                        onLoadedMetadata={(event) => {
                          const duration = Number.isFinite(
                            event.currentTarget.duration,
                          )
                            ? event.currentTarget.duration
                            : 0;
                          const time = 0;
                          setPreviewDuration(duration);
                          setPreviewTime(time);
                          event.currentTarget.currentTime = time;
                        }}
                        onLoadedData={drawPreview}
                        onSeeked={drawPreview}
                        onError={() =>
                          setPreviewError(
                            'This source cannot be previewed by the browser. Conversion may still work through the compatibility decoder.',
                          )
                        }
                      />
                      {!previewDuration && !previewError && (
                        <div className="absolute inset-0 grid place-items-center bg-black/55 text-xs text-white/75">
                          Loading frame…
                        </div>
                      )}
                    </div>

                    <div>
                      <fieldset disabled={runState === 'running'}>
                        <label
                          className="block text-xs font-semibold"
                          htmlFor="framing-mode"
                        >
                          Framing
                        </label>
                        <select
                          id="framing-mode"
                          className="ipvf-select ipvf-select-light mt-2 h-10 w-full rounded-xl border border-[var(--line-strong)] px-3 text-xs outline-none focus:border-[var(--teal)] focus:ring-3 focus:ring-[var(--teal-soft)]"
                          value={fit}
                          onChange={(event) =>
                            setFit(event.target.value as FitMode)
                          }
                        >
                          <option value="contain">
                            Letterbox — keep the whole frame
                          </option>
                          <option value="cover">
                            Crop to fill — trim outer edges
                          </option>
                          <option value="fill">
                            Stretch to fill — use every pixel
                          </option>
                        </select>
                      </fieldset>

                      {previewDuration > 0 && (
                        <label
                          className="mt-4 block text-xs font-semibold"
                          htmlFor="preview-time"
                        >
                          Preview frame
                          <input
                            id="preview-time"
                            className="mt-2 block w-full accent-[var(--teal)]"
                            type="range"
                            min="0"
                            max={previewDuration}
                            step={0.01}
                            value={previewTime}
                            onChange={(event) => {
                              const time = Number(event.target.value);
                              setPreviewTime(time);
                              if (videoRef.current)
                                videoRef.current.currentTime = time;
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                  {previewError && (
                    <p className="mt-3 text-xs leading-5 text-amber-800">
                      {previewError}
                    </p>
                  )}
                </section>
              )}

              {(runState === 'running' ||
                runState === 'complete' ||
                runState === 'error' ||
                runState === 'cancelled') && (
                <div
                  className="mt-5 rounded-[18px] border border-[var(--line)] bg-white/75 p-4 sm:p-5"
                  aria-live="polite"
                >
                  {runState === 'error' ? (
                    <div className="flex gap-3">
                      <X className="mt-0.5 size-5 shrink-0 text-red-700" />
                      <div>
                        <p className="text-sm font-semibold">
                          Conversion stopped
                        </p>
                        <p className="mt-1 text-xs leading-5 text-[var(--muted-ink)]">
                          {error}
                        </p>
                      </div>
                    </div>
                  ) : runState === 'cancelled' ? (
                    <p className="text-sm font-medium text-[var(--muted-ink)]">
                      Conversion cancelled. The partial output was not offered
                      for download.
                    </p>
                  ) : (
                    <Progress value={overallProgress} className="gap-2">
                      <ProgressLabel>
                        {friendlyStage(runProgress.stage)}
                      </ProgressLabel>
                      <span className="ml-auto text-sm tabular-nums text-[var(--muted-ink)]">
                        {Math.round(overallProgress)}%
                      </span>
                      <span className="basis-full text-xs text-[var(--muted-ink)]">
                        {runProgress.detail}
                        {runProgress.frameCount
                          ? ` · ${runProgress.frame?.toLocaleString()} / ${runProgress.frameCount.toLocaleString()} frames`
                          : ''}
                      </span>
                    </Progress>
                  )}
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-5">
            <section className="rounded-[24px] border border-[var(--line-strong)] bg-[var(--ink)] p-5 text-[var(--paper)] shadow-[0_3px_0_rgb(20_28_30)] sm:p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--mint)]">
                    02 / Output
                  </p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em]">
                    IPVF settings
                  </h2>
                </div>
                <CircleGauge className="size-5 text-[var(--mint)]" />
              </div>
              <fieldset className="space-y-4" disabled={runState === 'running'}>
                <div>
                  <label
                    className="mb-2 block text-xs font-medium text-white/65"
                    htmlFor="creator-profile"
                  >
                    Creator profile
                  </label>
                  <select
                    id="creator-profile"
                    className="ipvf-select ipvf-select-dark h-10 w-full rounded-xl border border-white/15 px-3 text-xs outline-none focus:border-[var(--mint)]"
                    value={profile}
                    onChange={(event) =>
                      setProfile(event.target.value as EncoderProfile)
                    }
                  >
                    <option value="everyday">
                      Everyday — source cadence up to 30 fps
                    </option>
                    <option value="native">
                      Native — full RGB565 precision
                    </option>
                    <option value="compact">Compact — fixed 20 fps</option>
                  </select>
                </div>

                <label className="block text-xs font-medium text-white/65">
                  Frame rate
                  <select
                    className="ipvf-select ipvf-select-dark mt-2 h-10 w-full rounded-xl border border-white/15 px-3 text-xs outline-none focus:border-[var(--mint)]"
                    value={frameRatePreset}
                    onChange={(event) => {
                      const value = event.target.value as FrameRatePreset;
                      setFrameRatePreset(value);
                      if (
                        value === '60/1' &&
                        (videoMode === 'motion' || videoMode === 'auto')
                      )
                        setVideoMode('default');
                    }}
                  >
                    <option value="profile">Profile default</option>
                    <option value="20/1">20 fps</option>
                    <option value="24000/1001">23.976 fps</option>
                    <option value="24/1">24 fps</option>
                    <option value="25/1">25 fps</option>
                    <option value="30000/1001">29.97 fps</option>
                    <option value="30/1">30 fps</option>
                    <option value="60/1">60 fps</option>
                  </select>
                </label>

                <label className="block text-xs font-medium text-white/65">
                  Color quality
                  <select
                    className="ipvf-select ipvf-select-dark mt-2 h-10 w-full rounded-xl border border-white/15 px-3 text-xs outline-none focus:border-[var(--mint)]"
                    value={colorDepth}
                    onChange={(event) =>
                      setColorDepth(event.target.value as ColorDepth)
                    }
                  >
                    <option value="rgb565">RGB565 · full quality</option>
                    <option value="rgb555">RGB555 · light reduction</option>
                    <option value="rgb454">RGB454 · compact</option>
                    <option value="rgb444">RGB444 · smallest palette</option>
                  </select>
                </label>

                <details className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-white/75">
                    Advanced encoder options
                  </summary>
                  <div className="mt-4 space-y-3">
                    <label className="block text-[11px] text-white/60">
                      Video mode
                      <select
                        className="ipvf-select ipvf-select-dark mt-1.5 h-9 w-full rounded-lg border border-white/15 px-2.5 text-xs"
                        value={videoMode}
                        onChange={(event) =>
                          setVideoMode(
                            event.target.value as 'default' | VideoMode,
                          )
                        }
                      >
                        <option value="default">
                          Default — Balanced ≤30 / Spatial &gt;30
                        </option>
                        <option value="current">Bounds only (spatial)</option>
                        <option value="spatial">
                          Spatial — independent-frame safety
                        </option>
                        <option
                          value="motion"
                          disabled={frameRatePreset === '60/1'}
                        >
                          Motion — maximum size savings (≤30 fps)
                        </option>
                        <option
                          value="auto"
                          disabled={frameRatePreset === '60/1'}
                        >
                          Auto — motion + XOR (experimental, ≤30 fps)
                        </option>
                      </select>
                    </label>
                    <p className="text-[10px] leading-4 text-white/50">
                      Through 30 fps, Default uses motion only for meaningful
                      per-frame wins of at least 5 KiB; above 30 fps it uses
                      Spatial. Explicit Motion prioritizes the smallest file.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-[11px] text-white/60">
                        Key interval (sec)
                        <input
                          className="mt-1.5 h-9 w-full rounded-lg border border-white/15 bg-[var(--ink)] px-2.5 text-xs text-white"
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={keySeconds}
                          onChange={(event) =>
                            setKeySeconds(Number(event.target.value))
                          }
                        />
                      </label>
                      <label className="text-[11px] text-white/60">
                        Max rectangles
                        <input
                          className="mt-1.5 h-9 w-full rounded-lg border border-white/15 bg-[var(--ink)] px-2.5 text-xs text-white"
                          type="number"
                          min="1"
                          max="255"
                          step="1"
                          value={maxRectangles}
                          onChange={(event) =>
                            setMaxRectangles(Number(event.target.value))
                          }
                        />
                      </label>
                    </div>
                    <div className="space-y-2 border-t border-white/10 pt-3">
                      <p className="text-[11px] text-white/60">
                        Metadata · blank fields inherit source tags
                      </p>
                      {(
                        [
                          ['Title', title, setTitle],
                          ['Artist', artist, setArtist],
                          ['Album', album, setAlbum],
                        ] as const
                      ).map(([label, value, setter]) => (
                        <label key={label} className="block">
                          <span className="sr-only">{label}</span>
                          <input
                            className="h-9 w-full rounded-lg border border-white/15 bg-[var(--ink)] px-2.5 text-xs text-white placeholder:text-white/35"
                            type="text"
                            maxLength={255}
                            placeholder={label}
                            value={value}
                            onChange={(event) => setter(event.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </details>
              </fieldset>
              <div className="my-5 h-px bg-white/10" />
              <dl className="space-y-3 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-white/55">Display</dt>
                  <dd className="font-mono text-[11px]">
                    220 × 176 · {colorDepth.toUpperCase()}BE
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-white/55">Compression</dt>
                  <dd className="font-mono text-[11px]">built-in LZ4</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-white/55">Framing</dt>
                  <dd className="font-mono text-[11px]">
                    {
                      {
                        contain: 'letterbox',
                        cover: 'crop to fill',
                        fill: 'stretch to fill',
                      }[fit]
                    }
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-white/55">Audio</dt>
                  <dd className="font-mono text-[11px]">
                    44.1 kHz · adaptive IMA ADPCM
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-white/55">Output</dt>
                  <dd className="max-w-[170px] truncate font-mono text-[11px]">
                    {outputName}
                  </dd>
                </div>
              </dl>
              {runState === 'running' ? (
                <Button
                  className="mt-6 h-12 w-full rounded-xl bg-white/10 text-white hover:bg-white/15"
                  onClick={cancelConversion}
                >
                  <Square className="size-3.5 fill-current" /> Cancel conversion
                </Button>
              ) : (
                <Button
                  className="mt-6 h-12 w-full rounded-xl bg-[var(--mint)] text-[var(--ink)] hover:bg-[var(--mint-bright)]"
                  disabled={!ready}
                  onClick={startConversion}
                >
                  <Sparkles className="size-4" /> Convert to IPVF
                </Button>
              )}
            </section>

            {result && runState === 'complete' ? (
              <section className="rounded-[22px] border border-[var(--teal)] bg-[var(--teal-soft)] p-5">
                <div className="flex gap-3">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[var(--teal)]" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">
                      Validated and ready
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-[var(--muted-ink)]">
                      {result.report.frameCount.toLocaleString()} frames ·{' '}
                      {result.report.fpsNumerator}/
                      {result.report.fpsDenominator} fps ·{' '}
                      {formatBytes(result.report.fileBytes)} ·{' '}
                      {result.report.indexCount} indexed keys · {result.engine}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    className="h-10 rounded-xl bg-[var(--ink)] text-[var(--paper)]"
                    onClick={downloadResult}
                  >
                    <Download className="size-4" /> Download
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 rounded-xl border-[var(--line-strong)] bg-white/70"
                    onClick={saveResult}
                  >
                    <Save className="size-4" /> Save as
                  </Button>
                </div>
              </section>
            ) : (
              <section className="rounded-[22px] border border-[var(--line)] bg-white/60 p-5">
                <div className="flex gap-3">
                  <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-[var(--teal)]" />
                  <div>
                    <h3 className="text-sm font-semibold">
                      Validated before download
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-[var(--muted-ink)]">
                      Header, metadata, record links, reconstructed video,
                      adaptive audio, sector padding, media identity, and the
                      keyframe index are checked against the Rockbox contract.
                    </p>
                  </div>
                </div>
              </section>
            )}
          </aside>
        </section>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 px-1 text-[11px] text-[var(--faint-ink)]">
          <p>No uploads. No account. No arbitrary YouTube downloading.</p>
          <a
            className="flex items-center gap-1.5 font-mono uppercase tracking-[0.1em] hover:text-[var(--teal)]"
            href="https://github.com/jspann21/ipod-ipvf-converter"
            target="_blank"
            rel="noreferrer"
          >
            Source on GitHub <ExternalLink className="size-3" />
          </a>
        </footer>
      </div>
    </main>
  );
}
