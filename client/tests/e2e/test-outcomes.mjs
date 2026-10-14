// Consumer assertions shared by standalone native drivers and their suite.
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function copiedText(actual, expected) {
  assert(actual === expected, "Clipboard bytes differ from the selected code block");
}
export function tokenColors(samples) {
  assert(samples.length > 0, "No token samples selected");
  for (const sample of samples) {
    assert(sample.actual && sample.actual === sample.expected, `${sample.theme}: missing or incorrect token color`);
  }
}
export function childSucceeded(result, name) {
  assert(!result.timedOut, `${name}: child timed out`);
  assert(result.success && result.code === 0, `${name}: child failed (exit ${result.code})`);
}
export function renamedConsumer(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert(actual[key] === value, `Rename ${key}: expected ${JSON.stringify(value)}, observed ${JSON.stringify(actual[key])}`);
  }
}
