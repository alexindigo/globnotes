import App from "/App.vue";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";
import { createApp } from "vue";
import { createPinia } from "pinia";
import { initTheme } from "./themes.js";
import { initDocTitle } from "./title.js";
import { loadStoredToken } from "./tokenStorage.js";
import { readPathPrefix } from "./pathPrefix.js";
import router from "/router.js";

// Theme vars are stamped on <html> before mount so every surface is
// themed from the first paint (style.css carries no duplicate defaults).
initTheme();
initDocTitle();

// Plugin stylesheets — Obsidian-style styles.css per plugin, served
// combined at <prefix>/_/plugins.css. Loaded globally; plugins namespace
// their own selectors.
{
  const prefix = readPathPrefix();
  const pluginStyles = document.createElement("link");
  pluginStyles.rel = "stylesheet";
  pluginStyles.href = prefix + "/_/plugins.css";
  document.head.appendChild(pluginStyles);
}

const app = createApp(App);
const pinia = createPinia();

app.use(router);
app.use(pinia);
app.use(PrimeVue, { unstyled: true });
app.use(ToastService);

// Custom v-focus directive to focus on an element when mounted
app.directive("focus", {
  mounted(el) {
    el.focus();
  },
});

loadStoredToken();

app.mount("#app");
