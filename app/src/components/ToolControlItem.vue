<template>
  <div class="tool-control-item">
    <div class="tool-control-item__header">
      <div class="tool-control-item__title">{{ title }}</div>
    </div>
    <div class="tool-control-item__content">
      <slot></slot>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    // id: {
    //   type: String,
    //   required: true,
    // },
    title: {
      type: String,
      required: false,
    },
  },
  // filters: {
  //   toUpperCase: s => s ? s.toUpperCase() : s,
  // }
};
</script>

<style lang="scss">
.tool-control-item__header {
  padding: 6px 8px;
  background-color: #3a3a3a;
}

.tool-control-item__title {
  color: #3a3a3a;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  font-size: 13px;
}

.tool-control-item__content {

}
</style>
