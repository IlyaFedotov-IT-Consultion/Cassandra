import type { AppEnv } from "../../config/env.js";

export const LIVE_EVALUATION_REQUIRED_MESSAGE =
  "Real evaluations require CASSANDRA_ADAPTER_MODE=live";

export function assertLiveEvaluationMode(env: Pick<AppEnv, "CASSANDRA_ADAPTER_MODE">): void {
  if (env.CASSANDRA_ADAPTER_MODE !== "live") {
    throw new Error(LIVE_EVALUATION_REQUIRED_MESSAGE);
  }
}
