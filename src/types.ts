/**
 * Shared types for Snooker Match.
 *
 * Coordinate conventions:
 * - Raw camera frames are 16:9 (RAW_W x RAW_H), RGB, 3 bytes per pixel.
 * - The CalibrationAgent computes a homography from four user-tapped table
 *   corners which maps raw pixels into "canonical" table coordinates: a
 *   rectified top-down view of the playing surface, CANON_W x CANON_H (2:1,
 *   matching a snooker table's playing area ratio).
 * - All detection, colour classification, differencing and rules logic work
 *   in canonical coordinates so they are independent of camera placement.
 */

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const RAW_W = 320;
export const RAW_H = 180;
export const CANON_W = 320;
export const CANON_H = 160;
export const FPS = 30;

/** An RGB frame (3 bytes per pixel, row-major). */
export interface Frame {
  width: number;
  height: number;
  /** RGB, length = width * height * 3 */
  data: Uint8Array;
  /** Milliseconds since match epoch. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

export const BALL_COLOURS = [
  "red",
  "yellow",
  "green",
  "brown",
  "blue",
  "pink",
  "black",
  "cue",
] as const;

export type BallColour = (typeof BALL_COLOURS)[number];

/** Point values for potting each ball (cue ball is never legally potted). */
export const BALL_VALUES: Record<BallColour, number> = {
  red: 1,
  yellow: 2,
  green: 3,
  brown: 4,
  blue: 5,
  pink: 6,
  black: 7,
  cue: 4, // minimum foul basis when the cue ball is potted; the penalty also
  // considers the value of the ball on (FR-3)
};

/** Order colours are cleared in the final sequence. */
export const COLOUR_SEQUENCE: BallColour[] = [
  "yellow",
  "green",
  "brown",
  "blue",
  "pink",
  "black",
];

/** A raw class-agnostic ball detection from the DetectionAgent. */
export interface Detection {
  /** Canonical-coordinate centre. */
  x: number;
  y: number;
  /** Estimated radius in canonical units. */
  r: number;
  /** Detector confidence in [0, 1]. */
  confidence: number;
}

/** A detection with a colour assignment from the ColourClassifier. */
export interface ClassifiedBall {
  colour: BallColour;
  x: number;
  y: number;
  /** Combined detection+classification confidence in [0, 1]. */
  confidence: number;
}

/** A consensus snapshot of the balls on the table at a stable moment. */
export interface TableState {
  timestamp: number;
  balls: ClassifiedBall[];
  /** Mean confidence over the consensus window. */
  confidence: number;
}

export type ShotChangeKind = "potted" | "respotted" | "moved";

export interface ShotChange {
  kind: ShotChangeKind;
  colour: BallColour;
}

/** Emitted by the StateObserver when two stable states differ. */
export interface Shot {
  before: TableState;
  after: TableState;
  changes: ShotChange[];
}

/** 3x3 homography matrix, row-major. */
export type Homography = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface Point {
  x: number;
  y: number;
}

/** CIELAB colour value. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

export type ColourCentroids = Record<BallColour, Lab>;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export type MotionPhase = "stable" | "moving" | "settling";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RulePresetId = "professional" | "amateur" | "club";

export const RULE_PRESET_IDS: RulePresetId[] = [
  "professional",
  "amateur",
  "club",
];

export interface RulePreset {
  id: RulePresetId;
  label: string;
  /**
   * How a foul penalty is computed from the value of the ball involved.
   * Professional/Amateur: max(4, ballValue). Club: flat 4 regardless.
   */
  foulPenalty: (ballValue: number) => number;
  /** Whether the "miss" rule is available (professional only in v1). */
  missRule: boolean;
  /** Whether a tied frame respots the black (professional) or ends in sudden
   *  death awarded to the last potter (amateur/club simplification). */
  respotBlackOnTie: boolean;
  /** Whether a foul with only the black remaining ends the frame (WPBSA-style
   *  professional/amateur; club plays on until the black is actually potted). */
  foulOnBlackEndsFrame: boolean;
  /** Number of reds racked at the start of each frame. */
  reds: number;
  /** Human-readable description of the differences, shown in the UI. */
  description: string;
}

export type Player = 1 | 2;

/** What the striker must hit/pot next. */
export type BallOn = "red" | "colour" | BallColour;

export interface FrameScores {
  1: number;
  2: number;
}

export type MatchPhase =
  | "setup"
  | "reds_and_colours"
  | "final_colours"
  | "frame_over"
  | "match_over";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventSource = "vision" | "human" | "system";

