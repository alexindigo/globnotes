// The page input keeps focus while Chromium initializes a separate popup.
// Admit keys only after the owned popup's color slider has actual focus.
// The visible-VM path uses the compositor and verifies the exact owned window.
import { done, pending, waitUntil } from "../../../tests/helpers/wait.ts";

export function focusedPickerSlider(nodes, ownerBackendId) {
  const owner = nodes.find(node => node.backendDOMNodeId === ownerBackendId);
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const descendants = [...(owner?.childIds ?? [])];
  for (const id of descendants) {
    const node = byId.get(id);
    if (!node) continue;
    if (node.role?.value === "slider" && node.properties?.some(property => property.name === "focused" && property.value.value === true)) return node;
    descendants.push(...(node.childIds ?? []));
  }
  return null;
}

export async function chooseNativeColor(session, selector, previous) {
  const socket = Deno.env.get("GLOBNOTES_E2E_WAYLAND_SOCKET");
  if (!socket) {
    await session.send("Accessibility.enable");
    try {
      const { root } = await session.send("DOM.getDocument");
      const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { node } = await session.send("DOM.describeNode", { nodeId });
      // Attach the AX cache before popup creation; a cache first attached
      // afterward does not expose the popup's document as an input child.
      await session.send("Accessibility.getFullAXTree");
      await session.click(selector);
      await session.poll(`document.querySelector(${JSON.stringify(selector)})?.matches(':open')`);
      await waitUntil(async () => {
        const { nodes } = await session.send("Accessibility.getFullAXTree");
        const slider = focusedPickerSlider(nodes, node.backendNodeId);
        return slider ? done(slider) : pending({ selector, nodes });
      }, { label: "native color picker's focused owned popup slider", intervalMs: 50 });
      await session.key("ArrowRight", { modifiers: 2, windowsVirtualKeyCode: 39 });
      await session.poll(`!!document.querySelector(${JSON.stringify(selector)}) && document.querySelector(${JSON.stringify(selector)}).value!==${JSON.stringify(previous)}`);
      await session.key("Enter", { windowsVirtualKeyCode: 13 });
      await session.poll(`!document.querySelector(${JSON.stringify(selector)})?.matches(':open')`);
    } finally {
      await session.send("Accessibility.disable");
    }
    return;
  }
  await session.click(selector);
  await session.poll(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);
  const originalTitle = await session.evaluate("document.title");
  const marker = "native-color-" + session.targetId;
  const env = { XDG_RUNTIME_DIR: "/run/user/1000", WAYLAND_DISPLAY: "wayland-1", NIRI_SOCKET: socket };
  async function command(executable, args) {
    const result = await new Deno.Command(executable, { args, env, signal: AbortSignal.timeout(5000) }).output();
    if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  }
  async function key(args) {
    const owned = await waitUntil(async () => {
      const windows = JSON.parse(await command("/usr/bin/niri", ["msg", "--json", "windows"]));
      const owned = windows.filter(window => window.title === marker + " - Chromium" && window.app_id === "chromium");
      return owned.length === 1 ? done(owned) : pending({ marker, owned });
    }, { label: "native picker's unique owned window", intervalMs: 50 });
    if (owned.length !== 1 || !owned[0].is_focused) throw Error("Native picker requires its unique focused owned window");
    await command("/usr/bin/wtype", args);
  }
  try {
    // Diagnostic-only title identifies this newly owned target among held
    // identical fixture titles; restored after the native interaction.
    await session.evaluate(`document.title=${JSON.stringify(marker)};true`);
    await key(["-M", "ctrl", "-k", "Right", "-m", "ctrl"]);
    await session.poll(`!!document.querySelector(${JSON.stringify(selector)}) && document.querySelector(${JSON.stringify(selector)}).value!==${JSON.stringify(previous)}`);
    await key(["-k", "Return"]);
  } finally {
    await session.evaluate(`document.title=${JSON.stringify(originalTitle)};true`);
  }
}
