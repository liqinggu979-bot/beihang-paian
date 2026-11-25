/** Site policy. A null collection/model policy and enabled reports retain upstream behavior. */
export interface WorkflowPolicy {
  collection: null | { intervalMinutes: number; adaptive: boolean; retryAtNextCycle: boolean; useLastSuccessfulCheck: boolean };
  reportsEnabled: boolean;
  translationEnabled: boolean;
  quietContentAlerts: boolean;
  models: null | { dailyCny: number; inputByteLimit: number; outputTokenLimit: number; envelopeTokens: number };
}
export const UPSTREAM_WORKFLOW: WorkflowPolicy = {
  collection: null, reportsEnabled: true, translationEnabled: true, quietContentAlerts: true, models: null,
};
export const WORKFLOW: WorkflowPolicy = {
  collection: { intervalMinutes: 2880, adaptive: false, retryAtNextCycle: true, useLastSuccessfulCheck: true },
  reportsEnabled: false, translationEnabled: false, quietContentAlerts: false,
  models: { dailyCny: 1, inputByteLimit: 24000, outputTokenLimit: 3000, envelopeTokens: 256 },
};
