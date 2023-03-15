import Point from '@mapbox/point-geometry';

import DOM from '../../util/dom';
import {extend, bindAll} from '../../util/util';
import {
    MouseRotateHandler,
    MousePitchHandler,
    generateMouseRotationHandler,
    generateMousePitchHandler
} from '../handler/mouse';

import type Map from '../map';
import {
    generateOneFingerTouchPitchHandler,
    generateOneFingerTouchRotationHandler,
    OneFingerTouchPitchHandler,
    OneFingerTouchRotateHandler
} from "../handler/one_finger_touch_drag";

type NavOptions = {
    showCompass?: boolean,
    showZoom?: boolean,
    visualizePitch?: boolean,
    position?: string
};

const defaultOptions: NavOptions = {
    showCompass: true,
    showZoom: true,
    visualizePitch: false,
    position: 'bottom-right'
};

class NavControl {
    _map: Map;
    options: NavOptions;
    _container: HTMLElement;
    _nav_container: HTMLElement;
    _zoomInButton: HTMLButtonElement;
    _zoomOutButton: HTMLButtonElement;
    _amapControlbar: HTMLElement;
    _amapLuopan: HTMLElement;
    _amapLuopanBG: HTMLElement;
    _amapCompass: HTMLElement;
    _amapPointers: HTMLElement;
    _amapPitchUp: HTMLElement;
    _amapPitchDown: HTMLElement;
    _amapRotateLeft: HTMLElement;
    _amapRotateRight: HTMLElement;
    _compass: HTMLElement;
    _compassArrow: HTMLElement;
    _handler: NavMouseRotateWrapper;
    _amapHandler: NavMouseRotateWrapper;
    _intervalFunc: NodeJS.Timer;

    constructor(options: NavOptions) {
        const this_ = this;
        this.options = extend({}, defaultOptions, options);
        this._container = DOM.create('div', 'topsmapgl-ctrl topsmapgl-ctrl-group mapboxgl-ctrl mapboxgl-ctrl-group');
        this._nav_container = DOM.create('div', 'topsmapgl-scalebox mapboxgl-scalebox zdeps-1 usel', this._container);
        this._container.addEventListener('contextmenu', (e) => e.preventDefault());
        this._nav_container.addEventListener('contextmenu', (e) => e.preventDefault());
        if (this.options.showZoom) {
            bindAll([
                '_setButtonTitle',
                '_updateZoomButtons'
            ], this);
            this._zoomInButton = this._createButton('maplibregl-ctrl-zoom-in', (e) => this._map.zoomIn({}, {originalEvent: e}));
            DOM.create('span', 'maplibregl-ctrl-icon', this._zoomInButton).setAttribute('aria-hidden', 'true');
            this._zoomOutButton = this._createButton('maplibregl-ctrl-zoom-out', (e) => this._map.zoomOut({}, {originalEvent: e}));
            DOM.create('span', 'maplibregl-ctrl-icon', this._zoomOutButton).setAttribute('aria-hidden', 'true');
        }
        if (this.options.showCompass) {
            bindAll([
                '_rotateCompassArrow'
            ], this);
            //罗盘容器div 高德样式罗盘
            this._amapControlbar = DOM.create('div', 'amap-controlbar', this._container);
            this._amapLuopan = DOM.create('div', 'amap-luopan', this._amapControlbar);
            this._amapLuopanBG = DOM.create('div', 'amap-luopan-bg', this._amapLuopan);
            this._amapCompass = DOM.create('div', 'amap-compass', this._amapLuopan);
            ///罗盘指针
            this._amapPointers = DOM.create('div', 'amap-pointers', this._amapCompass);
            //指针点击还原地图事件
            this._amapPointers.addEventListener('click', () => this._map.easeTo({
                bearing: 0,
                pitch: 0,
                duration: 1000,
                animate: true
            }));
            //倾斜角度控制按钮
            this._amapPitchUp = DOM.create('div', 'amap-pitchUp', this._amapLuopan);
            this._amapPitchUp.addEventListener('mousedown', function (ev) {
                this_._intervalFunc = setInterval(function () {
                    if (this_._map.getPitch() == 60) {
                        clearInterval(this_._intervalFunc);
                    } else {
                        this_._map.easeTo({pitch: this_._map.getPitch() + 5, duration: 100, animate: true})
                    }
                }, 50);
            });
            this._amapPitchUp.addEventListener('mouseup', function (ev) {
                clearInterval(this_._intervalFunc);
            });
            this._amapPitchUp.addEventListener('mouseleave', function (ev) {
                clearInterval(this_._intervalFunc);
            });

            //傾斜角度
            this._amapPitchDown = DOM.create('div', 'amap-pitchDown', this._amapLuopan);
            this._amapPitchDown.addEventListener('mousedown', function (ev) {
                this_._intervalFunc = setInterval(function () {
                    if (this_._map.getPitch() == 0) {
                        clearInterval(this_._intervalFunc);
                    } else {
                        this_._map.easeTo({pitch: this_._map.getPitch() - 5, duration: 100, animate: true})
                    }
                }, 50);
            });
            this._amapPitchDown.addEventListener('mouseup', function (ev) {
                clearInterval(this_._intervalFunc);
            });
            this._amapPitchDown.addEventListener('mouseleave', function (ev) {
                clearInterval(this_._intervalFunc);
            });

            //旋转角度控制按钮-逆时针
            this._amapRotateLeft = DOM.create('div', 'amap-rotateLeft', this._amapLuopan);
            this._amapRotateLeft.addEventListener('mousedown', function (ev) {
                this_._intervalFunc = setInterval(function () {
                    this_._map.easeTo({bearing: this_._map.getBearing() + 10, duration: 100, animate: true})
                }, 50);
            });
            this._amapRotateLeft.addEventListener('mouseup', function (ev) {
                clearInterval(this_._intervalFunc);
            });
            this._amapRotateLeft.addEventListener('mouseleave', function (ev) {
                clearInterval(this_._intervalFunc);
            });

            //旋转角度控制按钮-顺时针
            this._amapRotateRight = DOM.create('div', 'amap-rotateRight', this._amapLuopan);
            this._amapRotateRight.addEventListener('mousedown', function (ev) {
                this_._intervalFunc = setInterval(function () {
                    this_._map.easeTo({bearing: this_._map.getBearing() - 10, duration: 100, animate: true})
                }, 50);
            });
            this._amapRotateRight.addEventListener('mouseup', function (ev) {
                clearInterval(this_._intervalFunc);
            });
            this._amapRotateRight.addEventListener('mouseleave', function (ev) {
                clearInterval(this_._intervalFunc);
            });
        }
    }

