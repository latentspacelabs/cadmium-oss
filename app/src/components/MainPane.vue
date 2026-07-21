<!-- eslint-disable linebreak-style -->
<template>
  <!-- <main class="main-page"> -->

    <section
      class="main-pane"
      @dragenter.capture="onDragEnter"
      @dragleave.capture="onDragLeave"
      @dragover.capture="onDragOver"
      @dragend="onDragEnd"
    >
      <section class="main-pane__canvas-pane">
        <v-tour
          name="myTour"
          :steps="steps"
          :callbacks="tourCallbacks"
          :options="tourOptions">
        </v-tour>
        <div
          class="main-pane__canvas-wrapper"
          :class="{
              'main-pane__canvas-wrapper--hand-tool-active': handToolActive,
              'main-pane__canvas-wrapper--zoom-tool-active': zoomToolActive,
              'main-pane__canvas-wrapper--zoom-tool-mode-in': zoomToolModeIn,
              'main-pane__canvas-wrapper--mouse-down': isMouseDown,
          }"
          ref="canvasWrapper"
          id="canvasWrapper"
          @wheel="onCanvasWrapperScroll"
          @pointerdown="onCanvasWrapperMouseDown"
          @pointerup="onCanvasWrapperMouseUp"
          @click="onCanvasWrapperClick"
          @mousemove="onCanvasInnerWrapperMouseMove"
        >
          <div
            class="main-pane__canvas-inner-wrapper"
            ref="canvasInnerWrapper"
            :class="{
              'main-pane__canvas-inner-wrapper--fill-tool-active': fillToolActive,
              'main-pane__canvas-wrapper--fill-tool-mode-erase': fillToolModeErase,
              'main-pane__canvas-inner-wrapper--pen-tool-active': penToolActive,
              'main-pane__canvas-inner-wrapper--eraser-tool-active': eraserToolActive,
              'main-pane__canvas-inner-wrapper--pen-tool-diameter-adjust': penToolDiameterAdjust,
              'main-pane__canvas-inner-wrapper--eraser-tool-diameter-adjust':
              eraserToolDiameterAdjust,
              'main-pane__canvas-inner-wrapper--eyedropper-tool-active': eyedropperToolActive,
            }"
            :style="canvasInnerWrapperStyle"
            @pointerdown="onCanvasInnerWrapperMouseDown"
            @pointerup="onCanvasInnerWrapperMouseUp"
          >
            <div
              class="canvas-background"
              :style="canvasBackgroundStyle"
            ></div>
            <canvas
              ref="colorCanvas"
              class="main-canvas main-canvas--fill"
              :width="canvasWidth"
              :height="canvasHeight"
            ></canvas>
            <canvas
              ref="lineCanvas"
              class="main-canvas main-canvas--line"
              :width="canvasWidth"
              :height="canvasHeight"
            ></canvas>
            <canvas
              ref="tempCanvas"
              class="main-canvas main-canvas--temp"
              :width="canvasWidth"
              :height="canvasHeight"
            ></canvas>
          </div>
          <!--
            currently vue-debounce does not seem to work with custom events,
            se we have to wrap the call to the debounced function.
          -->
          <resize-observer @notify="onCanvasWrapperResize" />
          <!-- eslint-disable-next-line  -->
          <!-- <resize-observer v-debounce:500="saveCanvasWrapperSizeInStore" debounce-events="notify" /> -->
        </div>
        <div class="main-pane__canvas-tools-wrapper">
          <sidebar></sidebar>
          <tool-controls
            v-if="toolControlsVisible"
          ></tool-controls>
        </div>
        <welcome-modal
          :is-visible="welcomeVisible"
          @close="$emit('welcome-close')"
          @start-tour="startTourFromWelcome"
        ></welcome-modal>
      </section>
      <section class="timeline-and-footer" style="z-index:5;">
        <timeline-pane></timeline-pane>
        <footer-bar></footer-bar>
      </section>
      <image-import-waiting-screen></image-import-waiting-screen>
    </section>

<!-- </main> -->
</template> <!-- eslint-disable linebreak-style -->

<script>
/* eslint-disable linebreak-style */
/**
 * This component sits below the nav-bar and acts as a wrapper
*/
/* eslint-disable import/no-extraneous-dependencies */
import { setPref, subscribe } from '@/platform';
import { mapGetters, mapMutations, mapActions } from 'vuex';
/* eslint-disable import/extensions */
import debounce from 'vue-debounce/dist/debounce.min.js';
import StampMaker from 'px-brush/src/StampMaker.js';
/* eslint-disable import/extensions */
import store from '@/store'; // needed for debounced resize-handler

import {
  COLOR_IMAGE_FOR_SELECTED_FRAME,
  LINE_IMAGE_FOR_SELECTED_FRAME,
  TIMELINE_HAS_FRAMES,
  TIMELINE_VISIBILITY,
  LAYER_IS_VISIBLE,
  LAYER_IS_DRAWABLE,
  LAST_IMAGE_DIFFERENT_TO_CANVAS_SIZE,
  SELECTED_FRAME_NR,
  TOOL_CONTROLS_VISIBLE,
  SELECTED_COLOR,
  TOOL_CONTROL_ITEM_IS_VISIBLE,
  FILL_TOOL_MODE,
  // FILL_TOOL_EXPAND,
  FILL_TOOL_RANGE,
  ZOOM_TOOL_MODE,
  COLOR_IMAGE_ID_FOR_SELECTED_FRAME,
  LINE_IMAGE_ID_FOR_SELECTED_FRAME,
  // IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS,
  CANVAS_SIZE,
  CANVAS_SCALE,
  BACKGROUND_COLOR,
  CANVAS_TOOL_ACTIVE,
  PEN_TOOL_DIAMETER,
  ERASER_TOOL_DIAMETER,
  IS_PRESSURE_ENABLED,
  PEN_TOOL_MODE,
  PEN_DRAW_MODE,
  ACTIVE_CANVAS_TOOL,
  COLOR_PALETTE,
  ACTIVE_LAYER_ID,
  // IS_FILL_METHOD_SEGMAP,
  // IMAGE_HAS_SEGMENTATION_MAP,
  SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID,
  // DILATION_SIZE,
  PALETTE_EVENT_OCCURRED,
  CANVAS_REDRAW_TRIGGER,
  COLOR_PREVIEW_MODE,
  LINE_HASH_FOR_SELECTED_FRAME,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  IMAGE_DATA_OF_FRAME,
  COLORIZATION_IN_PROGRESS,
} from '@/store/getter-types';

import {
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
  // MAX_SUPPORTED_IMAGE_PIXELS_PRO,
  // MAX_SUPPORTED_IMAGE_PIXELS_STANDARD,
} from '@/store/general-types';

import {
  SET_CANVAS_TOOL_ACTIVE,
  SET_FILE_DRAG_N_DROP_IN_PROGRESS,
  SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  SET_SELECTED_COLOR,
  REPLACE_IMAGE_DATA_URI,
  SET_AVAILABLE_SPACE_FOR_CANVAS,
  ADD_COLOR_TO_PALETTE,
  SET_PEN_TOOL_DIAMETER,
  SET_ERASER_TOOL_DIAMETER,
  SET_PALETTE_EVENT_OCCURRED,
  SET_ZOOM_TOOL_MODE,
  // SET_ACTIVE_CANVAS_TOOL_ID,
  CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
  SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID,
} from '@/store/mutation-types';

import {
  STORE_IMAGE_IN_IMAGE_STORE,
  CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER,
  ACTIVATE_PREVIOUS_TOOL,
  ANALYZE_CURRENT_FRAME,
  CANVAS_ACTION,
  ACTIVATE_TOOL_BY_ID,
  STORE_BLANK_IMAGE_IN_IMAGE_STORE,
} from '@/store/action-types';
/*
import {
  undo,
  redo,
} from '@/store/undo-redo-plugin';
*/
import { closeUndoBoundary } from '@/store/undo-redo-plugin';
import {
  FILL_TOOL_MODE_FILL,
  FILL_TOOL_MODE_ERASE,
} from '@/store/modules/FillTool';

import {
  ZOOM_TOOL_MODE_IN,
  // ZOOM_TOOL_MODE_OUT,
} from '@/store/modules/ZoomTool';

import {
  MIN_DIAMETER,
  MAX_DIAMETER,
  PEN_TOOL_MODE_DRAW,
} from '@/store/modules/PenTool';

import {
  TOOL_CONTROLS_ID_HAND,
  TOOL_CONTROLS_ID_ZOOM,
  TOOL_CONTROLS_ID_FILL,
  TOOL_CONTROLS_ID_PEN,
  TOOL_CONTROLS_ID_ERASER,
  TOOL_CONTROLS_ID_EYEDROPPER,
} from '@/store/modules/ToolControls';

import {
  hexToRgbArray,
  rgbaArrayToHex,
} from '@/util/color-util';
import {
  LEFT_MOUSE_BUTTON,
  RIGHT_MOUSE_BUTTON,
} from '@/util/mouse-util';
import {
  loadImage,
  getImageDimensions,
} from '@/util/image-util';
import {
  base64Encode,
} from '@/util/file-util';
import {
  distanceBetween,
  angleBetween,
} from '@/util/2d-util';
// import { logError } from '@/util/error-util';
import { getBlankDataUri } from '@/util/canvas-util';
import { floodFill5 } from '@/util/flood-fill5';
import { floodFill6 } from '@/util/flood-fill6';

import TimelinePane from '@/components/TimelinePane.vue';
import FooterBar from '@/components/FooterBar.vue';
import ImageImportWaitingScreen from '@/components/ImageImportWaitingScreen.vue';
import Sidebar from '@/components/Sidebar.vue';
import ToolControls from '@/components/ToolControls.vue';
import WelcomeModal from '@/components/WelcomeModal.vue';

