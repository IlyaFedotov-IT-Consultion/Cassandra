import type { JudgmentServiceDeps, CreateJudgmentInput } from "../modules/judgments/service.js";
import { runJudgment } from "../modules/judgments/service.js";

export async function runJudgmentWorker(
  args: JudgmentServiceDeps & {
    input: CreateJudgmentInput;
  },
) {
  return runJudgment(args);
}
