// One fixture identity for CLI admission, native selection and matrix coverage.
import { matrixSelection, parseMatrixArguments } from "./native-matrix-cases.mjs";
export const PREFIX_AUTH_CASES = ["", "/notes"].flatMap(prefix =>
  ["password", "none", "read_only", "setup"].map(mode => ({
    prefix, mode, label: `${prefix ? "notes" : "empty"}-${mode.replaceAll("_", "-")}`,
  })));
export const parsePrefixAuthArguments = args => parseMatrixArguments(args, PREFIX_AUTH_CASES);
export const prefixAuthSelection = () => matrixSelection("plugin-prefix-auth", PREFIX_AUTH_CASES);