export type MatchEventType =
  | "MATCH_STARTED"
  | "POT"
  | "FOUL"
  | "MISS"
  | "END_OF_TURN"
  | "FRAME_ADVANCED"
  | "MATCH_OVER"
  | "CORRECTION"
  | "UNDO"
  | "SCORE_ADJUSTED"
  | "PRESET_CHANGED"
  | "THRESHOLD_CHANGED"
  | "NOTIFICATION"
  | "NOTIFICATION_CLEARED"
  | "FALLBACK_ACTIVATED"
  | "FALLBACK_CLEARED"
  | "CALIBRATION"
  | "RESPOT";

export interface MatchEvent {
  id: number;
  timestamp: number;
  type: MatchEventType;
  source: EventSource;
  message: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationReason = "low_confidence" | "occlusion" | null;

export interface NotificationState {
  active: boolean;
  reason: NotificationReason;
  /** Milliseconds since epoch when the problem was first detected. */
  since: number | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type CorrectionType =
  | "POT_MISSED" // model missed a pot; operator supplies the colour
  | "WRONG_COLOUR" // model potted the wrong colour; operator corrects it
  | "FOUL" // manual foul call with the ball involved
  | "UNDO" // revert the last scoring event
  | "CORRECT_SCORE" // set absolute scores
  | "SWITCH_PLAYER"; // active-player fix

export interface Correction {
  type: CorrectionType;
  colour?: BallColour;
  scores?: FrameScores;
  note?: string;
}

/** Recorded so future model fine-tuning can learn from human overrides and
 *  calibration captures (FR-9, FR-12). */
export interface FineTuningSample {
  timestamp: number;
  /** The human correction, or null for a calibration frame capture (FR-9). */
  correction: Correction | null;
  /** Table state snapshot at correction/capture time, when available. */
  tableState: TableState | null;
  modelName: string;
  /** Downsampled rectified frame snapshot (calibration captures only). */
  frame?: Frame;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationData {
  /** Four raw-frame corner taps, in order TL, TR, BR, BL. */
  corners: [Point, Point, Point, Point] | null;
  homography: Homography | null;
  centroids: ColourCentroids | null;
  calibratedAt: number | null;
  /** Frames captured by the calibration step for fine-tuning. */
  capturedFrames: number;
}

// ---------------------------------------------------------------------------
// Model artifact
// ---------------------------------------------------------------------------

/**
 * Fitted parameters of the ball detector. On Android this slot is a real
 * YOLO-style ONNX network executed by onnxruntime; in this local build the
 * artifact carries deterministic blob-detector parameters fitted by the
 * ModelTrainer from synthetic labelled frames. The file container and the
 * load/inference interface are identical either way.
 */
export interface ModelParams {
  /** Baize (cloth) reference colour in RGB. */
  baize: [number, number, number];
  /** Minimum per-channel colour distance from baize to count as "ball". */
  diffThreshold: number;
  /** Ball radius bounds in canonical units. */
  minRadius: number;
  maxRadius: number;
}

export interface ModelArtifact {
  name: string;
  version: string;
  classes: ["ball"];
  trainedAt: string;
  sampleCount: number;
  params: ModelParams;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export type Role = "operator" | "viewer";

export interface GrantManifest {
  roles: Record<Role, { read: boolean; correct: boolean }>;
}

// ---------------------------------------------------------------------------
// Workflow state (the single source of truth — plan task 9)
// ---------------------------------------------------------------------------

export interface SystemStatus {
  modelName: string;
  modelVersion: string;
  calibrated: boolean;
  fallbackActive: boolean;
  fps: number;
}

export interface WorkflowStateData {
  // Match
  players: { 1: string; 2: string };
  scores: FrameScores;
  framesWon: FrameScores;
  frameNumber: number;
  bestOf: number;
  activePlayer: Player;
  currentBreak: number;
  ballOn: BallOn;
  redsRemaining: number;
  coloursRemaining: BallColour[];
  remainingPoints: number;
  phase: MatchPhase;
  // Setup
  rulePreset: RulePresetId;
  confidenceThreshold: number;
  // Timing
  shotTimerStartedAt: number;
  now: number;
  // Vision
  calibration: CalibrationData;
  latestTableState: TableState | null;
  previousTableState: TableState | null;
  // Notifications & fallback
  notification: NotificationState;
  fallback: {
    active: boolean;
    since: number | null;
    lowConfidenceSince: number | null;
  };
  // Logs & learning
  eventLog: MatchEvent[];
  fineTuningBuffer: FineTuningSample[];
  // Status
  status: SystemStatus;
}