import { t } from '@/util/i18n';
import showCustomDialog from '@/util/customDialog';
import triggerMenuRebuildWithColorizationState from '@/util/menu';
import { preloadImages } from '@/util/frame-preload';

const Pressure = require('pressure');

const CANVAS_SCALE_MIN = 0.05;
const CANVAS_SCALE_MAX = 50;

// The mousemove event listener does not need to be reactive,
// so we can store it outside the data() property
let mouseMoveEventListener = null;

// let keyDownEventListener = null;

// let keyEventListener = null;
// let pointsHistory = [];

export default {
  name: 'my-tour',
  props: {
    welcomeVisible: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      tourOptions: {
        useKeyboardNavigation: false,
        labels: {
          buttonSkip: t('Skip tour'),
          buttonPrevious: t('Previous'),
          buttonNext: t('Next'),
          buttonStop: t('Finish'),
        },
      },
      tourCallbacks: {
        onSkip: this.tourCompleted,
        onFinish: this.tourCompleted,
      },
      steps: [
        {
          target: '.step-0', // We're using document.querySelector() under the hood
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-1',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-2',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-3',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-4',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-5',
          content: '',
          params: {
            placement: 'right',
          },
        },
        {
          target: '.step-6',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-7',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-8',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-9',
          content: '',
          params: {
            placement: 'right',
          },
        },
        {
          target: '.step-10',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-11',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-12',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-13',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-14',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-15',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-16',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-16a',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-17',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-18',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-19',
          content: '',
          params: {
            placement: 'bottom',
          },
        },
        {
          target: '.step-20',
          content: '',
          params: {
            placement: 'bottom',
          },
        },
        {
          target: '.step-21',
          content: '',
          params: {
            placement: 'bottom',
          },
        },
        {
          target: '.step-22',
          content: '',
          params: {
            placement: 'bottom',
          },
        },
        {
          target: '.step-23',
          content: '',
          params: {
            placement: 'top',
          },
        },
        {
          target: '.step-24',
          content: '',
          params: {
            placement: 'bottom',
          },
        },
      ],
      isDragOver: false,
      isMouseDown: false,
      isAltPressed: false,
      lastMouseClientX: 0,
      lastMouseClientY: 0,
      lastMouseZoomPosX: 0,
      lastMouseZoomPosY: 0,
      canvasScale: 0.5,
      canvasRelPositionLeft: 0,
      canvasRelPositionTop: 0,
      dragZoom: false,
      dragZoomX: 0,
      dragZoomY: 0,
      isDrawing: false,
      currentPressure: 0, // [0..1], 0 = no pressure, 1 = full pressure
      // previousPressure: 0,
      clickZoom: true,
      pointsToDraw: [],
      previousDrawPoint: null, // { x: 0, y: 0 },
      // which tool was selected when mouse was pressed,
      // this will be used to prevent a fill action to happen
      // after using the handtool (drag canvas)
      selectedToolIdOnMouseDown: null,
      penDiameterAdjust: false,
      eraserDiameterAdjust: false,
      firstDiameter: PEN_TOOL_DIAMETER,
      firstEraserDiameter: ERASER_TOOL_DIAMETER,
      newDiameter: PEN_TOOL_DIAMETER,
      newEraserDiameter: ERASER_TOOL_DIAMETER,
      firstXPos: 0,
      firstXDiamPos: 0,
      firstYDiamPos: 0,
      firstRecord: true,
      canvasPositionTopAdjust: 0,
      stampMaker: new StampMaker(),
      context: null,
      // drawColor: '#000000',
      safeDelay: false,
      safeTimer: null,
      whichButton: 0,
      mouseDownFinished: false,
      // radGradBrush: null,
    };
  },
  async created() {
    this.steps[0].content = t('<strong>Welcome To Cadmium!</strong><br/><br/>Start by dragging your .png line frames into this area.'
      + ' You can drag entire folders too :) Do not forget to have an alpha channel on your images!');
    this.steps[1].content = t('Cool. Nice. You might notice that Cadmium recognizes duplicate frames. Neat, right?');
    this.steps[2].content = t('Now that you have some frames, try playing what you imported. Everything look ok?');
    this.steps[3].content = t('Now, we need to give Cadmium an example of how to color your animation.'
      + ' There are two ways to do that...');
    this.steps[4].content = t('The first way is to drag a colored image onto the color layer '
      + '(make sure it does not include the line for best results.)');
    this.steps[5].content = t('You can also color with the fill tool, over here.');
    this.steps[6].content = t('Open up this circular buddy and choose your colors. You can change the background color here as well.');
    this.steps[7].content = t('Now you are ready to fill! Click areas of your line drawing to apply the color. '
      + 'The fill tool will always apply color to the color layer.');
    this.steps[8].content = t("If some gaps aren't closing, you can close them manually with this pen, pal.");
    this.steps[9].content = t('If you have been following along, you now have a "reference frame,"'
      + ' which is signified by a dot on the frame. clicking this diamond will toggle any selected frames to be a reference frame.'
      + ' Right clicking on that frame also allows you to toggle this state.');
    this.steps[10].content = t('After having added your reference frames, select the empty frames you would like Cadmium to color, and then hit this button.');
    this.steps[11].content = t('So neat, Cadmium hopefully did some coloring for you. There might be a few mistakes, '
      + 'but you can try correcting stuff and reprocessing with more reference frames.');
    this.steps[12].content = t('The closest reference frame will always be used to color your empty frame. '
      + 'You can make any colored frame a reference frame by right clicking it.');
    this.steps[13].content = t('When you are ready to export your frames, make visible the layers you would like to see, '
      + 'and hit export.');
    this.steps[14].content = t("Those are the basics! If you are curious, here's a few more useful tips that you might find helpful:...");
    this.steps[15].content = t('To change which layer to use the pen tool on, click the layer names, or press shift + up/down');
    this.steps[16].content = t('The analyze button will return a randomly colored image map of your art that shows '
      + ' you the different regions of your drawing.');
    this.steps[17].content = t('Inside the color panel is your color palette, which displays every color that you have used. '
      + 'Clicking on these color swatches selects that color. You can drag to reorder them, or add a new swatch here as well.');
    this.steps[18].content = t('You can globally change colors in your scene by selecting one or multiple color swatches, '
      + 'setting the color you want to change it to as your active color, and then pressing the Change Colors button.');
    this.steps[19].content = t('If you do not know what something does, hovering over most any button will display some info. '
      + 'You can also click the question mark for some more in depth information and links to tutorials.');
    this.steps[20].content = t('Up here are the preference panes, from left to right they are analyze settings, '
      + 'line colorization settings, and the reference panel.');
    this.steps[21].content = t('Analyze settings allows you to control how cadmium analyzes your line work.');
    this.steps[22].content = t('Line colorization settings control the auto line colorization feature. '
      + 'Heads up this is an experimental feature, but it might be quite helpful!.');
    this.steps[23].content = t('You can also toggle line colorization by clicking the spark icon on the outline layer.');
    this.steps[24].content = t('The reference panel allows you to load in several reference frames for quick color picking'
      + ' and reference.');
  },
  computed: {
    ...mapGetters({
      selectedLineHash: LINE_HASH_FOR_SELECTED_FRAME,
      selectedLineImage: LINE_IMAGE_FOR_SELECTED_FRAME,
      selectedColorImage: COLOR_IMAGE_FOR_SELECTED_FRAME,
      selectedColorImageId: COLOR_IMAGE_ID_FOR_SELECTED_FRAME,
      selectedLineImageId: LINE_IMAGE_ID_FOR_SELECTED_FRAME,
      selectedFrameNumber: SELECTED_FRAME_NR,
      timelineHasFrames: TIMELINE_HAS_FRAMES,
      timelineIsVisible: TIMELINE_VISIBILITY,
      layerIsVisibleByLayerId: LAYER_IS_VISIBLE,
      layerIsDrawable: LAYER_IS_DRAWABLE,
      lastImageSizeDifferentThanCanvas: LAST_IMAGE_DIFFERENT_TO_CANVAS_SIZE,
      toolControlsVisible: TOOL_CONTROLS_VISIBLE,
      selectedColor: SELECTED_COLOR,
      toolActive: TOOL_CONTROL_ITEM_IS_VISIBLE,
      // imageDataIdsOfSelectedFramesOnAllLayers: IMAGE_DATA_IDS_OF_SELECTED_FRAMES_ON_ALL_LAYERS,
      canvasSize: CANVAS_SIZE,
      initialCanvasScale: CANVAS_SCALE,
      canvasToolActive: CANVAS_TOOL_ACTIVE,
      activeCanvasTool: ACTIVE_CANVAS_TOOL,
      pressureEnabled: IS_PRESSURE_ENABLED,
      penToolMode: PEN_TOOL_MODE,
      penDrawMode: PEN_DRAW_MODE,
      penToolDiameter: PEN_TOOL_DIAMETER,
      eraserToolDiameter: ERASER_TOOL_DIAMETER,
      canvasBackgroundColor: BACKGROUND_COLOR,
      colorPalette: COLOR_PALETTE,
      activeLayerId: ACTIVE_LAYER_ID,
      paletteEventOccurred: PALETTE_EVENT_OCCURRED,
      canvasRedrawTrigger: CANVAS_REDRAW_TRIGGER,
      colorPreviewMode: COLOR_PREVIEW_MODE,
      imageUriByImageId: IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
      colorizationInProgress: COLORIZATION_IN_PROGRESS,
    }),
    canvasScaleRounded() { return this.canvasScale.toFixed(2); },
    canvasWidth() { return this.canvasSize.width; },
    canvasHeight() { return this.canvasSize.height; },
    handToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_HAND);
    },
    zoomToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_ZOOM);
    },
    zoomToolModeIn() {
      const isZoomToolModeIn = this.$store.getters[ZOOM_TOOL_MODE] === ZOOM_TOOL_MODE_IN;
      return isZoomToolModeIn;
    },
    fillToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_FILL);
    },
    fillToolModeErase() {
      const isFillToolModeErase = this.$store.getters[FILL_TOOL_MODE] === FILL_TOOL_MODE_ERASE;
      return isFillToolModeErase;
    },
    penToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_PEN);
    },
    eraserToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_ERASER);
    },
    penToolDiameterAdjust() {
      // console.log('penToolDiameterAdjust: ', this.penDiameterAdjust);
      return this.penDiameterAdjust;
    },
    eraserToolDiameterAdjust() {
      // console.log('penToolDiameterAdjust: ', this.penDiameterAdjust);
      return this.eraserDiameterAdjust;
    },
    eyedropperToolActive() {
      return this.toolActive(TOOL_CONTROLS_ID_EYEDROPPER);
    },
    lineLayerIsVisible() {
      return this.layerIsVisibleByLayerId(INITIAL_LINE_LAYER_ID);
    },
    colorLayerIsVisible() {
      return this.layerIsVisibleByLayerId(INITIAL_COLOR_LAYER_ID);
    },
    activeLayerIsVisible() {
      console.log('activeLayerIsVisible: ', this.layerIsDrawable(this.activeLayerId));
      return this.layerIsDrawable(this.activeLayerId);
    },
    paletteEventCheck() {
      return this.paletteEventOccurred;
    },
    canvasBackgroundStyle() {
      return {
        width: `${this.canvasWidth}px`,
        height: `${this.canvasHeight}px`,
      };
    },
    canvasInnerWrapperStyle() {
      // this is a hack to compensate the timeline being hidden
      // very hardcoded atm
      if (this.timelineIsVisible) {
        // eslint-disable-next-line
        this.canvasPositionTopAdjust = this.canvasRelPositionTop;
      } else {
        // eslint-disable-next-line
        this.canvasPositionTopAdjust = this.canvasRelPositionTop - 100;
      }
      // console.log('timeline visible: ', this.timelineIsVisible);
      // console.log('canvasTop: ', this.canvasPositionTopAdjust);
      // console.log('canvasLeft: ', this.canvasRelPositionLeft);
      return {
        width: `${this.canvasWidth}px`,
        height: `${this.canvasHeight}px`,
        // backgroundColor: 'red',
        backgroundColor: this.canvasBackgroundColor,
        // minWidth: `${this.canvasWidth}px`, // without this flexbox is changing the aspect ratio
        // minHeight: `${this.canvasHeight}px`, // ...
        // transform: `translateY(${this.canvasScale / 2 * 100}%) scale(${this.canvasScale})`,
        // TODO: This needs to be generalized, only looks good on certain screen sizes
        transform: `scale(${this.canvasScaleRounded})`,
        // make sure canvas appears in the center of the pane,
        // optically align canvas in center with multiplier
        // transformOrigin: `50% ${50 + 50 * this.canvasScale * 1.45}%`,
        // transformOrigin: '50% 50%',
        left: `${this.canvasRelPositionLeft + 40}px`, // position after hand tool usage
        // top: `${this.canvasPositionTop}px`,
        // next line is the hack
        top: `${this.canvasPositionTopAdjust}px`,
        '--renderStyle': `${this.renderStyle}`,
      };
    },
    activeCanvasToolId() {
      return this.activeCanvasTool ? this.activeCanvasTool.id : null;
    },
    // after experimentation, 1.5 was found to be a good scale to start pixelating,
    // because the smoothing is not yet noticeable and distracting
    // pixelating too early makes the image less clear,
    // so 1.5 seems to be a good balance.
    renderStyle() {
      if (this.canvasScale > 1.5) {
        return 'pixelated';
      }
      return 'smooth';
    },
  },
  methods: {
    startTourFromWelcome() {
      // centralized tour start logic
      this.$tours.myTour.start();
    },
    async preloadUpcomingFrames() {
      try {
        const start = this.selectedFrameNumber + 1;
        const end = Math.min(start + 8, this.$store.state.lastRealFrameNumber);
        const uris = [];
        for (let f = start; f <= end; f += 1) {
          const lineUri = this.$store.getters[IMAGE_DATA_OF_FRAME]
            ? this.$store.getters[IMAGE_DATA_OF_FRAME]({ layerId: INITIAL_LINE_LAYER_ID, frameNr: f })
            : null;
          const colorUri = this.$store.getters[IMAGE_DATA_OF_FRAME]
            ? this.$store.getters[IMAGE_DATA_OF_FRAME]({ layerId: INITIAL_COLOR_LAYER_ID, frameNr: f })
            : null;
          if (lineUri) { uris.push(lineUri); }
          if (colorUri) { uris.push(colorUri); }
        }
        await preloadImages(uris);
      } catch (e) {
        // ignore
      }
    },
    ...mapMutations({
      setDragNDropInProgress: SET_FILE_DRAG_N_DROP_IN_PROGRESS,
      setImageData: SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
      setSelectedColor: SET_SELECTED_COLOR,
      replaceImageDataUri: REPLACE_IMAGE_DATA_URI,
      setCanvasToolActive: SET_CANVAS_TOOL_ACTIVE,
      addColorToPalette: ADD_COLOR_TO_PALETTE,
      setPenToolDiameter: SET_PEN_TOOL_DIAMETER,
      setEraserToolDiameter: SET_ERASER_TOOL_DIAMETER,
      setPaletteEventOccurred: SET_PALETTE_EVENT_OCCURRED,
      setZoomToolMode: SET_ZOOM_TOOL_MODE,
      createEmptyFrameIfNoneExists: CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
      setSegMapPath: SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID,
      // setActiveCanvasTool: SET_ACTIVE_CANVAS_TOOL_ID,
    }),
    ...mapActions([
      STORE_IMAGE_IN_IMAGE_STORE,
      STORE_BLANK_IMAGE_IN_IMAGE_STORE,
      CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER,
      ACTIVATE_PREVIOUS_TOOL,
      ANALYZE_CURRENT_FRAME,
      CANVAS_ACTION,
      ACTIVATE_TOOL_BY_ID,
    ]),
    tourCompleted() {
      console.log('TOUR COMPLETED');
    },
    addColorToPalette(color) {
      // console.log('ADDING COLOR TO PALETTE', color);
      const listOfPaletteColors = this.colorPalette;
      let isInPalette = false;
      const colorLc = color.toLowerCase();
      for (let i = 0; i < listOfPaletteColors.length; i += 1) {
        if (listOfPaletteColors[i].hex === colorLc) {
          isInPalette = true;
        }
      }
      // console.log('Color already in palette?', isInPalette);
      if (isInPalette === false) {
        this.colorPalette.push({
          hex: colorLc,
          newHex: colorLc,
          visible: true,
          newVisible: true,
          selected: false,
          firstSelected: false,
          opacity: 255,
          newOpacity: 255,
        });
        // console.log('Adding color ', color, ' to palette');
      }
    },
    onDragEnter() {
      this.setDragNDropInProgress(true);
    },
    onDragLeave() {},
    onDragOver() {
      this.setDragNDropInProgress(true);
    },
    onDragEnd() {
      // this event should only fire when the user drags something inside the app
      // or drops the image inside the app, but not in the drop zone
      this.setDragNDropInProgress(false);
    },
    /**
     * @typedef {Object} Point
     * @property {number} x - The X Coordinate
     * @property {number} y - The Y Coordinate
     */

    /**
     * @returns {Point} - The position of the mouse inside the
     *   canvas (in canvas pixel-scale)
     */
    getCanvasMousePositionByMouseEvent(ev) {
      const { canvasInnerWrapper, colorCanvas } = this.$refs;
      const b = canvasInnerWrapper.getBoundingClientRect();
      const scale = colorCanvas.width / parseFloat(b.width);
      const x = (ev.clientX - b.left) * scale;
      const y = (ev.clientY - b.top) * scale;
      // the following makes sure that we never return NaN
      // (which can cause nasty errors on the GPU):
      if (Number.isNaN(x) || Number.isNaN(y)) {
        // logError('getCanvasMousePositionByMouseEvent resulted in NaN. Returning { x: 0, y: 0 }');
        return { x: 0, y: 0 };
      }
      return { x, y };
    },
    async fillRegionOnCanvas(ev) {
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      // Uncomment to mark mouse position on canvas (but fix canvas ref)
      // var ctx = canvas.getContext("2d");
      // ctx.beginPath();
      // ctx.arc(x, y, 10, 0, 2 * Math.PI);
      // ctx.stroke();
      // console.log('SELECTED COL FROM CANVAS', this.selectedColor);
      const selectedColorHex = this.selectedColor;
      const selectedColorArrRgb = hexToRgbArray(selectedColorHex);
      const selectedColorArrRgba = [...selectedColorArrRgb, 255]; // add alpha value, fully opaque
      const eraseColorArrRgba = [0, 0, 0, 0]; // transparent black
      const isFillMode = this.$store.getters[FILL_TOOL_MODE] === FILL_TOOL_MODE_FILL;
      // const fillExpandValue = this.$store.getters[FILL_TOOL_EXPAND];
      // const aiSync = this.$store.getters[IS_FILL_METHOD_SEGMAP];
      // console.log('fillExpandValue: ', fillExpandValue);
      let colorForFloodFill = isFillMode ? selectedColorArrRgba : eraseColorArrRgba;
      const lineImageUri = this.selectedLineImage;
      if (!lineImageUri) {
        console.warn('Cannot colorize without a line image');
        // TODO: Maybe it makes sense to create a fresh one!?
        return;
      }
      let colorImageUri = this.selectedColorImage;
      const { width, height } = await getImageDimensions(lineImageUri);
      if (!colorImageUri) {
        colorImageUri = getBlankDataUri({ width, height });
      }
      let newColorDataUri;

      const fillRangeValue = this.$store.getters[FILL_TOOL_RANGE];
      newColorDataUri = await floodFill5({
        lineImageUri,
        colorImageUri,
        x: Math.floor(x),
        y: Math.floor(y),
        color: colorForFloodFill, // e.g. [255, 0, 0, 255],
        range: fillRangeValue,
        // expand: fillExpandValue,
      });
      await this[ANALYZE_CURRENT_FRAME]({
        colorFrameFilePath: null,
      });
      // redefine segMapPath to current settings.
      const segMapPath = this.$store.getters[
        SEGMENTATION_MAP_PATH_OF_IMAGE_WITH_ID](this.selectedLineImageId);
      // console.log('new segMapPath: ', segMapPath);
      // proceed to fill
      const segMapImageUri = await base64Encode(
        segMapPath,
        { asDataUri: true },
      );
      if (segMapImageUri === 'noFile') {
        this.setCanvasToolActive(false);
        return;
      }
      // console.log('about to call floodFill6...', segMapImageUri);
      // const newBlankUri = getBlankDataUri({ width, height });
      console.log('flooding...', colorForFloodFill);
      newColorDataUri = await floodFill6({
        segImageUri: segMapImageUri,
        colorImageUri,
        x: Math.floor(x),
        y: Math.floor(y),
        color: colorForFloodFill, // e.g. [255, 0, 0, 255],
        // range: fillRangeValue,
        // expand: fillExpandValue,
      });

      if (this.colorLayerIsVisible && this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
        // start fill sequence on color layer
        let colorImageId = this.selectedColorImageId;
        if (!colorImageId) {
          colorImageId = await this[STORE_IMAGE_IN_IMAGE_STORE]({
            dataUri: newColorDataUri,
            forceNew: false,
          });
        } else {
          this.replaceImageDataUri({
            imageDataId: colorImageId,
            dataUri: newColorDataUri,
          });
        }
        // We need to mark the frame as original / reference frame,
        // so that it is not overwritten using a colorize-all task
        this.setImageData({
          layerId: INITIAL_COLOR_LAYER_ID,
          imageDataId: colorImageId,
          frameNr: this.selectedFrameNumber,
          isOriginal: true,
          force: true, // overwrite original image, not sure if needed any more
        });
        this[CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER]({ layerId: INITIAL_COLOR_LAYER_ID });
        // this.addColorToPalette(selectedColorHex);
      }

      this.setCanvasToolActive(false);
      await this.reDrawCanvas();
      // Fill commits inside the mouse-down handler (no drag/mouse-up flow), so
      // its CANVAS_ACTION undo boundary closes here, right after the commit.
      closeUndoBoundary();
    },

    async grabColorOnMousePositionFromCanvas(ev) {
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      const { colorCanvas, lineCanvas } = this.$refs;

      let rgbaArr;
      let ctx = lineCanvas.getContext('2d');
      rgbaArr = ctx.getImageData(x, y, 1, 1).data;
      // if line layer is on and has data
      if (rgbaArr[3] !== 0 && this.lineLayerIsVisible) {
        rgbaHexStr = rgbaArrayToHex(rgbaArr, { useAlpha: false, useHashSymbol: true });
        // console.log('RGB DATA: ', rgbaArr);
      } else { // try the color layer
        ctx = colorCanvas.getContext('2d');
        rgbaArr = ctx.getImageData(x, y, 1, 1).data;
        // if color layer is on and has data
        if (rgbaArr[3] !== 0 && this.colorLayerIsVisible) {
          rgbaHexStr = rgbaArrayToHex(rgbaArr, { useAlpha: false, useHashSymbol: true });
          // console.log('RGB DATA: ', rgbaArr);
        } else {
          rgbaHexStr = this.canvasBackgroundColor;
        }
      }
      // set the color
      this.setSelectedColor(rgbaHexStr);
    },

    async onCanvasInnerWrapperMouseDown(ev) {
      this.mouseDownFinished = false;
      // console.log('mouseDown');
      // store the currently selectted tool in selectedToolIdOnMouseDown
      // console.log('CLICK', ev);
      this.whichButton = ev.which;
      const selectedColorHex = this.selectedColor;
      if (this.whichButton === LEFT_MOUSE_BUTTON
        && (this.penToolActive || this.fillToolActive || this.eraserToolActive)) {
        await this[CANVAS_ACTION]();
      }
      this.selectedToolIdOnMouseDown = this.activeCanvasToolId;
      if (
        this.fillToolActive
        && this.selectedToolIdOnMouseDown === TOOL_CONTROLS_ID_FILL
      ) {
        if (ev.which !== LEFT_MOUSE_BUTTON) { return; }
        if (!this.colorLayerIsVisible) { return; }

        if (this.activeLayerId === INITIAL_LINE_LAYER_ID
          && !this.colorLayerIsVisible
        ) { return; }

        if (!this.fillToolModeErase) {
          console.log('fill tool');
          this.addColorToPalette(selectedColorHex);
        }
        await this.fillRegionOnCanvas(ev);
      } else {
        this.selectedToolIdOnMouseDown = this.activeCanvasToolId;
      }
      if (this.penToolActive) {
        console.log('pen tool');
        if (ev.which !== LEFT_MOUSE_BUTTON) { return; }
        const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
        this.previousDrawPoint = { x, y };
        this.isDrawing = true;
        // TODO: this next block is repeated from onCanvasMouseMove.
        // some of this code should get put in separate functions to avoid redundancy
        console.log(this.activeLayerId, ' visible: ', this.activeLayerIsVisible);
        if (this.activeLayerIsVisible) {
          console.log(this.activeLayerId, ' visible: ', this.activeLayerIsVisible);
          // reset delay
          clearTimeout(this.safeTimer);
          this.safeDelay = false;
          let canvas;
          if (this.activeLayerId === INITIAL_LINE_LAYER_ID) {
            canvas = this.$refs.lineCanvas;
          }
          if (this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
            canvas = this.$refs.colorCanvas;
          }
          this.context = canvas.getContext('2d');
          this.context.imageSmoothingEnabled = false;
          this.context.lineJoin = 'round';
          this.context.lineCap = 'round';

          let radius = this.penToolDiameter / 2;
          if (ev.pointerType !== 'pen') {
            this.currentPressure = 1;
          }
          if (this.pressureEnabled) {
            radius = Math.max(radius * this.currentPressure, 0.7);
          }
          if (this.penToolMode === PEN_TOOL_MODE_DRAW) {
            this.addColorToPalette(selectedColorHex);
            // define the draw mode: over, under, or within (defined in penTool.js)
            this.context.globalCompositeOperation = this.penDrawMode;
            // this.drawColor = this.selectedColor;
          } else { // erase mode
            // The existing content is erased where it overlays the brush
            this.context.globalCompositeOperation = 'destination-out';
          }
          // console.log('this.context: ', this.context);
          if (this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
            this.stampBrushDraw({
              from: this.previousDrawPoint,
              to: this.previousDrawPoint,
              size: Math.round(radius * 2) / window.devicePixelRatio,
              color: this.selectedColor,
            });
          }
          // implement radgrad brush if we are on line layer
          if (this.activeLayerId === INITIAL_LINE_LAYER_ID) {
            this.stampBrushDraw({
              from: this.previousDrawPoint,
              to: this.previousDrawPoint,
              size: Math.round(radius * 2) / window.devicePixelRatio,
              color: this.selectedColor,
            });
          }
        }
      }
      if (this.eraserToolActive) {
        if (ev.which !== LEFT_MOUSE_BUTTON) { return; }
        const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
        this.previousDrawPoint = { x, y };
        this.isDrawing = true;
        if (this.activeLayerIsVisible) {
          clearTimeout(this.safeTimer);
          this.safeDelay = false;
          let canvas;
          if (this.activeLayerId === INITIAL_LINE_LAYER_ID) {
            canvas = this.$refs.lineCanvas;
          }
          if (this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
            canvas = this.$refs.colorCanvas;
          }
          this.context = canvas.getContext('2d');
          this.context.imageSmoothingEnabled = false;
          this.context.lineJoin = 'round';
          this.context.lineCap = 'round';

          if (ev.pointerType !== 'pen') {
            this.currentPressure = 1;
          }
          let radius = this.eraserToolDiameter / 2;
          if (this.pressureEnabled) {
            radius = Math.max(radius * this.currentPressure, 0.7);
          }
          // The existing content is erased where it overlays the brush
          this.context.globalCompositeOperation = 'destination-out';
          // console.log('this.context: ', this.context);
          // this.drawColor = this.selectedColor;
          if (this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
            this.stampBrushDraw({
              from: this.previousDrawPoint,
              to: this.previousDrawPoint,
              size: Math.round(radius * 2) / window.devicePixelRatio,
              color: this.selectedColor,
            });
          }
          // implement radgrad brush if we are on line layer
          if (this.activeLayerId === INITIAL_LINE_LAYER_ID) {
            /*
            // eslint-disable-next-line
            radius = radius / window.devicePixelRatio;
            const rgb = hexToRgbArray(this.selectedColor);
            const radgrad = this.context.createRadialGradient(x, y, radius / 2, x, y, radius);
            radgrad.addColorStop(0, this.selectedColor);
            radgrad.addColorStop(0.9, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`);
            radgrad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
            // this.radGradBrush = this.createRadGradBrush(x, y, radius);
            this.context.fillStyle = radgrad;
            this.context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
            */
            this.stampBrushDraw({
              from: this.previousDrawPoint,
              to: this.previousDrawPoint,
              size: Math.round(radius * 2) / window.devicePixelRatio,
              color: this.selectedColor,
            });
          }
        }
      }
      this.mouseDownFinished = true;
    },

    async onCanvasInnerWrapperMouseMove(ev) {
      // console.log('CANVAS INNVER WRAPPER MOVE', ev.pointerType);
      if (this.activeLayerIsVisible) {
        if (this.penToolActive || this.eraserToolActive) {
          if (ev.pointerType === 'mouse' && ev.which !== LEFT_MOUSE_BUTTON) {
            return;
          }
          if (this.selectedToolIdOnMouseDown !== TOOL_CONTROLS_ID_PEN
              && this.selectedToolIdOnMouseDown !== TOOL_CONTROLS_ID_ERASER
          ) {
            // mouse down was triggered by another tool,
            // discard the drawing state.
            this.pointsToDraw = [];
            // this.isDrawing = false;
            return;
          }
          if (this.isDrawing) {
            if (!this.previousDrawPoint) {
              const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
              this.previousDrawPoint = { x, y };
            }
            let radius;
            if (this.penToolActive) {
              radius = this.penToolDiameter / 2;
            }
            if (this.eraserToolActive) {
              radius = this.eraserToolDiameter / 2;
            }
            if (this.pressureEnabled) {
              radius = Math.max(radius * this.currentPressure, 0.7);
            }
            const currentPoint = this.getCanvasMousePositionByMouseEvent(ev); // { x, y }
            if (this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
              this.stampBrushDraw({
                from: this.previousDrawPoint,
                to: currentPoint,
                size: Math.round(radius * 2) / window.devicePixelRatio,
                color: this.selectedColor,
              });
            }

            if (this.activeLayerId === INITIAL_LINE_LAYER_ID) {
              if (this.mouseDownFinished) {
                // RADGRAD STUFF
                // GENERATE ADDITIONAL dots --------------------------------------------->
                // console.log('rlRecomp: ', this.rlCompute);
                // console.log('RAD GRAD STUFF');
                /*
                const dist = distanceBetween(this.previousDrawPoint, currentPoint);
                const angle = angleBetween(this.previousDrawPoint, currentPoint);
                radius /= window.devicePixelRatio;
                for (let i = 0; i < dist; i += 1) {
                  const x = this.previousDrawPoint.x + (Math.sin(angle) * i);
                  const y = this.previousDrawPoint.y + (Math.cos(angle) * i);
                  // TODO: Investigate if there is a way to create a RadialGradient once
                  // and reuse it with different coordinates, so we don't have to generate
                  // it in each loop.
                  // eslint-disable-next-line
                  // this.radGradBrush = this.createRadGradBrush(x, y, radius);
                  const rgb = hexToRgbArray(this.selectedColor);
                  const radgrad = this.context.createRadialGradient(x, y, radius / 2, x, y, radius);
                  radgrad.addColorStop(0, this.selectedColor);
                  radgrad.addColorStop(0.9, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`);
                  radgrad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
                  this.context.fillStyle = radgrad;
                  this.context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
                }
                */
                this.stampBrushDraw({
                  from: this.previousDrawPoint,
                  to: currentPoint,
                  size: Math.round(radius * 2) / window.devicePixelRatio,
                  color: this.selectedColor,
                });
              }
            }
            // GENERATE ADDITIONAL dots --------------------------------------------->
            // this.context.globalCompositeOperation = 'source-over';
            // TODO: Maybe this should be moved to not be called all the time, but this
            // would need multiple places to be set:
            //   - when pen tool is activated
            //   - when pen mode is switched
            //   - when fill tool is used (because same context is used)

            this.previousDrawPoint = currentPoint;
          }
        }
      }
    },
    async onCanvasInnerWrapperMouseUp() {
      /*
      // MOVED TO CANVASWRAPPERMOUSEUP
      */
      // this.isDrawing = false;
    },
    /*
    createRadGradBrush(x, y, radius) {
      const rgb = hexToRgbArray(this.selectedColor);
      const radgrad = this.context.createRadialGradient(x, y, radius / 2, x, y, radius);
      radgrad.addColorStop(0, this.selectedColor);
      radgrad.addColorStop(0.9, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`);
      radgrad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
      return radgrad;
      // this.context.globalCompositeOperation = 'source-over';
    },
    */
    // eslint-disable-next-line
    stampBrushDraw({ from, to, size, color }) {
      // eslint-disable-next-line
      if (size < 1) { size = 1 / window.devicePixelRatio; }
      const halfSize = (size - (size % 2)) / 2;
      const stamp = this.stampMaker.make({ size, color });
      if (from.x === to.x && from.y === to.y) {
        const x = from.x - halfSize;
        const y = from.y - halfSize;
        this.context.drawImage(stamp, Math.round(x), Math.round(y), size, size);
        // console.log('single brush done');
        return;
      }
      const dist = distanceBetween(from, to);
      const angle = angleBetween(from, to);
      for (let i = 0; i < dist; i += 1) {
        const x = from.x + (Math.sin(angle) * i) - halfSize;
        const y = from.y + (Math.cos(angle) * i) - halfSize;
        window.requestAnimationFrame(() => {
          this.context.drawImage(stamp, Math.round(x), Math.round(y), size, size);
        });
        // console.log('brush done');
      }
    },

    async onCanvasWrapperClick(ev) {
      if (this.eyedropperToolActive) {
        await this.grabColorOnMousePositionFromCanvas(ev);
        // console.log('eyedropper clicked');
        await this[ACTIVATE_PREVIOUS_TOOL]();
      }
      /*
      if (this.zoomToolActive && this.clickZoom) {
        this.onCanvasClickZoom(ev);
      }
      */
    },
    onCanvasWrapperMouseDown(ev) {
      // store the currently selectted tool in selectedToolIdOnMouseDown

      this.selectedToolIdOnMouseDown = this.activeCanvasToolId;

      this.setCanvasToolActive(true);
      // console.log('mousedown: canvasToolActive: ', this.canvasToolActive);
      this.whichButton = ev.which;
      this.isMouseDown = true;
      this.lastMouseClientX = ev.clientX;
      this.lastMouseClientY = ev.clientY;
      // this.clickZoom = false;
      // removed this line to allow zoom in and out regardless
      // of selected tool.
      // if (!this.handToolActive && !this.zoomToolActive) { return; }
      const { canvasWrapper } = this.$refs;
      if (this.handToolActive && this.whichButton === LEFT_MOUSE_BUTTON) {
        // console.log("you pressed"+ this.whichButton);
        mouseMoveEventListener = canvasWrapper.addEventListener('pointermove', this.onCanvasMouseMove, false);
        // ev.preventDefault();
      }
      if (this.zoomToolActive && this.whichButton === LEFT_MOUSE_BUTTON) {
        // console.log('z');
        mouseMoveEventListener = canvasWrapper.addEventListener('pointermove', this.onCanvasZoom, false);
      }
      if ((this.penToolActive || this.eraserToolActive)
        && this.whichButton === RIGHT_MOUSE_BUTTON) {
        // console.log('q');
        // keyDownEventListener = canvasWrapper.addEventListener('keydown',this.onCanvasZoom,false);
        mouseMoveEventListener = canvasWrapper.addEventListener(
          'mousemove', this.onCanvasZoom, false,
        );
      } else if (!this.penToolActive && this.whichButton === RIGHT_MOUSE_BUTTON) {
        // console.log('calling canvas Zoom from else, ', this.whichButton);
        mouseMoveEventListener = canvasWrapper.addEventListener('pointermove', this.onCanvasZoom, false);
      }
    },

    eraseTempCanvas() {
      const { tempCanvas } = this.$refs;
      const ctxD = tempCanvas.getContext('2d');
      ctxD.globalCompositeOperation = 'source-over';
      ctxD.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    },

    async onCanvasWrapperMouseUp(ev) {
      // console.log('canvasWrapper up');
      this.firstRecord = true;
      this.setCanvasToolActive(false);
      // set penDiameter
      if (this.penDiameterAdjust === true) {
        this.penDiameterAdjust = false;
        this.setPenToolDiameter(this.newDiameter);
      }
      if (this.eraserDiameterAdjust === true) {
        this.eraserDiameterAdjust = false;
        this.setEraserToolDiameter(this.newEraserDiameter);
      }
      this.eraseTempCanvas();
      // this.previousPressure = 0;
      this.isMouseDown = false;
      this.dragZoom = false;
      if (this.zoomToolActive && this.clickZoom) {
        this.onCanvasClickZoom(ev);
      }
      // FROM INNERCANVASWRAPPERMOUSEUP vv
      if (this.isDrawing && this.activeLayerIsVisible) {
        this.isDrawing = false;
        this.pointsToDraw = [];
        if (this.mouseDownFinished) {
          await this.updateImageStore();
          // The stroke's CANVAS_ACTION settled back on mouse-down; its store
          // commit only just happened, so close its undo boundary here.
          closeUndoBoundary();
        }
      }
      // reset pen tool
      // clear previous points, as they have already been drawn by now
      // FROM INNERCANVASWRAPPERMOUSEUP ^^
      this.clickZoom = true;
      const { canvasWrapper } = this.$refs;
      // console.log('mouseMoveEventListener: ', mouseMoveEventListener);
      canvasWrapper.removeEventListener('pointermove', this.onCanvasMouseMove, false);
      canvasWrapper.removeEventListener('pointermove', this.onCanvasZoom, false);
      canvasWrapper.removeEventListener('mousemove', this.onCanvasZoom, false);
      canvasWrapper.removeEventListener('keydown', this.onCanvasZoom, false);

      this.lastMouseClientX = 0;
      this.lastMouseClientY = 0;
      this.currentPressure = 0;
    },

    async updateImageStore() {
      console.log('update image store');
      // save the image
      // TODO: layer (line or color) should be dynamic
      let imageId;
      let canvas;
      const frameNumber = this.selectedFrameNumber;
      const activeLayer = this.activeLayerId;
      // this.mouseDownFinished = false;
      if (this.activeLayerId === INITIAL_LINE_LAYER_ID) {
        imageId = this.selectedLineImageId;
        canvas = this.$refs.lineCanvas;
        // reset segmap
        if (imageId) {
          this.setSegMapPath({
            imageDataId: imageId,
            segmentationMapPath: null,
          });
        }
      }
      if (this.activeLayerId === INITIAL_COLOR_LAYER_ID) {
        imageId = this.selectedColorImageId;
        canvas = this.$refs.colorCanvas;
      }
      console.log(imageId);
      this.context = canvas.getContext('2d');
      const dataUri = canvas.toDataURL('image/png', 1.0);
      // console.log('dataURI: ', dataUri);
      // wait for delay to complete
      // console.log('safeDelay: ', this.safeDelay);
      await new Promise((resolve) => {
        this.safeTimer = setTimeout(resolve, 0);
        this.safeDelay = true;
        // console.log('safeDelay: ', this.safeDelay);
      });
      // console.log('safeDelay: ', this.safeDelay);
      if (this.safeDelay && !this.isDrawing) {
        // console.log(this.context.globalCompositeOperation);
        // console.log('imageId: ', imageId);
        // console.log('dataUri: ', dataUri);
        if (!imageId) {
          imageId = await this[STORE_IMAGE_IN_IMAGE_STORE]({
            dataUri,
            forceNew: true,
          });
          // create a ghost frame:
          let linkedImageDataId;
          let linkedLayerId;
          if (activeLayer === INITIAL_COLOR_LAYER_ID) {
            linkedLayerId = INITIAL_LINE_LAYER_ID;
            linkedImageDataId = `${imageId}_line`;
          } else { // we are on the line layer
            linkedLayerId = INITIAL_COLOR_LAYER_ID;
            linkedImageDataId = `${imageId}_color`;
          }
          await this[STORE_BLANK_IMAGE_IN_IMAGE_STORE]({
            imageDataId: linkedImageDataId,
          });
          await this.createEmptyFrameIfNoneExists({
            frameNr: frameNumber,
            layerId: linkedLayerId,
            imageDataId: linkedImageDataId,
          });
        } else {
          console.log('replace data of', imageId);
          this.replaceImageDataUri({
            imageDataId: imageId,
            dataUri,
          });
        }
        // console.log('set image data');
        this.context.globalCompositeOperation = 'source-over';
        this.setImageData({
          layerId: activeLayer,
          imageDataId: imageId,
          frameNr: frameNumber,
          isOriginal: true,
          isLoading: false,
          force: true, // overwrite original image, not sure if needed any more
        });

        if (activeLayer === INITIAL_COLOR_LAYER_ID) {
          this[CORRECT_ORIGINALITY_OF_FRAMES_ON_LAYER]({ layerId: INITIAL_COLOR_LAYER_ID });
        }
      }
    },

    onCanvasMouseMove(ev) {
      // console.log('onCanvasMouseMove');
      if (
        !this.handToolActive
        || !this.isMouseDown
      ) { return; }
      // console.log('onCanvasMouseMove still there ;;');
      const xChange = ev.clientX - this.lastMouseClientX;
      const yChange = ev.clientY - this.lastMouseClientY;
      // console.log('xChange: ', xChange);
      // console.log('ev.clientX: ', ev.clientX);
      // console.log('this.lastMouseClientX: ', this.lastMouseClientX);
      // console.log('----');
      this.canvasRelPositionLeft += xChange;
      this.canvasRelPositionTop += yChange;
      this.lastMouseClientX = ev.clientX;
      this.lastMouseClientY = ev.clientY;
      // console.log("x: "+ev.clientX+"   y: "+ev.clientY);
      // console.log('canvasLeft: ' + this.canvasRelPositionLeft);
      // ev.preventDefault();
    },
    onCanvasClickZoom(ev) {
      if (
        ev.which !== LEFT_MOUSE_BUTTON
        || this.dragZoom
      ) { return; }
      // console.log("zoom clicked");
      const isZoomModeIn = this.$store.getters[ZOOM_TOOL_MODE] === ZOOM_TOOL_MODE_IN;
      const zoomFactor = 0.3;

      // make canvas zoom from origin of mouse
      const scale = this.canvasScale;
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      const w = this.canvasSize.width;
      const h = this.canvasSize.height;
      const xOrigin = ((w / 2) - x);
      const yOrigin = ((h / 2) - y);
      // const xOffset = xOrigin - this.canvasRelPositionLeft;
      const dx = (xOrigin) * (zoomFactor * scale);
      const dy = (yOrigin) * (zoomFactor * scale);
      // const dx = (xOrigin - this.canvasRelPositionLeft) * (zoomFactor * scale);
      // const dy = (yOrigin - this.canvasRelPositionTop) * (zoomFactor * scale);
      // console.log("xOrigin: " + xOrigin);
      // console.log("scale: " + scale);
      // console.log("dx: " + dx);
      // now we have what we need to reposition canvas on zoom
      // if we are zooming out:
      if (!isZoomModeIn && scale > CANVAS_SCALE_MIN) {
        // these next lines reposition canvas on zoom
        this.canvasRelPositionLeft -= dx;
        this.canvasRelPositionTop -= dy;
        const newScale = this.canvasScale * (1 - zoomFactor);
        this.canvasScale = Math.min(
          Math.max(CANVAS_SCALE_MIN, newScale),
          CANVAS_SCALE_MAX,
        );
      } else if (isZoomModeIn && scale < CANVAS_SCALE_MAX) {
        // these next lines reposition canvas on zoom
        this.canvasRelPositionLeft += dx;
        this.canvasRelPositionTop += dy;
        const newScale = this.canvasScale * (1 + zoomFactor);
        this.canvasScale = Math.min(
          Math.max(CANVAS_SCALE_MIN, newScale),
          CANVAS_SCALE_MAX,
        );
      }
      // console.log("isZoomModeIn= " + isZoomModeIn);
      // console.log("canvasLeft: " + this.canvasRelPositionLeft);
    },
    onCanvasZoom(ev) {
      // console.log('onCanvasZoom');
      if (!this.isMouseDown) { return; }
      if (this.whichButton !== RIGHT_MOUSE_BUTTON && !this.zoomToolActive) { return; }
      // check if we should go to onPenDiameterChange
      if (ev.getModifierState('Meta') || ev.getModifierState('Control') || this.penDiameterAdjust || this.eraserDiameterAdjust) {
        if (this.penToolActive) {
          this.onPenDiameterChange(ev);
          return;
        }
        if (this.eraserToolActive) {
          this.onEraserDiameterChange(ev);
          return;
        }
      }
      // make canvas zoom from origin of mouse
      this.clickZoom = false;
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      const scale = this.canvasScale;
      const w = this.canvasSize.width;
      const h = this.canvasSize.height;
      const originX = (x - (w / 2));
      const originY = (y - (h / 2));
      // record first position of mouse
      if (!this.dragZoom) {
        this.dragZoom = true;
        this.dragZoomX = originX;
        this.dragZoomY = originY;
      }
      // console.log('dragCanvasScale: ', this.dragCanvasScale);
      const zoomFactor2 = 0.01;
      const xChange = ev.clientX - this.lastMouseClientX;
      // console.log('xChange: ', xChange);

      // these next lines reposition canvas on zoom
      const dx = (this.dragZoomX) * (zoomFactor2 * scale * xChange);
      const dy = (this.dragZoomY) * (zoomFactor2 * scale * xChange);

      // if (xChange > 0 && newScale < CANVAS_SCALE_MAX) {
      if (xChange > 0) {
        const newScale = this.canvasScale * (1 + (zoomFactor2 * xChange));
        if (newScale < CANVAS_SCALE_MAX) {
          this.canvasRelPositionLeft -= dx;
          this.canvasRelPositionTop -= dy;
          this.canvasScale = newScale;
        }
        // console.log('newScale: ', newScale);
      }
      if (xChange < 0) {
        const newScale = this.canvasScale * (1 + (zoomFactor2 * xChange));
        if (newScale > CANVAS_SCALE_MIN) {
          this.canvasRelPositionLeft -= dx;
          this.canvasRelPositionTop -= dy;
          this.canvasScale = newScale;
        }
        // console.log('newScale: ', newScale);
      }
      this.lastMouseClientX = ev.clientX;
      // ev.preventDefault();
    },
    onCanvasWrapperScroll(ev) {
      const zoomFactor = 0.1;
      // console.log("ev.deltaY: " + ev.deltaY);
      // make canvas zoom from origin of mouse
      const scale = this.canvasScale;
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      const w = this.canvasSize.width;
      const h = this.canvasSize.height;
      const xOrigin = (x - (w / 2));
      const yOrigin = (y - (h / 2));
      const dx = (xOrigin) * (zoomFactor * scale);
      const dy = (yOrigin) * (zoomFactor * scale);
      // now we have what we need to reposition canvas on zoom
      // if we are zooming out:
      if (ev.deltaY > 0 && scale > CANVAS_SCALE_MIN) {
        // these next lines reposition canvas on zoom
        this.canvasRelPositionLeft += dx;
        this.canvasRelPositionTop += dy;
        const newScale = this.canvasScale * (1 - zoomFactor);
        this.canvasScale = newScale;
      } else if (ev.deltaY < 0 && scale < CANVAS_SCALE_MAX) {
        // these next lines reposition canvas on zoom
        const newScale = this.canvasScale * (1 + zoomFactor);
        this.canvasScale = newScale;
        this.canvasRelPositionLeft -= dx;
        this.canvasRelPositionTop -= dy;
      }
    },
    onPenDiameterChange(ev) {
      // console.log('onPenDiameterChange');
      // check for proper mouse and key events:
      if (ev.which !== RIGHT_MOUSE_BUTTON || !this.penToolActive || !this.isMouseDown) { return; }
      // set up tempCanvas
      const { tempCanvas } = this.$refs;
      const ctxD = tempCanvas.getContext('2d');
      ctxD.globalCompositeOperation = 'source-over';
      ctxD.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      // console.log('onPenDiameterChange');
      // grab the first run info to compare against
      if (this.firstRecord) {
        this.firstXPos = x;
        this.firstYDiamPos = y;
        this.firstXDiamPos = x;
        this.firstDiameter = this.penToolDiameter;
        this.firstRecord = false;
      }
      // console.log('firstDiameter: ', this.firstDiameter);
      this.penDiameterAdjust = true;
      this.dragZoom = false;
      this.clickZoom = false;
      const factorD = 1.5;
      const xChange = x - this.firstXPos;
      // these next lines set a new pen diameter
      const dx = (factorD * xChange);
      this.newDiameter = Math.max(
        MIN_DIAMETER,
        Math.min(
          MAX_DIAMETER,
          Math.round(this.firstDiameter + dx),
        ),
      );
      // const newDiameter = this.penToolDiameter + dx;
      if (this.newDiameter === MIN_DIAMETER || this.newDiameter === MAX_DIAMETER) {
        // console.log('min or max diameter');
        this.firstDiameter = this.newDiameter;
        this.firstXPos = x;
      }
      // move this to mouse up so it is only set when we are done adjusting.
      // this.setPenToolDiameter(this.newDiameter);
      this.lastMouseClientX = x;
      // ev.preventDefault();

      // make visual representation
      // line 1, 2
      ctxD.strokeStyle = '#ff0000';
      ctxD.lineWidth = 1;
      ctxD.beginPath();
      ctxD.moveTo(this.firstXDiamPos, this.firstYDiamPos + (this.newDiameter / 2));
      ctxD.lineTo(this.firstXDiamPos, this.firstYDiamPos - (this.newDiameter / 2));
      ctxD.stroke();
      ctxD.beginPath();
      ctxD.moveTo(this.firstXDiamPos - (this.newDiameter / 2), this.firstYDiamPos);
      ctxD.lineTo(this.firstXDiamPos + (this.newDiameter / 2), this.firstYDiamPos);
      ctxD.stroke();

      // circle 1
      // ctxD.strokeStyle = '#000000';
      ctxD.lineWidth = 2;
      ctxD.beginPath();
      ctxD.arc(
        this.firstXDiamPos,
        this.firstYDiamPos,
        (this.newDiameter / 2),
        0, Math.PI * 2,
        true,
      );
      ctxD.closePath();
      ctxD.stroke();

      // brush size readout
      ctxD.font = '30px Arial';
      // ctxD.strokeStyle = 'white';
      // ctxD.strokeText(this.newDiameter, this.firstXDiamPos + 15, this.firstYDiamPos - 15);
      ctxD.fillText(this.newDiameter, this.firstXDiamPos + 15, this.firstYDiamPos - 15);

      /*
      // circle 2
      ctxD.strokeStyle = '#ffffff';
      ctxD.lineWidth = 1;
      ctxD.beginPath();
      ctxD.arc(
        this.firstXDiamPos,
        this.firstYDiamPos,
        ((this.newDiameter / 2) + 1),
        0, Math.PI * 2,
        true,
      );
      ctxD.closePath();
      ctxD.stroke();
      */
    },

    onEraserDiameterChange(ev) {
      // console.log('onPenDiameterChange');
      // check for proper mouse and key events:
      if (ev.which !== RIGHT_MOUSE_BUTTON || !this.eraserToolActive || !this.isMouseDown) {
        return;
      }
      // set up tempCanvas
      const { tempCanvas } = this.$refs;
      const ctxD = tempCanvas.getContext('2d');
      ctxD.globalCompositeOperation = 'source-over';
      ctxD.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
      const { x, y } = this.getCanvasMousePositionByMouseEvent(ev);
      // console.log('onPenDiameterChange');
      // grab the first run info to compare against
      if (this.firstRecord) {
        this.firstXPos = x;
        this.firstYDiamPos = y;
        this.firstXDiamPos = x;
        this.firstEraserDiameter = this.eraserToolDiameter;
        this.firstRecord = false;
      }
      // console.log('firstDiameter: ', this.firstDiameter);
      this.eraserDiameterAdjust = true;
      this.dragZoom = false;
      this.clickZoom = false;
      const factorD = 1.5;
      const xChange = x - this.firstXPos;
      // these next lines set a new pen diameter
      const dx = (factorD * xChange);
      this.newEraserDiameter = Math.max(
        MIN_DIAMETER,
        Math.min(
          MAX_DIAMETER,
          Math.round(this.firstEraserDiameter + dx),
        ),
      );
      // const newDiameter = this.penToolDiameter + dx;
      if (this.newEraserDiameter === MIN_DIAMETER || this.newEraserDiameter === MAX_DIAMETER) {
        // console.log('min or max diameter');
        this.firstEraserDiameter = this.newEraserDiameter;
        this.firstXPos = x;
      }
      // move this to mouse up so it is only set when we are done adjusting.
      // this.setPenToolDiameter(this.newDiameter);
      this.lastMouseClientX = x;
      // ev.preventDefault();

      // make visual representation
      // line 1, 2
      ctxD.strokeStyle = '#ff0000';
      ctxD.lineWidth = 1;
      ctxD.beginPath();
      ctxD.moveTo(this.firstXDiamPos, this.firstYDiamPos + (this.newEraserDiameter / 2));
      ctxD.lineTo(this.firstXDiamPos, this.firstYDiamPos - (this.newEraserDiameter / 2));
      ctxD.stroke();
      ctxD.beginPath();
      ctxD.moveTo(this.firstXDiamPos - (this.newEraserDiameter / 2), this.firstYDiamPos);
      ctxD.lineTo(this.firstXDiamPos + (this.newEraserDiameter / 2), this.firstYDiamPos);
      ctxD.stroke();

      // circle 1
      // ctxD.strokeStyle = '#000000';
      ctxD.lineWidth = 2;
      ctxD.beginPath();
      ctxD.arc(
        this.firstXDiamPos,
        this.firstYDiamPos,
        (this.newEraserDiameter / 2),
        0, Math.PI * 2,
        true,
      );
      ctxD.closePath();
      ctxD.stroke();

      // brush size readout
      ctxD.font = '30px Arial';
      ctxD.fillText(this.newEraserDiameter, this.firstXDiamPos + 15, this.firstYDiamPos - 15);
    },

    /**
     * Redraws both canvases
     */
    async reDrawCanvas() {
      // this.renderStyle = this.canvasScale <= 1.3 ? 'smooth' : 'pixelated';
      // console.log('renderStyle: ', this.renderStyle);
      const { lineCanvas, colorCanvas } = this.$refs;
      // console.log('this.$refs from reDraw: ', this.$refs);
      const ctxLine = lineCanvas.getContext('2d');
      const ctxColor = colorCanvas.getContext('2d');
      const existingLineImage = this.selectedLineImage;
      const existingColorImage = this.selectedColorImage;
      let lineImage;
      let colorImage;
      if (this.colorLayerIsVisible && existingColorImage) {
        colorImage = await loadImage(existingColorImage);
      } else if (colorCanvas.width > 0 && colorCanvas.height > 0) {
        const colorBlank = getBlankDataUri({
          width: colorCanvas.width,
          height: colorCanvas.height,
        });
        colorImage = await loadImage(colorBlank);
      }

      if (this.lineLayerIsVisible && existingLineImage) {
        lineImage = await loadImage(existingLineImage);
      } else if (lineCanvas.width > 0 && lineCanvas.height > 0) {
        console.log('LINE LAYER HIDDEN');
        const lineBlank = getBlankDataUri({
          width: lineCanvas.width,
          height: lineCanvas.height,
        });
        lineImage = await loadImage(lineBlank);
      }
      window.requestAnimationFrame(() => {
        this.isDrawing = false;
        // ctxColor.globalCompositeOperation = 'source-over';
        // ctxLine.globalCompositeOperation = 'source-over';
        ctxColor.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
        ctxLine.clearRect(0, 0, lineCanvas.width, lineCanvas.height);
        if (colorImage) {
          ctxColor.drawImage(colorImage, 0, 0);
        }
        if (lineImage) {
          ctxLine.drawImage(lineImage, 0, 0);
        }
      });
    },
    onCanvasWrapperResize() {
      /* eslint-disable no-use-before-define */
      storeCanvasWrapperSizeInStoreDebounced();
    },
    // onPressureStart() { // console.log('pressure start'); },
    onPressureEnd() {
      // console.log('pressure end');
      this.previousDrawPoint = null;
      this.pointsToDraw = [];
    },
    /**
     * Called by the drawing pen library Pressure once the pressure changes.
     * @param {number} force
     *   How strong the pressure is, [0..1].
     *   When no compatible device is detected, time can be used to simulate pressure.
     */
    onPressureChange(force) {
      if (this.penToolActive || this.eraserToolActive) {
        if (this.currentPressure !== force) {
          this.currentPressure = (force ** 2);
          // average out for smoothness.
          // this.previousPressure = this.currentPressure;
          // this.currentPressure = (force + this.previousPressure) / 2;
        }
      }
    },
    zoomFromMenu(inOrOut) {
      // console.log('zoom in');
      // set a different tool so we can snap the canvas out of it after changing scale
      if (inOrOut === 'in') {
        // console.log('in!!');
        return this.canvasScale + (this.canvasScale * 0.1);
      }
      if (inOrOut === 'out') {
        return this.canvasScale - (this.canvasScale * 0.1);
      }
      return null;
    },

    initializePressureLibrary() {
      // TODO: Currently pluggin in a drawing tablet later on
      // needs a restart of the application.
      // Would be good to catch this (USB devices change listener?)
      Pressure.set(
        '.main-pane__canvas-inner-wrapper', // the element to enable pressure on
        {
          change: this.onPressureChange,
          end: this.onPressureEnd,
          // called when no tablet or 3D touch device is used,
          // no operation
          unsupported: () => {
            this.currentPressure = 1;
            // console.log('unsupported pressure');
          },
        },
        {
          only: 'pointer', // only react on wacom tablets (no 3D touch)
          polyfill: false, // disable fake-pressure when there is no drawing tablet
        },
      );
    },
  },
  watch: {
    lastImageSizeDifferentThanCanvas(b) {
      if (b) {
        showCustomDialog({
          title: t('Image Size Mismatch'),
          message: t('Sorry, you cannot import images of different sizes.'),
          buttons: [t('OK')],
          defaultId: 0,
          cancelId: 0,
          type: 'warning',
        });
      }
    },
    lineLayerIsVisible() { this.reDrawCanvas(); },
    colorLayerIsVisible() { this.reDrawCanvas(); },
    // selectedLineImage() { this.reDrawCanvas(); },
    // selectedColorImage() { this.reDrawCanvas(); },
    selectedFrameNumber() { this.reDrawCanvas(); this.preloadUpcomingFrames(); },
    canvasRedrawTrigger() { this.reDrawCanvas(); },
    initialCanvasScale(scale) {
      this.canvasScale = scale;
    },
    colorizationInProgress(newVal) {
      triggerMenuRebuildWithColorizationState(newVal);
    },
  },
  mounted() {
    const { canvasWrapper } = this.$refs;
    canvasWrapper.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen') {
        this.onCanvasInnerWrapperMouseMove(e);
      }
    });
    // Expose colorization state for main process
    window.__cadmiumGetColorizationInProgress = () => this.colorizationInProgress;
    storeCanvasWrapperSizeInStoreDebounced();
    this.initializePressureLibrary();
    subscribe('reset-canvas-view', () => {
      this.canvasScale = 0.45;
      this.canvasRelPositionLeft = 0;
      this.canvasRelPositionTop = 0;
    });
    subscribe('relaunch-tour', () => {
      // eslint-disable-next-line
      this.$tours['myTour'].start();
    });
    subscribe('zoom-canvas-from-menu', async (event, inOrOut) => {
      console.log('inOrOut: ', inOrOut);
      if (this.zoomToolActive) {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_PEN,
        });
      }
      if (this.handToolActive) {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_PEN,
        });
        // await this[ACTIVATE_PREVIOUS_TOOL]();
      }
      // actually do the zoom here:
      const newCanvasScale = this.zoomFromMenu(inOrOut);
      this.canvasScale = newCanvasScale;
      this.onCanvasWrapperResize();
      // this.reDrawCanvas();
      // set a different tool to update canvas (hack)

      if (this.penToolActive) {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_FILL,
        });
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_PEN,
        });
      }
      if (this.eraserToolActive) {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_FILL,
        });
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_ERASER,
        });
      }

      if (this.fillToolActive) {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_PEN,
        });
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_FILL,
        });
        // await this[ACTIVATE_PREVIOUS_TOOL]();
      }
      if (this.eyedropperToolActive) {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_PEN,
        });
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_EYEDROPPER,
        });
        // await this[ACTIVATE_PREVIOUS_TOOL]();
      } else {
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_FILL,
        });
        await this[ACTIVATE_TOOL_BY_ID]({
          toolId: TOOL_CONTROLS_ID_PEN,
        });
        // await this[ACTIVATE_PREVIOUS_TOOL]();
      }
    });

    subscribe('loadWalkthrough', () => {
      console.log('LOADING WALTHROUGH TOUR');
      // eslint-disable-next-line
      this.$tours['myTour'].start();
      setPref('completedTour', true);
    });
  },
  beforeDestroy() {
    if (mouseMoveEventListener) {
      const { canvasWrapper } = this.$refs;
      canvasWrapper.removeEventListener('pointermove', this.onCanvasMouseMove, false);
      canvasWrapper.removeEventListener('pointermove', this.onCanvasZoom, false);
      canvasWrapper.removeEventListener('mousemove', this.onCanvasZoom, false);
      canvasWrapper.removeEventListener('keydown', this.onCanvasZoom, false);
    }
  },
  components: {
    TimelinePane,
    FooterBar,
    ImageImportWaitingScreen,
    Sidebar,
    ToolControls,
    WelcomeModal,
  },
};

