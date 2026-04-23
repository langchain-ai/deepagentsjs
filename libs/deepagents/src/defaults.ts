const FALLBACK_MODEL = "anthropic:claude-sonnet-4-6";

let _warned = false;

export function getDefaultModel(): string {
  if (!_warned) {
    _warned = true;
    process.emitWarning(
      "Passing `model=undefined` to `createDeepAgent` is deprecated and " +
        "will be removed in a future release. The `model` parameter will " +
        "become required. Please specify a model explicitly.",
      "DeprecationWarning",
    );
  }
  return FALLBACK_MODEL;
}
