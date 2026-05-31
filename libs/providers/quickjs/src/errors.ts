/**
 * Options for constructing a {@link PTCCallBudgetExceededError}.
 */
interface PTCCallBudgetExceededOptions {
  /**
   * The configured per-eval PTC call limit.
   */
  limit: number;

  /**
   * The call number that triggered the violation (always `limit + 1`).
   */
  attempted: number;

  /**
   * The name of the tool function that was called over budget.
   */
  functionName: string;
}

/**
 * Thrown when a single eval exhausts its configured PTC call budget.
 */
export class PTCCallBudgetExceededError extends Error {
  readonly limit: number;
  readonly attempted: number;
  readonly functionName: string;

  constructor(options: PTCCallBudgetExceededOptions) {
    super(
      `PTC call budget exceeded (limit=${options.limit}, attempted=${options.attempted}, function=${options.functionName})`,
    );
    this.name = "PTCCallBudgetExceededError";
    this.limit = options.limit;
    this.attempted = options.attempted;
    this.functionName = options.functionName;
  }
}
