import type {
  ColorDepth,
  FrameRate,
  IpvfMetadata,
  ValidationReport,
  VideoMode,
} from './ipvf';

export type ConversionSource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string };

export type FitMode = 'contain' | 'cover' | 'fill';
export type EncoderProfile = 'everyday' | 'native' | 'compact';
export type FrameRateSetting = 'profile' | FrameRate;

export type StartConversionMessage = {
  type: 'start';
  jobId: string;
  source: ConversionSource;
  profile: EncoderProfile;
  frameRate: FrameRateSetting;
  colorDepth: ColorDepth;
  videoMode: 'default' | VideoMode;
  keySeconds: number;
  maxRectangles: number;
  metadata: IpvfMetadata;
  fit: FitMode;
  outputName: string;
  assetBase: string;
};

export type CancelConversionMessage = {
  type: 'cancel';
  jobId: string;
};

export type WorkerRequest = StartConversionMessage | CancelConversionMessage;

export type ConversionStage =
  | 'inspect'
  | 'audio'
  | 'video'
  | 'validate'
  | 'done';

export type WorkerResponse =
  | {
      type: 'progress';
      jobId: string;
      stage: ConversionStage;
      progress: number;
      detail: string;
      bytesWritten?: number;
      frame?: number;
      frameCount?: number;
    }
  | {
      type: 'complete';
      jobId: string;
      outputName: string;
      opfsName: string;
      duration: number;
      sourceVideoCodec: string;
      sourceAudioCodec: string;
      engine: 'WebCodecs' | 'ffmpeg.wasm → WebCodecs';
      report: ValidationReport;
    }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string; detail?: string };
