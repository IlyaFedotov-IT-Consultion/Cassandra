/** The judge service answered with a non-success status. */
export class JudgeServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JudgeServiceError";
  }
}