function storeCanvasWrapperSizeInStore() {
  const el = document.querySelector('.main-pane__canvas-pane');
  const bb = el.getBoundingClientRect();
  store.commit(SET_AVAILABLE_SPACE_FOR_CANVAS, {
    width: bb.width,
    height: bb.height,
  });
}

const storeCanvasWrapperSizeInStoreDebounced = debounce(storeCanvasWrapperSizeInStore, 400);

</script>

<style lang="scss">
.main-pane {
  position: relative;
  max-width: 100vw;
  // height: calc(100vh - var(--nav-bar-height));
  // max-height: calc(100vh - var(--nav-bar-height));
  // max-height: 100vh;
  overflow: hidden;
  // max-height: calc(100vh - 80px); // subtract nav bar height
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  touch-action: none;
}
.main-pane__canvas-pane {
  background-color: #272727;
  flex-grow: 1;
  position: relative;
  width: 100vw;
  height: 100%;
}
.main-pane__canvas-tools-wrapper, .main-pane__canvas-wrapper {
  position: absolute;
  width: 100vw;
  height: 100%;
  top: 0;
  left: 0;
}
.main-pane__canvas-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;

  &--hand-tool-active {
    cursor: url('../assets/icons/hand-open-black.svg') 0 0, auto;

    &.main-pane__canvas-wrapper--mouse-down {
      cursor: url('../assets/icons/hand-closed-black.svg') 0 0, auto;
    }
  }

  &--zoom-tool-active {
    cursor: url('../assets/icons/zoom-out-cursor.svg') 10 10, auto;

    &.main-pane__canvas-wrapper--zoom-tool-mode-in {
      cursor: url('../assets/icons/zoom-in-cursor.svg') 10 10, auto;
    }
  }
}
.main-pane__canvas-tools-wrapper {
  pointer-events: none;
}
// .main-pane__rest-wrapper {
//   height: 100%;
//   position: relative;
// }
// .main-pane__current-images {
//   display: none;
//   width: 960px;
//   height: 540px;
//   position: relative;
//   // outline: 1px solid #3C3C3C;
//   background-color: white;
// }
// .main-pane__timeline-pane {
//   background-color: #3c3c3c;
// }
// .main-pane__current-color-image, .main-pane__current-line-image {
//   position: absolute;
//   top: 0;
//   left: 0;
//   width: 100%;
//   height: 100%;
//   background-size: cover;
// }

