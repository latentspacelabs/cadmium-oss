<!-- eslint-disable linebreak-style -->
<!-- eslint-disable max-len -->

<template>
    <div class="reference-controls">
      <el-collapse v-model="activeReferencePanes" @change="handleCollapse()">
        <el-collapse-item title="REFERENCE PANEL" name="reference"
            style="height:100%">
          <template slot="title">
            {{ referenceTitle }} <div class="handle tool-handle"></div>
          </template>
          <vue-resizable
            :active="['b']"
            :min-height="100"
            :height="refWinHeight"
            style="width:100%; position: relative; max-height:50vh;"
            @resize:end="refResizeHeightEnd"
          >
          <div id="ref_canvas_outer_container"
            @pointerdown="onRefCanvasMouseDown"
            style="height:100%"
          >
            <div
            id="ref_canvas_container"
            >
            <canvas
              id="referenceCanvas"
              ref="refCanvas"
              class="ref-canvas"
              :class="{
                  'main-pane__canvas-wrapper--hand-tool-active': handToolActive,
                  'main-pane__canvas-wrapper--zoom-tool-active': zoomToolActive,
                  'main-pane__canvas-wrapper--zoom-tool-mode-in': zoomToolModeIn,
                  'main-pane__canvas-inner-wrapper--eyedropper-tool-active': eyedropperToolActive,
              }"
              :width="refCanvasWidth"
              :height="refCanvasHeight"
              :style="refCanvasContainerStyle"
              @click="onRefCanvasClick"
              @mouseup="onRefCanvasMouseUp"
              @wheel="onRefCanvasScroll"
            ></canvas>
          </div>
        </div>
        <div style="width: 100%;
                    height: 50px;
                    bottom: 0px;
                    position: absolute;
                    background: #333333;"
        >
          <sidebar-item
            class="palette_dropper_button"
            :iconUrl="icons.eyedropper"
            :isPressed="toolActive(eyedropperToolId)"
            :isHighlighted="toolActive(eyedropperToolId)"
            @click="onSidebarItemClick(eyedropperToolId)"
            style="display:inline-block; margin-left: 5px; margin-top: 5px;"
          ></sidebar-item>
          <round-button
            class="swatchButtons resetRefBUTTON"
            :text="resetButtonText"
            size="s"
            @click="resetRefCanvasView"
            color="white-outline"
            :style="{
              // position: 'absolute',
              marginLeft: '10px',
              height: '24px',
              width: '120px',
              fontSize: '12px',
              textTransform: 'lowercase',
              opacity: .4,
              position: 'absolute',
              top: '11px',
            }"
          ></round-button>
        </div>
         </vue-resizable>
        </el-collapse-item>
        <el-collapse-item :title="libraryTitle" name="library">
          <ul id="reference_file_list">
            <li
            class="reference_image_list_item"
            :key="index"
            :id="referenceImage.name"
            v-for="(referenceImage, index) in reference_images"
            v-on:click="setReferenceSelected(index)"
            v-bind:class="{ referenceFileSelected: referenceImage.selected}"
            >
              {{ referenceImage.name }}
            </li>
          </ul>
          <div
           class="addReferenceImageButton"
           v-on:click="addNewReferenceImage()"
         >
           <svg class="svg-circleplus" viewBox="20 20 60 60" >
             <line x1="32.5" y1="50" x2="67.5" y2="50" stroke-width="5"></line>
             <line x1="50" y1="32.5" x2="50" y2="67.5" stroke-width="5"></line>
           </svg>
         </div>
         <div
          v-on:click="deleteReferenceImage()"
          class="deleteReferenceButton"
         >
         <svg class="svg-trashcan">
         <g>
           <g>
             <path class="st0" d="M11.5,5.38c0-0.76,0.61-1.37,1.37-1.37h4.26c0.76,0,1.37,0.61,1.37,1.37"/>
             <g>
               <line class="st0" x1="15" y1="10.33" x2="15" y2="23.02"/>
               <line class="st0" x1="19.97" y1="10.33" x2="19.62" y2="23.02"/>
               <line class="st0" x1="10.03" y1="10.33" x2="10.58" y2="23.02"/>
             </g>
             <path class="st0" d="M5.78,7.8h18.44V7.33c0-0.79-0.64-1.44-1.44-1.44H7.22c-0.79,0-1.44,0.64-1.44,1.44V7.8z"/>
             <path class="st0" d="M6.5,8.22l0.75,15.73c0.07,1.21,0.91,2.03,2.03,2.03h11.44c1.12,0,1.92-0.84,2.03-2.03L23.5,8.22"/>
           </g>
         </g>
         </svg>
        </div>
       </el-collapse-item>
     </el-collapse>
    </div>

