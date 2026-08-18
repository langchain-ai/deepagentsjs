export const RUNBOOK_PATH = "/runbooks/on-call.md";

/**
 * Two facts (the timeout value and the incident ID) are split across two
 * files and never stated together anywhere. The parent has to actually read
 * both to know both — a hand-written task description is the likely place
 * for one of them to get dropped.
 */
export const initialFiles: Record<string, string> = {
  "/services/payments/config.py": `# Payment gateway configuration
GATEWAY_URL = "https://gateway.internal/v3/charge"
MAX_RETRIES = 3
RETRY_TIMEOUT_MS = 450
CIRCUIT_BREAKER_THRESHOLD = 5
`,
  "/services/payments/client.py": `import time
from config import RETRY_TIMEOUT_MS, MAX_RETRIES

def call_gateway(payload):
    # NOTE: bumped RETRY_TIMEOUT_MS from 200ms to 450ms after INC-4471
    # (gateway timeouts under load during the Black Friday traffic spike)
    for attempt in range(MAX_RETRIES):
        try:
            return _send(payload)
        except TimeoutError:
            time.sleep(RETRY_TIMEOUT_MS / 1000)
    raise RuntimeError("gateway unreachable")
`,
  [RUNBOOK_PATH]: `# Payments On-Call Runbook

## Alerting
Page on-call if the gateway error rate exceeds 5% for 10 minutes.

## Escalation
Escalate to #payments-eng if unresolved after 30 minutes.
`,
};

export const QUERY =
  "We just changed the payment gateway's retry timeout. Look at /services/payments/config.py " +
  "and /services/payments/client.py to find the current timeout value in milliseconds and the " +
  "incident that caused the change, then delegate to the 'runbook_writer' subagent to append a " +
  `new "## Retry Timeout" section to ${RUNBOOK_PATH} stating the exact timeout value and the ` +
  "reason it changed.";

export const QUERY_WITH_EXPLICIT_INSTRUCTION =
  QUERY +
  " When you delegate, write the exact timeout value and incident ID directly in the task " +
  "description itself — don't just refer to 'the file' or 'what I found'.";

/** Both facts must appear in the runbook for the delegation to have actually worked. */
export const EXPECTED_FACTS = ["450", "INC-4471"];

export function buildRunbookWriterSubagent(mode: "handoff" | "fork") {
  return {
    name: "runbook_writer",
    description:
      "Writes and edits sections of the on-call runbook. Give it the exact facts to record — " +
      "it will not guess.",
    systemPrompt:
      "You are a technical writer for the on-call runbook. Append the requested section using " +
      "only the exact facts you were given. If a fact is missing, write 'UNKNOWN' rather than " +
      "guessing.",
    mode,
  };
}
