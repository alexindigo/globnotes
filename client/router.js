import * as constants from "./constants.js";

import { createRouter, createWebHistory } from "vue-router";

import { getConfig } from "./api.js";
import { activeTokenStorage } from "./tokenStorage.js";
import { notePath } from "./notePath.js";
import { publish, TOPICS } from "./bus/index.js";
import { setDocTitleBase } from "./title.js";
import { readPathPrefix } from "./pathPrefix.js";
import { canCreateNote } from "./noteCreation.js";

const pathPrefix = readPathPrefix();

/** Prepared guard; explicit sign-in and own-account never require vault read. */
export function createIdentityRouteGuard({ status, credentials, session = () => null, signIn = to => ({ name: "login", query: { redirect: to.fullPath } }) }) {
  return async (to, from) => {
    const owner = session();
    if (owner?.state.reloadRequired) return false;
    if (to.name === "login") return true;
    // A caret/fragment update is not a departure. If access has meanwhile
    // been lost, reject the update without routing the retained editor away.
    const fragmentOnly = to.name === "note" && from?.name === "note" && to.hash !== from.hash &&
      to.fullPath.split("#", 1)[0] === from.fullPath.split("#", 1)[0];
    const tokens = credentials?.();
    async function read(retry) {
      const current = tokens?.capture() ?? (() => true);
      try {
        const config = await status();
        return { config, current };
      } catch (error) {
        if (!current()) return null;
        if (!retry || !tokens || error.response?.status !== 401) throw error;
        tokens.clearStoredToken();
        return read(false);
      }
    }
    // Root setup binds the session before Vue Router's first queued guard.
    // Both router and shell wait for the same startup request and guest retry.
    const admitted = owner && !owner.state.ready
      ? await owner.load() && { config: owner.snapshot(), current: owner.captureCredential() }
      : await read(true);
    if (!admitted?.current()) return false;
    const current = admitted.config;
    if (fragmentOnly && (current.setupRequired || current.principal?.passwordChangeRequired || !current.capabilities.canRead)) return false;
    if (to.name === "account") return current.capabilities.canManageOwnAccount ? true : signIn(to);
    if (current.setupRequired) return to.name === "setup" ? true : { name: "setup" };
    if (to.name === "setup") return { name: "home" };
    if (current.principal?.passwordChangeRequired) return { name: "account" };
    if (to.name === "new" && current.capabilities.canRead && !canCreateNote(current)) return { name: "home" };
    return current.capabilities.canRead ? true : current.principal?.kind === "account" ? { name: "account" } : signIn(to);
  };
}

const router = createRouter({
  history: createWebHistory(pathPrefix + "/"),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("./views/Home.vue"),
    },
    {
      path: "/_/login",
      name: "login",
      component: () => import("./views/LogIn.vue"),
      props: (route) => ({ redirect: route.query[constants.params.redirect] }),
    },
    {
      path: "/_/new",
      name: "new",
      component: () => import("./views/Note.vue"),
    },
    { path: "/_/setup", name: "setup", component: () => import("./views/Setup.vue") },
    { path: "/_/account", name: "account", component: () => import("./views/Account.vue") },
    {
      path: "/_/search",
      name: "search",
      component: () => import("./views/SearchResults.vue"),
      props: (route) => ({
        searchTerm: route.query[constants.params.searchTerm],
        sortBy: Number(route.query[constants.params.sortBy]) || undefined,
        folder: route.query[constants.params.folder] || undefined,
      }),
    },
    {
      path: "/_/conflicts",
      name: "conflicts",
      component: () => import("./views/Conflicts.vue"),
    },
    {
      path: "/_/conflicts/:id",
      name: "conflict",
      component: () => import("./views/Conflicts.vue"),
      props: true,
    },
    {
      // Notes live in the root URL space; paths may contain slashes.
      path: "/:path(.*)",
      name: "note",
      component: () => import("./views/Note.vue"),
      props: true,
    },
  ],
});

// Normalize note paths: a clicked relative link may carry the .md suffix
// (e.g. /dad/other.md -> note "dad/other").
router.beforeEach(async (to) => {
  if (
    to.name === "note" &&
    typeof to.params.path === "string" &&
    to.params.path.endsWith(".md")
  ) {
    return {
      path: notePath(to.params.path.slice(0, -".md".length)),
      replace: true,
    };
  }
});

let routeSession;
export function bindIdentityRouteSession(session) {
  routeSession = session;
  return () => { if (routeSession === session) routeSession = null; };
}
router.beforeEach(createIdentityRouteGuard({ status: () => getConfig(), credentials: () => activeTokenStorage(), session: () => routeSession }));

router.afterEach((to) => {
  // The tab's title: the bare brand for non-note pages; an open note's
  // live title arrives via NOTE_TITLE_CHANGED (title.js owns the tab).
  setDocTitleBase();
  if (to.name === "note" && to.params.path) {
    publish(TOPICS.NOTE_OPEN, { path: to.params.path });
  }
  if (to.name === "search" && to.query[constants.params.searchTerm]) {
    publish(TOPICS.SEARCH_PERFORM, {
      term: to.query[constants.params.searchTerm],
    });
  }
});

export default router;