</template> <!-- eslint-disable linebreak-style -->
<!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
/* eslint-disable-next-line */
import { mapGetters, mapMutations, mapActions } from 'vuex';
import { t } from '@/util/i18n';
import VueResizable from 'vue-resizable';

import {
  REFERENCE_COLLAPSE,
  REFERENCE_IMAGES,
  REF_CANVAS_SIZE,
  ZOOM_TOOL_MODE,
  REF_WIN_HEIGHT,
  REF_WIN_WIDTH,
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  REF_CAN_POS,
  REF_CAN_SCALE,
} from '@/store/getter-types';

import {
  ADD_NEW_REFERENCE_IMAGE,
  DELETE_SELECTED_REFERENCE_IMAGES,
  ACTIVATE_TOOL_BY_ID,
} from '@/store/action-types';

import {
  SET_REFERENCE_COLLAPSE,
  DELETE_FILE_FROM_REFERENCE_FILES,
  SET_SELECTED_REFERENCE_FILE,
  SET_REF_CANVAS_SIZE,
  SET_REF_WIN_HEIGHT,
  SET_SELECTED_COLOR,
  SET_REF_CAN_POS,
  SET_REF_CAN_SCALE,
} from '@/store/mutation-types';

import {
  LEFT_MOUSE_BUTTON,
} from '@/util/mouse-util';

import {
  ZOOM_TOOL_MODE_IN,
  // ZOOM_TOOL_MODE_OUT,
} from '@/store/modules/ZoomTool';

import {
  TOOL_CONTROLS_ID_ZOOM,
  TOOL_CONTROLS_ID_EYEDROPPER,
  TOOL_CONTROLS_ID_HAND,
  TOOL_CONTROLS_ID_PEN,
} from '@/store/modules/ToolControls';

import {
  rgbaArrayToHex,
} from '@/util/color-util';

import SidebarItem from '@/components/SidebarItem.vue';

import RoundButton from '@/components/RoundButton.vue';

import { eventBus } from '@/main';

const REF_CANVAS_SCALE_MIN = 0.05;
const REF_CANVAS_SCALE_MAX = 50;

