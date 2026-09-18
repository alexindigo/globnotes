import * as constants from "./constants.js";

import { createRouter, createWebHistory } from "vue-router";

import { authCheck } from "./api.js";
import { currentBrandName } from "./brand.js";
import { notePath } from "./notePath.js";
import { publish, TOPICS } from "./bus/index.js";
import { getInstancePrefix, namespaced, setVault } from "./vault.js";

const pathPrefix = getInstancePrefix();

const singleRoutes = [
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
    path: "/:path(.*)",
    name: "note",
    component: () => import("./views/Note.vue"),
    props: true,
  },
];

const multiRoutes = [
  {
    path: "/",
    name: "picker",
    component: () => import("./views/VaultPicker.vue"),
  },
  {
    path: "/:vault/_/login",
    name: "login",
    component: () => import("./views/LogIn.vue"),
    props: (route) => ({ redirect: route.query[constants.params.redirect] }),
  },
  {
    path: "/:vault/_/new",
    name: "new",
    component: () => import("./views/Note.vue"),
  },
  {
    path: "/:vault/_/search",
    name: "search",
    component: () => import("./views/SearchResults.vue"),
    props: (route) => ({
      searchTerm: route.query[constants.params.searchTerm],
      sortBy: Number(route.query[constants.params.sortBy]) || undefined,
      folder: route.query[constants.params.folder] || undefined,
    }),
  },
  {
    path: "/:vault",
    name: "home",
    component: () => import("./views/Home.vue"),
  },
  {
    path: "/:vault/:path(.*)",
    name: "note",
    component: () => import("./views/Note.vue"),
    props: true,
  },
];

const router = createRouter({
  history: createWebHistory(pathPrefix + "/"),
  routes: namespaced ? multiRoutes : singleRoutes,
});
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

router.beforeEach((to) => {
  if (typeof to.params.vault === "string" && to.params.vault) {
    setVault(to.params.vault);
  }
});
let authChecked = false;
router.beforeEach(async (to) => {
  if (authChecked || to.name === "login" || to.name === "picker") {
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