    _updateZoomButtons() {
        const zoom = this._map.getZoom();
        const isMax = zoom === this._map.getMaxZoom();
        const isMin = zoom === this._map.getMinZoom();
        this._zoomInButton.disabled = isMax;
        this._zoomOutButton.disabled = isMin;
        this._zoomInButton.setAttribute('aria-disabled', isMax.toString());
        this._zoomOutButton.setAttribute('aria-disabled', isMin.toString());
    }

    /**
     * 重新計算羅盤指針方向
     */
    _rotateCompassArrow() {
        const rotate = `rotate(${this._map.transform.angle * (180 / Math.PI)}deg)`;
        // this._compassArrow.style.transform = rotate;
        // 设置罗盘旋转角度和倾斜角度
        const amapRotate = `rotateX(${this._map.transform._pitch * (180 / Math.PI)}deg) rotateZ(${this._map.transform.angle * (180 / Math.PI)}deg)`;
        this._amapCompass.style.transform = amapRotate;
    }

    onAdd(map: Map) {
        this._map = map;
        if (this.options.showZoom) {
            this._setButtonTitle(this._zoomInButton, 'ZoomIn');
            this._setButtonTitle(this._zoomOutButton, 'ZoomOut');
            this._map.on('zoom', this._updateZoomButtons);
            this._updateZoomButtons();
        }
        if (this.options.showCompass) {
            this._map.on('rotate', this._rotateCompassArrow);
            this._map.on('pitch', this._rotateCompassArrow);
            this._rotateCompassArrow();
            this._handler = new NavMouseRotateWrapper(map, this._amapCompass, this.options.visualizePitch);
            DOM.addEventListener(this._amapCompass, 'mousedown', this._handler.mousedown);
            this._handler.reset();
        }
        this._calcContainerStyle();
        return this._container;
    }

    onRemove() {
        if (this.options.showZoom) {
            this._map.off('zoom', this._updateZoomButtons);
        }
        if (this.options.showCompass) {
            this._map.off('rotate', this._rotateCompassArrow);
            this._map.off('pitch', this._rotateCompassArrow);
            DOM.removeEventListener(this._amapCompass, 'mousedown', this._handler.mousedown);
            this._handler.reset();
            this._handler.off();
            delete this._handler;
        }
        DOM.remove(this._container);
        delete this._map;
    }

    getDefaultPosition() {
        return this.options.position;
    }

