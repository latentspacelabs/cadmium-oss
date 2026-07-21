<!-- eslint-disable linebreak-style -->
<template>
  <div>
    <draggable
      class="tool-controls tool-controls-left"
      id="toolsList"
      v-bind:class="{ toolControlsNoClick: canvasToolActive, toolDropZone: toolDrag }"
      group="tools"
      v-bind="toolDragOptions"
      handle=".handle"
      @start="toolDragStart"
      @end="toolDragEnd"
    >
      <div class="panelWrapper">
        <div
          class="tool-controls-item fixedWidthPanel"
          id="colorPanel"
          @wheel="colorPanelScroll"
        >
          <tool-control-item
            v-if="toolItemVisibleById(toolIdColor)"
          >
            <color-wheel-controls></color-wheel-controls>
          </tool-control-item>
        </div>
      </div>
      <div class="panelWrapper">
        <div
          class="tool-controls-item fixedWidthPanel"
          id="penPanel"
          @wheel="penPanelScroll"
        >
          <tool-control-item
            v-if="toolItemVisibleById(toolIdPen)"
            title="pen"
          >
            <pen-controls></pen-controls>
          </tool-control-item>
        </div>
      </div>
      <div class="panelWrapper">
        <div
          class="tool-controls-item fixedWidthPanel"
          id="eraserPanel"
          @wheel="eraserPanelScroll"
        >
          <tool-control-item
            v-if="toolItemVisibleById(toolIdEraser)"
            title="eraser"
          >
            <eraser-controls></eraser-controls>
          </tool-control-item>
        </div>
      </div>
      <div class="panelWrapper">
        <div
          class="tool-controls-item fixedWidthPanel"
          id="fillPanel"
          @wheel="fillPanelScroll"
        >
            <tool-control-item
              v-if="toolItemVisibleById(toolIdFill)"
              title="fill"
            >
              <fill-controls></fill-controls>
            </tool-control-item>
        </div>
      </div>
      <!--
      <tool-control-item
        v-if="toolItemVisibleById(toolIdZoom)"
        title="zoom"
      >
        <zoom-controls></zoom-controls>
      </tool-control-item>
    -->
    </draggable>
    <draggable
      class="tool-controls tool-controls-right"
      v-bind:class="{ toolControlsNoClick: canvasToolActive, toolDropZone: toolDrag }"
      group="tools"
      v-bind="toolDragOptions"
      handle=".handle"
      @start="toolDragStart"
      @end="toolDragEnd"
    >
      <div style="position:relative;">
        <vue-resizable
          :active="['r', 'l']"
          :min-width="200"
          :left="0"
          style="position: initial; height:100%; max-width:90vw;"
          :width="refWinWidth"
          @resize:end="refResizeWidthEnd"
        >
          <tool-control-item
            class="tool-controls-item"
            v-if="toolItemVisibleById(toolIdReference)"
            id="refPanel"
            @wheel="refPanelScroll"
          >
           <reference-controls></reference-controls>
          </tool-control-item>
        </vue-resizable>
      </div>
        <div class="panelWrapper">
          <div
            class="tool-controls-item fixedWidthPanel"
            id="segOptions"
            @wheel="segOptionsPanelScroll"
          >
              <tool-control-item
                v-if="toolItemVisibleById(toolIdSegOptions)"
                title="segoptions"
              >
                <seg-options></seg-options>
              </tool-control-item>
          </div>
        </div>
    </draggable>
  </div>
</template> <!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
/* eslint-disable linebreak-style */
import { mapGetters, mapMutations } from 'vuex';

import draggable from 'vuedraggable';
import ToolControlItem from '@/components/ToolControlItem.vue';
import ColorWheelControls from '@/components/ColorWheelControls.vue';
import FillControls from '@/components/FillControls.vue';
import PenControls from '@/components/PenControls.vue';
import EraserControls from '@/components/EraserControls.vue';
import ReferenceControls from '@/components/ReferenceControls.vue';
import SegOptions from '@/components/SegOptions.vue';
import VueResizable from 'vue-resizable';

import { eventBus } from '@/main';

// import ZoomControls from '@/components/ZoomControls.vue';

import {
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  CANVAS_TOOL_ACTIVE,
  REF_WIN_WIDTH,
} from '@/store/getter-types';

import {
  SET_REF_WIN_WIDTH,
} from '@/store/mutation-types';

import {
  TOOL_CONTROLS_ID_COLOR,
  TOOL_CONTROLS_ID_FILL,
  TOOL_CONTROLS_ID_PEN,
  TOOL_CONTROLS_ID_ERASER,
  TOOL_CONTROLS_ID_EYEDROPPER,
  TOOL_CONTROLS_ID_ZOOM,
  TOOL_CONTROLS_ID_REFERENCE,
  TOOL_CONTROLS_SEG_OPTIONS,
} from '@/store/modules/ToolControls';

