import * as constants from "./constants.js";

import { createRouter, createWebHistory } from "vue-router";

import { authCheck } from "./api.js";
import { notePath } from "./notePath.js";

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
      // Notes live in the root URL space; titles may contain slashes.
      path: "/:title(.*)",
      name: "note",
      component: () => import("./views/Note.vue"),
      props: true,
    },
  ],
});

// Normalize note titles: a clicked relative link may carry the .md suffix
// (e.g. /dad/other.md -> note "dad/other").
router.beforeEach(async (to) => {
  if (
    to.name === "note" &&
    typeof to.params.title === "string" &&
    to.params.title.endsWith(".md")
  ) {
    return {
      path: notePath(to.params.title.slice(0, -".md".length)),
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
  let title = "globnotes";
  if (to.name === "note") {
    if (to.params.title) {
      title = `${to.params.title} - ${title}`;
    } else {
      title = "New Note - " + title;
    }
  }
  document.title = title;
});

export default router;
