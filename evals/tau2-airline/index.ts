import * as ls from "langsmith/vitest";
import { beforeEach, expect, vi } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import type { EvalRunner } from "@deepagents/evals";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function spiedTool(
  fn: (...args: any[]) => any,
  config: { name: string; description: string; schema: any },
) {
  const spy = vi.fn(fn);
  return { tool: tool(spy, config), spy };
}

const { tool: lookupReservation, spy: lookupReservationSpy } = spiedTool(
  ({ confirmation_code }) => ({
    confirmation_code,
    passenger: "Alex Doe",
    status: "confirmed",
    flights: ["LC102"],
  }),
  {
    name: "lookup_reservation",
    description: "Look up reservation details by confirmation code.",
    schema: z.object({ confirmation_code: z.string() }),
  },
);

const { tool: verifyIdentity, spy: verifyIdentitySpy } = spiedTool(
  ({ last_name, email }) => ({ verified: true, last_name, email }),
  {
    name: "verify_identity",
    description: "Verify traveler identity before sensitive changes.",
    schema: z.object({ last_name: z.string(), email: z.string() }),
  },
);

const { tool: rebookFlight, spy: rebookFlightSpy } = spiedTool(
  ({ confirmation_code, new_flight }) =>
    `Rebooked ${confirmation_code} to ${new_flight}. Fee waived due to weather.`,
  {
    name: "rebook_flight",
    description: "Rebook a flight to a new flight number.",
    schema: z.object({ confirmation_code: z.string(), new_flight: z.string() }),
  },
);

const { tool: cancelFlight, spy: cancelFlightSpy } = spiedTool(
  ({ confirmation_code }) => `Cancelled ${confirmation_code}.`,
  {
    name: "cancel_flight",
    description: "Cancel a reservation.",
    schema: z.object({ confirmation_code: z.string() }),
  },
);

const { tool: requestRefund, spy: requestRefundSpy } = spiedTool(
  ({ confirmation_code }) => `Refund requested for ${confirmation_code}.`,
  {
    name: "request_refund",
    description: "Request a refund for an eligible cancellation.",
    schema: z.object({ confirmation_code: z.string() }),
  },
);

const { tool: seatUpgrade, spy: seatUpgradeSpy } = spiedTool(
  ({ confirmation_code, cabin }) =>
    `Upgraded ${confirmation_code} to ${cabin}.`,
  {
    name: "seat_upgrade",
    description: "Upgrade seat cabin for a reservation.",
    schema: z.object({ confirmation_code: z.string(), cabin: z.string() }),
  },
);

const { tool: sendConfirmation, spy: sendConfirmationSpy } = spiedTool(
  ({ confirmation_code, channel }) =>
    `Sent confirmation for ${confirmation_code} via ${channel}.`,
  {
    name: "send_confirmation",
    description: "Send itinerary confirmation through a specified channel.",
    schema: z.object({ confirmation_code: z.string(), channel: z.string() }),
  },
);

const ALL_TOOLS = [
  lookupReservation,
  verifyIdentity,
  rebookFlight,
  cancelFlight,
  requestRefund,
  seatUpgrade,
  sendConfirmation,
] as const;

const POLICY_PROMPT = `
You are an airline support agent.
Policy:
1. Verify identity before rebooking, cancellation, refund, or upgrades.
2. Always look up reservation before actioning a change.
3. Send confirmation after any successful change.
4. Be concise and accurate.
`;

type TaskCase = {
  taskId: string;
  query: string;
  requiredTool: string;
  expectedText: string;
};

