import type { JudgmentServiceDeps, RunJudgmentInput } from "../modules/judgments/service.js";
import { runJudgment } from "../modules/judgments/service.js";

export async function runJudgmentWorker(
  args: JudgmentServiceDeps & {
    input: RunJudgmentInput;
  },
) {
  return runJudgment(args);
}