export default {
  data() {
    return {
      toolIdColor: TOOL_CONTROLS_ID_COLOR,
      toolIdFill: TOOL_CONTROLS_ID_FILL,
      toolIdPen: TOOL_CONTROLS_ID_PEN,
      toolIdEraser: TOOL_CONTROLS_ID_ERASER,
      toolIdEyedropper: TOOL_CONTROLS_ID_EYEDROPPER,
      toolIdZoom: TOOL_CONTROLS_ID_ZOOM,
      toolDrag: false,
      toolIdReference: TOOL_CONTROLS_ID_REFERENCE,
      toolIdSegOptions: TOOL_CONTROLS_SEG_OPTIONS,
    };
  },
  computed: {
    ...mapGetters({
      toolItemVisibleById: TOOL_CONTROL_ITEM_IS_VISIBLE,
      canvasToolActive: CANVAS_TOOL_ACTIVE,
      refWinWidth: REF_WIN_WIDTH,

    }),
    toolDragOptions() {
      return {
        animation: 10,
        group: 'tools',
        disabled: false,
        ghostClass: 'toolGhost',
      };
    },
  },
  methods: {
    refResizeWidthEnd(data) {
      console.log('RESIZING', data.width);
      this.setRefWinWidth(data.width);
    },
    toolDragStart() {
      console.log('TOOL DRAG START');
      this.toolDrag = true;
    },
    toolDragEnd() {
      console.log('TOOL DRAG END');
      this.toolDrag = false;
      eventBus.$emit('redrawRefPanel');
    },
    ...mapMutations({
      setRefWinWidth: SET_REF_WIN_WIDTH,
    }),
    colorPanelScroll(ev) {
      const panelElement = document.getElementById('colorPanel');
      const panelWrapper = panelElement.parentElement;
      const panelParent = panelWrapper.parentElement;
      panelParent.scrollTop += ev.deltaY;
    },
    penPanelScroll(ev) {
      const panelElement = document.getElementById('penPanel');
      const panelWrapper = panelElement.parentElement;
      const panelParent = panelWrapper.parentElement;
      panelParent.scrollTop += ev.deltaY;
    },
    eraserPanelScroll(ev) {
      const panelElement = document.getElementById('eraserPanel');
      const panelWrapper = panelElement.parentElement;
      const panelParent = panelWrapper.parentElement;
      panelParent.scrollTop += ev.deltaY;
    },
    fillPanelScroll(ev) {
      const panelElement = document.getElementById('fillPanel');
      const panelWrapper = panelElement.parentElement;
      const panelParent = panelWrapper.parentElement;
      panelParent.scrollTop += ev.deltaY;
    },
    refPanelScroll(ev) {
      const panelElement = document.getElementById('refPanel');
      const panelWrapper = panelElement.parentElement;
      const panelParent = panelWrapper.parentElement;
      panelParent.scrollTop += ev.deltaY;
    },
    segOptionsPanelScroll(ev) {
      const panelElement = document.getElementById('segOptions');
      const panelWrapper = panelElement.parentElement;
      const panelParent = panelWrapper.parentElement;
      panelParent.scrollTop += ev.deltaY;
    },
  },
  components: {
    ToolControlItem,
    ColorWheelControls,
    FillControls,
    PenControls,
    EraserControls,
    draggable,
    ReferenceControls,
    VueResizable,
    SegOptions,
    // ZoomControls,
  },
};
</script>

<style lang="scss">
.tool-controls-left {
  min-width: 200px;
  position: absolute;
  top: 4px;
  left: 59px;
  min-height: 1px;
  max-height: 100%;
  padding-bottom: 11px;
  overflow:scroll;
  width: min-content;
}

.tool-controls-right {
  min-width: 200px;
  position: absolute;
  top: 4px;
  right: 4px;
  min-height: 1px;
  max-height: 100%;
  padding-bottom: 11px;
  overflow:scroll;
  width: min-content;
}

.tool-controls-right .panelWrapper {
  float:right;
  width: -webkit-fill-available;
}

.tool-controls-right .panelWrapper .fixedWidthPanel {
  float:right;
}

.tool-controls::-webkit-scrollbar {
    width: 0px;  /* Remove scrollbar space */
    background: transparent;  /* Optional: just make scrollbar invisible */
}

.toolControlsNoClick {
  pointer-events: none;
}

.toolGhost {
  opacity: 0.2;
}

.handle {
  float: left;
  padding-top: 8px;
  padding-bottom: 8px;
}

.toolDropZone {
  min-height: 30px;
  min-width: 208px;
  background: #333333;
  border: 1px dashed;
  border-color: grey;
  pointer-events: all;
}

[role=tab] {
    width: 100%;
    overflow: hidden;
}

.fixedWidthPanel {
  width:200px;
}

.tool-controls-item {
  pointer-events: all;
}

.resizable-component {
  pointer-events: all;
}
</style>