.main-pane__canvas-inner-wrapper {
  position: relative;
  // display: block;
  flex-shrink: 0;
  overflow: hidden; // without this the scaling will not work (flexbox-scale conflict)
  image-rendering: var(--renderStyle);
  overflow: initial;
  //image-rendering: pixelated;

  &--fill-tool-active {
    cursor: url('../assets/icons/fill-cursor.svg') 0 0, auto;

    &.main-pane__canvas-wrapper--fill-tool-mode-erase {
      cursor: url('../assets/icons/cursor-fill-erase.svg') 0 0, auto;
    }
  }

  &--pen-tool-active {
    // manually positioned so the center matches the regular cursor tip
    cursor: url('../assets/icons/cross-point-cursor.svg') 12 12, auto;
  }
  &--eraser-tool-active {
    // manually positioned so the center matches the regular cursor tip
    cursor: url('../assets/icons/cross-point-cursor.svg') 12 12, auto;
  }

  &--pen-tool-diameter-adjust {
    // manually positioned so the center matches the regular cursor tip
    // cursor: none;
  }

  &--eyedropper-tool-active {
    cursor: url('../assets/icons/eyedropper-cursor.svg') 0 0, auto;
  }
}

.canvas-background, .main-canvas {
  position: absolute;
  top: 0;
  left: 0;
  // width: 100%;
  // height: 100%;
  // max-width: 100%;
  // max-height: 100%;
  min-width: 0;
  min-height: 0;
}

.canvas-background {
  // background-color: white;
}

.main-canvas {}

.timeline-and-footer {
  // position: absolute;
  // bottom: 0;
  // height: 243px; // not optimal
  max-width: 100vw;
}

.color-preview-mode {
      width: 101.5%;
      height: 103%;
      border-color: #fff;
      border-style: solid;
      margin-left: -0.7%;
      margin-top: -.8%;
}

.color-preview-mode-text {
    color: white;
    background-color: #272727;
    padding: 7px;
    margin-top: -20px;
    position: absolute;
    margin-left: 44%;
}

.el-notification.right {
  right: 70px;
  height: 50px;
  top: 5px !important;
  cursor: pointer;
  background: #272727;
  border: none;
  width: 400px;
}

.el-notification__content {
  font-size: 12px;
  margin-top: -11px;
  margin-right: 8px;
  color: #777777;
  line-height: 15px;
}

.el-loading-text {
  color: white !important;
  font-size: 16px !important;
}

.el-icon-loading {
  color: #9834d3 !important;
}

.el-hide {
  display:none;
}
</style>
