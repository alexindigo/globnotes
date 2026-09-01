import * as constants from "./constants.js";

import { createRouter, createWebHistory } from "vue-router";

import { authCheck } from "./api.js";
import { currentBrandName } from "./brand.js";
import { notePath } from "./notePath.js";
import { publish, TOPICS } from "./bus/index.js";

const pathPrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

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

// Check the user is authenticated on first navigation (unless going to login)
let authChecked = false;
router.beforeEach(async (to) => {
  if (authChecked || to.name === "login") {
    return;
  }
  try {
    await authCheck();
    return;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      return {
        name: "login",
        query: { [constants.params.redirect]: to.fullPath },
      };
    }
  } finally {
    authChecked = true;
  }
});

router.afterEach((to) => {
  let docTitle = currentBrandName();
  if (to.name === "note") {
    if (to.params.path) {
      docTitle = `${to.params.path} - ${docTitle}`;
      publish(TOPICS.NOTE_OPEN, { path: to.params.path });
    } else {
      docTitle = "New Note - " + docTitle;
    }
  }
  if (to.name === "search" && to.query[constants.params.searchTerm]) {
    publish(TOPICS.SEARCH_PERFORM, {
      term: to.query[constants.params.searchTerm],
    });
  }
  document.title = docTitle;
});

export default router;