const TASKS: TaskCase[] = [
  {
    taskId: "2",
    query:
      "Rebook reservation ZX91 to flight LC208. My last name is Doe and email is alex@example.com.",
    requiredTool: "rebook_flight",
    expectedText: "LC208",
  },
  {
    taskId: "5",
    query: "Cancel confirmation ZX91. Last name Doe, email alex@example.com.",
    requiredTool: "cancel_flight",
    expectedText: "cancel",
  },
  {
    taskId: "7",
    query:
      "Please request a refund for ZX91. I am Alex Doe at alex@example.com.",
    requiredTool: "request_refund",
    expectedText: "refund",
  },
  {
    taskId: "9",
    query:
      "Upgrade ZX91 to business class. Last name Doe, email alex@example.com.",
    requiredTool: "seat_upgrade",
    expectedText: "business",
  },
  {
    taskId: "14",
    query: "Check booking ZX91 and send confirmation to email.",
    requiredTool: "send_confirmation",
    expectedText: "email",
  },
  {
    taskId: "23",
    query: "Move ZX91 to LC350 and notify me by sms. Doe / alex@example.com",
    requiredTool: "rebook_flight",
    expectedText: "LC350",
  },
  {
    taskId: "27",
    query: "Cancel ZX91 and text me confirmation. Doe / alex@example.com",
    requiredTool: "cancel_flight",
    expectedText: "cancel",
  },
  {
    taskId: "29",
    query: "Upgrade ZX91 to premium economy. Doe / alex@example.com",
    requiredTool: "seat_upgrade",
    expectedText: "premium",
  },
  {
    taskId: "32",
    query: "Rebook ZX91 to LC412 due to weather. Doe / alex@example.com",
    requiredTool: "rebook_flight",
    expectedText: "LC412",
  },
  {
    taskId: "33",
    query: "Request refund for cancelled booking ZX91. Doe / alex@example.com",
    requiredTool: "request_refund",
    expectedText: "refund",
  },
  {
    taskId: "35",
    query:
      "Please cancel ZX91 and then send an email confirmation. Doe / alex@example.com",
    requiredTool: "cancel_flight",
    expectedText: "email",
  },
  {
    taskId: "37",
    query: "I need an upgrade for ZX91 to first class. Doe / alex@example.com",
    requiredTool: "seat_upgrade",
    expectedText: "first",
  },
  {
    taskId: "38",
    query:
      "Rebook ZX91 to LC499 and send sms confirmation. Doe / alex@example.com",
    requiredTool: "rebook_flight",
    expectedText: "LC499",
  },
  {
    taskId: "39",
    query:
      "Cancel ZX91 then request refund. Last name Doe and email alex@example.com",
    requiredTool: "request_refund",
    expectedText: "refund",
  },
  {
    taskId: "44",
    query: "Lookup ZX91 and send confirmation by push notification.",
    requiredTool: "send_confirmation",
    expectedText: "confirmation",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

function requiredToolCalled(name: string): boolean {
  switch (name) {
    case "rebook_flight":
      return rebookFlightSpy.mock.calls.length > 0;
    case "cancel_flight":
      return cancelFlightSpy.mock.calls.length > 0;
    case "request_refund":
      return requestRefundSpy.mock.calls.length > 0;
    case "seat_upgrade":
      return seatUpgradeSpy.mock.calls.length > 0;
    case "send_confirmation":
      return sendConfirmationSpy.mock.calls.length > 0;
    default:
      return false;
  }
}

export function tau2AirlineSuite(runner: EvalRunner): void {
  for (const task of TASKS) {
    ls.test(
      `task_${task.taskId}`,
      {
        inputs: {
          taskId: task.taskId,
          query: task.query,
        },
      },
      async () => {
        const result = await runner
          .extend({
            tools: [...ALL_TOOLS],
            systemPrompt: POLICY_PROMPT,
          })
          .run({ query: task.query });

        expect(lookupReservationSpy).toHaveBeenCalled();
        expect(verifyIdentitySpy).toHaveBeenCalled();
        expect(requiredToolCalled(task.requiredTool)).toBe(true);
        expect(sendConfirmationSpy).toHaveBeenCalled();
        expect(result).toHaveFinalTextContaining(task.expectedText, true);

        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
        ls.logFeedback({ key: "task_id", value: task.taskId });
      },
    );
  }
}