export default {
  data() {
    return {
      activeReferencePanes: [],
      dragZoom: false,
      dragZoomX: 0,
      dragZoomY: 0,
      lastMouseClientX: 0,
      lastMouseClientY: 0,
      eyedropperToolId: TOOL_CONTROLS_ID_EYEDROPPER,
      /* eslint-disable global-require */
      icons: {
        eyedropper: require('../assets/icons/eyedropper.svg'),
      },
    };
  },
  computed: {
    renderStyle() { return this.refCanvasContainerScale <= 1.5 ? 'auto' : 'pixelated'; },
    refCanvasContainerStyle() {
      return {
        transform: `scale(${this.refCanvasContainerScale})`,
        left: `${this.refCanvasRelPositionLeft}px`, // position after hand tool usage
        top: `${this.refCanvasRelPositionTop}px`,
        position: 'relative',
        imageRendering: `${this.renderStyle}`,
      };
    },
    refCanvasRelPositionLeft() { return this.refCanPos.left; },
    refCanvasRelPositionTop() { return this.refCanPos.top; },
    refCanvasContainerScale() { return this.refCanScale; },
    refCanvasWidth() { return this.refCanvasSize.width; },
    refCanvasHeight() { return this.refCanvasSize.height; },
    referenceTitle() { return t('REFERENCE PANEL'); },
    libraryTitle() { return t('LIBRARY'); },
    resetButtonText() { return t('Reset View'); },
    ...mapGetters({
      referenceCollapse: REFERENCE_COLLAPSE,
      refCanvasSize: REF_CANVAS_SIZE,
      reference_images: REFERENCE_IMAGES,
      refWinHeight: REF_WIN_HEIGHT,
      refWinWidth: REF_WIN_WIDTH,
      toolActive: TOOL_CONTROL_ITEM_IS_VISIBLE,
      refCanPos: REF_CAN_POS,
      refCanScale: REF_CAN_SCALE,
    }),
    dragOptions() {
      return {
        animation: 200,
        group: 'description',
        disabled: false,
        ghostClass: 'ghost',
      };
    },
    zoomToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_ZOOM);
    },
    zoomToolModeIn() {
      const isZoomToolModeIn = this.$store.getters[ZOOM_TOOL_MODE] === ZOOM_TOOL_MODE_IN;
      return isZoomToolModeIn;
    },
    eyedropperToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_EYEDROPPER);
    },
    handToolActive() {
      let handToolResp = false;
      if (this.toolActive(TOOL_CONTROLS_ID_HAND)) {
        handToolResp = true;
      } else if (this.toolActive(TOOL_CONTROLS_ID_PEN)) {
        handToolResp = true;
      } return handToolResp;
    },
    penToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_PEN);
    },
  },
  methods: {
    onSidebarItemClick(itemType) {
      this.$store.dispatch(ACTIVATE_TOOL_BY_ID, {
        toolId: itemType,
        preventReActivation: true, // special case for color picker
      });
    },
    refResizeHeightEnd(data) {
      this.setRefWinHeight(data.height);
    },
    resetRefCanvasView() {
      let index;
      for (let i = 0; i < this.reference_images.length; i += 1) {
        if (this.reference_images[i].selected) {
          index = i;
        }
      }
      this.setReferenceSelected(index);
    },
    addNewReferenceImage() {
      this.$store.dispatch(ADD_NEW_REFERENCE_IMAGE);
    },
    deleteReferenceImage() {
      // Through the ACTION so the delete is undoable (and the reverse loop
      // there splices safely).
      this.$store.dispatch(DELETE_SELECTED_REFERENCE_IMAGES);
    },
    async setReferenceSelected(index) {
      this.setRefCanPos({ top: 0, left: 0 });
      this.setSelectedReferenceFile(index);
      const refWidth = this.reference_images[index].width;
      const refHeight = this.reference_images[index].height;
      await this.setRefCanvasSize({ height: refHeight, width: refWidth });
      const refCanvas = document.getElementById('referenceCanvas');
      const ctx = refCanvas.getContext('2d');
      const blankImageData = ctx.createImageData(refWidth, refHeight);
      for (let i = 0; i < blankImageData.data.length; i += 4) {
        blankImageData.data[i + 0] = 0;
        blankImageData.data[i + 1] = 0;
        blankImageData.data[i + 2] = 0;
        blankImageData.data[i + 3] = 0;
      }
      ctx.putImageData(blankImageData, 0, 0);
      const refImage = new Image();
      refImage.src = this.reference_images[index].b64Data;
      const refWinRatio = this.refWinWidth / refWidth;
      this.setRefCanScale(refWinRatio);
      refImage.onload = function refLoaded() {
        ctx.drawImage(refImage, 0, 0);
        document.getElementById('referenceCanvas').scrollIntoView({
          behavior: 'auto',
          block: 'center',
          inline: 'center',
        });
      };
    },
    async redrawRefPanel(index) {
      console.log('redraw');
      const setRefTop = this.refCanPos.top;
      const setRefLeft = this.refCanPos.left;
      this.setRefCanPos({ top: 0, left: 0 });
      this.setSelectedReferenceFile(index);
      const refWidth = this.reference_images[index].width;
      const refHeight = this.reference_images[index].height;
      await this.setRefCanvasSize({ height: refHeight, width: refWidth });
      const refCanvas = document.getElementById('referenceCanvas');
      const ctx = refCanvas.getContext('2d');
      const blankImageData = ctx.createImageData(refWidth, refHeight);
      for (let i = 0; i < blankImageData.data.length; i += 4) {
        blankImageData.data[i + 0] = 0;
        blankImageData.data[i + 1] = 0;
        blankImageData.data[i + 2] = 0;
        blankImageData.data[i + 3] = 0;
      }
      ctx.putImageData(blankImageData, 0, 0);
      const refImage = new Image();
      refImage.src = this.reference_images[index].b64Data;
      refImage.onload = function refLoaded() {
        ctx.drawImage(refImage, 0, 0);
      };
      document.getElementById('referenceCanvas').scrollIntoView({
        behavior: 'auto',
        block: 'center',
        inline: 'center',
      });
      this.setRefCanPos({ top: setRefTop, left: setRefLeft });
    },
    handleCollapse() {
      const referencePanes = this.activeReferencePanes;
      this.setReferenceCollapse(referencePanes);
    },
    loadCollapse() {
      this.activeReferencePanes = this.referenceCollapse;
    },
    ...mapActions({
    }),
    ...mapMutations({
      setReferenceCollapse: SET_REFERENCE_COLLAPSE,
      deleteFileFromReferenceFiles: DELETE_FILE_FROM_REFERENCE_FILES,
      setSelectedReferenceFile: SET_SELECTED_REFERENCE_FILE,
      setRefCanvasSize: SET_REF_CANVAS_SIZE,
      setRefWinHeight: SET_REF_WIN_HEIGHT,
      setSelectedColor: SET_SELECTED_COLOR,
      setRefCanPos: SET_REF_CAN_POS,
      setRefCanScale: SET_REF_CAN_SCALE,
    }),
    onRefCanvasMouseMove(ev) {
      if (this.handToolActive || this.penToolActive) {
        const xChange = ev.clientX - this.lastMouseClientX;
        const yChange = ev.clientY - this.lastMouseClientY;
        const newLeft = this.refCanPos.left + xChange;
        const newTop = this.refCanPos.top + yChange;
        this.setRefCanPos({ top: newTop, left: newLeft });
        this.lastMouseClientX = ev.clientX;
        this.lastMouseClientY = ev.clientY;
      }
    },
    onRefCanvasClick(ev) {
      if (this.zoomToolActive) {
        this.onRefCanvasClickZoom(ev);
      } else if (this.eyedropperToolActive) {
        this.grabColorOnMousePositionFromCanvas(ev);
      }
    },
    onRefCanvasMouseDown(ev) {
      this.lastMouseClientX = ev.clientX;
      this.lastMouseClientY = ev.clientY;
      document.getElementById('ref_canvas_outer_container').addEventListener('mousemove', this.onRefCanvasMouseMove);
      document.getElementById('ref_canvas_outer_container').addEventListener('pointerleave', this.onRefCanvasMouseExit);
    },
    onRefCanvasMouseExit() {
      document.getElementById('ref_canvas_outer_container').removeEventListener('mousemove', this.onRefCanvasMouseMove);
    },
    onRefCanvasMouseUp() {
      document.getElementById('ref_canvas_outer_container').removeEventListener('mousemove', this.onRefCanvasMouseMove);
    },
    onRefCanvasClickZoom(ev) {
      if (
        ev.which !== LEFT_MOUSE_BUTTON
        || this.dragZoom
      ) { return; }
      // console.log("zoom clicked");
      const isZoomModeIn = this.$store.getters[ZOOM_TOOL_MODE] === ZOOM_TOOL_MODE_IN;
      const zoomFactor = 0.3;

      // make canvas zoom from origin of mouse
      const scale = this.refCanScale;
      const { x, y } = this.getRefCanvasMousePositionByMouseEvent(ev);
      const w = this.refCanvasSize.width;
      const h = this.refCanvasSize.height;
      const xOrigin = ((w / 2) - x);
      const yOrigin = ((h / 2) - y);
      const dx = (xOrigin) * (zoomFactor * scale);
      const dy = (yOrigin) * (zoomFactor * scale);
      if (!isZoomModeIn && scale > REF_CANVAS_SCALE_MIN) {
        // these next lines reposition canvas on zoom
        const newX = this.refCanPos.left - dx;
        const newY = this.refCanPos.top - dy;
        this.setRefCanPos({ top: newY, left: newX });
        const newScale = this.refCanScale * (1 - zoomFactor);
        this.setRefCanScale(Math.min(
          Math.max(REF_CANVAS_SCALE_MIN, newScale),
          REF_CANVAS_SCALE_MAX,
        ));
      } else if (isZoomModeIn && scale < REF_CANVAS_SCALE_MAX) {
        // these next lines reposition canvas on zoom
        const newX = this.refCanPos.left + dx;
        const newY = this.refCanPos.top + dy;
        this.setRefCanPos({ top: newY, left: newX });
        const newScale = this.refCanScale * (1 + zoomFactor);
        this.setRefCanScale(Math.min(
          Math.max(REF_CANVAS_SCALE_MIN, newScale),
          REF_CANVAS_SCALE_MAX,
        ));
      }
      // console.log("isZoomModeIn= " + isZoomModeIn);
      // console.log("canvasLeft: " + this.canvasRelPositionLeft);
    },
    onRefCanvasScroll(ev) {
      const zoomFactor = 0.1;
      // console.log("ev.deltaY: " + ev.deltaY);
      // make canvas zoom from origin of mouse
      const scale = this.refCanScale;
      console.log('scale', this.renderStyle);
      const { x, y } = this.getRefCanvasMousePositionByMouseEvent(ev);
      const w = this.refCanvasSize.width;
      const h = this.refCanvasSize.height;
      const xOrigin = (x - (w / 2));
      const yOrigin = (y - (h / 2));
      const dx = (xOrigin) * (zoomFactor * scale);
      const dy = (yOrigin) * (zoomFactor * scale);
      // now we have what we need to reposition canvas on zoom
      // if we are zooming out:
      if (ev.deltaY > 0 && scale > REF_CANVAS_SCALE_MIN) {
        // these next lines reposition canvas on zoom
        const newX = this.refCanPos.left + dx;
        const newY = this.refCanPos.top + dy;
        this.setRefCanPos({ top: newY, left: newX });
        const newScale = this.refCanScale * (1 - zoomFactor);
        this.setRefCanScale(newScale);
      } else if (ev.deltaY < 0 && scale < REF_CANVAS_SCALE_MAX) {
        // these next lines reposition canvas on zoom
        const newScale = this.refCanScale * (1 + zoomFactor);
        this.setRefCanScale(newScale);
        const newX = this.refCanPos.left - dx;
        const newY = this.refCanPos.top - dy;
        this.setRefCanPos({ top: newY, left: newX });
      }
    },
    async grabColorOnMousePositionFromCanvas(ev) {
      const { x, y } = this.getRefCanvasMousePositionByMouseEvent(ev);
      const referenceCanvas = document.getElementById('referenceCanvas');
      let ctx = referenceCanvas.getContext('2d');
      let rgbaArr;
      const rgbaArrPre = ctx.getImageData(x, y, 1, 1).data;
      if (rgbaArrPre[3] === 0) {
        ctx = referenceCanvas.getContext('2d');
        rgbaArr = ctx.getImageData(x, y, 1, 1).data;
      } else {
        rgbaArr = ctx.getImageData(x, y, 1, 1).data;
      }
      // Special case: if there is the selected pixel is transparent (alpha = 0),
      // then transparent black is returned.
      // Because our canvas background is white, we return opaque white then.
      // Otherwise it would be confusing for the user, because the fill color
      // would be opaque black.
      if (rgbaArr[3] === 0) {
        rgbaArr = this.canvasBackgroundColor;
        this.setSelectedColor(rgbaArr);
      } else {
        const rgbaHexStr = rgbaArrayToHex(rgbaArr, { useAlpha: false, useHashSymbol: true });
        this.setSelectedColor(rgbaHexStr);
      }
    },
    getRefCanvasMousePositionByMouseEvent(ev) {
      const referenceCanvas = document.getElementById('referenceCanvas');
      const b = referenceCanvas.getBoundingClientRect();
      const scale = referenceCanvas.width / parseFloat(b.width);
      const x = (ev.clientX - b.left) * scale;
      const y = (ev.clientY - b.top) * scale;
      // the following makes sure that we never return NaN
      // (which can cause nasty errors on the GPU):
      if (Number.isNaN(x) || Number.isNaN(y)) {
        return { x: 0, y: 0 };
      }
      return { x, y };
    },
  },
  watch: {
    reference_images(r) {
      if (r.length === 1) {
        this.setReferenceSelected(0);
      } else if (r.length === 0) {
        this.setRefCanvasSize({ height: 0, width: 0 });
      }
    },
  },
  mounted() {
  },
  created() {
    this.loadCollapse();
    if (this.refHeight !== undefined) {
      this.setRefCanvasSize({ height: this.refHeight, width: this.refWidth });
    }
    for (let i = 0; i < this.reference_images.length; i += 1) {
      if (this.reference_images[i].selected) {
        this.redrawRefPanel(i);
      }
    }
    eventBus.$on('redrawRefPanel', () => {
      for (let i = 0; i < this.reference_images.length; i += 1) {
        if (this.reference_images[i].selected) {
          this.redrawRefPanel(i);
        }
      }
    });
  },
  updated() {
  },
  components: {
    VueResizable,
    RoundButton,
    SidebarItem,
  },
};

