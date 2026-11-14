// Pure admission shared by fixture matrices; each selected leaf owns its budget.
import { parseArguments } from "./harness-arguments.mjs";
export function parseMatrixArguments(args, cases) {
  const rest = [...args], index = rest.indexOf("--variant");
  let variant;
  if (index !== -1) {
    variant = rest[index + 1];
    if (!cases.some(item => item.label === variant)) throw Error("--variant requires a known matrix fixture");
    rest.splice(index, 2);
  }
  return { ...parseArguments(rest), variant };
}
export const matrixSelection = (driver, cases) => [
  [driver], ...cases.slice(1).map(item => [driver, "--variant", item.label]),
];
