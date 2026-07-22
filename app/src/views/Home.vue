<template>
  <div class="home">
    <nav-bar @open-server-settings="onOpenServerSettings"></nav-bar>
    <main-pane
      class="home__main-pane"
      :welcome-visible="showWelcomeModal && !showServerSettings"
      @welcome-close="onWelcomeModalClose"
    ></main-pane>
    <server-settings-modal
      :is-visible="showServerSettings"
      :initial-backend="serverBackendForModal"
      :first-run="serverFirstRun"
      @save="onServerBackendSaved"
      @close="onServerSettingsClose"
    ></server-settings-modal>
  </div>
</template>

<script>
// @ is an alias to /src
import NavBar from '@/components/NavBar.vue';
// import HelloWorld from '@/components/HelloWorld.vue';
import MainPane from '@/components/MainPane.vue';
import ServerSettingsModal from '@/components/ServerSettingsModal.vue';
import {
  resolveServerBackend,
  coerceServerBackend,
  SERVER_BACKEND_PREF_KEY,
} from '@/util/server-config';
import { SET_SERVER_BACKEND } from '@/store/mutation-types';
import { requestPref, subscribe, removeListeners } from '@/platform';

export default {
  name: 'home',
  components: {
    // HelloWorld,
    NavBar,
    MainPane,
    ServerSettingsModal,
  },
  data() {
    return {
      showWelcomeModal: false,
      showServerSettings: false,
      serverFirstRun: false,
      serverBackendForModal: resolveServerBackend(null, null),
    };
  },
  methods: {
    onWelcomeModalClose() {
      this.showWelcomeModal = false;
    },
    onServerSettingsClose() {
      this.showServerSettings = false;
      this.serverFirstRun = false;
    },
    // The nav-bar acceleration chip: open settings in normal (not first-run) mode.
    onOpenServerSettings() {
      this.serverFirstRun = false;
      this.showServerSettings = true;
    },
    onServerBackendSaved(backend) {
      this.serverBackendForModal = backend;
      this.$store.commit(SET_SERVER_BACKEND, backend);
      this.showServerSettings = false;
      this.serverFirstRun = false;
    },
    checkShouldShowWelcomeModal() {
      // Check if this is a first-time user
      requestPref('welcomeModalShown');
    },
    checkServerConfigured() {
      // Ask the main process whether a backend has been saved yet (legacy
      // serverUrl prefs are folded into it at startup, see background.js).
      requestPref(SERVER_BACKEND_PREF_KEY);
    },
  },
  mounted() {
    // Listen for preference response
    subscribe('pref-response', (event, key, value) => {
      if (key === 'welcomeModalShown') {
        // Show modal only if preference is not set/false (first-time user)
        this.showWelcomeModal = !value;
      } else if (key === SERVER_BACKEND_PREF_KEY) {
        const backend = coerceServerBackend(value);
        if (backend) {
          this.serverBackendForModal = backend;
          this.$store.commit(SET_SERVER_BACKEND, backend);
        } else if (!process.env.VUE_APP_SERVER_URL) {
          // No saved backend and none baked in at build time: prompt on first
          // run so users of a pre-built binary can point the app at their server.
          this.serverFirstRun = true;
          this.showServerSettings = true;
        }
      }
    });

    // Show the welcome modal on first run (based on the welcomeModalShown pref)
    this.checkShouldShowWelcomeModal();
    this.checkServerConfigured();

    // Allow opening the welcome modal from the menu
    subscribe('show-welcome-modal', () => {
      this.showWelcomeModal = true;
    });

    // Allow opening the server settings from the menu (not first-run mode)
    subscribe('show-server-settings', () => {
      this.serverFirstRun = false;
      this.showServerSettings = true;
    });
  },
  beforeDestroy() {
    // Clean up listeners
    removeListeners('pref-response');
    removeListeners('show-welcome-modal');
    removeListeners('show-server-settings');
  },
};
</script>

<style lang="scss">
.home {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.home__main-pane {
  // flex-grow: 1;
  height: calc(100vh - var(--nav-bar-height));
}
</style>
