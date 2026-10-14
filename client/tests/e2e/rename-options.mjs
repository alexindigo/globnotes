import { runCase } from "./legacy-fixture.mjs";
import { cases } from "./legacy-native-cases.mjs";
const strategy = Deno.args[0] ?? "move";
await runCase("rename-options-" + strategy, fixture => cases["rename-options"](fixture, strategy));
