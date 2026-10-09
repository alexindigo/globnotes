// Actual browser/API/disk consumers. The runner injects only owned resources.
import { CHAIN } from "./legacy-fixture.mjs";
import { assert, copiedText, renamedConsumer, tokenColors } from "./test-outcomes.mjs";
import { visibleElement } from "./native-actions.mjs";
import { captureClipboard, restoreClipboard } from "./native-clipboard.mjs";

const PALETTES = [
  ["globnotes-light", false, "ffffff", "0284c7", "2c3139", "eceef0"],
  ["globnotes-dark", true, "22262c", "38bdf8", "c1c7d0", "5e6b80"],
  ["dracula", true, "282a36", "bd93f9", "f8f8f2", "44475a"],
  ["dracula-alucard", false, "fffbeb", "644ac9", "1f1f1f", "cfcfde"],
  ["catppuccin-latte", false, "eff1f5", "1e66f5", "4c4f69", "bcc0cc"],
  ["catppuccin-frappe", true, "303446", "8caaee", "c6d0f5", "51576d"],
  ["catppuccin-macchiato", true, "24273a", "8aadf4", "cad3f5", "494d64"],
  ["catppuccin-mocha", true, "1e1e2e", "89b4fa", "cdd6f4", "45475a"],
  ["solarized-light", false, "fdf6e3", "268bd2", "657b83", "eee8d5"],
  ["solarized-dark", true, "002b36", "268bd2", "839496", "073642"],
  ["gruvbox-light", false, "fbf1c7", "af3a03", "3c3836", "d5c4a1"],
  ["gruvbox-dark", true, "282828", "fe8019", "ebdbb2", "504945"],
  ["nord", true, "2e3440", "88c0d0", "d8dee9", "434c5e"],
  ["tokyo-night", true, "1a1b26", "7aa2f7", "a9b1d6", "24283b"],
  ["tokyo-night-light", false, "e6e7ed", "2959aa", "343b58", "d5d6db"],
];
const rgb = hex => `rgb(${[0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;

async function open(f, path = "rendering/code-blocks") {
  await f.page.goto(f.baseUrl + "/" + path);
  await f.page.poll("!!document.querySelector('.toast-viewer')?.textContent.trim()");
}
async function theme(f, id) {
  await f.page.evaluate(`localStorage.setItem('globnotes-theme',${JSON.stringify(id)}); true`);
  await f.page.reload();
  await f.page.poll("!!document.querySelector('nav')");
  await f.page.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
}
async function viewImage(f, loaded = true) {
  await f.page.poll(`!!document.querySelector('.toast-viewer img')?.complete && (document.querySelector('.toast-viewer img').naturalWidth>0)===${loaded}`);
  return f.page.evaluate("(()=>{const image=document.querySelector('.toast-viewer img');return{path:location.pathname,src:image.getAttribute('src'),resolved:image.src,loaded:image.complete&&image.naturalWidth>0};})()");
}
async function edit(f) {
  await f.page.button("Edit", ".content-column");
  await f.page.button("Source", ".content-column");
  await f.page.poll("!!document.querySelector('.cm-content[contenteditable=true]')");
}
async function rename(f, folder, strategy) {
  const start = f.writes.length;
  await edit(f);
  const path = await f.page.evaluate(`(()=>{const el=[...document.querySelectorAll('input')].find(input=>input.value===${JSON.stringify(folder)});if(!el)throw Error('Missing folder field');el.value=${JSON.stringify(strategy.target)};el.dispatchEvent(new Event('input',{bubbles:true}));return location.pathname;})()`);
  await f.page.button("Save", ".content-column");
  await f.page.poll("document.body.innerText.includes('Move note with attachments')");
  await f.page.button(strategy.label, '[data-modal-top="true"]');
  await f.page.poll(`location.pathname===${JSON.stringify('/' + strategy.target + '/moving-note')}`);
  const note = await f.api("notes/" + strategy.target + "/moving-note");
  assert(note.status === 200, "Renamed note API unavailable");
  assert(note.body.path === strategy.target + "/moving-note", "Rename API returned a different identity");
  const operations = f.writes.slice(start).filter(row => decodeURIComponent(new URL(row.url).pathname) === "/_/api/notes/" + folder + "/moving-note");
  assert(operations.length === 1, `Rename did not send exactly one source mutation: ${JSON.stringify(f.writes.slice(start))}`);
  const operation = operations[0];
  assert(operation.body.newPath === strategy.target + "/moving-note" && new URL(operation.url).searchParams.get("file_refs") === strategy.fileRefs && operation.status === 200, "Rename wire/strategy/status differs from the chosen operation");
  const deadline = Date.now() + 15000;
  while (!operation.finished && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(operation.finished, "Rename response did not finish");
  const response = JSON.parse((await f.page.send("Network.getResponseBody", { requestId: operation.id })).body);
  assert(response.path === note.body.path, "Rename acknowledgement returned a different identity");
  assert((await f.api("notes/" + folder + "/moving-note")).status === 404, "Old note identity remains");
  assert(await Deno.readTextFile(f.vault + "/" + strategy.target + "/moving-note.md") === note.body.content, "Rename API/disk bytes differ");
  await f.page.button("Edit", ".content-column");
  await f.page.poll("!!document.querySelector('.toast-viewer') && !document.querySelector('.cm-content,.ProseMirror')");
  return { path, operation, returnedIdentity: response.path, note: note.body, immediate: await viewImage(f, strategy.loaded ?? true) };
}

export const cases = {
  async "tour-chain"(f) {
    await open(f, CHAIN[0]);
    for (const path of CHAIN.slice(1)) {
      await f.page.poll(`!!document.querySelector('.toast-viewer a[href="/${path}"]')`);
      await f.page.click(`.toast-viewer a[href="/${path}"]`);
      await f.page.poll(`location.pathname===${JSON.stringify('/' + path)} && document.querySelector('.toast-viewer')?.textContent.includes(${JSON.stringify('Fixture ' + path)})`);
    }
    return { followed: CHAIN, final: await f.page.evaluate("location.pathname") };
  },
  async "test-vault"(f) {
    const selectors = { "rendering/code-blocks": ".token", "rendering/math": ".katex", "rendering/callouts": "blockquote", "rendering/highlights": "mark", "rendering/mermaid": ".mermaid svg", "rendering/frontmatter": ".properties-panel", "links/embeds": "img", "rename-me/moving-note": "img" };
    const outcomes = [];
    for (const path of CHAIN) {
      await open(f, path);
      await f.page.poll(`document.querySelector('.toast-viewer')?.textContent.includes(${JSON.stringify('Fixture ' + path)})`);
      if (selectors[path]) await f.page.poll(`!!document.querySelector('.toast-viewer ${selectors[path]}')`);
      assert(f.page.pageErrors.length === 0, `${path}: render exception`);
      outcomes.push({ path, signature: selectors[path] ?? "fixture text" });
    }
    return outcomes;
  },
  async theme(f) {
    await open(f);
    const outcomes = [];
    for (const [id, dark, background, brand] of PALETTES) {
      await theme(f, id);
      const value = await f.page.evaluate("({background:getComputedStyle(document.body).backgroundColor,nav:getComputedStyle(document.querySelector('nav')).backgroundColor,dark:document.body.classList.contains('dark'),brand:document.documentElement.style.getPropertyValue('--theme-brand').trim()})");
      assert(value.dark === dark && value.background === rgb(background) && value.nav === rgb(background), `${id}: palette did not reach body/navbar`);
      assert(value.brand === [0, 2, 4].map(offset => parseInt(brand.slice(offset, offset + 2), 16)).join(" "), `${id}: wrong brand palette`);
      outcomes.push({ id, ...value });
    }
    await theme(f, "system");
    for (const mode of ["light", "dark"]) {
      const [, dark, background] = PALETTES.find(row => row[0] === "globnotes-" + mode);
      await f.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });
      await f.page.poll(`document.body.classList.contains('dark')===${dark}&&getComputedStyle(document.body).backgroundColor===${JSON.stringify(rgb(background))}`);
      const value = await f.page.evaluate("({body:getComputedStyle(document.body).backgroundColor,nav:getComputedStyle(document.querySelector('nav')).backgroundColor})");
      assert(value.body === rgb(background) && value.nav === rgb(background), `System ${mode}: palette did not reach actual surfaces`);
      outcomes.push({ id: "system", mode, ...value });
    }
    return outcomes;
  },
  async surfaces(f) {
    await open(f); await f.page.click('[title="Open sidebar"]');
    const outcomes = [];
    for (const id of ["globnotes-light", "globnotes-dark", "dracula", "catppuccin-latte"]) {
      const [, , background, , text, border] = PALETTES.find(row => row[0] === id);
      await theme(f, id);
      await f.page.poll("document.querySelector('aside')?.getBoundingClientRect().width>0");
      const value = await f.page.evaluate("(()=>{const aside=document.querySelector('aside');return{body:getComputedStyle(document.body).backgroundColor,nav:getComputedStyle(document.querySelector('nav')).backgroundColor,sidebar:getComputedStyle(aside).backgroundColor,text:getComputedStyle(document.querySelector('.content-column')).color,border:getComputedStyle(aside).borderRightColor,button:getComputedStyle(document.querySelector('[title=Search] svg')).stroke};})()");
      assert([value.body, value.nav, value.sidebar].every(color => color === rgb(background)), `${id}: a surface retained a stale background`);
      assert(value.text === rgb(text) && value.border === rgb(border), `${id}: text/border palette did not reach consumers`);
      assert(value.button === rgb({ "globnotes-light": "8891a1", "globnotes-dark": "8891a1", dracula: "6272a4", "catppuccin-latte": "6c6f85" }[id]), `${id}: button glyph retained a stale palette`);
      outcomes.push({ id, ...value });
    }
    return outcomes;
  },
  async "code-tokens"(f) {
    await open(f);
    const samples = [];
    for (const [id, color] of [["tokyo-night", "bb9af7"], ["dracula", "ff79c6"], ["catppuccin-latte", "8839ef"]]) {
      await theme(f, id); await f.page.poll("!!document.querySelector('.toast-viewer .token.keyword')");
      samples.push({ theme: id, actual: await f.page.evaluate(`(()=>{const token=document.querySelector('.toast-viewer .token.keyword');return (${visibleElement.toString()})(token)?getComputedStyle(token).color:null;})()`), expected: rgb(color) });
    }
    tokenColors(samples); return samples;
  },
  async "copy-button"(f) {
    await open(f); await f.page.grantClipboard();
    const prior = await captureClipboard(f.page);
    try {
      const expected = await f.page.evaluate("document.querySelector('.toast-viewer pre code').textContent");
      await f.page.click(".code-copy-btn");
      await f.page.poll(`navigator.clipboard.readText().then(text=>text===${JSON.stringify(expected)})`);
      copiedText(await f.page.readClipboard(), expected);
      assert(expected.includes("def greet"), "Code fixture changed");
      return { copiedSelectedBlock: true, characters: expected.length };
    } finally {
      await restoreClipboard(f.page, prior);
    }
  },
  async "editor-modes"(f) {
    await open(f); await edit(f);
    await f.page.poll("document.querySelector('.cm-content')?.textContent.includes('def greet')");
    await f.page.button("WYSIWYG", ".content-column");
    await f.page.poll("!!document.querySelector('.ProseMirror pre') && document.querySelector('.ProseMirror').textContent.includes('def greet')");
    await f.page.evaluate("(()=>{const pm=document.querySelector('.ProseMirror'),paragraph=[...pm.querySelectorAll('p')].find(el=>el.textContent==='Fixture rendering/code-blocks. #inbox');if(!paragraph)throw Error('Missing editable selection fixture');pm.focus();const range=document.createRange();range.selectNodeContents(paragraph);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return true;})()");
    await f.page.poll("getSelection().toString()==='Fixture rendering/code-blocks. #inbox'");
    await f.page.click('.wysiwyg-toolbar button[title="Bold"]');
    await f.page.poll("(()=>{const pm=document.querySelector('.ProseMirror'),selection=getSelection();return pm.contains(document.activeElement)&&!!pm.querySelector('strong')&&!selection.isCollapsed&&selection.toString().length>0;})()");
    await f.page.button("Source", ".content-column");
    await f.page.poll("document.querySelector('.cm-content')?.textContent.includes('def greet')");
    return { bothEditorsReadContent: true, toolbarPreservedSelection: true, sourceRoundTrip: true };
  },
  async "rename-options"(f, option = "move") {
    assert(["move", "relink", "none"].includes(option), "Invalid rename strategy");
    await open(f, "rename-me/moving-note"); await viewImage(f);
    const target = "archive-" + option;
    const labels = { move: "Move files with the note", relink: "Keep files, fix the links", none: "Don't touch anything" };
    const result = await rename(f, "rename-me", { target, label: labels[option], fileRefs: option, loaded: option !== "none" });
    const source = option === "relink" ? "../rename-me/assets/pic.png" : "assets/pic.png";
    assert(result.note.content.includes(`![pic](${source})`), `${option}: persisted attachment link differs`);
    const attachment = option === "move" ? `${target}/assets/pic.png` : "rename-me/assets/pic.png";
    const bytes = await Deno.readFile(f.vault + "/" + attachment);
    assert(bytes.length === f.image.length && bytes.every((byte, index) => byte === f.image[index]), "Attachment bytes changed");
    // none deliberately keeps a relative link without moving files: it is broken at the new folder.
    renamedConsumer(result.immediate, { path: "/" + target + "/moving-note", src: source, loaded: option !== "none" });
    const absent = option === "move" ? "rename-me/assets/pic.png" : target + "/assets/pic.png";
    try { await Deno.stat(f.vault + "/" + absent); throw Error("Attachment exists at the wrong location"); }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
    assert(result.immediate.resolved.startsWith(f.baseUrl + "/"), "Rendered attachment escaped its fixture origin");
    const served = await fetch(result.immediate.resolved);
    const displayed = new Uint8Array(await served.arrayBuffer());
    assert(option === "none" ? served.status === 404 : served.status === 200 && displayed.length === f.image.length && displayed.every((byte,index)=>byte===f.image[index]), "Rendered attachment response has the wrong status/bytes");
    return { option, attachment, ...result };
  },
  async "rename-twice"(f) {
    await open(f, "rename-me/moving-note");
    const first = await rename(f, "rename-me", { target: "archive", label: "Move files with the note", fileRefs: "move" });
    renamedConsumer(first.immediate, { path: "/archive/moving-note", src: "assets/pic.png", loaded: true });
    const second = await rename(f, "archive", { target: "archive1", label: "Keep files, fix the links", fileRefs: "relink" });
    renamedConsumer(second.immediate, { path: "/archive1/moving-note", src: "../archive/assets/pic.png", loaded: true });
    assert(second.note.content.includes("../archive/assets/pic.png"), "Second rename did not persist relink");
    await f.page.reload(); const reloaded = await viewImage(f);
    renamedConsumer(reloaded, second.immediate); return { first, second, reloaded };
  },
  async "wikilink-rename"(f) {
    assert((await f.api("notes", "POST", { path: "probe/link-source", content: "see [[probe/link-target]]" })).status === 200, "Link source fixture failed");
    assert((await f.api("notes", "POST", { path: "probe/link-target", content: "# link-target" })).status === 200, "Link target fixture failed");
    await open(f, "probe/link-target"); await edit(f);
    await f.page.fill('input[placeholder="Title"]', "link-target-renamed"); await f.page.button("Save", ".content-column");
    await f.page.poll("location.pathname==='/probe/link-target-renamed'");
    await f.page.poll("fetch('/_/api/notes/probe/link-source').then(r=>r.json()).then(note=>note.content.includes('[[probe/link-target-renamed]]'))");
    await open(f, "probe/link-source"); await f.page.poll("!!document.querySelector('.toast-viewer a[href=\"/probe/link-target-renamed\"]')");
    await f.page.click('.toast-viewer a[href="/probe/link-target-renamed"]'); await f.page.poll("location.pathname==='/probe/link-target-renamed'");
    const note = await f.api("notes/probe/link-source");
    assert(await Deno.readTextFile(f.vault + "/probe/link-source.md") === note.body.content, "Link rewrite disk/API differ");
    return { persisted: note.body.content, renderedNavigation: await f.page.evaluate("location.pathname") };
  },
  async "client-driven-links"(f) {
    await open(f, "rename-me/moving-note");
    await rename(f, "rename-me", { target: "archive-client", label: "Move files with the note", fileRefs: "move" });
    const outcomes = [];
    for (const path of ["readme", "folders/mom/ideas"]) {
      await f.page.poll(`fetch('/_/api/notes/${path}').then(r=>r.json()).then(note=>note.content.includes('[[archive-client/moving-note]]'))`);
      const note = await f.api("notes/" + path);
      assert(await Deno.readTextFile(f.vault + "/" + path + ".md") === note.body.content, "Reference rewrite did not reach disk");
      outcomes.push({ path, content: note.body.content });
    }
    return outcomes;
  },
  async "recent-files"(f) {
    await open(f); await f.page.click('[title="Open sidebar"]');
    assert(!await f.page.evaluate("[...document.querySelectorAll('aside p')].some(el=>el.textContent.trim()==='Recent')"), "Recent fixture was not initially off");
    await f.page.click('[title="Recent notes"]');
    await f.page.poll("[...document.querySelectorAll('aside p')].some(el=>el.textContent.trim()==='Recent')");
    const notes = (await f.api("search?term=*")).body;
    const expected = [...CHAIN].reverse().slice(0, 5).map(path => "/" + path);
    const apiOrder = [...notes].sort((a, b) => b.lastModified - a.lastModified).slice(0, 5).map(note => "/" + note.path);
    assert(JSON.stringify(apiOrder) === JSON.stringify(expected), "Recent-order fixture/API disagree");
    await f.page.poll("(()=>{const title=[...document.querySelectorAll('aside p')].find(el=>el.textContent.trim()==='Recent');return title?.parentElement.querySelectorAll('a').length===5;})()");
    const actual = await f.page.evaluate("(()=>{const title=[...document.querySelectorAll('aside p')].find(el=>el.textContent.trim()==='Recent');return [...title.parentElement.querySelectorAll('a')].map(el=>el.getAttribute('href'));})()");
    assert(JSON.stringify(actual) === JSON.stringify(expected), `Recent notes have wrong identity/order: ${JSON.stringify({ actual, expected })}`);
    await f.page.reload(); await f.page.poll("document.querySelector('aside')?.getBoundingClientRect().width>0");
    await f.page.poll("[...document.querySelectorAll('aside p')].some(el=>el.textContent.trim()==='Recent')");
    await f.page.click('[title="Recent notes"]');
    await f.page.poll("![...document.querySelectorAll('aside p')].some(el=>['Recent','Files'].includes(el.textContent.trim()))");
    return { actual, expected, persistedThenDisabled: true };
  },
  async "sidebar-refresh"(f) {
    await f.page.addInitScript('localStorage.setItem("sidebarVisible","true");localStorage.setItem("sidebarPinned","true");');
    await f.page.goto(f.baseUrl + "/"); await f.page.poll("!!document.querySelector('aside')?.getBoundingClientRect().width");
    assert((await f.api("notes/SidebarProbe")).status === 404, "Live-refresh fixture is not fresh");
    await f.page.click('[title="New note"]'); await f.page.poll("!!document.querySelector('input[placeholder=Title]')");
    await f.page.fill('input[placeholder="Title"]', "SidebarProbe"); await f.page.button("Save", ".content-column");
    await f.page.poll(`location.pathname==='/SidebarProbe' && (${visibleElement.toString()})(document.querySelector('aside a[href="/SidebarProbe"]'))`);
    const note = await f.api("notes/SidebarProbe"); assert(note.status === 200, "Created note missing from API");
    assert(await Deno.readTextFile(f.vault + "/SidebarProbe.md") === note.body.content, "Sidebar-created note missing from disk");
    return { exactIdentity: "SidebarProbe", liveWithoutReload: true };
  },
  async "quick-switcher"(f) {
    await open(f, "rendering/code-blocks"); await f.page.click('[title="Search"]');
    await f.page.poll("!!document.querySelector('input[placeholder=\"Search or switch to note…\"]')");
    const first = await f.page.evaluate("(()=>{const row=document.querySelector('ul.switcher-results li');return [...row.querySelectorAll('*')].filter(el=>el.childElementCount===0).map(el=>el.textContent.trim());})()");
    assert(first.includes("rendering/code-blocks"), "Exact recently-opened identity not first");
    const input = 'input[placeholder="Search or switch to note…"]';
    await f.page.fill(input, "math"); await f.page.poll("document.querySelector('ul.switcher-results')?.textContent.includes('math')");
    await f.page.key("Enter", { windowsVirtualKeyCode: 13 }); await f.page.poll("location.pathname==='/rendering/math'");
    await f.page.click('[title="Search"]'); await f.page.fill(input, "code");
    await f.page.poll("[...document.querySelectorAll('ul.switcher-results li')].some(el=>el.textContent.includes('Search for'))");
    await f.page.evaluate("[...document.querySelectorAll('ul.switcher-results li')].find(el=>el.textContent.includes('Search for')).setAttribute('data-native-full-search',''); true");
    await f.page.click('[data-native-full-search]');
    await f.page.poll("location.pathname==='/_/search' && new URLSearchParams(location.search).get('term')==='code'");
    await f.page.click('[title="Search"]'); await f.page.fill(input, "#");
    await f.page.evaluate(`document.querySelector(${JSON.stringify(input)}).setSelectionRange(1,1);true`);
    await f.page.key("Shift", { code: "ShiftLeft", windowsVirtualKeyCode: 16 });
    await f.page.poll(`(()=>{const input=document.querySelector(${JSON.stringify(input)});return [...input.parentElement.querySelectorAll('p')].some(el=>el.textContent.trim()==='#inbox'&&el.getBoundingClientRect().height>0);})()`);
    await f.page.evaluate("(()=>{const input=document.querySelector('input[placeholder=\"Search or switch to note…\"]');const item=[...input.parentElement.querySelectorAll('p')].find(el=>el.textContent.trim()==='#inbox');if(!item)throw Error('Missing tag suggestion');item.setAttribute('data-native-tag','');return true;})()");
    await f.page.click('[data-native-tag]');
    await f.page.poll(`document.querySelector(${JSON.stringify(input)}).value==='#inbox'`);
    return { recentlyOpened: first, fuzzyOpened: "rendering/math", fullSearch: "code", tagSuggestion: "inbox" };
  },
};
