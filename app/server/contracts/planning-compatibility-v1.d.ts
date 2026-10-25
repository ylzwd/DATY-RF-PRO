/** Effective planning evidence stored inside the existing run result; no new API. */
export type CompatibilityLevel = 'standard' | 'robust' | 'more-frequencies';
export interface PlanningCompatibilitySnapshot {
  version: 'daty-compatibility-v1';
  level: CompatibilityLevel;
  label: '标准' | '保守' | '紧凑';
  /** All input channels, including unassigned ones. Identity is never GROUP. */
  devices: Array<{
    deviceId: string | number;
    profileId: string;
    deviceModeId: string | null;
    channelSpacingKHz: number;
    /** Nonnegative integer kHz. DATY compact defaults to 0, explicitly no effective IMD guard. */
    intermodSpacingKHz: number;
    scanThresholdDbm: number;
    scanGuardKHz: number;
    candidateStepKHz: number;
  }>;
}
/** Historical results may lack this evidence; do not invent it from current profiles. */
export interface ResultCompatibilityEvidence {
  compatibility?: PlanningCompatibilitySnapshot;
  frequencyPool?: PlanningFrequencyPool;
  distribution?: {
    policy: 'legacy' | 'spread-range';
    enabled: boolean;
    targetCount: number;
    rangeStartKHz: number;
    rangeEndKHz: number;
    /** Preference only, rounded to integer kHz. Actual assignments still enforce all constraints. */
    preferredFrequencies: Array<{deviceId: string | number; frequencyKHz: number}>;
  };
}
/** Historical/explicit optional pools only. Current UI requests 0 in all modes.
 * Reserves are unbound frequency data, never device assignments or control targets.
 * Existing historical results may have no pool. Values are integer kHz/counts. */
export interface PlanningFrequencyPool {
  version: 'daty-frequency-pool-v1';
  targetCount: number;
  actualCount: number;
  plannedCount: number;
  reservedFrequenciesKHz: number[];
  shortfall: number;
  complete: boolean;
  checkedCandidates: number;
  truncated: boolean;
  scope: 'all-input-profile-intersection';
  strategy: 'ascending-first-fit';
  channelSpacingKHz: number;
  intermodSpacingKHz: number;
}
