<template>
    <div :class="{s_disabled: disabled}"
         class="cpw_container"
         ref="color-wheel"
         id="color-wheel"
         :style="{width: `${width}px`, height: `${height}px`, position: 'relative'}">
        <div ref="farbtastic-solid"
             class="farbtastic-solid"
             :style="solidStyle"
             style="position: absolute"></div>
        <canvas ref="farbtastic-mask"
                class="farbtastic-mask"
                :style="{width, height}"
                :width="width"
                :height="height"></canvas>
        <canvas @mousedown="mousedown"
                @touchstart="touchHandleStart"
                @touchmove="touchHandleMove"
                @touchend="touchHandleEnd"
                ref="farbtastic-overlay"
                class="farbtastic-overlay"
                :style="{width, height}"
                :width="width"
                :height="height"></canvas>
    </div>
</template>
<script>
// import isIE from './util/is-ie.js';
const isIE = false;

const DEFAULT_WIDTH_HEIGHT = 300;
const DEFAULT_START_COLOR = '#000000';

export default {
  name: 'color-picker',
  props: {
    width: {
      required: false,
      type: Number,
      default: DEFAULT_WIDTH_HEIGHT,
    },
    height: {
      required: false,
      type: Number,
      default: DEFAULT_WIDTH_HEIGHT,
    },
    disabled: {
      required: false,
      type: Boolean,
      default: false,
    },
    startColor: {
      required: false,
      type: String,
    },
    value: {
      required: false,
      type: String,
    },
  },
  mounted() {
    /**
     * @deprecated since: 0.4.0, remove in: 1.0.0, https://github.com/stijlbreuk/vue-color-picker-wheel/issues/6
     */
    if (this.hasCamelCaseColorChangeListener) {
      /* eslint-disable-next-line */
      console.warn(`Using the colorChange event is deprecated since version 0.4.0. It will be deleted in version 1.0.0. 'v-model' or the kebab-case variant 'color-change' should be used.`);
    }
    this.initWidget();
    this.setColor(this.value || this.startColor || DEFAULT_START_COLOR);
  },
  data() {
    return {
      debug: false,
      dragging: false,
      circleDrag: false,
      color: '',
      rgb: '',
      hsl: '',
      hsv: '',
      radius: '',
      square: '',
      mid: '',
      markerSize: '',
      ctxMask: '',
      ctxOverlay: '',
      cnvMask: '',
      cnvOverlay: '',
      offset: {
        left: '',
        top: '',
      },
    };
  },
  watch: {
    value(newVal, oldVal) {
      if (newVal !== oldVal) {
        // console.log("newVal: "+newVal);
        this.setColor(newVal);
      }
    },
  },
  computed: {
    /**
     * @deprecated since: 0.4.0, remove in: 1.0.0, https://github.com/stijlbreuk/vue-color-picker-wheel/issues/6
     */
    hasCamelCaseColorChangeListener() {
      return this.$listeners && this.$listeners.colorChange;
    },
    solidStyle() {
      return {
        'background-color': this.pack(this.HSLToRGB([this.hsl[0], 1, 0.5])),
        width: `${this.square * 2 - 0}px`,
        height: `${this.square * 2 - 0}px`,
        left: `${this.mid - this.square}px`,
        top: `${this.mid - this.square}px`,
      };
    },
    wheelWidth() {
      return (this.width || 300) / 10;
    },
  },
  methods: {
    setColor(color, noEmit = false) {
      const unpack = this.unpack(color);
      // console.log("unpack color: "+ unpack);
      if (this.color !== color && unpack) {
        this.color = color;
        this.rgb = unpack;
        this.hsl = this.RGBToHSL(this.rgb);
        // this.hsv = this.HSLtoHSV(this.hsl);
        this.hsv = this.RGBToHSV(this.rgb);
        this.updateDisplay(noEmit);
      }
      return this;
    },
    setHSL(hsl) {
      this.hsl = hsl;
      this.hsv = this.HSLtoHSV(hsl);
      this.rgb = this.HSLToRGB(hsl);
      this.color = this.pack(this.rgb);
      this.updateDisplay();
      return this;
    },
    setHSV(hsv) {
      this.hsv = hsv;
      this.hsl = this.HSVtoHSL(hsv);
      this.rgb = this.HSLToRGB(this.hsl);
      // this.rgb = this.HSVToRGB(hsv);
      this.color = this.pack(this.rgb);
      this.updateDisplay();
      // eslint-disable-next-line
      // console.log('h: ' + this.hsv[0]+'    s: ' + this.hsv[1] + '    v: ' + this.hsv[2]);
      return this;
    },

    initWidget() {
      // Determine layout
      this.radius = (this.width - this.wheelWidth) / 2 - 0;
      this.square = Math.floor((this.radius - this.wheelWidth / 2) * 0.7) - 0;
      this.mid = Math.floor(this.width / 2);
      this.markerSize = this.wheelWidth * 0.4;

      // Set up drawing context.
      this.cnvMask = this.$refs['farbtastic-mask'];
      this.ctxMask = this.cnvMask.getContext('2d');
      this.cnvOverlay = this.$refs['farbtastic-overlay'];
      this.ctxOverlay = this.cnvOverlay.getContext('2d');
      this.devicePixelRatio = window.devicePixelRatio || 1;
      this.upscaleCanvas(this.cnvMask);
      this.upscaleCanvas(this.cnvOverlay);
      this.ctxMask.translate(this.mid, this.mid);
      this.ctxOverlay.translate(this.mid, this.mid);

      // Draw widget base layers.
      this.drawCircle();
      this.drawMask();
    },
    /* eslint-disable */
    upscaleCanvas(cnv) {
      const ctx = cnv.getContext('2d');
      const backingStoreRatio =
        ctx.webkitBackingStorePixelRatio ||
        ctx.mozBackingStorePixelRatio ||
        ctx.msBackingStorePixelRatio ||
        ctx.oBackingStorePixelRatio ||
        ctx.backingStorePixelRatio ||
        1;
      if (this.devicePixelRatio !== backingStoreRatio) {
        const ratio = this.devicePixelRatio / backingStoreRatio;

        const oldWidth = cnv.width;
        const oldHeight = cnv.height;
        cnv.width = oldWidth * ratio;
        cnv.height = oldHeight * ratio;
        cnv.style.width = `${oldWidth}px`;
        cnv.style.height = `${oldHeight}px`;
        ctx.scale(ratio, ratio);
      }
    },
    /* eslint-enable */
    drawCircle() {
      const tm = +(new Date());
      // Draw a hue circle with a bunch of gradient-stroked beziers.
      // Have to use beziers, as gradient-stroked arcs don't work.
      const n = 24;
      const r = this.radius;
      const w = this.wheelWidth;
      const nudge = (8 / r / n) * Math.PI; // Fudge factor for seams.
      const m = this.ctxMask;
      let angle1 = 0;
      let angle2;
      // let d1;
      let color1;
      let color2;
      m.save();
      m.lineWidth = w / r;
      m.scale(r, r);
      // Each segment goes from angle1 to angle2.
      // eslint-disable-next-line
    for (let i = 0; i <= n; ++i) {
        const d2 = i / n;
        angle2 = d2 * Math.PI * 2;
        // Endpoints
        const x1 = Math.sin(angle1);
        const y1 = -Math.cos(angle1);
        const x2 = Math.sin(angle2);
        const y2 = -Math.cos(angle2);
        // Midpoint chosen so that the endpoints are tangent to the circle.
        const am = (angle1 + angle2) / 2;
        const tan = 1 / Math.cos((angle2 - angle1) / 2);
        const xm = Math.sin(am) * tan;
        const ym = -Math.cos(am) * tan;
        // New color
        color2 = this.pack(this.HSLToRGB([d2, 1, 0.5]));
        if (i > 0) {
          // Create gradient fill between the endpoints.
          const grad = m.createLinearGradient(x1, y1, x2, y2);
          grad.addColorStop(0, color1);
          grad.addColorStop(1, color2);
          m.strokeStyle = grad;
          // Draw quadratic curve segment.
          m.beginPath();
          m.moveTo(x1, y1);
          m.quadraticCurveTo(xm, ym, x2, y2);
          m.stroke();
        }
        // Prevent seams where curves join.
        angle1 = angle2 - nudge;
        color1 = color2;
        // d1 = d2;
      }
      m.restore();
      if (this.debug) {
        const debugElement = document.createElement('div');
        debugElement.textContent = `drawCircle ${(+(new Date()) - tm)} ms`;
        document.body.appendChild(debugElement);
      }
    },
    drawMask() {
      const tm = +(new Date());

      // Iterate over sat/lum space and calculate appropriate mask pixel values.
      const size = this.square * 2;
      const sq = this.square;
      function calculateMask(sizex, sizey, outputPixel) {
        const isx = 1 / sizex;
        const isy = 1 / sizey;
        // eslint-disable-next-line
        for (let y = 0; y <= sizey; ++y) {
          const l = (1 - y * isy) / 1;
          // eslint-disable-next-line
          for (let x = 0; x <= sizex; ++x) {
            const s = x * isx;
            // From sat/lum to alpha and color (grayscale)
            // const a = 0;
            if (l > s) {
              const a = (1 - s);
              // const a = 1;
              // const a = (1-l)+((1-s)*l);
              // const a = 1 - 2 * Math.min(l * s, (1 - l) * s);
              const c = l;
              // const c = a > 0 ? (2 * l - 1 + a) * (0.5 / a) : 0;
              outputPixel(x, y, c, a);
            } else {
              const a = (1 - l);
              const c = l;
              outputPixel(x, y, c, a);
            }
          }
        }
      }

      // Method #1: direct pixel access (new Canvas).
      if (this.ctxMask.getImageData) {
        // Create half-resolution buffer.
        const sz = Math.floor(size / 2);
        const buffer = document.createElement('canvas');
        buffer.width = sz + 1;
        buffer.height = sz + 1;
        const ctx = buffer.getContext('2d');
        const frame = ctx.getImageData(0, 0, sz + 1, sz + 1);

        let i = 0;
        calculateMask(sz, sz, (x, y, c, a) => {
          // eslint-disable-next-line
          frame.data[i++] = frame.data[i++] = frame.data[i++] = c * 255;
          // eslint-disable-next-line
          frame.data[i++] = a * 255;
        });

        ctx.putImageData(frame, 0, 0);
        this.ctxMask.drawImage(
          buffer,
          0,
          0,
          sz + 1,
          sz + 1,
          -sq,
          -sq,
          sq * 2,
          sq * 2,
        );
      } else if (!isIE()) {
        // Render directly at half-resolution
        const sz = Math.floor(size / 2);
        calculateMask(sz, sz, (x, y, _c, a) => {
          const c = Math.round(_c * 255);
          this.ctxMask.fillStyle = `rgba(${c}, ${c}, ${c}, ${a})`;
          this.ctxMask.fillRect(x * 2 - sq - 1, y * 2 - sq - 1, 2, 2);
        });
      } else {
        let cacheLast;
        let cache;
        const w = 6; // Each strip is 6 pixels wide.
        const sizex = Math.floor(size / w);
        // 6 vertical pieces of gradient per strip.
        calculateMask(sizex, 6, (x, y, c, a) => {
          if (x === 0) {
            cacheLast = cache;
            cache = [];
          }
          /* eslint-disable */
          c = Math.round(c * 255);
          a = Math.round(a * 255);
          /* eslint-enable */
          // We can only start outputting gradients
          // once we have two rows of pixels.
          if (y > 0) {
            const cLast = cacheLast[x][0];
            const aLast = cacheLast[x][1];
            const color1 = this.packDX(cLast, aLast);
            const color2 = this.packDX(c, a);
            const y1 = Math.round(this.mid + ((y - 1) * 0.333 - 1) * sq);
            const y2 = Math.round(this.mid + (y * 0.333 - 1) * sq);
            // Append div to canvasMask
            const div = document.createElement('div');
            div.style.position = 'absolute';
            div.style.filter = `progid:DXImageTransform.Microsoft.Gradient(StartColorStr=${color1}, EndColorStr=${color2}, GradientType=0)`;
            div.style.top = y1;
            div.style.height = y2 - y1;
            div.style.left = this.mid + (x * w - sq - 1);
            div.style.width = this.mid + (x * w - sq - 1);
            this.cnvMask.appendChild(div);
          }
          cache.push([c, a]);
        });
      }
      if (this.debug) {
        const debugElement = document.createElement('div');
        debugElement.textContent = `drawMask ${(+(new Date()) - tm)} ms`;
        document.body.appendChild(debugElement);
      }
    },
    drawMarkers() {
      // Determine marker dimensions
      const sz = this.width;
      const lw = Math.ceil(this.markerSize / 7);
      const r = this.markerSize - lw + lw;
      const angle = this.hsv[0] * 6.28;
      const x1 = Math.sin(angle) * this.radius;
      const y1 = -Math.cos(angle) * this.radius;

      const x2 = -2 * this.square * (0.5 - this.hsv[1]);
      const y2 = 2 * this.square * (0.5 - this.hsv[2]);
      // eslint-disable-next-line
      // console.log("from drawmarkers: ");
      // console.log('x2: ' + x2 + '    y2: ' + y2);
      // console.log("hue: " + this.hsv[0] + "   sat: " + this.hsv[1] +"    val: " + this.hsv[2]);
      const c1 = this.invert ? '#fff' : '#000';
      // const c2 = this.invert ? '#000' : '#fff';
      // TO DO: fix edge case where marker dissapears from typing hex 000000 in manually.
      /* eslint-disable */
      const circles = [
        // { x: x1, y: y1, r, c: '#000', lw: lw + 1 },
        { x: x1, y: y1, r, c: '#000', lw },
        // { x: x2, y: y2, r, c: c2, lw: lw + 1 },
        { x: x2, y: y2, r, c: c1, lw }
      ];
      /* eslint-enable */
      // Update the overlay canvas.
      this.ctxOverlay.clearRect(-this.mid, -this.mid, sz, sz);
      for (let i = 0; i < circles.length; i += 1) {
        const c = circles[i];
        this.ctxOverlay.lineWidth = c.lw;
        this.ctxOverlay.strokeStyle = c.c;
        this.ctxOverlay.beginPath();
        this.ctxOverlay.arc(c.x, c.y, c.r, 0, Math.PI * 2, true);
        this.ctxOverlay.stroke();
      }
    },
    updateDisplay(noEmit) {
      // Determine whether labels/markers should invert.
      this.invert = this.hsv[2] <= 0.5;
      // Draw markers
      this.drawMarkers();

      if (!noEmit) {
        // Emit color
        this.$emit('input', this.color);
        /**
         * @deprecated since: 0.4.0, remove in: 1.0.0, https://github.com/stijlbreuk/vue-color-picker-wheel/issues/6
         */
        this.$emit('colorChange', this.color);
        this.$emit('color-change', this.color);
      }
    },
    widgetCoords(event) {
      return {
        x: event.clientX - this.offset.left - this.mid,
        y: event.clientY - this.offset.top - this.mid,
      };
    },
    mousedown(event) {
      if (this.disabled) return false;
      // Capture mouse
      if (!this.dragging) {
        document.addEventListener('mousemove', this.mousemove);
        document.addEventListener('mouseup', this.mouseup);
        this.dragging = true;
      }

      // Update the stored offset for the widget.
      this.offset = {
        left: this.$refs['color-wheel'].getBoundingClientRect().left,
        top: this.$refs['color-wheel'].getBoundingClientRect().top,
      };

      // Check which area is being dragged
      const pos = this.widgetCoords(event);
      this.circleDrag = Math.max(Math.abs(pos.x), Math.abs(pos.y)) > this.square + 2;

      // Process
      this.mousemove(event);
      return false;
    },
    mousemove(event) {
      // Get coordinates relative to color picker center
      const pos = this.widgetCoords(event);
      const xMap = (pos.x / this.square / 2) + 0.5;
      const yMap = (-pos.y / this.square / 2) + 0.5;

      // Set new HSL parameters
      if (this.circleDrag) {
        const hue = Math.atan2(pos.x, -pos.y) / 6.28;
        this.setHSV([(hue + 1) % 1, this.hsv[1], this.hsv[2]]);
      } else {
        const sat = Math.max(0, Math.min(1, xMap));
        // const sat = Math.max(0, Math.min(1, -(pos.x / this.square / 2) + 0.5));
        const val = Math.max(0, Math.min(1, yMap));
        // const lum = Math.max(0, Math.min(1, -(pos.y / this.square / 2) + 0.5));
        this.setHSV([this.hsv[0], sat, val]);
      }
      return false;
    },
    mouseup() {
      // Uncapture mouse
      document.removeEventListener('mousemove', this.mousemove);
      document.removeEventListener('mouseup', this.mouseup);
      this.dragging = false;
    },
    /* Constious color utility functions */
    dec2hex(x) {
      return (x < 16 ? '0' : '') + x.toString(16);
    },
    packDX(c, a) {
      return `#${this.dec2hex(a)
        + this.dec2hex(c)
        + this.dec2hex(c)
        + this.dec2hex(c)}`;
    },
    pack(rgb) {
      const r = Math.round(rgb[0] * 255);
      const g = Math.round(rgb[1] * 255);
      const b = Math.round(rgb[2] * 255);
      return `#${this.dec2hex(r) + this.dec2hex(g) + this.dec2hex(b)}`;
    },
    unpack(color) {
      // console.log("color from unpack: "+color);
      if (color.length === 7) {
        return [1, 3, 5].map(
          // eslint-disable-next-line
          i => parseInt(color.substring(i, i + 2), 16) / 255,
        );
      }
      if (color.length === 4) {
        // eslint-disable-next-line
        return [1, 2, 3].map(i => parseInt(color.substring(i, i + 1), 16) / 15);
      }
      return false;
    },
    HSLToRGB(hsl) {
      const h = hsl[0];
      const s = hsl[1];
      const l = hsl[2];
      const m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s;
      const m1 = l * 2 - m2;
      return [
        this.hueToRGB(m1, m2, h + 0.33333),
        this.hueToRGB(m1, m2, h),
        this.hueToRGB(m1, m2, h + 0.66666),
      ];
    },
    /*
    HSVToRGB(hsv) {
      console.log('HSVToRGB');
      let r, g, b;
      const h = hsv[0];
      const s = hsv[1];
      const v = hsv[2];

      const i = Math.floor(h * 6);
      const f = h * 6 - i;
      const p = v * (1 - s);
      const q = v * (1 - f * s);
      const t = v * (1 - (1 - f) * s);
      switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        default: r = v, g = p, b = q; break;
      }
      return {
          r: Math.round(r * 255),
          g: Math.round(g * 255),
          b: Math.round(b * 255)
      };
    },
    */
    RGBToHSV(rgb) {
      const r = rgb[0];
      const g = rgb[1];
      const b = rgb[2];
      let h = 0;
      let s = 0;

      const min = Math.min(r, g, b);
      const max = Math.max(r, g, b);
      const d = max - min;
      const v = max;
      if (d === 0) {
        h = 0;
        s = 0;
      } else {
        s = d / max;
        const rr = (((max - r) / 6) + (d / 2)) / d;
        const gg = (((max - g) / 6) + (d / 2)) / d;
        const bb = (((max - b) / 6) + (d / 2)) / d;

        if (r === max) {
          h = bb - gg;
        } else if (g === max) {
          h = (1 / 3) + rr - bb;
        } else if (b === max) {
          h = (2 / 3) + gg - rr;
        }
        if (h < 0) {
          h += 1;
        }
        if (h > 0) {
          h -= 1;
        }
      }
      // console.log("from rgbtohsv:");
      // console.log("h: " + h + "   s: " + s + "    v: " + v);
      return [h, s, v];
    },
    /*
    // this function is coded more elegantly, but doesn't work...
    // so the one above will suffice.
    RGBToHSV2(rgb) {
      if (arguments.length === 1) {
        const r = this.rgb[0];
        const g = this.rgb[1];
        const b = this.rgb[2];

      var max = Math.max(r, g, b), min = Math.min(r, g, b),
      d = max - min,
      h,
      s = (max === 0 ? 0 : d / max),
      v = max / 255;

      switch (max) {
        case min: h = 0; break;
        case r: h = (g - b) + d * (g < b ? 6: 0); h /= 6 * d; break;
        case g: h = (b - r) + d * 2; h /= 6 * d; break;
        case b: h = (r - g) + d * 4; h /= 6 * d; break;
      }
      console.log("s: " + s + "    v: " + v);
      return [h, s, v];
      }
    },
    */
    hueToRGB(m1, m2, h) {
      /* eslint-disable-next-line */
      h = (h + 1) % 1;
      if (h * 6 < 1) return m1 + (m2 - m1) * h * 6;
      if (h * 2 < 1) return m2;
      if (h * 3 < 2) return m1 + (m2 - m1) * (0.66666 - h) * 6;
      return m1;
    },
    RGBToHSL(rgb) {
      const r = rgb[0];
      const g = rgb[1];
      const b = rgb[2];
      const min = Math.min(r, g, b);
      const max = Math.max(r, g, b);
      const delta = max - min;
      let h = 0;
      let s = 0;
      const l = (min + max) / 2;
      if (l > 0 && l < 1) {
        s = delta / (l < 0.5 ? 2 * l : 2 - 2 * l);
      }
      if (delta > 0) {
        if (max === r && max !== g) h += (g - b) / delta;
        if (max === g && max !== b) h += 2 + (b - r) / delta;
        if (max === b && max !== r) h += 4 + (r - g) / delta;
        h /= 6;
      }
      return [h, s, l];
    },
    HSLtoHSV(hsl) {
      const h = hsl[0];
      const l = hsl[2] * 2;
      const ss = hsl[1] * (l <= 1) ? l : 2 - l;
      const v = (l + ss) / 2;
      const s = (2 * ss) / (l + ss);
      // console.log("from HSLtoHSV: ");
      // console.log('h: ' + h + '   s : ' + s + "   v: " + v);
      return [h, s, v];
    },

    HSVtoHSL(hsv) {
      const h = hsv[0];
      const ll = (2 - hsv[1]) * hsv[2];
      const ss = hsv[1] * hsv[2];
      // check for NaN value dividing by zero
      if (ll > 0 && ll < 2) {
        const s = ss / ((ll <= 1) ? (ll) : 2 - (ll));
        // console.log('ll: ' + ll);
        const l = ll / 2;
        return [h, s, l];
      }
      const s = ss;
      // console.log('s: ' + s);
      const l = ll / 2;
      return [h, s, l];
    },

    /**
     * Helper for returning coordinates relative to the center with touch event
     */
    widgetCoordsTouch(event) {
      return {
        x: event.targetTouches[0].clientX - this.offset.left - this.mid,
        y: event.targetTouches[0].clientY - this.offset.top - this.mid,
      };
    },
    /**
     * Handle the touchstart events
     */
    touchHandleStart(event) {
      // Ignore the event if another is already being handled
      if (this.touchHandled) {
        return;
      }

      // Set the flag to prevent others from inheriting the touch event
      this.touchHandled = true;

      // Track movement to determine if interaction was a click
      this.touchMoved = false;

      // Update the stored offset for the widget.
      this.offset = {
        left: this.$refs['color-wheel'].getBoundingClientRect().left,
        top: this.$refs['color-wheel'].getBoundingClientRect().top,
      };

      // Check which area is being dragged
      const pos = this.widgetCoordsTouch(event);
      this.circleDrag = Math.max(Math.abs(pos.x), Math.abs(pos.y)) > this.square + 2;
    },
    /**
     * Handle the touchstart events
     */
    touchHandleMove(event) {
      // Ignore event if not handled
      if (!this.touchHandled) {
        return;
      }
      event.preventDefault();

      // Interaction was not a click
      this.touchMoved = true;

      // Get coordinates relative to color picker center
      const pos = this.widgetCoordsTouch(event);
      const xMap = (pos.x / this.square / 2) + 0.5;
      const yMap = (-pos.y / this.square / 2) + 0.5;

      // Set new HSL parameters
      if (this.circleDrag) {
        const hue = Math.atan2(pos.x, -pos.y) / 6.28;
        this.setHSV([(hue + 1) % 1, this.hsv[1], this.hsv[2]]);
      } else {
        const sat = Math.max(0, Math.min(1, xMap));
        // const sat = Math.max(0, Math.min(1, -(pos.x / this.square / 2) + 0.5));
        const val = Math.max(0, Math.min(1, yMap));
        // const lum = Math.max(0, Math.min(1, -(pos.y / this.square / 2) + 0.5));
        this.setHSV([this.hsv[0], sat, val]);
      }
      // return false;
    },
    /**
     * Handle the touchstart events
     */
    touchHandleEnd() {
      // Ignore event if not handled
      if (!this.touchHandled) {
        return;
      }
      // Unset the flag to allow other widgets to inherit the touch event
      this.touchHandled = false;
    },
  },
};
</script>
<style lang="scss" scoped>
.s_disabled {
  opacity: 0.5;
}

.cpw_container {
  -webkit-touch-callout: none; /* prevent callout to copy image, etc when tap to hold */
  text-size-adjust:none; /* prevent webkit from resizing text to fit */
  tap-highlight-color:rgba(0,0,0,0); /* prevent tap highlight color*/
  tap-highlight-color: transparent; /* prevent tap highlight color*/
  user-select:none;

  .farbtastic-mask {
    position: absolute;
    left: 0;
  }

  .farbtastic-overlay {
    position: absolute;
    left: 0;
  }
}
</style>
