// Pure argument admission, independent of the Deno server-launch adapter.
export function parseArguments(args) {
  const result = { help: false, artifacts: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error(`Duplicate argument: ${option}`);
    seen.add(option);
    if (option === "--help") result.help = true;
    else if (option === "--artifacts") {
      const directory = args[++index];
      if (!directory || directory.startsWith("--")) throw new Error("--artifacts requires a directory");
      result.artifacts = directory;
    } else throw new Error(`Unknown argument: ${option}`);
  }
  return result;
}
