// One fixture identity for CLI admission, native selection and matrix coverage.
import { parseArguments } from "./harness-arguments.mjs";
export const PREFIX_AUTH_CASES = ["", "/notes"].flatMap(prefix =>
  ["password", "none", "read_only", "setup"].map(mode => ({
    prefix, mode, label: `${prefix ? "notes" : "empty"}-${mode.replaceAll("_", "-")}`,
  })));
export function parsePrefixAuthArguments(args) {
  const rest = [...args], index = rest.indexOf("--variant");
  let variant;
  if (index !== -1) {
    variant = rest[index + 1];
    if (!PREFIX_AUTH_CASES.some(item => item.label === variant)) throw Error("--variant requires a known prefix/auth fixture");
    rest.splice(index, 2);
  }
  return { ...parseArguments(rest), variant };
}
export const prefixAuthSelection = () => [
  ["plugin-prefix-auth"],
  ...PREFIX_AUTH_CASES.slice(1).map(item => ["plugin-prefix-auth", "--variant", item.label]),
];
