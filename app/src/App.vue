<template>
  <div id="app" class="cadmium-app">
    <router-view/>
  </div>
</template>

<script>

export default {
  data() {
    return {};
  },
};

</script>

<style lang="scss">
@import '@/scss/main.scss';
@import '@/scss/walkthrough.scss';

.cadmium-app {
  height: 100vh;
  min-height: 100vh;
  background-color: #272727;
  user-select: none;
}

</style>
