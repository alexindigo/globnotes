// Browser popup keys can leave CDP's page widget. The approved visible-VM
// path uses the compositor's keyboard and verifies the exact owned window.
export async function chooseNativeColor(session, selector, previous) {
  const socket = Deno.env.get("GLOBNOTES_E2E_WAYLAND_SOCKET");
  await session.click(selector);
  await session.poll(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);
  if (!socket) {
    await session.key("ArrowRight", { modifiers: 2, windowsVirtualKeyCode: 39 });
    await session.poll(`document.querySelector(${JSON.stringify(selector)}).value!==${JSON.stringify(previous)}`);
    await session.key("Enter", { windowsVirtualKeyCode: 13 });
    return;
  }
  const originalTitle = await session.evaluate("document.title");
  const marker = "native-color-" + session.targetId;
  const env = { XDG_RUNTIME_DIR: "/run/user/1000", WAYLAND_DISPLAY: "wayland-1", NIRI_SOCKET: socket };
  async function command(executable, args) {
    const result = await new Deno.Command(executable, { args, env, signal: AbortSignal.timeout(5000) }).output();
    if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  }
  async function key(args) {
    const deadline = Date.now() + 5000;
    let owned;
    do {
      const windows = JSON.parse(await command("/usr/bin/niri", ["msg", "--json", "windows"]));
      owned = windows.filter(window => window.title === marker + " - Chromium" && window.app_id === "chromium");
      if (owned.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    if (owned.length !== 1 || !owned[0].is_focused) throw Error("Native picker requires its unique focused owned window");
    await command("/usr/bin/wtype", args);
  }
  try {
    // Diagnostic-only title identifies this newly owned target among held
    // identical fixture titles; restored after the native interaction.
    await session.evaluate(`document.title=${JSON.stringify(marker)};true`);
    await key(["-M", "ctrl", "-k", "Right", "-m", "ctrl"]);
    await session.poll(`document.querySelector(${JSON.stringify(selector)}).value!==${JSON.stringify(previous)}`);
    await key(["-k", "Return"]);
  } finally {
    await session.evaluate(`document.title=${JSON.stringify(originalTitle)};true`);
  }
}