    /**
     * 計算控件所在位置
     */
    _calcContainerStyle() {
        if (this.options.position == 'bottom-right') {
            this._amapControlbar.style.right = '-16px';
            this._amapControlbar.style.bottom = '-32px';
            this._container.style.margin = '0 20px 40px 0';
        } else if (this.options.position == 'top-right') {
            this._amapControlbar.style.right = '-16px';
            this._amapControlbar.style.bottom = '-200px';
            this._container.style.margin = '20px 20px 0px 0';
        } else if (this.options.position == 'bottom-left') {
            this._container.style.margin = '0 0 10px 20px';
            this._amapControlbar.style.left = '-85px';
            this._amapControlbar.style.bottom = '-33px';
            this._amapRotateRight.style.right = '-48px';
            this._amapCompass.style.left = '93px';
            this._amapPitchDown.style.margin = '12px';
            this._amapPitchUp.style.margin = '0px';
            this._amapPitchUp.style.left = '78%';
        } else if (this.options.position == 'top-left') {
            this._container.style.margin = '20px 0 10px 20px';
            this._amapControlbar.style.left = '-95px';
            this._amapControlbar.style.top = '87px';
            this._amapRotateRight.style.right = '-35px';
            this._amapCompass.style.left = '93px';
            this._amapPitchDown.style.margin = '0 12px';
            this._amapPitchUp.style.margin = '0px';
            this._amapPitchUp.style.left = '70%';
        }
    }

    _createButtonAMap(className: string, ariaLabel: string, fn: () => unknown) {
        const a = DOM.create('button', className, this._container);
        a.type = 'button';
        a.setAttribute('aria-label', ariaLabel);
        a.addEventListener('click', fn);
        return a;
    }

    _createButton(className: string, fn: (e?: any) => unknown) {
        const a = DOM.create('button', className, this._container) as HTMLButtonElement;
        a.type = 'button';
        a.addEventListener('click', fn);
        return a;
    }

    _createDiv(className: string, ariaLabel: string, fn: () => unknown) {
        const a = DOM.create('div', className, this._nav_container);
        a.addEventListener('click', fn);
        return a;
    }

    _setButtonTitle(button: HTMLElement, title: string) {
        const str = this._map._getUIString(`NavControl.${title}`);
        button.title = str;
        button.setAttribute('aria-label', str);
    }
}


class NavMouseRotateWrapper {

    map: Map;
    _clickTolerance: number;
    element: HTMLElement;
    // Rotation and pitch handlers are separated due to different _clickTolerance values
    mouseRotate: MouseRotateHandler;
    touchRotate: OneFingerTouchRotateHandler;
    mousePitch: MousePitchHandler;
    touchPitch: OneFingerTouchPitchHandler;
    _startPos: Point;
    _lastPos: Point;

