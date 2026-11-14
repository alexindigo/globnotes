import { matrixSelection, parseMatrixArguments } from "./native-matrix-cases.mjs";
export const REVIEW_REPAIR_CASES = [
  { label: "inventory-handoff", groups: 1 },
  { label: "access-conflict", groups: 1 },
  { label: "browser-ownership", groups: 3 },
  { label: "descriptor-settlement", groups: 1 },
  { label: "postponed-prompt", groups: 1 },
];
export const parseReviewRepairArguments = args => parseMatrixArguments(args, REVIEW_REPAIR_CASES);
export const reviewRepairSelection = () => matrixSelection("plugin-review-repairs", REVIEW_REPAIR_CASES);