</script>

<style lang="scss">
@import '../scss/modules/general.scss';

  .tool-handle {
    width: 100%;
    height: 25px;
    position: absolute;
    margin-left: -7px;
  }

  .reference-controls {
    margin-top: -20px;
    padding-left:0px;
    padding-right:0px;
    padding-top: var(--space-md);
  }

  .addReferenceImageButton {
    border-style: solid;
    border-color: rgb(78, 78, 78);
    border-radius: 50%;
    border-width: 2px;
    width: 26px;
    height: 26px;
    stroke: #4e4e4e;
    display: inline-block;
    margin-left: 10px;
    margin-bottom: 10px;
    cursor: pointer;
  }

  .addReferenceImageButton:hover {
    stroke: #fff;
    border: 2px solid #fff;
    opacity: 0.4;
  }

  .reference_image_list_item{
    color: #898989;
    cursor: pointer;
  }

  .reference_image_list_item:nth-child(even) {
    background: #3a3a3a;
  }

  #reference_file_list {
    padding-inline-start: 0px;
    padding-left: 7px;
    padding-right: 7px;
    margin-top: 0px;
  }

  .referenceFileSelected {
    color: white;
  }

  .deleteReferenceButton{
    color: grey;
    display: inline-block;
    margin-left: 8px;
    cursor: pointer;
  }

  .svg-trashcan:hover {
    stroke: #fff;
    opacity: 0.4;
  }

  .svg-trashcan {
    stroke: #4e4e4e;
    fill: none;
    width: 25px;
    height: 27px;
  }

  #ref_canvas_outer_container {
    height: calc(100% - 50px ) !important;
    overflow: hidden;
    position: relative;
  }

  #ref_canvas_container {
    display: inline-flex;
  }

  .palette_dropper_button img {
    margin-left: 5px;
    margin-top: 6px;
  }

  #refPanel .tool-control-item__header {
    display:none;
  }

</style>