    constructor(map: Map, element: HTMLElement, pitch: boolean = false) {
        this._clickTolerance = 10;
        const mapRotateTolerance = map.dragRotate._mouseRotate.getClickTolerance();
        const mapPitchTolerance = map.dragRotate._mousePitch.getClickTolerance();
        this.element = element;
        //this.mouseRotate = new MouseRotateHandler({clickTolerance: map.dragRotate._mouseRotate._clickTolerance});
        this.mouseRotate = generateMouseRotationHandler({clickTolerance: mapRotateTolerance, enable: true});
        this.touchRotate = generateOneFingerTouchRotationHandler({clickTolerance: mapRotateTolerance, enable: true});
        this.map = map;
        if (pitch) {
            this.mousePitch = generateMousePitchHandler({clickTolerance: mapPitchTolerance, enable: true});
            this.touchPitch = generateOneFingerTouchPitchHandler({clickTolerance: mapPitchTolerance, enable: true});
        }
        bindAll(['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'reset'], this);
        DOM.addEventListener(element, 'mousedown', this.mousedown);
        DOM.addEventListener(element, 'touchstart', this.touchstart, {passive: false});
        DOM.addEventListener(element, 'touchmove', this.touchmove);
        DOM.addEventListener(element, 'touchend', this.touchend);
        DOM.addEventListener(element, 'touchcancel', this.reset);
    }

    startMouse(e: MouseEvent, point: Point) {
        this.mouseRotate.dragStart(e, point);
        if (this.mousePitch) this.mousePitch.dragStart(e, point);
        DOM.disableDrag();
    }

    startTouch(e: TouchEvent, point: Point) {
        this.touchRotate.dragStart(e, point);
        if (this.touchPitch) this.touchPitch.dragStart(e, point);
        DOM.disableDrag();
    }

    moveMouse(e: MouseEvent, point: Point) {
        const map = this.map;
        const {bearingDelta} = this.mouseRotate.dragMove(e, point) || {};
        if (bearingDelta) map.setBearing(map.getBearing() + bearingDelta);
        if (this.mousePitch) {
            const {pitchDelta} = this.mousePitch.dragMove(e, point) || {};
            if (pitchDelta) map.setPitch(map.getPitch() + pitchDelta);
        }
    }

    moveTouch(e: TouchEvent, point: Point) {
        const map = this.map;
        const {bearingDelta} = this.touchRotate.dragMove(e, point) || {};
        if (bearingDelta) map.setBearing(map.getBearing() + bearingDelta);
        if (this.touchPitch) {
            const {pitchDelta} = this.touchPitch.dragMove(e, point) || {};
            if (pitchDelta) map.setPitch(map.getPitch() + pitchDelta);
        }
    }

    down(e: MouseEvent, point: Point) {
        this.mouseRotate.mousedown(e, point);
        if (this.mousePitch) this.mousePitch.mousedown(e, point);
        DOM.disableDrag();
    }

    move(e: MouseEvent, point: Point) {
        const map = this.map;
        const r = this.mouseRotate.mousemoveWindow(e, point) as any;
        if (r && r.bearingDelta) map.setBearing(map.getBearing() + r.bearingDelta);
        if (this.mousePitch) {
            const p = this.mousePitch.mousemoveWindow(e, point) as any;
            if (p && p.pitchDelta) map.setPitch(map.getPitch() + p.pitchDelta);
        }
    }

    off() {
        const element = this.element;
        DOM.removeEventListener(element, 'mousedown', this.mousedown);
        DOM.removeEventListener(element, 'touchstart', this.touchstart, {passive: false});
        DOM.removeEventListener(element, 'touchmove', this.touchmove);
        DOM.removeEventListener(element, 'touchend', this.touchend);
        DOM.removeEventListener(window, 'touchmove', this.touchmove, {passive: false});
        DOM.removeEventListener(window, 'touchend', this.touchend);
        DOM.removeEventListener(element, 'touchcancel', this.reset);
        this.offTemp();
    }

    offTemp() {
        DOM.enableDrag();
        DOM.removeEventListener(window, 'mousemove', this.mousemove);
        DOM.removeEventListener(window, 'mouseup', this.mouseup);
        DOM.removeEventListener(window, 'touchmove', this.touchmove, {passive: false});
        DOM.removeEventListener(window, 'touchend', this.touchend);
    }

    mousedown(e: MouseEvent) {
        this.startMouse(extend({}, e, {
            ctrlKey: true,
            preventDefault: () => e.preventDefault()
        }), DOM.mousePos(this.element, e));
        DOM.addEventListener(window, 'mousemove', this.mousemove);
        DOM.addEventListener(window, 'mouseup', this.mouseup);
    }

    mousemove(e: MouseEvent) {
        this.moveMouse(e, DOM.mousePos(this.element, e));
    }

    mouseup(e: MouseEvent) {
        this.mouseRotate.dragEnd(e);
        if (this.mousePitch) this.mousePitch.dragEnd(e);
        this.offTemp();
    }

    touchstart(e: TouchEvent) {
        if (e.targetTouches.length !== 1) {
            this.reset();
        } else {
            this._startPos = this._lastPos = DOM.touchPos(this.element, e.targetTouches)[0];
            this.startTouch(e, this._startPos);
            DOM.addEventListener(window, 'touchmove', this.touchmove, {passive: false});
            DOM.addEventListener(window, 'touchend', this.touchend);
        }
    }

    touchmove(e: TouchEvent) {
        if (e.targetTouches.length !== 1) {
            this.reset();
        } else {
            this._lastPos = DOM.touchPos(this.element, e.targetTouches)[0];
            this.moveTouch(e, this._lastPos);
        }
    }

    touchend(e: TouchEvent) {
        if (e.targetTouches.length === 0 &&
            this._startPos &&
            this._lastPos &&
            this._startPos.dist(this._lastPos) < this._clickTolerance) {
            this.element.click();
        }
        delete this._startPos;
        delete this._lastPos;
        this.offTemp();
    }

    reset() {
        this.mouseRotate.reset();
        if (this.mousePitch) this.mousePitch.reset();
        this.touchRotate.reset();
        if (this.touchPitch) this.touchPitch.reset();
        delete this._startPos;
        delete this._lastPos;
        this.offTemp();
    }
}

export default NavControl;
