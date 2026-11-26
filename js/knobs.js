/**
 * OMI SYNDICATE — Physical Anodized Rotary Knob Component
 *
 * Tactile precision hardware knobs with:
 *  - 270-degree sweep (-135° to +135°)
 *  - SVG precision ticks + luminous value arc
 *  - Vertical pointer drag (with Shift fine-tune), wheel scroll, double-click reset, keyboard support
 */

(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const START_ANGLE = -135;
  const END_ANGLE = 135;
  const SWEEP_ANGLE = END_ANGLE - START_ANGLE; // 270°

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad)
    };
  }

  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, startAngle);
    const end = polarToCartesian(cx, cy, r, endAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  class RotaryKnob {
    constructor(hostEl, options = {}) {
      this.host = hostEl;
      this.id = hostEl.dataset.knob || options.id || 'param';
      this.label = hostEl.dataset.label || options.label || 'PARAM';
      this.min = parseFloat(hostEl.dataset.min ?? options.min ?? 0);
      this.max = parseFloat(hostEl.dataset.max ?? options.max ?? 1);
      this.defaultValue = parseFloat(hostEl.dataset.default ?? options.defaultValue ?? 0.5);
      this.value = parseFloat(hostEl.dataset.value ?? this.defaultValue);
      this.formatter = options.formatter || ((v) => `${Math.round(v * 100)}%`);
      this.onChange = options.onChange || (() => {});

      this.isDragging = false;
      this.dragStartY = 0;
      this.dragStartVal = this.value;

      this.buildDOM();
      this.bindEvents();
      this.render();
    }

    buildDOM() {
      const gradId = `knob-grad-${this.id}`;
      const cx = 32;
      const cy = 32;
      const arcRadius = 26.5;
      this.arcLength = (SWEEP_ANGLE / 360) * 2 * Math.PI * arcRadius;

      const wrapper = document.createElement('div');
      wrapper.className = 'knob-control';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'slider');
      wrapper.setAttribute('aria-label', this.label);
      wrapper.setAttribute('aria-valuemin', String(this.min));
      wrapper.setAttribute('aria-valuemax', String(this.max));

      const dialWrap = document.createElement('div');
      dialWrap.className = 'knob-dial-wrap';

      // Build crisp SVG precision ring & ticks
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'knob-svg');
      svg.setAttribute('viewBox', '0 0 64 64');

      const defs = document.createElementNS(SVG_NS, 'defs');
      const linGrad = document.createElementNS(SVG_NS, 'linearGradient');
      linGrad.setAttribute('id', gradId);
      linGrad.setAttribute('x1', '0%');
      linGrad.setAttribute('y1', '100%');
      linGrad.setAttribute('x2', '100%');
      linGrad.setAttribute('y2', '0%');

      const stop1 = document.createElementNS(SVG_NS, 'stop');
      stop1.setAttribute('offset', '0%');
      stop1.setAttribute('stop-color', '#9f8cff');

      const stop2 = document.createElementNS(SVG_NS, 'stop');
      stop2.setAttribute('offset', '55%');
      stop2.setAttribute('stop-color', '#86e2f8');

      const stop3 = document.createElementNS(SVG_NS, 'stop');
      stop3.setAttribute('offset', '100%');
      stop3.setAttribute('stop-color', '#eef5ff');

      linGrad.appendChild(stop1);
      linGrad.appendChild(stop2);
      linGrad.appendChild(stop3);
      defs.appendChild(linGrad);
      svg.appendChild(defs);

      // 21 precision radial ticks around perimeter
      const tickCount = 21;
      for (let i = 0; i < tickCount; i++) {
        const frac = i / (tickCount - 1);
        const angle = START_ANGLE + frac * SWEEP_ANGLE;
        const isMajor = i % 5 === 0;
        const inner = isMajor ? 29.3 : 29.9;
        const outer = 31.6;
        const p1 = polarToCartesian(cx, cy, inner, angle);
        const p2 = polarToCartesian(cx, cy, outer, angle);

        const tick = document.createElementNS(SVG_NS, 'line');
        tick.setAttribute('x1', p1.x.toFixed(2));
        tick.setAttribute('y1', p1.y.toFixed(2));
        tick.setAttribute('x2', p2.x.toFixed(2));
        tick.setAttribute('y2', p2.y.toFixed(2));
        tick.setAttribute('class', isMajor ? 'knob-tick is-major' : 'knob-tick');
        svg.appendChild(tick);
      }

      // Track arc
      const arcPath = describeArc(cx, cy, arcRadius, START_ANGLE, END_ANGLE);
      const trackArc = document.createElementNS(SVG_NS, 'path');
      trackArc.setAttribute('d', arcPath);
      trackArc.setAttribute('class', 'knob-track-arc');
      svg.appendChild(trackArc);

      // Active value arc
      const valueArc = document.createElementNS(SVG_NS, 'path');
      valueArc.setAttribute('d', arcPath);
      valueArc.setAttribute('class', 'knob-value-arc');
      valueArc.style.stroke = `url(#${gradId})`;
      valueArc.style.strokeDasharray = `${this.arcLength.toFixed(2)}`;
      svg.appendChild(valueArc);

      // Physical recessed socket + rotating anodized aluminum cap
      const socket = document.createElement('div');
      socket.className = 'knob-socket';

      const cap = document.createElement('div');
      cap.className = 'knob-cap';

      const indicator = document.createElement('div');
      indicator.className = 'knob-indicator';
      cap.appendChild(indicator);
      socket.appendChild(cap);

      dialWrap.appendChild(svg);
      dialWrap.appendChild(socket);

      // Label & monospace readout
      const labelEl = document.createElement('span');
      labelEl.className = 'knob-label';
      labelEl.textContent = this.label;

      const readoutEl = document.createElement('span');
      readoutEl.className = 'knob-readout';

      wrapper.appendChild(dialWrap);
      wrapper.appendChild(labelEl);
      wrapper.appendChild(readoutEl);

      this.host.innerHTML = '';
      this.host.appendChild(wrapper);

      this.el = wrapper;
      this.dialWrap = dialWrap;
      this.capEl = cap;
      this.valueArcEl = valueArc;
      this.readoutEl = readoutEl;
    }

    bindEvents() {
      this.dialWrap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.isDragging = true;
        this.dragStartY = e.clientY;
        this.dragStartVal = this.value;
        this.el.classList.add('is-dragging');
        this.dialWrap.setPointerCapture(e.pointerId);
      });

      this.dialWrap.addEventListener('pointermove', (e) => {
        if (!this.isDragging) return;
        e.preventDefault();
        const dy = this.dragStartY - e.clientY;
        const sensitivity = e.shiftKey ? 520 : 145;
        const delta = (dy / sensitivity) * (this.max - this.min);
        this.setValue(this.dragStartVal + delta, true);
      });

      const endDrag = (e) => {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.el.classList.remove('is-dragging');
        if (e && e.pointerId !== undefined) {
          try { this.dialWrap.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };

      this.dialWrap.addEventListener('pointerup', endDrag);
      this.dialWrap.addEventListener('pointercancel', endDrag);

      // Double-click resets cleanly to factory default
      this.dialWrap.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setValue(this.defaultValue, true);
      });

      // Mouse wheel / trackpad precision scroll
      this.dialWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 0.008 : 0.032;
        const dir = e.deltaY < 0 ? 1 : -1;
        this.setValue(this.value + dir * step * (this.max - this.min), true);
      }, { passive: false });

      // Keyboard navigation
      this.el.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.01 : 0.04;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          this.setValue(this.value + step * (this.max - this.min), true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          this.setValue(this.value - step * (this.max - this.min), true);
        } else if (e.key === 'Home') {
          e.preventDefault();
          this.setValue(this.defaultValue, true);
        }
      });
    }

    setValue(nextVal, emit = false) {
      const clamped = clamp(nextVal, this.min, this.max);
      if (Math.abs(clamped - this.value) < 0.0001) return;
      this.value = clamped;
      this.render();
      if (emit) {
        this.onChange(this.value, this.id);
      }
    }

    render() {
      const norm = (this.value - this.min) / (this.max - this.min || 1);
      const angle = START_ANGLE + norm * SWEEP_ANGLE;
      const dashOffset = this.arcLength * (1 - norm);

      this.capEl.style.transform = `rotate(${angle.toFixed(2)}deg)`;
      this.valueArcEl.style.strokeDashoffset = `${dashOffset.toFixed(2)}`;
      this.readoutEl.textContent = this.formatter(this.value);
      this.el.setAttribute('aria-valuenow', this.value.toFixed(3));
      this.el.setAttribute('aria-valuetext', this.readoutEl.textContent);
    }
  }

  global.OmiKnobs = {
    RotaryKnob
  };
})(window);
