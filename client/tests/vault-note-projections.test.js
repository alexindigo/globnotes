// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createQuickAccess } from "../quickAccess.js";
import { createSearchResults } from "../searchResults.js";
import { createSidebarTree } from "../sidebarTree.js";
import { publish, TOPICS } from "../bus/index.js";
import { useGlobalStore } from "../globalStore.js";
import "../noteIndex.js";
vi.mock("../api.js",()=>({getNotes:vi.fn(),getTree:vi.fn(),rewriteRefs:vi.fn(),apiErrorHandler:vi.fn(),getNoteIndex:vi.fn(async()=>[{path:"From remote"}])}));
const owners=[];
afterEach(()=>owners.splice(0).forEach(owner=>owner.dispose()));
it("all note-list projections refresh from hub peers and reset, not only browser-authored note facts",async()=>{
  setActivePinia(createPinia());const rows=[{path:"From remote",title:"From remote",lastModified:1}],loadNotes=vi.fn(async()=>rows);
  const quick=createQuickAccess({config:()=>({quickAccessTerm:"*",quickAccessSort:"lastModified",quickAccessLimit:5}),loadNotes});
  const search=createSearchResults({query:()=>({searchTerm:"*"}),loadNotes,preferences:{includeNested:ref(true)}});
  const sidebar=createSidebarTree({loadTree:async()=>({folders:[],notes:rows}),loadNotes,preferences:{expandedFolders:ref(new Set()),sidebarRecent:ref(true),sidebarVisible:ref(true),sidebarPinned:ref(false),setExpandedFolders(){},setSidebarRecent(){},setSidebarVisible(){},setSidebarPinned(){}}});
  owners.push(quick,search,sidebar);
  publish(TOPICS.VAULT_CHANGE,{seq:1,path:"From remote.md",kind:"created",peer:"home"});await flushPromises();
  expect(quick.snapshot().notes).toEqual(rows);expect(search.snapshot().results).toEqual(rows);expect(sidebar.snapshot().visibleRows.map(row=>row.note?.path)).toContain("From remote");expect(useGlobalStore().notePaths).toEqual(["From remote"]);
  const calls=loadNotes.mock.calls.length;publish(TOPICS.VAULT_RESET,{next:2});await flushPromises();expect(loadNotes.mock.calls.length).toBeGreaterThan(calls);
  owners.splice(0).forEach(owner=>owner.dispose());const retired=loadNotes.mock.calls.length;publish(TOPICS.VAULT_CHANGE,{path:"Later.md",kind:"created"});await flushPromises();expect(loadNotes).toHaveBeenCalledTimes(retired);
});
