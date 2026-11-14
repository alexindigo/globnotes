import { afterEach, expect, it, vi } from "vitest";
import { settleSettingsInventory } from "./settings-inventory-native.mjs";

afterEach(() => { document.body.innerHTML = ""; });
const evaluate = expression => Function(`return (${expression})`)();

it("does not confuse an SSE-observed choice with the held policy acknowledgement", async () => {
  document.body.innerHTML = '<div data-inventory-recovery><p>Inventory outcome is unknown</p><button>Check current status</button></div>';
  const session = {
    page: { onEvent: () => () => {} },
    evaluate,
    poll: vi.fn(async expression => {
      if (session.poll.mock.calls.length === 1) {
        expect(evaluate(expression)).toBe(false);
        document.querySelector("[data-inventory-recovery] p").textContent = "Policy saved; catalogue refresh was not accepted.";
      }
      expect(evaluate(expression)).toBe(true);
    }),
    button: vi.fn(async () => {
      document.querySelector("[data-inventory-recovery]").remove();
      document.body.innerHTML = '<button id="settled-control"></button>';
    }),
  };
  const result = await settleSettingsInventory(session, "!!document.querySelector('#settled-control')");
  expect(session.button).toHaveBeenCalledExactlyOnceWith("Check current status", "[data-inventory-recovery]");
  expect(result.explicitCommittedPolicyReview).toBe(true);
  expect(result.additionalPolicyPuts).toBe(0);
});

it("does not review or replay an already settled policy", async () => {
  const session = { page: { onEvent: () => () => {} }, evaluate, poll: async expression => expect(evaluate(expression)).toBe(true), button: vi.fn() };
  expect((await settleSettingsInventory(session, "true")).explicitCommittedPolicyReview).toBe(false);
  expect(session.button).not.toHaveBeenCalled();
});
