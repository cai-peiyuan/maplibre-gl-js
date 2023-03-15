define(['./shared'], (function (performance) { 'use strict';

function stringify(obj) {
    const type = typeof obj;
    if (type === 'number' || type === 'boolean' || type === 'string' || obj === undefined || obj === null)
        return JSON.stringify(obj);
    if (Array.isArray(obj)) {
        let str = '[';
        for (const val of obj) {
            str += `${stringify(val)},`;
        }
        return `${str}]`;
    }
    const keys = Object.keys(obj).sort();
    let str = '{';
    for (let i = 0; i < keys.length; i++) {
        str += `${JSON.stringify(keys[i])}:${stringify(obj[keys[i]])},`;
    }
    return `${str}}`;
}
function getKey(layer) {
    let key = '';
    for (const k of performance.refProperties) {
        key += `/${stringify(layer[k])}`;
    }
    return key;
}
/**
 * Given an array of layers, return an array of arrays of layers where all
 * layers in each group have identical layout-affecting properties. These
 * are the properties that were formerly used by explicit `ref` mechanism
 * for layers: 'type', 'source', 'source-layer', 'minzoom', 'maxzoom',
 * 'filter', and 'layout'.
 *
 * The input is not modified. The output layers are references to the
 * input layers.
 *
 * @private
 * @param {Array<Layer>} layers
 * @param {Object} [cachedKeys] - an object to keep already calculated keys.
 * @returns {Array<Array<Layer>>}
 */
function groupByLayout(layers, cachedKeys) {
    const groups = {};
    for (let i = 0; i < layers.length; i++) {
        const k = (cachedKeys && cachedKeys[layers[i].id]) || getKey(layers[i]);
        // update the cache if there is one
        if (cachedKeys)
            cachedKeys[layers[i].id] = k;
        let group = groups[k];
        if (!group) {
            group = groups[k] = [];
        }
        group.push(layers[i]);
    }
    const result = [];
    for (const k in groups) {
        result.push(groups[k]);
    }
    return result;
}

class StyleLayerIndex {
    constructor(layerConfigs) {
        this.keyCache = {};
        if (layerConfigs) {
            this.replace(layerConfigs);
        }
    }
    replace(layerConfigs) {
        this._layerConfigs = {};
        this._layers = {};
        this.update(layerConfigs, []);
    }
    update(layerConfigs, removedIds) {
        for (const layerConfig of layerConfigs) {
            this._layerConfigs[layerConfig.id] = layerConfig;
            const layer = this._layers[layerConfig.id] = performance.createStyleLayer(layerConfig);
            layer._featureFilter = performance.createFilter(layer.filter);
            if (this.keyCache[layerConfig.id])
                delete this.keyCache[layerConfig.id];
        }
        for (const id of removedIds) {
            delete this.keyCache[id];
            delete this._layerConfigs[id];
            delete this._layers[id];
        }
        this.familiesBySource = {};
        const groups = groupByLayout(Object.values(this._layerConfigs), this.keyCache);
        for (const layerConfigs of groups) {
            const layers = layerConfigs.map((layerConfig) => this._layers[layerConfig.id]);
            const layer = layers[0];
            if (layer.visibility === 'none') {
                continue;
            }
            const sourceId = layer.source || '';
            let sourceGroup = this.familiesBySource[sourceId];
            if (!sourceGroup) {
                sourceGroup = this.familiesBySource[sourceId] = {};
            }
            const sourceLayerId = layer.sourceLayer || '_geojsonTileLayer';
            let sourceLayerFamilies = sourceGroup[sourceLayerId];
            if (!sourceLayerFamilies) {
                sourceLayerFamilies = sourceGroup[sourceLayerId] = [];
            }
            sourceLayerFamilies.push(layers);
        }
    }
}

const padding = 1;
class GlyphAtlas {
    constructor(stacks) {
        const positions = {};
        const bins = [];
        for (const stack in stacks) {
            const glyphs = stacks[stack];
            const stackPositions = positions[stack] = {};
            for (const id in glyphs) {
                const src = glyphs[+id];
                if (!src || src.bitmap.width === 0 || src.bitmap.height === 0)
                    continue;
                const bin = {
                    x: 0,
                    y: 0,
                    w: src.bitmap.width + 2 * padding,
                    h: src.bitmap.height + 2 * padding
                };
                bins.push(bin);
                stackPositions[id] = { rect: bin, metrics: src.metrics };
            }
        }
        const { w, h } = performance.potpack(bins);
        const image = new performance.AlphaImage({ width: w || 1, height: h || 1 });
        for (const stack in stacks) {
            const glyphs = stacks[stack];
            for (const id in glyphs) {
                const src = glyphs[+id];
                if (!src || src.bitmap.width === 0 || src.bitmap.height === 0)
                    continue;
                const bin = positions[stack][id].rect;
                performance.AlphaImage.copy(src.bitmap, image, { x: 0, y: 0 }, { x: bin.x + padding, y: bin.y + padding }, src.bitmap);
            }
        }
        this.image = image;
        this.positions = positions;
    }
}
performance.register('GlyphAtlas', GlyphAtlas);

class WorkerTile {
    constructor(params) {
        this.tileID = new performance.OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.showCollisionBoxes = params.showCollisionBoxes;
        this.collectResourceTiming = !!params.collectResourceTiming;
        this.returnDependencies = !!params.returnDependencies;
        this.promoteId = params.promoteId;
    }
    parse(data, layerIndex, availableImages, actor, callback) {
        this.status = 'parsing';
        this.data = data;
        this.collisionBoxArray = new performance.CollisionBoxArray();
        const sourceLayerCoder = new performance.DictionaryCoder(Object.keys(data.layers).sort());
        const featureIndex = new performance.FeatureIndex(this.tileID, this.promoteId);
        featureIndex.bucketLayerIDs = [];
        const buckets = {};
        const options = {
            featureIndex,
            iconDependencies: {},
            patternDependencies: {},
            glyphDependencies: {},
            availableImages
        };
        const layerFamilies = layerIndex.familiesBySource[this.source];
        for (const sourceLayerId in layerFamilies) {
            const sourceLayer = data.layers[sourceLayerId];
            if (!sourceLayer) {
                continue;
            }
            if (sourceLayer.version === 1) {
                performance.warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" ` +
                    'does not use vector tile spec v2 and therefore may have some rendering errors.');
            }
            const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
            const features = [];
            for (let index = 0; index < sourceLayer.length; index++) {
                const feature = sourceLayer.feature(index);
                const id = featureIndex.getId(feature, sourceLayerId);
                features.push({ feature, id, index, sourceLayerIndex });
            }
            for (const family of layerFamilies[sourceLayerId]) {
                const layer = family[0];
                if (layer.source !== this.source) {
                    performance.warnOnce(`layer.source = ${layer.source} does not equal this.source = ${this.source}`);
                }
                if (layer.minzoom && this.zoom < Math.floor(layer.minzoom))
                    continue;
                if (layer.maxzoom && this.zoom >= layer.maxzoom)
                    continue;
                if (layer.visibility === 'none')
                    continue;
                recalculateLayers(family, this.zoom, availableImages);
                const bucket = buckets[layer.id] = layer.createBucket({
                    index: featureIndex.bucketLayerIDs.length,
                    layers: family,
                    zoom: this.zoom,
                    pixelRatio: this.pixelRatio,
                    overscaling: this.overscaling,
                    collisionBoxArray: this.collisionBoxArray,
                    sourceLayerIndex,
                    sourceID: this.source
                });
                bucket.populate(features, options, this.tileID.canonical);
                featureIndex.bucketLayerIDs.push(family.map((l) => l.id));
            }
        }
        let error;
        let glyphMap;
        let iconMap;
        let patternMap;
        const stacks = performance.mapObject(options.glyphDependencies, (glyphs) => Object.keys(glyphs).map(Number));
        if (Object.keys(stacks).length) {
            actor.send('getGlyphs', { uid: this.uid, stacks, source: this.source, tileID: this.tileID, type: 'glyphs' }, (err, result) => {
                if (!error) {
                    error = err;
                    glyphMap = result;
                    maybePrepare.call(this);
                }
            });
        }
        else {
            glyphMap = {};
        }
        const icons = Object.keys(options.iconDependencies);
        if (icons.length) {
            actor.send('getImages', { icons, source: this.source, tileID: this.tileID, type: 'icons' }, (err, result) => {
                if (!error) {
                    error = err;
                    iconMap = result;
                    maybePrepare.call(this);
                }
            });
        }
        else {
            iconMap = {};
        }
        const patterns = Object.keys(options.patternDependencies);
        if (patterns.length) {
            actor.send('getImages', { icons: patterns, source: this.source, tileID: this.tileID, type: 'patterns' }, (err, result) => {
                if (!error) {
                    error = err;
                    patternMap = result;
                    maybePrepare.call(this);
                }
            });
        }
        else {
            patternMap = {};
        }
        maybePrepare.call(this);
        function maybePrepare() {
            if (error) {
                return callback(error);
            }
            else if (glyphMap && iconMap && patternMap) {
                const glyphAtlas = new GlyphAtlas(glyphMap);
                const imageAtlas = new performance.ImageAtlas(iconMap, patternMap);
                for (const key in buckets) {
                    const bucket = buckets[key];
                    if (bucket instanceof performance.SymbolBucket) {
                        recalculateLayers(bucket.layers, this.zoom, availableImages);
                        performance.performSymbolLayout({
                            bucket,
                            glyphMap,
                            glyphPositions: glyphAtlas.positions,
                            imageMap: iconMap,
                            imagePositions: imageAtlas.iconPositions,
                            showCollisionBoxes: this.showCollisionBoxes,
                            canonical: this.tileID.canonical
                        });
                    }
                    else if (bucket.hasPattern &&
                        (bucket instanceof performance.LineBucket ||
                            bucket instanceof performance.FillBucket ||
                            bucket instanceof performance.FillExtrusionBucket)) {
                        recalculateLayers(bucket.layers, this.zoom, availableImages);
                        bucket.addFeatures(options, this.tileID.canonical, imageAtlas.patternPositions);
                    }
                }
                this.status = 'done';
                callback(null, {
                    buckets: Object.values(buckets).filter(b => !b.isEmpty()),
                    featureIndex,
                    collisionBoxArray: this.collisionBoxArray,
                    glyphAtlasImage: glyphAtlas.image,
                    imageAtlas,
                    // Only used for benchmarking:
                    glyphMap: this.returnDependencies ? glyphMap : null,
                    iconMap: this.returnDependencies ? iconMap : null,
                    glyphPositions: this.returnDependencies ? glyphAtlas.positions : null
                });
            }
        }
    }
}
function recalculateLayers(layers, zoom, availableImages) {
    // Layers are shared and may have been used by a WorkerTile with a different zoom.
    const parameters = new performance.EvaluationParameters(zoom);
    for (const layer of layers) {
        layer.recalculate(parameters, availableImages);
    }
}

/**
 * @private
 */
function loadVectorTile(params, callback) {
    const request = performance.getArrayBuffer(params.request, (err, data, cacheControl, expires) => {
        if (err) {
            callback(err);
        }
        else if (data) {
            callback(null, {
                vectorTile: new performance.vectorTile.VectorTile(new performance.pbf(data)),
                rawData: data,
                cacheControl,
                expires
            });
        }
    });
    return () => {
        request.cancel();
        callback();
    };
}
/**
 * The {@link WorkerSource} implementation that supports {@link VectorTileSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory VectorTile
 * representation.  To do so, create it with
 * `new VectorTileWorkerSource(actor, styleLayers, customLoadVectorDataFunction)`.
 *
 * @private
 */
class VectorTileWorkerSource {
    /**
     * @param [loadVectorData] Optional method for custom loading of a VectorTile
     * object based on parameters passed from the main-thread Source. See
     * {@link VectorTileWorkerSource#loadTile}. The default implementation simply
     * loads the pbf at `params.url`.
     * @private
     */
    constructor(actor, layerIndex, availableImages, loadVectorData) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.loadVectorData = loadVectorData || loadVectorTile;
        this.loading = {};
        this.loaded = {};
    }
    /**
     * Implements {@link WorkerSource#loadTile}. Delegates to
     * {@link VectorTileWorkerSource#loadVectorData} (which by default expects
     * a `params.url` property) for fetching and producing a VectorTile object.
     * @private
     */
    loadTile(params, callback) {
        const uid = params.uid;
        if (!this.loading)
            this.loading = {};
        const perf = (params && params.request && params.request.collectResourceTiming) ?
            new performance.RequestPerformance(params.request) : false;
        const workerTile = this.loading[uid] = new WorkerTile(params);
        workerTile.abort = this.loadVectorData(params, (err, response) => {
            delete this.loading[uid];
            if (err || !response) {
                workerTile.status = 'done';
                this.loaded[uid] = workerTile;
                return callback(err);
            }
            const rawTileData = response.rawData;
            const cacheControl = {};
            if (response.expires)
                cacheControl.expires = response.expires;
            if (response.cacheControl)
                cacheControl.cacheControl = response.cacheControl;
            const resourceTiming = {};
            if (perf) {
                const resourceTimingData = perf.finish();
                // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                // late evaluation in the main thread causes TypeError: illegal invocation
                if (resourceTimingData)
                    resourceTiming.resourceTiming = JSON.parse(JSON.stringify(resourceTimingData));
            }
            workerTile.vectorTile = response.vectorTile;
            workerTile.parse(response.vectorTile, this.layerIndex, this.availableImages, this.actor, (err, result) => {
                if (err || !result)
                    return callback(err);
                // Transferring a copy of rawTileData because the worker needs to retain its copy.
                callback(null, performance.extend({ rawTileData: rawTileData.slice(0) }, result, cacheControl, resourceTiming));
            });
            this.loaded = this.loaded || {};
            this.loaded[uid] = workerTile;
        });
    }
    /**
     * Implements {@link WorkerSource#reloadTile}.
     * @private
     */
    reloadTile(params, callback) {
        const loaded = this.loaded, uid = params.uid, vtSource = this;
        if (loaded && loaded[uid]) {
            const workerTile = loaded[uid];
            workerTile.showCollisionBoxes = params.showCollisionBoxes;
            const done = (err, data) => {
                const reloadCallback = workerTile.reloadCallback;
                if (reloadCallback) {
                    delete workerTile.reloadCallback;
                    workerTile.parse(workerTile.vectorTile, vtSource.layerIndex, this.availableImages, vtSource.actor, reloadCallback);
                }
                callback(err, data);
            };
            if (workerTile.status === 'parsing') {
                workerTile.reloadCallback = done;
            }
            else if (workerTile.status === 'done') {
                // if there was no vector tile data on the initial load, don't try and re-parse tile
                if (workerTile.vectorTile) {
                    workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.actor, done);
                }
                else {
                    done();
                }
            }
        }
    }
    /**
     * Implements {@link WorkerSource#abortTile}.
     *
     * @param params
     * @param params.uid The UID for this tile.
     * @private
     */
    abortTile(params, callback) {
        const loading = this.loading, uid = params.uid;
        if (loading && loading[uid] && loading[uid].abort) {
            loading[uid].abort();
            delete loading[uid];
        }
        callback();
    }
    /**
     * Implements {@link WorkerSource#removeTile}.
     *
     * @param params
     * @param params.uid The UID for this tile.
     * @private
     */
    removeTile(params, callback) {
        const loaded = this.loaded, uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
        callback();
    }
}

class RasterDEMTileWorkerSource {
    constructor() {
        this.loaded = {};
    }
    loadTile(params, callback) {
        const { uid, encoding, rawImageData } = params;
        // Main thread will transfer ImageBitmap if offscreen decode with OffscreenCanvas is supported, else it will transfer an already decoded image.
        const imagePixels = performance.isImageBitmap(rawImageData) ? this.getImageData(rawImageData) : rawImageData;
        const dem = new performance.DEMData(uid, imagePixels, encoding);
        this.loaded = this.loaded || {};
        this.loaded[uid] = dem;
        callback(null, dem);
    }
    getImageData(imgBitmap) {
        // Lazily initialize OffscreenCanvas
        if (!this.offscreenCanvas || !this.offscreenCanvasContext) {
            // Dem tiles are typically 256x256
            this.offscreenCanvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
            this.offscreenCanvasContext = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        }
        this.offscreenCanvas.width = imgBitmap.width;
        this.offscreenCanvas.height = imgBitmap.height;
        this.offscreenCanvasContext.drawImage(imgBitmap, 0, 0, imgBitmap.width, imgBitmap.height);
        // Insert an additional 1px padding around the image to allow backfilling for neighboring data.
        const imgData = this.offscreenCanvasContext.getImageData(-1, -1, imgBitmap.width + 2, imgBitmap.height + 2);
        this.offscreenCanvasContext.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
        return new performance.RGBAImage({ width: imgData.width, height: imgData.height }, imgData.data);
    }
    removeTile(params) {
        const loaded = this.loaded, uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
    }
}

var geojsonRewind = rewind;

function rewind(gj, outer) {
    var type = gj && gj.type, i;

    if (type === 'FeatureCollection') {
        for (i = 0; i < gj.features.length; i++) rewind(gj.features[i], outer);

    } else if (type === 'GeometryCollection') {
        for (i = 0; i < gj.geometries.length; i++) rewind(gj.geometries[i], outer);

    } else if (type === 'Feature') {
        rewind(gj.geometry, outer);

    } else if (type === 'Polygon') {
        rewindRings(gj.coordinates, outer);

    } else if (type === 'MultiPolygon') {
        for (i = 0; i < gj.coordinates.length; i++) rewindRings(gj.coordinates[i], outer);
    }

    return gj;
}

function rewindRings(rings, outer) {
    if (rings.length === 0) return;

    rewindRing(rings[0], outer);
    for (var i = 1; i < rings.length; i++) {
        rewindRing(rings[i], !outer);
    }
}

function rewindRing(ring, dir) {
    var area = 0, err = 0;
    for (var i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
        var k = (ring[i][0] - ring[j][0]) * (ring[j][1] + ring[i][1]);
        var m = area + k;
        err += Math.abs(area) >= Math.abs(k) ? area - m + k : k - m + area;
        area = m;
    }
    if (area + err >= 0 !== !!dir) ring.reverse();
}

const toGeoJSON = performance.vectorTile.VectorTileFeature.prototype.toGeoJSON;
let FeatureWrapper$1 = class FeatureWrapper {
    constructor(feature) {
        this._feature = feature;
        this.extent = performance.EXTENT;
        this.type = feature.type;
        this.properties = feature.tags;
        // If the feature has a top-level `id` property, copy it over, but only
        // if it can be coerced to an integer, because this wrapper is used for
        // serializing geojson feature data into vector tile PBF data, and the
        // vector tile spec only supports integer values for feature ids --
        // allowing non-integer values here results in a non-compliant PBF
        // that causes an exception when it is parsed with vector-tile-js
        if ('id' in feature && !isNaN(feature.id)) {
            this.id = parseInt(feature.id, 10);
        }
    }
    loadGeometry() {
        if (this._feature.type === 1) {
            const geometry = [];
            for (const point of this._feature.geometry) {
                geometry.push([new performance.pointGeometry(point[0], point[1])]);
            }
            return geometry;
        }
        else {
            const geometry = [];
            for (const ring of this._feature.geometry) {
                const newRing = [];
                for (const point of ring) {
                    newRing.push(new performance.pointGeometry(point[0], point[1]));
                }
                geometry.push(newRing);
            }
            return geometry;
        }
    }
    toGeoJSON(x, y, z) {
        return toGeoJSON.call(this, x, y, z);
    }
};
let GeoJSONWrapper$2 = class GeoJSONWrapper {
    constructor(features) {
        this.layers = { '_geojsonTileLayer': this };
        this.name = '_geojsonTileLayer';
        this.extent = performance.EXTENT;
        this.length = features.length;
        this._features = features;
    }
    feature(i) {
        return new FeatureWrapper$1(this._features[i]);
    }
};

var vtPbfExports = {};
var vtPbf = {
  get exports(){ return vtPbfExports; },
  set exports(v){ vtPbfExports = v; },
};

'use strict';

var Point = performance.pointGeometry;
var VectorTileFeature = performance.vectorTile.VectorTileFeature;

var geojson_wrapper = GeoJSONWrapper$1;

// conform to vectortile api
function GeoJSONWrapper$1 (features, options) {
  this.options = options || {};
  this.features = features;
  this.length = features.length;
}

GeoJSONWrapper$1.prototype.feature = function (i) {
  return new FeatureWrapper(this.features[i], this.options.extent)
};

function FeatureWrapper (feature, extent) {
  this.id = typeof feature.id === 'number' ? feature.id : undefined;
  this.type = feature.type;
  this.rawGeometry = feature.type === 1 ? [feature.geometry] : feature.geometry;
  this.properties = feature.tags;
  this.extent = extent || 4096;
}

FeatureWrapper.prototype.loadGeometry = function () {
  var rings = this.rawGeometry;
  this.geometry = [];

  for (var i = 0; i < rings.length; i++) {
    var ring = rings[i];
    var newRing = [];
    for (var j = 0; j < ring.length; j++) {
      newRing.push(new Point(ring[j][0], ring[j][1]));
    }
    this.geometry.push(newRing);
  }
  return this.geometry
};

FeatureWrapper.prototype.bbox = function () {
  if (!this.geometry) this.loadGeometry();

  var rings = this.geometry;
  var x1 = Infinity;
  var x2 = -Infinity;
  var y1 = Infinity;
  var y2 = -Infinity;

  for (var i = 0; i < rings.length; i++) {
    var ring = rings[i];

    for (var j = 0; j < ring.length; j++) {
      var coord = ring[j];

      x1 = Math.min(x1, coord.x);
      x2 = Math.max(x2, coord.x);
      y1 = Math.min(y1, coord.y);
      y2 = Math.max(y2, coord.y);
    }
  }

  return [x1, y1, x2, y2]
};

FeatureWrapper.prototype.toGeoJSON = VectorTileFeature.prototype.toGeoJSON;

var Pbf = performance.pbf;
var GeoJSONWrapper = geojson_wrapper;

vtPbf.exports = fromVectorTileJs;
var fromVectorTileJs_1 = vtPbfExports.fromVectorTileJs = fromVectorTileJs;
var fromGeojsonVt_1 = vtPbfExports.fromGeojsonVt = fromGeojsonVt;
var GeoJSONWrapper_1 = vtPbfExports.GeoJSONWrapper = GeoJSONWrapper;

/**
 * Serialize a vector-tile-js-created tile to pbf
 *
 * @param {Object} tile
 * @return {Buffer} uncompressed, pbf-serialized tile data
 */
function fromVectorTileJs (tile) {
  var out = new Pbf();
  writeTile(tile, out);
  return out.finish()
}

/**
 * Serialized a geojson-vt-created tile to pbf.
 *
 * @param {Object} layers - An object mapping layer names to geojson-vt-created vector tile objects
 * @param {Object} [options] - An object specifying the vector-tile specification version and extent that were used to create `layers`.
 * @param {Number} [options.version=1] - Version of vector-tile spec used
 * @param {Number} [options.extent=4096] - Extent of the vector tile
 * @return {Buffer} uncompressed, pbf-serialized tile data
 */
function fromGeojsonVt (layers, options) {
  options = options || {};
  var l = {};
  for (var k in layers) {
    l[k] = new GeoJSONWrapper(layers[k].features, options);
    l[k].name = k;
    l[k].version = options.version;
    l[k].extent = options.extent;
  }
  return fromVectorTileJs({ layers: l })
}

function writeTile (tile, pbf) {
  for (var key in tile.layers) {
    pbf.writeMessage(3, writeLayer, tile.layers[key]);
  }
}

function writeLayer (layer, pbf) {
  pbf.writeVarintField(15, layer.version || 1);
  pbf.writeStringField(1, layer.name || '');
  pbf.writeVarintField(5, layer.extent || 4096);

  var i;
  var context = {
    keys: [],
    values: [],
    keycache: {},
    valuecache: {}
  };

  for (i = 0; i < layer.length; i++) {
    context.feature = layer.feature(i);
    pbf.writeMessage(2, writeFeature, context);
  }

  var keys = context.keys;
  for (i = 0; i < keys.length; i++) {
    pbf.writeStringField(3, keys[i]);
  }

  var values = context.values;
  for (i = 0; i < values.length; i++) {
    pbf.writeMessage(4, writeValue, values[i]);
  }
}

function writeFeature (context, pbf) {
  var feature = context.feature;

  if (feature.id !== undefined) {
    pbf.writeVarintField(1, feature.id);
  }

  pbf.writeMessage(2, writeProperties, context);
  pbf.writeVarintField(3, feature.type);
  pbf.writeMessage(4, writeGeometry, feature);
}

function writeProperties (context, pbf) {
  var feature = context.feature;
  var keys = context.keys;
  var values = context.values;
  var keycache = context.keycache;
  var valuecache = context.valuecache;

  for (var key in feature.properties) {
    var value = feature.properties[key];

    var keyIndex = keycache[key];
    if (value === null) continue // don't encode null value properties

    if (typeof keyIndex === 'undefined') {
      keys.push(key);
      keyIndex = keys.length - 1;
      keycache[key] = keyIndex;
    }
    pbf.writeVarint(keyIndex);

    var type = typeof value;
    if (type !== 'string' && type !== 'boolean' && type !== 'number') {
      value = JSON.stringify(value);
    }
    var valueKey = type + ':' + value;
    var valueIndex = valuecache[valueKey];
    if (typeof valueIndex === 'undefined') {
      values.push(value);
      valueIndex = values.length - 1;
      valuecache[valueKey] = valueIndex;
    }
    pbf.writeVarint(valueIndex);
  }
}

function command (cmd, length) {
  return (length << 3) + (cmd & 0x7)
}

function zigzag (num) {
  return (num << 1) ^ (num >> 31)
}

function writeGeometry (feature, pbf) {
  var geometry = feature.loadGeometry();
  var type = feature.type;
  var x = 0;
  var y = 0;
  var rings = geometry.length;
  for (var r = 0; r < rings; r++) {
    var ring = geometry[r];
    var count = 1;
    if (type === 1) {
      count = ring.length;
    }
    pbf.writeVarint(command(1, count)); // moveto
    // do not write polygon closing path as lineto
    var lineCount = type === 3 ? ring.length - 1 : ring.length;
    for (var i = 0; i < lineCount; i++) {
      if (i === 1 && type !== 1) {
        pbf.writeVarint(command(2, lineCount - 1)); // lineto
      }
      var dx = ring[i].x - x;
      var dy = ring[i].y - y;
      pbf.writeVarint(zigzag(dx));
      pbf.writeVarint(zigzag(dy));
      x += dx;
      y += dy;
    }
    if (type === 3) {
      pbf.writeVarint(command(7, 1)); // closepath
    }
  }
}

function writeValue (value, pbf) {
  var type = typeof value;
  if (type === 'string') {
    pbf.writeStringField(1, value);
  } else if (type === 'boolean') {
    pbf.writeBooleanField(7, value);
  } else if (type === 'number') {
    if (value % 1 !== 0) {
      pbf.writeDoubleField(3, value);
    } else if (value < 0) {
      pbf.writeSVarintField(6, value);
    } else {
      pbf.writeVarintField(5, value);
    }
  }
}

const defaultOptions = {
    minZoom: 0,   // min zoom to generate clusters on
    maxZoom: 16,  // max zoom level to cluster the points on
    minPoints: 2, // minimum points to form a cluster
    radius: 40,   // cluster radius in pixels
    extent: 512,  // tile extent (radius is calculated relative to it)
    nodeSize: 64, // size of the KD-tree leaf node, affects performance
    log: false,   // whether to log timing info

    // whether to generate numeric ids for input features (in vector tiles)
    generateId: false,

    // a reduce function for calculating custom cluster properties
    reduce: null, // (accumulated, props) => { accumulated.sum += props.sum; }

    // properties to use for individual points when running the reducer
    map: props => props // props => ({sum: props.my_value})
};

const fround = Math.fround || (tmp => ((x) => { tmp[0] = +x; return tmp[0]; }))(new Float32Array(1));

class Supercluster {
    constructor(options) {
        this.options = extend(Object.create(defaultOptions), options);
        this.trees = new Array(this.options.maxZoom + 1);
    }

    load(points) {
        const {log, minZoom, maxZoom, nodeSize} = this.options;

        if (log) console.time('total time');

        const timerId = `prepare ${  points.length  } points`;
        if (log) console.time(timerId);

        this.points = points;

        // generate a cluster object for each point and index input points into a KD-tree
        let clusters = [];
        for (let i = 0; i < points.length; i++) {
            if (!points[i].geometry) continue;
            clusters.push(createPointCluster(points[i], i));
        }
        this.trees[maxZoom + 1] = new performance.KDBush(clusters, getX, getY, nodeSize, Float32Array);

        if (log) console.timeEnd(timerId);

        // cluster points on max zoom, then cluster the results on previous zoom, etc.;
        // results in a cluster hierarchy across zoom levels
        for (let z = maxZoom; z >= minZoom; z--) {
            const now = +Date.now();

            // create a new set of clusters for the zoom and index them with a KD-tree
            clusters = this._cluster(clusters, z);
            this.trees[z] = new performance.KDBush(clusters, getX, getY, nodeSize, Float32Array);

            if (log) console.log('z%d: %d clusters in %dms', z, clusters.length, +Date.now() - now);
        }

        if (log) console.timeEnd('total time');

        return this;
    }

    getClusters(bbox, zoom) {
        let minLng = ((bbox[0] + 180) % 360 + 360) % 360 - 180;
        const minLat = Math.max(-90, Math.min(90, bbox[1]));
        let maxLng = bbox[2] === 180 ? 180 : ((bbox[2] + 180) % 360 + 360) % 360 - 180;
        const maxLat = Math.max(-90, Math.min(90, bbox[3]));

        if (bbox[2] - bbox[0] >= 360) {
            minLng = -180;
            maxLng = 180;
        } else if (minLng > maxLng) {
            const easternHem = this.getClusters([minLng, minLat, 180, maxLat], zoom);
            const westernHem = this.getClusters([-180, minLat, maxLng, maxLat], zoom);
            return easternHem.concat(westernHem);
        }

        const tree = this.trees[this._limitZoom(zoom)];
        const ids = tree.range(lngX(minLng), latY(maxLat), lngX(maxLng), latY(minLat));
        const clusters = [];
        for (const id of ids) {
            const c = tree.points[id];
            clusters.push(c.numPoints ? getClusterJSON(c) : this.points[c.index]);
        }
        return clusters;
    }

    getChildren(clusterId) {
        const originId = this._getOriginId(clusterId);
        const originZoom = this._getOriginZoom(clusterId);
        const errorMsg = 'No cluster with the specified id.';

        const index = this.trees[originZoom];
        if (!index) throw new Error(errorMsg);

        const origin = index.points[originId];
        if (!origin) throw new Error(errorMsg);

        const r = this.options.radius / (this.options.extent * Math.pow(2, originZoom - 1));
        const ids = index.within(origin.x, origin.y, r);
        const children = [];
        for (const id of ids) {
            const c = index.points[id];
            if (c.parentId === clusterId) {
                children.push(c.numPoints ? getClusterJSON(c) : this.points[c.index]);
            }
        }

        if (children.length === 0) throw new Error(errorMsg);

        return children;
    }

    getLeaves(clusterId, limit, offset) {
        limit = limit || 10;
        offset = offset || 0;

        const leaves = [];
        this._appendLeaves(leaves, clusterId, limit, offset, 0);

        return leaves;
    }

    getTile(z, x, y) {
        const tree = this.trees[this._limitZoom(z)];
        const z2 = Math.pow(2, z);
        const {extent, radius} = this.options;
        const p = radius / extent;
        const top = (y - p) / z2;
        const bottom = (y + 1 + p) / z2;

        const tile = {
            features: []
        };

        this._addTileFeatures(
            tree.range((x - p) / z2, top, (x + 1 + p) / z2, bottom),
            tree.points, x, y, z2, tile);

        if (x === 0) {
            this._addTileFeatures(
                tree.range(1 - p / z2, top, 1, bottom),
                tree.points, z2, y, z2, tile);
        }
        if (x === z2 - 1) {
            this._addTileFeatures(
                tree.range(0, top, p / z2, bottom),
                tree.points, -1, y, z2, tile);
        }

        return tile.features.length ? tile : null;
    }

    getClusterExpansionZoom(clusterId) {
        let expansionZoom = this._getOriginZoom(clusterId) - 1;
        while (expansionZoom <= this.options.maxZoom) {
            const children = this.getChildren(clusterId);
            expansionZoom++;
            if (children.length !== 1) break;
            clusterId = children[0].properties.cluster_id;
        }
        return expansionZoom;
    }

    _appendLeaves(result, clusterId, limit, offset, skipped) {
        const children = this.getChildren(clusterId);

        for (const child of children) {
            const props = child.properties;

            if (props && props.cluster) {
                if (skipped + props.point_count <= offset) {
                    // skip the whole cluster
                    skipped += props.point_count;
                } else {
                    // enter the cluster
                    skipped = this._appendLeaves(result, props.cluster_id, limit, offset, skipped);
                    // exit the cluster
                }
            } else if (skipped < offset) {
                // skip a single point
                skipped++;
            } else {
                // add a single point
                result.push(child);
            }
            if (result.length === limit) break;
        }

        return skipped;
    }

    _addTileFeatures(ids, points, x, y, z2, tile) {
        for (const i of ids) {
            const c = points[i];
            const isCluster = c.numPoints;

            let tags, px, py;
            if (isCluster) {
                tags = getClusterProperties(c);
                px = c.x;
                py = c.y;
            } else {
                const p = this.points[c.index];
                tags = p.properties;
                px = lngX(p.geometry.coordinates[0]);
                py = latY(p.geometry.coordinates[1]);
            }

            const f = {
                type: 1,
                geometry: [[
                    Math.round(this.options.extent * (px * z2 - x)),
                    Math.round(this.options.extent * (py * z2 - y))
                ]],
                tags
            };

            // assign id
            let id;
            if (isCluster) {
                id = c.id;
            } else if (this.options.generateId) {
                // optionally generate id
                id = c.index;
            } else if (this.points[c.index].id) {
                // keep id if already assigned
                id = this.points[c.index].id;
            }

            if (id !== undefined) f.id = id;

            tile.features.push(f);
        }
    }

    _limitZoom(z) {
        return Math.max(this.options.minZoom, Math.min(Math.floor(+z), this.options.maxZoom + 1));
    }

    _cluster(points, zoom) {
        const clusters = [];
        const {radius, extent, reduce, minPoints} = this.options;
        const r = radius / (extent * Math.pow(2, zoom));

        // loop through each point
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            // if we've already visited the point at this zoom level, skip it
            if (p.zoom <= zoom) continue;
            p.zoom = zoom;

            // find all nearby points
            const tree = this.trees[zoom + 1];
            const neighborIds = tree.within(p.x, p.y, r);

            const numPointsOrigin = p.numPoints || 1;
            let numPoints = numPointsOrigin;

            // count the number of points in a potential cluster
            for (const neighborId of neighborIds) {
                const b = tree.points[neighborId];
                // filter out neighbors that are already processed
                if (b.zoom > zoom) numPoints += b.numPoints || 1;
            }

            // if there were neighbors to merge, and there are enough points to form a cluster
            if (numPoints > numPointsOrigin && numPoints >= minPoints) {
                let wx = p.x * numPointsOrigin;
                let wy = p.y * numPointsOrigin;

                let clusterProperties = reduce && numPointsOrigin > 1 ? this._map(p, true) : null;

                // encode both zoom and point index on which the cluster originated -- offset by total length of features
                const id = (i << 5) + (zoom + 1) + this.points.length;

                for (const neighborId of neighborIds) {
                    const b = tree.points[neighborId];

                    if (b.zoom <= zoom) continue;
                    b.zoom = zoom; // save the zoom (so it doesn't get processed twice)

                    const numPoints2 = b.numPoints || 1;
                    wx += b.x * numPoints2; // accumulate coordinates for calculating weighted center
                    wy += b.y * numPoints2;

                    b.parentId = id;

                    if (reduce) {
                        if (!clusterProperties) clusterProperties = this._map(p, true);
                        reduce(clusterProperties, this._map(b));
                    }
                }

                p.parentId = id;
                clusters.push(createCluster(wx / numPoints, wy / numPoints, id, numPoints, clusterProperties));

            } else { // left points as unclustered
                clusters.push(p);

                if (numPoints > 1) {
                    for (const neighborId of neighborIds) {
                        const b = tree.points[neighborId];
                        if (b.zoom <= zoom) continue;
                        b.zoom = zoom;
                        clusters.push(b);
                    }
                }
            }
        }

        return clusters;
    }

    // get index of the point from which the cluster originated
    _getOriginId(clusterId) {
        return (clusterId - this.points.length) >> 5;
    }

    // get zoom of the point from which the cluster originated
    _getOriginZoom(clusterId) {
        return (clusterId - this.points.length) % 32;
    }

    _map(point, clone) {
        if (point.numPoints) {
            return clone ? extend({}, point.properties) : point.properties;
        }
        const original = this.points[point.index].properties;
        const result = this.options.map(original);
        return clone && result === original ? extend({}, result) : result;
    }
}

function createCluster(x, y, id, numPoints, properties) {
    return {
        x: fround(x), // weighted cluster center; round for consistency with Float32Array index
        y: fround(y),
        zoom: Infinity, // the last zoom the cluster was processed at
        id, // encodes index of the first child of the cluster and its zoom level
        parentId: -1, // parent cluster id
        numPoints,
        properties
    };
}

function createPointCluster(p, id) {
    const [x, y] = p.geometry.coordinates;
    return {
        x: fround(lngX(x)), // projected point coordinates
        y: fround(latY(y)),
        zoom: Infinity, // the last zoom the point was processed at
        index: id, // index of the source feature in the original input array,
        parentId: -1 // parent cluster id
    };
}

function getClusterJSON(cluster) {
    return {
        type: 'Feature',
        id: cluster.id,
        properties: getClusterProperties(cluster),
        geometry: {
            type: 'Point',
            coordinates: [xLng(cluster.x), yLat(cluster.y)]
        }
    };
}

function getClusterProperties(cluster) {
    const count = cluster.numPoints;
    const abbrev =
        count >= 10000 ? `${Math.round(count / 1000)  }k` :
        count >= 1000 ? `${Math.round(count / 100) / 10  }k` : count;
    return extend(extend({}, cluster.properties), {
        cluster: true,
        cluster_id: cluster.id,
        point_count: count,
        point_count_abbreviated: abbrev
    });
}

// longitude/latitude to spherical mercator in [0..1] range
function lngX(lng) {
    return lng / 360 + 0.5;
}
function latY(lat) {
    const sin = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI);
    return y < 0 ? 0 : y > 1 ? 1 : y;
}

// spherical mercator to longitude/latitude
function xLng(x) {
    return (x - 0.5) * 360;
}
function yLat(y) {
    const y2 = (180 - y * 360) * Math.PI / 180;
    return 360 * Math.atan(Math.exp(y2)) / Math.PI - 90;
}

function extend(dest, src) {
    for (const id in src) dest[id] = src[id];
    return dest;
}

function getX(p) {
    return p.x;
}
function getY(p) {
    return p.y;
}

var geojsonVtDevExports = {};
var geojsonVtDev = {
  get exports(){ return geojsonVtDevExports; },
  set exports(v){ geojsonVtDevExports = v; },
};

(function (module, exports) {
	(function (global, factory) {
	'object' === 'object' && 'object' !== 'undefined' ? module.exports = factory() :
	typeof undefined === 'function' && undefined.amd ? undefined(factory) :
	(global.geojsonvt = factory());
	}(this, (function () { 'use strict';

	// calculate simplification data using optimized Douglas-Peucker algorithm

	function simplify(coords, first, last, sqTolerance) {
	    var maxSqDist = sqTolerance;
	    var mid = (last - first) >> 1;
	    var minPosToMid = last - first;
	    var index;

	    var ax = coords[first];
	    var ay = coords[first + 1];
	    var bx = coords[last];
	    var by = coords[last + 1];

	    for (var i = first + 3; i < last; i += 3) {
	        var d = getSqSegDist(coords[i], coords[i + 1], ax, ay, bx, by);

	        if (d > maxSqDist) {
	            index = i;
	            maxSqDist = d;

	        } else if (d === maxSqDist) {
	            // a workaround to ensure we choose a pivot close to the middle of the list,
	            // reducing recursion depth, for certain degenerate inputs
	            // https://github.com/mapbox/geojson-vt/issues/104
	            var posToMid = Math.abs(i - mid);
	            if (posToMid < minPosToMid) {
	                index = i;
	                minPosToMid = posToMid;
	            }
	        }
	    }

	    if (maxSqDist > sqTolerance) {
	        if (index - first > 3) simplify(coords, first, index, sqTolerance);
	        coords[index + 2] = maxSqDist;
	        if (last - index > 3) simplify(coords, index, last, sqTolerance);
	    }
	}

	// square distance from a point to a segment
	function getSqSegDist(px, py, x, y, bx, by) {

	    var dx = bx - x;
	    var dy = by - y;

	    if (dx !== 0 || dy !== 0) {

	        var t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);

	        if (t > 1) {
	            x = bx;
	            y = by;

	        } else if (t > 0) {
	            x += dx * t;
	            y += dy * t;
	        }
	    }

	    dx = px - x;
	    dy = py - y;

	    return dx * dx + dy * dy;
	}

	function createFeature(id, type, geom, tags) {
	    var feature = {
	        id: typeof id === 'undefined' ? null : id,
	        type: type,
	        geometry: geom,
	        tags: tags,
	        minX: Infinity,
	        minY: Infinity,
	        maxX: -Infinity,
	        maxY: -Infinity
	    };
	    calcBBox(feature);
	    return feature;
	}

	function calcBBox(feature) {
	    var geom = feature.geometry;
	    var type = feature.type;

	    if (type === 'Point' || type === 'MultiPoint' || type === 'LineString') {
	        calcLineBBox(feature, geom);

	    } else if (type === 'Polygon' || type === 'MultiLineString') {
	        for (var i = 0; i < geom.length; i++) {
	            calcLineBBox(feature, geom[i]);
	        }

	    } else if (type === 'MultiPolygon') {
	        for (i = 0; i < geom.length; i++) {
	            for (var j = 0; j < geom[i].length; j++) {
	                calcLineBBox(feature, geom[i][j]);
	            }
	        }
	    }
	}

	function calcLineBBox(feature, geom) {
	    for (var i = 0; i < geom.length; i += 3) {
	        feature.minX = Math.min(feature.minX, geom[i]);
	        feature.minY = Math.min(feature.minY, geom[i + 1]);
	        feature.maxX = Math.max(feature.maxX, geom[i]);
	        feature.maxY = Math.max(feature.maxY, geom[i + 1]);
	    }
	}

	// converts GeoJSON feature into an intermediate projected JSON vector format with simplification data

	function convert(data, options) {
	    var features = [];
	    if (data.type === 'FeatureCollection') {
	        for (var i = 0; i < data.features.length; i++) {
	            convertFeature(features, data.features[i], options, i);
	        }

	    } else if (data.type === 'Feature') {
	        convertFeature(features, data, options);

	    } else {
	        // single geometry or a geometry collection
	        convertFeature(features, {geometry: data}, options);
	    }

	    return features;
	}

	function convertFeature(features, geojson, options, index) {
	    if (!geojson.geometry) return;

	    var coords = geojson.geometry.coordinates;
	    var type = geojson.geometry.type;
	    var tolerance = Math.pow(options.tolerance / ((1 << options.maxZoom) * options.extent), 2);
	    var geometry = [];
	    var id = geojson.id;
	    if (options.promoteId) {
	        id = geojson.properties[options.promoteId];
	    } else if (options.generateId) {
	        id = index || 0;
	    }
	    if (type === 'Point') {
	        convertPoint(coords, geometry);

	    } else if (type === 'MultiPoint') {
	        for (var i = 0; i < coords.length; i++) {
	            convertPoint(coords[i], geometry);
	        }

	    } else if (type === 'LineString') {
	        convertLine(coords, geometry, tolerance, false);

	    } else if (type === 'MultiLineString') {
	        if (options.lineMetrics) {
	            // explode into linestrings to be able to track metrics
	            for (i = 0; i < coords.length; i++) {
	                geometry = [];
	                convertLine(coords[i], geometry, tolerance, false);
	                features.push(createFeature(id, 'LineString', geometry, geojson.properties));
	            }
	            return;
	        } else {
	            convertLines(coords, geometry, tolerance, false);
	        }

	    } else if (type === 'Polygon') {
	        convertLines(coords, geometry, tolerance, true);

	    } else if (type === 'MultiPolygon') {
	        for (i = 0; i < coords.length; i++) {
	            var polygon = [];
	            convertLines(coords[i], polygon, tolerance, true);
	            geometry.push(polygon);
	        }
	    } else if (type === 'GeometryCollection') {
	        for (i = 0; i < geojson.geometry.geometries.length; i++) {
	            convertFeature(features, {
	                id: id,
	                geometry: geojson.geometry.geometries[i],
	                properties: geojson.properties
	            }, options, index);
	        }
	        return;
	    } else {
	        throw new Error('Input data is not a valid GeoJSON object.');
	    }

	    features.push(createFeature(id, type, geometry, geojson.properties));
	}

	function convertPoint(coords, out) {
	    out.push(projectX(coords[0]));
	    out.push(projectY(coords[1]));
	    out.push(0);
	}

	function convertLine(ring, out, tolerance, isPolygon) {
	    var x0, y0;
	    var size = 0;

	    for (var j = 0; j < ring.length; j++) {
	        var x = projectX(ring[j][0]);
	        var y = projectY(ring[j][1]);

	        out.push(x);
	        out.push(y);
	        out.push(0);

	        if (j > 0) {
	            if (isPolygon) {
	                size += (x0 * y - x * y0) / 2; // area
	            } else {
	                size += Math.sqrt(Math.pow(x - x0, 2) + Math.pow(y - y0, 2)); // length
	            }
	        }
	        x0 = x;
	        y0 = y;
	    }

	    var last = out.length - 3;
	    out[2] = 1;
	    simplify(out, 0, last, tolerance);
	    out[last + 2] = 1;

	    out.size = Math.abs(size);
	    out.start = 0;
	    out.end = out.size;
	}

	function convertLines(rings, out, tolerance, isPolygon) {
	    for (var i = 0; i < rings.length; i++) {
	        var geom = [];
	        convertLine(rings[i], geom, tolerance, isPolygon);
	        out.push(geom);
	    }
	}

	function projectX(x) {
	    return x / 360 + 0.5;
	}

	function projectY(y) {
	    var sin = Math.sin(y * Math.PI / 180);
	    var y2 = 0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI;
	    return y2 < 0 ? 0 : y2 > 1 ? 1 : y2;
	}

	/* clip features between two axis-parallel lines:
	 *     |        |
	 *  ___|___     |     /
	 * /   |   \____|____/
	 *     |        |
	 */

	function clip(features, scale, k1, k2, axis, minAll, maxAll, options) {

	    k1 /= scale;
	    k2 /= scale;

	    if (minAll >= k1 && maxAll < k2) return features; // trivial accept
	    else if (maxAll < k1 || minAll >= k2) return null; // trivial reject

	    var clipped = [];

	    for (var i = 0; i < features.length; i++) {

	        var feature = features[i];
	        var geometry = feature.geometry;
	        var type = feature.type;

	        var min = axis === 0 ? feature.minX : feature.minY;
	        var max = axis === 0 ? feature.maxX : feature.maxY;

	        if (min >= k1 && max < k2) { // trivial accept
	            clipped.push(feature);
	            continue;
	        } else if (max < k1 || min >= k2) { // trivial reject
	            continue;
	        }

	        var newGeometry = [];

	        if (type === 'Point' || type === 'MultiPoint') {
	            clipPoints(geometry, newGeometry, k1, k2, axis);

	        } else if (type === 'LineString') {
	            clipLine(geometry, newGeometry, k1, k2, axis, false, options.lineMetrics);

	        } else if (type === 'MultiLineString') {
	            clipLines(geometry, newGeometry, k1, k2, axis, false);

	        } else if (type === 'Polygon') {
	            clipLines(geometry, newGeometry, k1, k2, axis, true);

	        } else if (type === 'MultiPolygon') {
	            for (var j = 0; j < geometry.length; j++) {
	                var polygon = [];
	                clipLines(geometry[j], polygon, k1, k2, axis, true);
	                if (polygon.length) {
	                    newGeometry.push(polygon);
	                }
	            }
	        }

	        if (newGeometry.length) {
	            if (options.lineMetrics && type === 'LineString') {
	                for (j = 0; j < newGeometry.length; j++) {
	                    clipped.push(createFeature(feature.id, type, newGeometry[j], feature.tags));
	                }
	                continue;
	            }

	            if (type === 'LineString' || type === 'MultiLineString') {
	                if (newGeometry.length === 1) {
	                    type = 'LineString';
	                    newGeometry = newGeometry[0];
	                } else {
	                    type = 'MultiLineString';
	                }
	            }
	            if (type === 'Point' || type === 'MultiPoint') {
	                type = newGeometry.length === 3 ? 'Point' : 'MultiPoint';
	            }

	            clipped.push(createFeature(feature.id, type, newGeometry, feature.tags));
	        }
	    }

	    return clipped.length ? clipped : null;
	}

	function clipPoints(geom, newGeom, k1, k2, axis) {
	    for (var i = 0; i < geom.length; i += 3) {
	        var a = geom[i + axis];

	        if (a >= k1 && a <= k2) {
	            newGeom.push(geom[i]);
	            newGeom.push(geom[i + 1]);
	            newGeom.push(geom[i + 2]);
	        }
	    }
	}

	function clipLine(geom, newGeom, k1, k2, axis, isPolygon, trackMetrics) {

	    var slice = newSlice(geom);
	    var intersect = axis === 0 ? intersectX : intersectY;
	    var len = geom.start;
	    var segLen, t;

	    for (var i = 0; i < geom.length - 3; i += 3) {
	        var ax = geom[i];
	        var ay = geom[i + 1];
	        var az = geom[i + 2];
	        var bx = geom[i + 3];
	        var by = geom[i + 4];
	        var a = axis === 0 ? ax : ay;
	        var b = axis === 0 ? bx : by;
	        var exited = false;

	        if (trackMetrics) segLen = Math.sqrt(Math.pow(ax - bx, 2) + Math.pow(ay - by, 2));

	        if (a < k1) {
	            // ---|-->  | (line enters the clip region from the left)
	            if (b > k1) {
	                t = intersect(slice, ax, ay, bx, by, k1);
	                if (trackMetrics) slice.start = len + segLen * t;
	            }
	        } else if (a > k2) {
	            // |  <--|--- (line enters the clip region from the right)
	            if (b < k2) {
	                t = intersect(slice, ax, ay, bx, by, k2);
	                if (trackMetrics) slice.start = len + segLen * t;
	            }
	        } else {
	            addPoint(slice, ax, ay, az);
	        }
	        if (b < k1 && a >= k1) {
	            // <--|---  | or <--|-----|--- (line exits the clip region on the left)
	            t = intersect(slice, ax, ay, bx, by, k1);
	            exited = true;
	        }
	        if (b > k2 && a <= k2) {
	            // |  ---|--> or ---|-----|--> (line exits the clip region on the right)
	            t = intersect(slice, ax, ay, bx, by, k2);
	            exited = true;
	        }

	        if (!isPolygon && exited) {
	            if (trackMetrics) slice.end = len + segLen * t;
	            newGeom.push(slice);
	            slice = newSlice(geom);
	        }

	        if (trackMetrics) len += segLen;
	    }

	    // add the last point
	    var last = geom.length - 3;
	    ax = geom[last];
	    ay = geom[last + 1];
	    az = geom[last + 2];
	    a = axis === 0 ? ax : ay;
	    if (a >= k1 && a <= k2) addPoint(slice, ax, ay, az);

	    // close the polygon if its endpoints are not the same after clipping
	    last = slice.length - 3;
	    if (isPolygon && last >= 3 && (slice[last] !== slice[0] || slice[last + 1] !== slice[1])) {
	        addPoint(slice, slice[0], slice[1], slice[2]);
	    }

	    // add the final slice
	    if (slice.length) {
	        newGeom.push(slice);
	    }
	}

	function newSlice(line) {
	    var slice = [];
	    slice.size = line.size;
	    slice.start = line.start;
	    slice.end = line.end;
	    return slice;
	}

	function clipLines(geom, newGeom, k1, k2, axis, isPolygon) {
	    for (var i = 0; i < geom.length; i++) {
	        clipLine(geom[i], newGeom, k1, k2, axis, isPolygon, false);
	    }
	}

	function addPoint(out, x, y, z) {
	    out.push(x);
	    out.push(y);
	    out.push(z);
	}

	function intersectX(out, ax, ay, bx, by, x) {
	    var t = (x - ax) / (bx - ax);
	    out.push(x);
	    out.push(ay + (by - ay) * t);
	    out.push(1);
	    return t;
	}

	function intersectY(out, ax, ay, bx, by, y) {
	    var t = (y - ay) / (by - ay);
	    out.push(ax + (bx - ax) * t);
	    out.push(y);
	    out.push(1);
	    return t;
	}

	function wrap(features, options) {
	    var buffer = options.buffer / options.extent;
	    var merged = features;
	    var left  = clip(features, 1, -1 - buffer, buffer,     0, -1, 2, options); // left world copy
	    var right = clip(features, 1,  1 - buffer, 2 + buffer, 0, -1, 2, options); // right world copy

	    if (left || right) {
	        merged = clip(features, 1, -buffer, 1 + buffer, 0, -1, 2, options) || []; // center world copy

	        if (left) merged = shiftFeatureCoords(left, 1).concat(merged); // merge left into center
	        if (right) merged = merged.concat(shiftFeatureCoords(right, -1)); // merge right into center
	    }

	    return merged;
	}

	function shiftFeatureCoords(features, offset) {
	    var newFeatures = [];

	    for (var i = 0; i < features.length; i++) {
	        var feature = features[i],
	            type = feature.type;

	        var newGeometry;

	        if (type === 'Point' || type === 'MultiPoint' || type === 'LineString') {
	            newGeometry = shiftCoords(feature.geometry, offset);

	        } else if (type === 'MultiLineString' || type === 'Polygon') {
	            newGeometry = [];
	            for (var j = 0; j < feature.geometry.length; j++) {
	                newGeometry.push(shiftCoords(feature.geometry[j], offset));
	            }
	        } else if (type === 'MultiPolygon') {
	            newGeometry = [];
	            for (j = 0; j < feature.geometry.length; j++) {
	                var newPolygon = [];
	                for (var k = 0; k < feature.geometry[j].length; k++) {
	                    newPolygon.push(shiftCoords(feature.geometry[j][k], offset));
	                }
	                newGeometry.push(newPolygon);
	            }
	        }

	        newFeatures.push(createFeature(feature.id, type, newGeometry, feature.tags));
	    }

	    return newFeatures;
	}

	function shiftCoords(points, offset) {
	    var newPoints = [];
	    newPoints.size = points.size;

	    if (points.start !== undefined) {
	        newPoints.start = points.start;
	        newPoints.end = points.end;
	    }

	    for (var i = 0; i < points.length; i += 3) {
	        newPoints.push(points[i] + offset, points[i + 1], points[i + 2]);
	    }
	    return newPoints;
	}

	// Transforms the coordinates of each feature in the given tile from
	// mercator-projected space into (extent x extent) tile space.
	function transformTile(tile, extent) {
	    if (tile.transformed) return tile;

	    var z2 = 1 << tile.z,
	        tx = tile.x,
	        ty = tile.y,
	        i, j, k;

	    for (i = 0; i < tile.features.length; i++) {
	        var feature = tile.features[i],
	            geom = feature.geometry,
	            type = feature.type;

	        feature.geometry = [];

	        if (type === 1) {
	            for (j = 0; j < geom.length; j += 2) {
	                feature.geometry.push(transformPoint(geom[j], geom[j + 1], extent, z2, tx, ty));
	            }
	        } else {
	            for (j = 0; j < geom.length; j++) {
	                var ring = [];
	                for (k = 0; k < geom[j].length; k += 2) {
	                    ring.push(transformPoint(geom[j][k], geom[j][k + 1], extent, z2, tx, ty));
	                }
	                feature.geometry.push(ring);
	            }
	        }
	    }

	    tile.transformed = true;

	    return tile;
	}

	function transformPoint(x, y, extent, z2, tx, ty) {
	    return [
	        Math.round(extent * (x * z2 - tx)),
	        Math.round(extent * (y * z2 - ty))];
	}

	function createTile(features, z, tx, ty, options) {
	    var tolerance = z === options.maxZoom ? 0 : options.tolerance / ((1 << z) * options.extent);
	    var tile = {
	        features: [],
	        numPoints: 0,
	        numSimplified: 0,
	        numFeatures: 0,
	        source: null,
	        x: tx,
	        y: ty,
	        z: z,
	        transformed: false,
	        minX: 2,
	        minY: 1,
	        maxX: -1,
	        maxY: 0
	    };
	    for (var i = 0; i < features.length; i++) {
	        tile.numFeatures++;
	        addFeature(tile, features[i], tolerance, options);

	        var minX = features[i].minX;
	        var minY = features[i].minY;
	        var maxX = features[i].maxX;
	        var maxY = features[i].maxY;

	        if (minX < tile.minX) tile.minX = minX;
	        if (minY < tile.minY) tile.minY = minY;
	        if (maxX > tile.maxX) tile.maxX = maxX;
	        if (maxY > tile.maxY) tile.maxY = maxY;
	    }
	    return tile;
	}

	function addFeature(tile, feature, tolerance, options) {

	    var geom = feature.geometry,
	        type = feature.type,
	        simplified = [];

	    if (type === 'Point' || type === 'MultiPoint') {
	        for (var i = 0; i < geom.length; i += 3) {
	            simplified.push(geom[i]);
	            simplified.push(geom[i + 1]);
	            tile.numPoints++;
	            tile.numSimplified++;
	        }

	    } else if (type === 'LineString') {
	        addLine(simplified, geom, tile, tolerance, false, false);

	    } else if (type === 'MultiLineString' || type === 'Polygon') {
	        for (i = 0; i < geom.length; i++) {
	            addLine(simplified, geom[i], tile, tolerance, type === 'Polygon', i === 0);
	        }

	    } else if (type === 'MultiPolygon') {

	        for (var k = 0; k < geom.length; k++) {
	            var polygon = geom[k];
	            for (i = 0; i < polygon.length; i++) {
	                addLine(simplified, polygon[i], tile, tolerance, true, i === 0);
	            }
	        }
	    }

	    if (simplified.length) {
	        var tags = feature.tags || null;
	        if (type === 'LineString' && options.lineMetrics) {
	            tags = {};
	            for (var key in feature.tags) tags[key] = feature.tags[key];
	            tags['mapbox_clip_start'] = geom.start / geom.size;
	            tags['mapbox_clip_end'] = geom.end / geom.size;
	        }
	        var tileFeature = {
	            geometry: simplified,
	            type: type === 'Polygon' || type === 'MultiPolygon' ? 3 :
	                type === 'LineString' || type === 'MultiLineString' ? 2 : 1,
	            tags: tags
	        };
	        if (feature.id !== null) {
	            tileFeature.id = feature.id;
	        }
	        tile.features.push(tileFeature);
	    }
	}

	function addLine(result, geom, tile, tolerance, isPolygon, isOuter) {
	    var sqTolerance = tolerance * tolerance;

	    if (tolerance > 0 && (geom.size < (isPolygon ? sqTolerance : tolerance))) {
	        tile.numPoints += geom.length / 3;
	        return;
	    }

	    var ring = [];

	    for (var i = 0; i < geom.length; i += 3) {
	        if (tolerance === 0 || geom[i + 2] > sqTolerance) {
	            tile.numSimplified++;
	            ring.push(geom[i]);
	            ring.push(geom[i + 1]);
	        }
	        tile.numPoints++;
	    }

	    if (isPolygon) rewind(ring, isOuter);

	    result.push(ring);
	}

	function rewind(ring, clockwise) {
	    var area = 0;
	    for (var i = 0, len = ring.length, j = len - 2; i < len; j = i, i += 2) {
	        area += (ring[i] - ring[j]) * (ring[i + 1] + ring[j + 1]);
	    }
	    if (area > 0 === clockwise) {
	        for (i = 0, len = ring.length; i < len / 2; i += 2) {
	            var x = ring[i];
	            var y = ring[i + 1];
	            ring[i] = ring[len - 2 - i];
	            ring[i + 1] = ring[len - 1 - i];
	            ring[len - 2 - i] = x;
	            ring[len - 1 - i] = y;
	        }
	    }
	}

	function geojsonvt(data, options) {
	    return new GeoJSONVT(data, options);
	}

	function GeoJSONVT(data, options) {
	    options = this.options = extend(Object.create(this.options), options);

	    var debug = options.debug;

	    if (debug) console.time('preprocess data');

	    if (options.maxZoom < 0 || options.maxZoom > 24) throw new Error('maxZoom should be in the 0-24 range');
	    if (options.promoteId && options.generateId) throw new Error('promoteId and generateId cannot be used together.');

	    var features = convert(data, options);

	    this.tiles = {};
	    this.tileCoords = [];

	    if (debug) {
	        console.timeEnd('preprocess data');
	        console.log('index: maxZoom: %d, maxPoints: %d', options.indexMaxZoom, options.indexMaxPoints);
	        console.time('generate tiles');
	        this.stats = {};
	        this.total = 0;
	    }

	    features = wrap(features, options);

	    // start slicing from the top tile down
	    if (features.length) this.splitTile(features, 0, 0, 0);

	    if (debug) {
	        if (features.length) console.log('features: %d, points: %d', this.tiles[0].numFeatures, this.tiles[0].numPoints);
	        console.timeEnd('generate tiles');
	        console.log('tiles generated:', this.total, JSON.stringify(this.stats));
	    }
	}

	GeoJSONVT.prototype.options = {
	    maxZoom: 14,            // max zoom to preserve detail on
	    indexMaxZoom: 5,        // max zoom in the tile index
	    indexMaxPoints: 100000, // max number of points per tile in the tile index
	    tolerance: 3,           // simplification tolerance (higher means simpler)
	    extent: 4096,           // tile extent
	    buffer: 64,             // tile buffer on each side
	    lineMetrics: false,     // whether to calculate line metrics
	    promoteId: null,        // name of a feature property to be promoted to feature.id
	    generateId: false,      // whether to generate feature ids. Cannot be used with promoteId
	    debug: 0                // logging level (0, 1 or 2)
	};

	GeoJSONVT.prototype.splitTile = function (features, z, x, y, cz, cx, cy) {

	    var stack = [features, z, x, y],
	        options = this.options,
	        debug = options.debug;

	    // avoid recursion by using a processing queue
	    while (stack.length) {
	        y = stack.pop();
	        x = stack.pop();
	        z = stack.pop();
	        features = stack.pop();

	        var z2 = 1 << z,
	            id = toID(z, x, y),
	            tile = this.tiles[id];

	        if (!tile) {
	            if (debug > 1) console.time('creation');

	            tile = this.tiles[id] = createTile(features, z, x, y, options);
	            this.tileCoords.push({z: z, x: x, y: y});

	            if (debug) {
	                if (debug > 1) {
	                    console.log('tile z%d-%d-%d (features: %d, points: %d, simplified: %d)',
	                        z, x, y, tile.numFeatures, tile.numPoints, tile.numSimplified);
	                    console.timeEnd('creation');
	                }
	                var key = 'z' + z;
	                this.stats[key] = (this.stats[key] || 0) + 1;
	                this.total++;
	            }
	        }

	        // save reference to original geometry in tile so that we can drill down later if we stop now
	        tile.source = features;

	        // if it's the first-pass tiling
	        if (!cz) {
	            // stop tiling if we reached max zoom, or if the tile is too simple
	            if (z === options.indexMaxZoom || tile.numPoints <= options.indexMaxPoints) continue;

	        // if a drilldown to a specific tile
	        } else {
	            // stop tiling if we reached base zoom or our target tile zoom
	            if (z === options.maxZoom || z === cz) continue;

	            // stop tiling if it's not an ancestor of the target tile
	            var m = 1 << (cz - z);
	            if (x !== Math.floor(cx / m) || y !== Math.floor(cy / m)) continue;
	        }

	        // if we slice further down, no need to keep source geometry
	        tile.source = null;

	        if (features.length === 0) continue;

	        if (debug > 1) console.time('clipping');

	        // values we'll use for clipping
	        var k1 = 0.5 * options.buffer / options.extent,
	            k2 = 0.5 - k1,
	            k3 = 0.5 + k1,
	            k4 = 1 + k1,
	            tl, bl, tr, br, left, right;

	        tl = bl = tr = br = null;

	        left  = clip(features, z2, x - k1, x + k3, 0, tile.minX, tile.maxX, options);
	        right = clip(features, z2, x + k2, x + k4, 0, tile.minX, tile.maxX, options);
	        features = null;

	        if (left) {
	            tl = clip(left, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
	            bl = clip(left, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
	            left = null;
	        }

	        if (right) {
	            tr = clip(right, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
	            br = clip(right, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
	            right = null;
	        }

	        if (debug > 1) console.timeEnd('clipping');

	        stack.push(tl || [], z + 1, x * 2,     y * 2);
	        stack.push(bl || [], z + 1, x * 2,     y * 2 + 1);
	        stack.push(tr || [], z + 1, x * 2 + 1, y * 2);
	        stack.push(br || [], z + 1, x * 2 + 1, y * 2 + 1);
	    }
	};

	GeoJSONVT.prototype.getTile = function (z, x, y) {
	    var options = this.options,
	        extent = options.extent,
	        debug = options.debug;

	    if (z < 0 || z > 24) return null;

	    var z2 = 1 << z;
	    x = ((x % z2) + z2) % z2; // wrap tile x coordinate

	    var id = toID(z, x, y);
	    if (this.tiles[id]) return transformTile(this.tiles[id], extent);

	    if (debug > 1) console.log('drilling down to z%d-%d-%d', z, x, y);

	    var z0 = z,
	        x0 = x,
	        y0 = y,
	        parent;

	    while (!parent && z0 > 0) {
	        z0--;
	        x0 = Math.floor(x0 / 2);
	        y0 = Math.floor(y0 / 2);
	        parent = this.tiles[toID(z0, x0, y0)];
	    }

	    if (!parent || !parent.source) return null;

	    // if we found a parent tile containing the original geometry, we can drill down from it
	    if (debug > 1) console.log('found parent tile z%d-%d-%d', z0, x0, y0);

	    if (debug > 1) console.time('drilling down');
	    this.splitTile(parent.source, z0, x0, y0, z, x, y);
	    if (debug > 1) console.timeEnd('drilling down');

	    return this.tiles[id] ? transformTile(this.tiles[id], extent) : null;
	};

	function toID(z, x, y) {
	    return (((1 << z) * y + x) * 32) + z;
	}

	function extend(dest, src) {
	    for (var i in src) dest[i] = src[i];
	    return dest;
	}

	return geojsonvt;

	})));
} (geojsonVtDev, geojsonVtDevExports));

var geojsonvt = geojsonVtDevExports;

function getFeatureId(feature, promoteId) {
    return promoteId ? feature.properties[promoteId] : feature.id;
}
function isUpdateableGeoJSON(data, promoteId) {
    // null can be updated
    if (data == null) {
        return true;
    }
    // a single feature with an id can be updated, need to explicitly check against null because 0 is a valid feature id that is falsy
    if (data.type === 'Feature') {
        return getFeatureId(data, promoteId) != null;
    }
    // a feature collection can be updated if every feature has an id, and the ids are all unique
    // this prevents us from silently dropping features if ids get reused
    if (data.type === 'FeatureCollection') {
        const seenIds = new Set();
        for (const feature of data.features) {
            const id = getFeatureId(feature, promoteId);
            if (id == null) {
                return false;
            }
            if (seenIds.has(id)) {
                return false;
            }
            seenIds.add(id);
        }
        return true;
    }
    return false;
}
function toUpdateable(data, promoteId) {
    const result = new Map();
    if (data == null) {
        // empty result
    }
    else if (data.type === 'Feature') {
        result.set(getFeatureId(data, promoteId), data);
    }
    else {
        for (const feature of data.features) {
            result.set(getFeatureId(feature, promoteId), feature);
        }
    }
    return result;
}
// mutates updateable
function applySourceDiff(updateable, diff, promoteId) {
    var _a, _b, _c, _d;
    if (diff.removeAll) {
        updateable.clear();
    }
    if (diff.remove) {
        for (const id of diff.remove) {
            updateable.delete(id);
        }
    }
    if (diff.add) {
        for (const feature of diff.add) {
            const id = getFeatureId(feature, promoteId);
            if (id != null) {
                updateable.set(id, feature);
            }
        }
    }
    if (diff.update) {
        for (const update of diff.update) {
            let feature = updateable.get(update.id);
            if (feature == null) {
                continue;
            }
            // be careful to clone the feature and/or properties objects to avoid mutating our input
            const cloneFeature = update.newGeometry || update.removeAllProperties;
            // note: removeAllProperties gives us a new properties object, so we can skip the clone step
            const cloneProperties = !update.removeAllProperties && (((_a = update.removeProperties) === null || _a === void 0 ? void 0 : _a.length) > 0 || ((_b = update.addOrUpdateProperties) === null || _b === void 0 ? void 0 : _b.length) > 0);
            if (cloneFeature || cloneProperties) {
                feature = { ...feature };
                updateable.set(update.id, feature);
                if (cloneProperties) {
                    feature.properties = { ...feature.properties };
                }
            }
            if (update.newGeometry) {
                feature.geometry = update.newGeometry;
            }
            if (update.removeAllProperties) {
                feature.properties = {};
            }
            else if (((_c = update.removeProperties) === null || _c === void 0 ? void 0 : _c.length) > 0) {
                for (const prop of update.removeProperties) {
                    if (Object.prototype.hasOwnProperty.call(feature.properties, prop)) {
                        delete feature.properties[prop];
                    }
                }
            }
            if (((_d = update.addOrUpdateProperties) === null || _d === void 0 ? void 0 : _d.length) > 0) {
                for (const { key, value } of update.addOrUpdateProperties) {
                    feature.properties[key] = value;
                }
            }
        }
    }
}

function loadGeoJSONTile(params, callback) {
    const canonical = params.tileID.canonical;
    if (!this._geoJSONIndex) {
        return callback(null, null); // we couldn't load the file
    }
    const geoJSONTile = this._geoJSONIndex.getTile(canonical.z, canonical.x, canonical.y);
    if (!geoJSONTile) {
        return callback(null, null); // nothing in the given tile
    }
    const geojsonWrapper = new GeoJSONWrapper$2(geoJSONTile.features);
    // Encode the geojson-vt tile into binary vector tile form.  This
    // is a convenience that allows `FeatureIndex` to operate the same way
    // across `VectorTileSource` and `GeoJSONSource` data.
    let pbf = vtPbfExports(geojsonWrapper);
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
        pbf = new Uint8Array(pbf);
    }
    callback(null, {
        vectorTile: geojsonWrapper,
        rawData: pbf.buffer
    });
}
/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation.  To do so, create it with
 * `new GeoJSONWorkerSource(actor, layerIndex, customLoadGeoJSONFunction)`.
 * For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 *
 * @private
 */
class GeoJSONWorkerSource extends VectorTileWorkerSource {
    /**
     * @param [loadGeoJSON] Optional method for custom loading/parsing of
     * GeoJSON based on parameters passed from the main-thread Source.
     * See {@link GeoJSONWorkerSource#loadGeoJSON}.
     * @private
     */
    constructor(actor, layerIndex, availableImages, loadGeoJSON) {
        super(actor, layerIndex, availableImages, loadGeoJSONTile);
        this._dataUpdateable = new Map();
        /**
         * Fetch and parse GeoJSON according to the given params.  Calls `callback`
         * with `(err, data)`, where `data` is a parsed GeoJSON object.
         *
         * GeoJSON is loaded and parsed from `params.url` if it exists, or else
         * expected as a literal (string or object) `params.data`.
         *
         * @param params
         * @param [params.url] A URL to the remote GeoJSON data.
         * @param [params.data] Literal GeoJSON data. Must be provided if `params.url` is not.
         * @returns {Cancelable} A Cancelable object.
         * @private
         */
        this.loadGeoJSON = (params, callback) => {
            const { promoteId } = params;
            // Because of same origin issues, urls must either include an explicit
            // origin or absolute path.
            // ie: /foo/bar.json or http://example.com/bar.json
            // but not ../foo/bar.json
            if (params.request) {
                return performance.getJSON(params.request, (error, data, cacheControl, expires) => {
                    this._dataUpdateable = isUpdateableGeoJSON(data, promoteId) ? toUpdateable(data, promoteId) : undefined;
                    callback(error, data, cacheControl, expires);
                });
            }
            else if (typeof params.data === 'string') {
                try {
                    const parsed = JSON.parse(params.data);
                    this._dataUpdateable = isUpdateableGeoJSON(parsed, promoteId) ? toUpdateable(parsed, promoteId) : undefined;
                    callback(null, parsed);
                }
                catch (e) {
                    callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
                }
            }
            else if (params.dataDiff) {
                if (this._dataUpdateable) {
                    applySourceDiff(this._dataUpdateable, params.dataDiff, promoteId);
                    callback(null, { type: 'FeatureCollection', features: Array.from(this._dataUpdateable.values()) });
                }
                else {
                    callback(new Error(`Cannot update existing geojson data in ${params.source}`));
                }
            }
            else {
                callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
            }
            return { cancel: () => { } };
        };
        if (loadGeoJSON) {
            this.loadGeoJSON = loadGeoJSON;
        }
    }
    /**
     * Fetches (if appropriate), parses, and index geojson data into tiles. This
     * preparatory method must be called before {@link GeoJSONWorkerSource#loadTile}
     * can correctly serve up tiles.
     *
     * Defers to {@link GeoJSONWorkerSource#loadGeoJSON} for the fetching/parsing,
     * expecting `callback(error, data)` to be called with either an error or a
     * parsed GeoJSON object.
     *
     * When a `loadData` request comes in while a previous one is being processed,
     * the previous one is aborted.
     *
     * @param params
     * @param callback
     * @private
     */
    loadData(params, callback) {
        var _a;
        (_a = this._pendingRequest) === null || _a === void 0 ? void 0 : _a.cancel();
        if (this._pendingCallback) {
            // Tell the foreground the previous call has been abandoned
            this._pendingCallback(null, { abandoned: true });
        }
        const perf = (params && params.request && params.request.collectResourceTiming) ?
            new performance.RequestPerformance(params.request) : false;
        this._pendingCallback = callback;
        this._pendingRequest = this.loadGeoJSON(params, (err, data) => {
            delete this._pendingCallback;
            delete this._pendingRequest;
            if (err || !data) {
                return callback(err);
            }
            else if (typeof data !== 'object') {
                return callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
            }
            else {
                geojsonRewind(data, true);
                try {
                    if (params.filter) {
                        const compiled = performance.createExpression(params.filter, { type: 'boolean', 'property-type': 'data-driven', overridable: false, transition: false });
                        if (compiled.result === 'error')
                            throw new Error(compiled.value.map(err => `${err.key}: ${err.message}`).join(', '));
                        const features = data.features.filter(feature => compiled.value.evaluate({ zoom: 0 }, feature));
                        data = { type: 'FeatureCollection', features };
                    }
                    this._geoJSONIndex = params.cluster ?
                        new Supercluster(getSuperclusterOptions(params)).load(data.features) :
                        geojsonvt(data, params.geojsonVtOptions);
                }
                catch (err) {
                    return callback(err);
                }
                this.loaded = {};
                const result = {};
                if (perf) {
                    const resourceTimingData = perf.finish();
                    // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                    // late evaluation in the main thread causes TypeError: illegal invocation
                    if (resourceTimingData) {
                        result.resourceTiming = {};
                        result.resourceTiming[params.source] = JSON.parse(JSON.stringify(resourceTimingData));
                    }
                }
                callback(null, result);
            }
        });
    }
    /**
    * Implements {@link WorkerSource#reloadTile}.
    *
    * If the tile is loaded, uses the implementation in VectorTileWorkerSource.
    * Otherwise, such as after a setData() call, we load the tile fresh.
    *
    * @param params
    * @param params.uid The UID for this tile.
    * @private
    */
    reloadTile(params, callback) {
        const loaded = this.loaded, uid = params.uid;
        if (loaded && loaded[uid]) {
            return super.reloadTile(params, callback);
        }
        else {
            return this.loadTile(params, callback);
        }
    }
    removeSource(params, callback) {
        if (this._pendingCallback) {
            // Don't leak callbacks
            this._pendingCallback(null, { abandoned: true });
        }
        callback();
    }
    getClusterExpansionZoom(params, callback) {
        try {
            callback(null, this._geoJSONIndex.getClusterExpansionZoom(params.clusterId));
        }
        catch (e) {
            callback(e);
        }
    }
    getClusterChildren(params, callback) {
        try {
            callback(null, this._geoJSONIndex.getChildren(params.clusterId));
        }
        catch (e) {
            callback(e);
        }
    }
    getClusterLeaves(params, callback) {
        try {
            callback(null, this._geoJSONIndex.getLeaves(params.clusterId, params.limit, params.offset));
        }
        catch (e) {
            callback(e);
        }
    }
}
function getSuperclusterOptions({ superclusterOptions, clusterProperties }) {
    if (!clusterProperties || !superclusterOptions)
        return superclusterOptions;
    const mapExpressions = {};
    const reduceExpressions = {};
    const globals = { accumulated: null, zoom: 0 };
    const feature = { properties: null };
    const propertyNames = Object.keys(clusterProperties);
    for (const key of propertyNames) {
        const [operator, mapExpression] = clusterProperties[key];
        const mapExpressionParsed = performance.createExpression(mapExpression);
        const reduceExpressionParsed = performance.createExpression(typeof operator === 'string' ? [operator, ['accumulated'], ['get', key]] : operator);
        mapExpressions[key] = mapExpressionParsed.value;
        reduceExpressions[key] = reduceExpressionParsed.value;
    }
    superclusterOptions.map = (pointProperties) => {
        feature.properties = pointProperties;
        const properties = {};
        for (const key of propertyNames) {
            properties[key] = mapExpressions[key].evaluate(globals, feature);
        }
        return properties;
    };
    superclusterOptions.reduce = (accumulated, clusterProperties) => {
        feature.properties = clusterProperties;
        for (const key of propertyNames) {
            globals.accumulated = accumulated[key];
            accumulated[key] = reduceExpressions[key].evaluate(globals, feature);
        }
    };
    return superclusterOptions;
}

/**
 * @private
 */
class Worker {
    constructor(self) {
        this.self = self;
        this.actor = new performance.Actor(self, this);
        this.layerIndexes = {};
        this.availableImages = {};
        this.workerSourceTypes = {
            vector: VectorTileWorkerSource,
            geojson: GeoJSONWorkerSource
        };
        // [mapId][sourceType][sourceName] => worker source instance
        this.workerSources = {};
        this.demWorkerSources = {};
        this.self.registerWorkerSource = (name, WorkerSource) => {
            if (this.workerSourceTypes[name]) {
                throw new Error(`Worker source with name "${name}" already registered.`);
            }
            this.workerSourceTypes[name] = WorkerSource;
        };
        // This is invoked by the RTL text plugin when the download via the `importScripts` call has finished, and the code has been parsed.
        this.self.registerRTLTextPlugin = (rtlTextPlugin) => {
            if (performance.plugin.isParsed()) {
                throw new Error('RTL text plugin already registered.');
            }
            performance.plugin['applyArabicShaping'] = rtlTextPlugin.applyArabicShaping;
            performance.plugin['processBidirectionalText'] = rtlTextPlugin.processBidirectionalText;
            performance.plugin['processStyledBidirectionalText'] = rtlTextPlugin.processStyledBidirectionalText;
        };
    }
    setReferrer(mapID, referrer) {
        this.referrer = referrer;
    }
    setImages(mapId, images, callback) {
        this.availableImages[mapId] = images;
        for (const workerSource in this.workerSources[mapId]) {
            const ws = this.workerSources[mapId][workerSource];
            for (const source in ws) {
                ws[source].availableImages = images;
            }
        }
        callback();
    }
    setLayers(mapId, layers, callback) {
        this.getLayerIndex(mapId).replace(layers);
        callback();
    }
    updateLayers(mapId, params, callback) {
        this.getLayerIndex(mapId).update(params.layers, params.removedIds);
        callback();
    }
    loadTile(mapId, params, callback) {
        this.getWorkerSource(mapId, params.type, params.source).loadTile(params, callback);
    }
    loadDEMTile(mapId, params, callback) {
        this.getDEMWorkerSource(mapId, params.source).loadTile(params, callback);
    }
    reloadTile(mapId, params, callback) {
        this.getWorkerSource(mapId, params.type, params.source).reloadTile(params, callback);
    }
    abortTile(mapId, params, callback) {
        this.getWorkerSource(mapId, params.type, params.source).abortTile(params, callback);
    }
    removeTile(mapId, params, callback) {
        this.getWorkerSource(mapId, params.type, params.source).removeTile(params, callback);
    }
    removeDEMTile(mapId, params) {
        this.getDEMWorkerSource(mapId, params.source).removeTile(params);
    }
    removeSource(mapId, params, callback) {
        if (!this.workerSources[mapId] ||
            !this.workerSources[mapId][params.type] ||
            !this.workerSources[mapId][params.type][params.source]) {
            return;
        }
        const worker = this.workerSources[mapId][params.type][params.source];
        delete this.workerSources[mapId][params.type][params.source];
        if (worker.removeSource !== undefined) {
            worker.removeSource(params, callback);
        }
        else {
            callback();
        }
    }
    /**
     * Load a {@link WorkerSource} script at params.url.  The script is run
     * (using importScripts) with `registerWorkerSource` in scope, which is a
     * function taking `(name, workerSourceObject)`.
     *  @private
     */
    loadWorkerSource(map, params, callback) {
        try {
            this.self.importScripts(params.url);
            callback();
        }
        catch (e) {
            callback(e.toString());
        }
    }
    syncRTLPluginState(map, state, callback) {
        try {
            performance.plugin.setState(state);
            const pluginURL = performance.plugin.getPluginURL();
            if (performance.plugin.isLoaded() &&
                !performance.plugin.isParsed() &&
                pluginURL != null // Not possible when `isLoaded` is true, but keeps flow happy
            ) {
                this.self.importScripts(pluginURL);
                const complete = performance.plugin.isParsed();
                const error = complete ? undefined : new Error(`RTL Text Plugin failed to import scripts from ${pluginURL}`);
                callback(error, complete);
            }
        }
        catch (e) {
            callback(e.toString());
        }
    }
    getAvailableImages(mapId) {
        let availableImages = this.availableImages[mapId];
        if (!availableImages) {
            availableImages = [];
        }
        return availableImages;
    }
    getLayerIndex(mapId) {
        let layerIndexes = this.layerIndexes[mapId];
        if (!layerIndexes) {
            layerIndexes = this.layerIndexes[mapId] = new StyleLayerIndex();
        }
        return layerIndexes;
    }
    getWorkerSource(mapId, type, source) {
        if (!this.workerSources[mapId])
            this.workerSources[mapId] = {};
        if (!this.workerSources[mapId][type])
            this.workerSources[mapId][type] = {};
        if (!this.workerSources[mapId][type][source]) {
            // use a wrapped actor so that we can attach a target mapId param
            // to any messages invoked by the WorkerSource
            const actor = {
                send: (type, data, callback) => {
                    this.actor.send(type, data, callback, mapId);
                }
            };
            this.workerSources[mapId][type][source] = new this.workerSourceTypes[type](actor, this.getLayerIndex(mapId), this.getAvailableImages(mapId));
        }
        return this.workerSources[mapId][type][source];
    }
    getDEMWorkerSource(mapId, source) {
        if (!this.demWorkerSources[mapId])
            this.demWorkerSources[mapId] = {};
        if (!this.demWorkerSources[mapId][source]) {
            this.demWorkerSources[mapId][source] = new RasterDEMTileWorkerSource();
        }
        return this.demWorkerSources[mapId][source];
    }
}
if (performance.isWorker()) {
    self.worker = new Worker(self);
}

return Worker;

}));
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvc3R5bGUtc3BlYy9ncm91cF9ieV9sYXlvdXQudHMiLCIuLi8uLi8uLi9zcmMvc3R5bGUvc3R5bGVfbGF5ZXJfaW5kZXgudHMiLCIuLi8uLi8uLi9zcmMvcmVuZGVyL2dseXBoX2F0bGFzLnRzIiwiLi4vLi4vLi4vc3JjL3NvdXJjZS93b3JrZXJfdGlsZS50cyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvdmVjdG9yX3RpbGVfd29ya2VyX3NvdXJjZS50cyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvcmFzdGVyX2RlbV90aWxlX3dvcmtlcl9zb3VyY2UudHMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvQG1hcGJveC9nZW9qc29uLXJld2luZC9pbmRleC5qcyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvZ2VvanNvbl93cmFwcGVyLnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3Z0LXBiZi9saWIvZ2VvanNvbl93cmFwcGVyLmpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3Z0LXBiZi9pbmRleC5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9zdXBlcmNsdXN0ZXIvaW5kZXguanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvZ2VvanNvbi12dC9nZW9qc29uLXZ0LWRldi5qcyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvZ2VvanNvbl9zb3VyY2VfZGlmZi50cyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvZ2VvanNvbl93b3JrZXJfc291cmNlLnRzIiwiLi4vLi4vLi4vc3JjL3NvdXJjZS93b3JrZXIudHMiXSwic291cmNlc0NvbnRlbnQiOltudWxsLG51bGwsbnVsbCxudWxsLG51bGwsbnVsbCwiXG5tb2R1bGUuZXhwb3J0cyA9IHJld2luZDtcblxuZnVuY3Rpb24gcmV3aW5kKGdqLCBvdXRlcikge1xuICAgIHZhciB0eXBlID0gZ2ogJiYgZ2oudHlwZSwgaTtcblxuICAgIGlmICh0eXBlID09PSAnRmVhdHVyZUNvbGxlY3Rpb24nKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBnai5mZWF0dXJlcy5sZW5ndGg7IGkrKykgcmV3aW5kKGdqLmZlYXR1cmVzW2ldLCBvdXRlcik7XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdHZW9tZXRyeUNvbGxlY3Rpb24nKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBnai5nZW9tZXRyaWVzLmxlbmd0aDsgaSsrKSByZXdpbmQoZ2ouZ2VvbWV0cmllc1tpXSwgb3V0ZXIpO1xuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnRmVhdHVyZScpIHtcbiAgICAgICAgcmV3aW5kKGdqLmdlb21ldHJ5LCBvdXRlcik7XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgICByZXdpbmRSaW5ncyhnai5jb29yZGluYXRlcywgb3V0ZXIpO1xuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlQb2x5Z29uJykge1xuICAgICAgICBmb3IgKGkgPSAwOyBpIDwgZ2ouY29vcmRpbmF0ZXMubGVuZ3RoOyBpKyspIHJld2luZFJpbmdzKGdqLmNvb3JkaW5hdGVzW2ldLCBvdXRlcik7XG4gICAgfVxuXG4gICAgcmV0dXJuIGdqO1xufVxuXG5mdW5jdGlvbiByZXdpbmRSaW5ncyhyaW5ncywgb3V0ZXIpIHtcbiAgICBpZiAocmluZ3MubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICByZXdpbmRSaW5nKHJpbmdzWzBdLCBvdXRlcik7XG4gICAgZm9yICh2YXIgaSA9IDE7IGkgPCByaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICByZXdpbmRSaW5nKHJpbmdzW2ldLCAhb3V0ZXIpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gcmV3aW5kUmluZyhyaW5nLCBkaXIpIHtcbiAgICB2YXIgYXJlYSA9IDAsIGVyciA9IDA7XG4gICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IHJpbmcubGVuZ3RoLCBqID0gbGVuIC0gMTsgaSA8IGxlbjsgaiA9IGkrKykge1xuICAgICAgICB2YXIgayA9IChyaW5nW2ldWzBdIC0gcmluZ1tqXVswXSkgKiAocmluZ1tqXVsxXSArIHJpbmdbaV1bMV0pO1xuICAgICAgICB2YXIgbSA9IGFyZWEgKyBrO1xuICAgICAgICBlcnIgKz0gTWF0aC5hYnMoYXJlYSkgPj0gTWF0aC5hYnMoaykgPyBhcmVhIC0gbSArIGsgOiBrIC0gbSArIGFyZWE7XG4gICAgICAgIGFyZWEgPSBtO1xuICAgIH1cbiAgICBpZiAoYXJlYSArIGVyciA+PSAwICE9PSAhIWRpcikgcmluZy5yZXZlcnNlKCk7XG59XG4iLG51bGwsIid1c2Ugc3RyaWN0J1xuXG52YXIgUG9pbnQgPSByZXF1aXJlKCdAbWFwYm94L3BvaW50LWdlb21ldHJ5JylcbnZhciBWZWN0b3JUaWxlRmVhdHVyZSA9IHJlcXVpcmUoJ0BtYXBib3gvdmVjdG9yLXRpbGUnKS5WZWN0b3JUaWxlRmVhdHVyZVxuXG5tb2R1bGUuZXhwb3J0cyA9IEdlb0pTT05XcmFwcGVyXG5cbi8vIGNvbmZvcm0gdG8gdmVjdG9ydGlsZSBhcGlcbmZ1bmN0aW9uIEdlb0pTT05XcmFwcGVyIChmZWF0dXJlcywgb3B0aW9ucykge1xuICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9XG4gIHRoaXMuZmVhdHVyZXMgPSBmZWF0dXJlc1xuICB0aGlzLmxlbmd0aCA9IGZlYXR1cmVzLmxlbmd0aFxufVxuXG5HZW9KU09OV3JhcHBlci5wcm90b3R5cGUuZmVhdHVyZSA9IGZ1bmN0aW9uIChpKSB7XG4gIHJldHVybiBuZXcgRmVhdHVyZVdyYXBwZXIodGhpcy5mZWF0dXJlc1tpXSwgdGhpcy5vcHRpb25zLmV4dGVudClcbn1cblxuZnVuY3Rpb24gRmVhdHVyZVdyYXBwZXIgKGZlYXR1cmUsIGV4dGVudCkge1xuICB0aGlzLmlkID0gdHlwZW9mIGZlYXR1cmUuaWQgPT09ICdudW1iZXInID8gZmVhdHVyZS5pZCA6IHVuZGVmaW5lZFxuICB0aGlzLnR5cGUgPSBmZWF0dXJlLnR5cGVcbiAgdGhpcy5yYXdHZW9tZXRyeSA9IGZlYXR1cmUudHlwZSA9PT0gMSA/IFtmZWF0dXJlLmdlb21ldHJ5XSA6IGZlYXR1cmUuZ2VvbWV0cnlcbiAgdGhpcy5wcm9wZXJ0aWVzID0gZmVhdHVyZS50YWdzXG4gIHRoaXMuZXh0ZW50ID0gZXh0ZW50IHx8IDQwOTZcbn1cblxuRmVhdHVyZVdyYXBwZXIucHJvdG90eXBlLmxvYWRHZW9tZXRyeSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHJpbmdzID0gdGhpcy5yYXdHZW9tZXRyeVxuICB0aGlzLmdlb21ldHJ5ID0gW11cblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHJpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIHJpbmcgPSByaW5nc1tpXVxuICAgIHZhciBuZXdSaW5nID0gW11cbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJpbmcubGVuZ3RoOyBqKyspIHtcbiAgICAgIG5ld1JpbmcucHVzaChuZXcgUG9pbnQocmluZ1tqXVswXSwgcmluZ1tqXVsxXSkpXG4gICAgfVxuICAgIHRoaXMuZ2VvbWV0cnkucHVzaChuZXdSaW5nKVxuICB9XG4gIHJldHVybiB0aGlzLmdlb21ldHJ5XG59XG5cbkZlYXR1cmVXcmFwcGVyLnByb3RvdHlwZS5iYm94ID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZ2VvbWV0cnkpIHRoaXMubG9hZEdlb21ldHJ5KClcblxuICB2YXIgcmluZ3MgPSB0aGlzLmdlb21ldHJ5XG4gIHZhciB4MSA9IEluZmluaXR5XG4gIHZhciB4MiA9IC1JbmZpbml0eVxuICB2YXIgeTEgPSBJbmZpbml0eVxuICB2YXIgeTIgPSAtSW5maW5pdHlcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHJpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIHJpbmcgPSByaW5nc1tpXVxuXG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCByaW5nLmxlbmd0aDsgaisrKSB7XG4gICAgICB2YXIgY29vcmQgPSByaW5nW2pdXG5cbiAgICAgIHgxID0gTWF0aC5taW4oeDEsIGNvb3JkLngpXG4gICAgICB4MiA9IE1hdGgubWF4KHgyLCBjb29yZC54KVxuICAgICAgeTEgPSBNYXRoLm1pbih5MSwgY29vcmQueSlcbiAgICAgIHkyID0gTWF0aC5tYXgoeTIsIGNvb3JkLnkpXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFt4MSwgeTEsIHgyLCB5Ml1cbn1cblxuRmVhdHVyZVdyYXBwZXIucHJvdG90eXBlLnRvR2VvSlNPTiA9IFZlY3RvclRpbGVGZWF0dXJlLnByb3RvdHlwZS50b0dlb0pTT05cbiIsInZhciBQYmYgPSByZXF1aXJlKCdwYmYnKVxudmFyIEdlb0pTT05XcmFwcGVyID0gcmVxdWlyZSgnLi9saWIvZ2VvanNvbl93cmFwcGVyJylcblxubW9kdWxlLmV4cG9ydHMgPSBmcm9tVmVjdG9yVGlsZUpzXG5tb2R1bGUuZXhwb3J0cy5mcm9tVmVjdG9yVGlsZUpzID0gZnJvbVZlY3RvclRpbGVKc1xubW9kdWxlLmV4cG9ydHMuZnJvbUdlb2pzb25WdCA9IGZyb21HZW9qc29uVnRcbm1vZHVsZS5leHBvcnRzLkdlb0pTT05XcmFwcGVyID0gR2VvSlNPTldyYXBwZXJcblxuLyoqXG4gKiBTZXJpYWxpemUgYSB2ZWN0b3ItdGlsZS1qcy1jcmVhdGVkIHRpbGUgdG8gcGJmXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IHRpbGVcbiAqIEByZXR1cm4ge0J1ZmZlcn0gdW5jb21wcmVzc2VkLCBwYmYtc2VyaWFsaXplZCB0aWxlIGRhdGFcbiAqL1xuZnVuY3Rpb24gZnJvbVZlY3RvclRpbGVKcyAodGlsZSkge1xuICB2YXIgb3V0ID0gbmV3IFBiZigpXG4gIHdyaXRlVGlsZSh0aWxlLCBvdXQpXG4gIHJldHVybiBvdXQuZmluaXNoKClcbn1cblxuLyoqXG4gKiBTZXJpYWxpemVkIGEgZ2VvanNvbi12dC1jcmVhdGVkIHRpbGUgdG8gcGJmLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBsYXllcnMgLSBBbiBvYmplY3QgbWFwcGluZyBsYXllciBuYW1lcyB0byBnZW9qc29uLXZ0LWNyZWF0ZWQgdmVjdG9yIHRpbGUgb2JqZWN0c1xuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEFuIG9iamVjdCBzcGVjaWZ5aW5nIHRoZSB2ZWN0b3ItdGlsZSBzcGVjaWZpY2F0aW9uIHZlcnNpb24gYW5kIGV4dGVudCB0aGF0IHdlcmUgdXNlZCB0byBjcmVhdGUgYGxheWVyc2AuXG4gKiBAcGFyYW0ge051bWJlcn0gW29wdGlvbnMudmVyc2lvbj0xXSAtIFZlcnNpb24gb2YgdmVjdG9yLXRpbGUgc3BlYyB1c2VkXG4gKiBAcGFyYW0ge051bWJlcn0gW29wdGlvbnMuZXh0ZW50PTQwOTZdIC0gRXh0ZW50IG9mIHRoZSB2ZWN0b3IgdGlsZVxuICogQHJldHVybiB7QnVmZmVyfSB1bmNvbXByZXNzZWQsIHBiZi1zZXJpYWxpemVkIHRpbGUgZGF0YVxuICovXG5mdW5jdGlvbiBmcm9tR2VvanNvblZ0IChsYXllcnMsIG9wdGlvbnMpIHtcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge31cbiAgdmFyIGwgPSB7fVxuICBmb3IgKHZhciBrIGluIGxheWVycykge1xuICAgIGxba10gPSBuZXcgR2VvSlNPTldyYXBwZXIobGF5ZXJzW2tdLmZlYXR1cmVzLCBvcHRpb25zKVxuICAgIGxba10ubmFtZSA9IGtcbiAgICBsW2tdLnZlcnNpb24gPSBvcHRpb25zLnZlcnNpb25cbiAgICBsW2tdLmV4dGVudCA9IG9wdGlvbnMuZXh0ZW50XG4gIH1cbiAgcmV0dXJuIGZyb21WZWN0b3JUaWxlSnMoeyBsYXllcnM6IGwgfSlcbn1cblxuZnVuY3Rpb24gd3JpdGVUaWxlICh0aWxlLCBwYmYpIHtcbiAgZm9yICh2YXIga2V5IGluIHRpbGUubGF5ZXJzKSB7XG4gICAgcGJmLndyaXRlTWVzc2FnZSgzLCB3cml0ZUxheWVyLCB0aWxlLmxheWVyc1trZXldKVxuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlTGF5ZXIgKGxheWVyLCBwYmYpIHtcbiAgcGJmLndyaXRlVmFyaW50RmllbGQoMTUsIGxheWVyLnZlcnNpb24gfHwgMSlcbiAgcGJmLndyaXRlU3RyaW5nRmllbGQoMSwgbGF5ZXIubmFtZSB8fCAnJylcbiAgcGJmLndyaXRlVmFyaW50RmllbGQoNSwgbGF5ZXIuZXh0ZW50IHx8IDQwOTYpXG5cbiAgdmFyIGlcbiAgdmFyIGNvbnRleHQgPSB7XG4gICAga2V5czogW10sXG4gICAgdmFsdWVzOiBbXSxcbiAgICBrZXljYWNoZToge30sXG4gICAgdmFsdWVjYWNoZToge31cbiAgfVxuXG4gIGZvciAoaSA9IDA7IGkgPCBsYXllci5sZW5ndGg7IGkrKykge1xuICAgIGNvbnRleHQuZmVhdHVyZSA9IGxheWVyLmZlYXR1cmUoaSlcbiAgICBwYmYud3JpdGVNZXNzYWdlKDIsIHdyaXRlRmVhdHVyZSwgY29udGV4dClcbiAgfVxuXG4gIHZhciBrZXlzID0gY29udGV4dC5rZXlzXG4gIGZvciAoaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgcGJmLndyaXRlU3RyaW5nRmllbGQoMywga2V5c1tpXSlcbiAgfVxuXG4gIHZhciB2YWx1ZXMgPSBjb250ZXh0LnZhbHVlc1xuICBmb3IgKGkgPSAwOyBpIDwgdmFsdWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgcGJmLndyaXRlTWVzc2FnZSg0LCB3cml0ZVZhbHVlLCB2YWx1ZXNbaV0pXG4gIH1cbn1cblxuZnVuY3Rpb24gd3JpdGVGZWF0dXJlIChjb250ZXh0LCBwYmYpIHtcbiAgdmFyIGZlYXR1cmUgPSBjb250ZXh0LmZlYXR1cmVcblxuICBpZiAoZmVhdHVyZS5pZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcGJmLndyaXRlVmFyaW50RmllbGQoMSwgZmVhdHVyZS5pZClcbiAgfVxuXG4gIHBiZi53cml0ZU1lc3NhZ2UoMiwgd3JpdGVQcm9wZXJ0aWVzLCBjb250ZXh0KVxuICBwYmYud3JpdGVWYXJpbnRGaWVsZCgzLCBmZWF0dXJlLnR5cGUpXG4gIHBiZi53cml0ZU1lc3NhZ2UoNCwgd3JpdGVHZW9tZXRyeSwgZmVhdHVyZSlcbn1cblxuZnVuY3Rpb24gd3JpdGVQcm9wZXJ0aWVzIChjb250ZXh0LCBwYmYpIHtcbiAgdmFyIGZlYXR1cmUgPSBjb250ZXh0LmZlYXR1cmVcbiAgdmFyIGtleXMgPSBjb250ZXh0LmtleXNcbiAgdmFyIHZhbHVlcyA9IGNvbnRleHQudmFsdWVzXG4gIHZhciBrZXljYWNoZSA9IGNvbnRleHQua2V5Y2FjaGVcbiAgdmFyIHZhbHVlY2FjaGUgPSBjb250ZXh0LnZhbHVlY2FjaGVcblxuICBmb3IgKHZhciBrZXkgaW4gZmVhdHVyZS5wcm9wZXJ0aWVzKSB7XG4gICAgdmFyIHZhbHVlID0gZmVhdHVyZS5wcm9wZXJ0aWVzW2tleV1cblxuICAgIHZhciBrZXlJbmRleCA9IGtleWNhY2hlW2tleV1cbiAgICBpZiAodmFsdWUgPT09IG51bGwpIGNvbnRpbnVlIC8vIGRvbid0IGVuY29kZSBudWxsIHZhbHVlIHByb3BlcnRpZXNcblxuICAgIGlmICh0eXBlb2Yga2V5SW5kZXggPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBrZXlzLnB1c2goa2V5KVxuICAgICAga2V5SW5kZXggPSBrZXlzLmxlbmd0aCAtIDFcbiAgICAgIGtleWNhY2hlW2tleV0gPSBrZXlJbmRleFxuICAgIH1cbiAgICBwYmYud3JpdGVWYXJpbnQoa2V5SW5kZXgpXG5cbiAgICB2YXIgdHlwZSA9IHR5cGVvZiB2YWx1ZVxuICAgIGlmICh0eXBlICE9PSAnc3RyaW5nJyAmJiB0eXBlICE9PSAnYm9vbGVhbicgJiYgdHlwZSAhPT0gJ251bWJlcicpIHtcbiAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpXG4gICAgfVxuICAgIHZhciB2YWx1ZUtleSA9IHR5cGUgKyAnOicgKyB2YWx1ZVxuICAgIHZhciB2YWx1ZUluZGV4ID0gdmFsdWVjYWNoZVt2YWx1ZUtleV1cbiAgICBpZiAodHlwZW9mIHZhbHVlSW5kZXggPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB2YWx1ZXMucHVzaCh2YWx1ZSlcbiAgICAgIHZhbHVlSW5kZXggPSB2YWx1ZXMubGVuZ3RoIC0gMVxuICAgICAgdmFsdWVjYWNoZVt2YWx1ZUtleV0gPSB2YWx1ZUluZGV4XG4gICAgfVxuICAgIHBiZi53cml0ZVZhcmludCh2YWx1ZUluZGV4KVxuICB9XG59XG5cbmZ1bmN0aW9uIGNvbW1hbmQgKGNtZCwgbGVuZ3RoKSB7XG4gIHJldHVybiAobGVuZ3RoIDw8IDMpICsgKGNtZCAmIDB4Nylcbn1cblxuZnVuY3Rpb24gemlnemFnIChudW0pIHtcbiAgcmV0dXJuIChudW0gPDwgMSkgXiAobnVtID4+IDMxKVxufVxuXG5mdW5jdGlvbiB3cml0ZUdlb21ldHJ5IChmZWF0dXJlLCBwYmYpIHtcbiAgdmFyIGdlb21ldHJ5ID0gZmVhdHVyZS5sb2FkR2VvbWV0cnkoKVxuICB2YXIgdHlwZSA9IGZlYXR1cmUudHlwZVxuICB2YXIgeCA9IDBcbiAgdmFyIHkgPSAwXG4gIHZhciByaW5ncyA9IGdlb21ldHJ5Lmxlbmd0aFxuICBmb3IgKHZhciByID0gMDsgciA8IHJpbmdzOyByKyspIHtcbiAgICB2YXIgcmluZyA9IGdlb21ldHJ5W3JdXG4gICAgdmFyIGNvdW50ID0gMVxuICAgIGlmICh0eXBlID09PSAxKSB7XG4gICAgICBjb3VudCA9IHJpbmcubGVuZ3RoXG4gICAgfVxuICAgIHBiZi53cml0ZVZhcmludChjb21tYW5kKDEsIGNvdW50KSkgLy8gbW92ZXRvXG4gICAgLy8gZG8gbm90IHdyaXRlIHBvbHlnb24gY2xvc2luZyBwYXRoIGFzIGxpbmV0b1xuICAgIHZhciBsaW5lQ291bnQgPSB0eXBlID09PSAzID8gcmluZy5sZW5ndGggLSAxIDogcmluZy5sZW5ndGhcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVDb3VudDsgaSsrKSB7XG4gICAgICBpZiAoaSA9PT0gMSAmJiB0eXBlICE9PSAxKSB7XG4gICAgICAgIHBiZi53cml0ZVZhcmludChjb21tYW5kKDIsIGxpbmVDb3VudCAtIDEpKSAvLyBsaW5ldG9cbiAgICAgIH1cbiAgICAgIHZhciBkeCA9IHJpbmdbaV0ueCAtIHhcbiAgICAgIHZhciBkeSA9IHJpbmdbaV0ueSAtIHlcbiAgICAgIHBiZi53cml0ZVZhcmludCh6aWd6YWcoZHgpKVxuICAgICAgcGJmLndyaXRlVmFyaW50KHppZ3phZyhkeSkpXG4gICAgICB4ICs9IGR4XG4gICAgICB5ICs9IGR5XG4gICAgfVxuICAgIGlmICh0eXBlID09PSAzKSB7XG4gICAgICBwYmYud3JpdGVWYXJpbnQoY29tbWFuZCg3LCAxKSkgLy8gY2xvc2VwYXRoXG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlVmFsdWUgKHZhbHVlLCBwYmYpIHtcbiAgdmFyIHR5cGUgPSB0eXBlb2YgdmFsdWVcbiAgaWYgKHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgcGJmLndyaXRlU3RyaW5nRmllbGQoMSwgdmFsdWUpXG4gIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgcGJmLndyaXRlQm9vbGVhbkZpZWxkKDcsIHZhbHVlKVxuICB9IGVsc2UgaWYgKHR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgaWYgKHZhbHVlICUgMSAhPT0gMCkge1xuICAgICAgcGJmLndyaXRlRG91YmxlRmllbGQoMywgdmFsdWUpXG4gICAgfSBlbHNlIGlmICh2YWx1ZSA8IDApIHtcbiAgICAgIHBiZi53cml0ZVNWYXJpbnRGaWVsZCg2LCB2YWx1ZSlcbiAgICB9IGVsc2Uge1xuICAgICAgcGJmLndyaXRlVmFyaW50RmllbGQoNSwgdmFsdWUpXG4gICAgfVxuICB9XG59XG4iLCJcbmltcG9ydCBLREJ1c2ggZnJvbSAna2RidXNoJztcblxuY29uc3QgZGVmYXVsdE9wdGlvbnMgPSB7XG4gICAgbWluWm9vbTogMCwgICAvLyBtaW4gem9vbSB0byBnZW5lcmF0ZSBjbHVzdGVycyBvblxuICAgIG1heFpvb206IDE2LCAgLy8gbWF4IHpvb20gbGV2ZWwgdG8gY2x1c3RlciB0aGUgcG9pbnRzIG9uXG4gICAgbWluUG9pbnRzOiAyLCAvLyBtaW5pbXVtIHBvaW50cyB0byBmb3JtIGEgY2x1c3RlclxuICAgIHJhZGl1czogNDAsICAgLy8gY2x1c3RlciByYWRpdXMgaW4gcGl4ZWxzXG4gICAgZXh0ZW50OiA1MTIsICAvLyB0aWxlIGV4dGVudCAocmFkaXVzIGlzIGNhbGN1bGF0ZWQgcmVsYXRpdmUgdG8gaXQpXG4gICAgbm9kZVNpemU6IDY0LCAvLyBzaXplIG9mIHRoZSBLRC10cmVlIGxlYWYgbm9kZSwgYWZmZWN0cyBwZXJmb3JtYW5jZVxuICAgIGxvZzogZmFsc2UsICAgLy8gd2hldGhlciB0byBsb2cgdGltaW5nIGluZm9cblxuICAgIC8vIHdoZXRoZXIgdG8gZ2VuZXJhdGUgbnVtZXJpYyBpZHMgZm9yIGlucHV0IGZlYXR1cmVzIChpbiB2ZWN0b3IgdGlsZXMpXG4gICAgZ2VuZXJhdGVJZDogZmFsc2UsXG5cbiAgICAvLyBhIHJlZHVjZSBmdW5jdGlvbiBmb3IgY2FsY3VsYXRpbmcgY3VzdG9tIGNsdXN0ZXIgcHJvcGVydGllc1xuICAgIHJlZHVjZTogbnVsbCwgLy8gKGFjY3VtdWxhdGVkLCBwcm9wcykgPT4geyBhY2N1bXVsYXRlZC5zdW0gKz0gcHJvcHMuc3VtOyB9XG5cbiAgICAvLyBwcm9wZXJ0aWVzIHRvIHVzZSBmb3IgaW5kaXZpZHVhbCBwb2ludHMgd2hlbiBydW5uaW5nIHRoZSByZWR1Y2VyXG4gICAgbWFwOiBwcm9wcyA9PiBwcm9wcyAvLyBwcm9wcyA9PiAoe3N1bTogcHJvcHMubXlfdmFsdWV9KVxufTtcblxuY29uc3QgZnJvdW5kID0gTWF0aC5mcm91bmQgfHwgKHRtcCA9PiAoKHgpID0+IHsgdG1wWzBdID0gK3g7IHJldHVybiB0bXBbMF07IH0pKShuZXcgRmxvYXQzMkFycmF5KDEpKTtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgU3VwZXJjbHVzdGVyIHtcbiAgICBjb25zdHJ1Y3RvcihvcHRpb25zKSB7XG4gICAgICAgIHRoaXMub3B0aW9ucyA9IGV4dGVuZChPYmplY3QuY3JlYXRlKGRlZmF1bHRPcHRpb25zKSwgb3B0aW9ucyk7XG4gICAgICAgIHRoaXMudHJlZXMgPSBuZXcgQXJyYXkodGhpcy5vcHRpb25zLm1heFpvb20gKyAxKTtcbiAgICB9XG5cbiAgICBsb2FkKHBvaW50cykge1xuICAgICAgICBjb25zdCB7bG9nLCBtaW5ab29tLCBtYXhab29tLCBub2RlU2l6ZX0gPSB0aGlzLm9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGxvZykgY29uc29sZS50aW1lKCd0b3RhbCB0aW1lJyk7XG5cbiAgICAgICAgY29uc3QgdGltZXJJZCA9IGBwcmVwYXJlICR7ICBwb2ludHMubGVuZ3RoICB9IHBvaW50c2A7XG4gICAgICAgIGlmIChsb2cpIGNvbnNvbGUudGltZSh0aW1lcklkKTtcblxuICAgICAgICB0aGlzLnBvaW50cyA9IHBvaW50cztcblxuICAgICAgICAvLyBnZW5lcmF0ZSBhIGNsdXN0ZXIgb2JqZWN0IGZvciBlYWNoIHBvaW50IGFuZCBpbmRleCBpbnB1dCBwb2ludHMgaW50byBhIEtELXRyZWVcbiAgICAgICAgbGV0IGNsdXN0ZXJzID0gW107XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcG9pbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBpZiAoIXBvaW50c1tpXS5nZW9tZXRyeSkgY29udGludWU7XG4gICAgICAgICAgICBjbHVzdGVycy5wdXNoKGNyZWF0ZVBvaW50Q2x1c3Rlcihwb2ludHNbaV0sIGkpKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnRyZWVzW21heFpvb20gKyAxXSA9IG5ldyBLREJ1c2goY2x1c3RlcnMsIGdldFgsIGdldFksIG5vZGVTaXplLCBGbG9hdDMyQXJyYXkpO1xuXG4gICAgICAgIGlmIChsb2cpIGNvbnNvbGUudGltZUVuZCh0aW1lcklkKTtcblxuICAgICAgICAvLyBjbHVzdGVyIHBvaW50cyBvbiBtYXggem9vbSwgdGhlbiBjbHVzdGVyIHRoZSByZXN1bHRzIG9uIHByZXZpb3VzIHpvb20sIGV0Yy47XG4gICAgICAgIC8vIHJlc3VsdHMgaW4gYSBjbHVzdGVyIGhpZXJhcmNoeSBhY3Jvc3Mgem9vbSBsZXZlbHNcbiAgICAgICAgZm9yIChsZXQgeiA9IG1heFpvb207IHogPj0gbWluWm9vbTsgei0tKSB7XG4gICAgICAgICAgICBjb25zdCBub3cgPSArRGF0ZS5ub3coKTtcblxuICAgICAgICAgICAgLy8gY3JlYXRlIGEgbmV3IHNldCBvZiBjbHVzdGVycyBmb3IgdGhlIHpvb20gYW5kIGluZGV4IHRoZW0gd2l0aCBhIEtELXRyZWVcbiAgICAgICAgICAgIGNsdXN0ZXJzID0gdGhpcy5fY2x1c3RlcihjbHVzdGVycywgeik7XG4gICAgICAgICAgICB0aGlzLnRyZWVzW3pdID0gbmV3IEtEQnVzaChjbHVzdGVycywgZ2V0WCwgZ2V0WSwgbm9kZVNpemUsIEZsb2F0MzJBcnJheSk7XG5cbiAgICAgICAgICAgIGlmIChsb2cpIGNvbnNvbGUubG9nKCd6JWQ6ICVkIGNsdXN0ZXJzIGluICVkbXMnLCB6LCBjbHVzdGVycy5sZW5ndGgsICtEYXRlLm5vdygpIC0gbm93KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChsb2cpIGNvbnNvbGUudGltZUVuZCgndG90YWwgdGltZScpO1xuXG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIGdldENsdXN0ZXJzKGJib3gsIHpvb20pIHtcbiAgICAgICAgbGV0IG1pbkxuZyA9ICgoYmJveFswXSArIDE4MCkgJSAzNjAgKyAzNjApICUgMzYwIC0gMTgwO1xuICAgICAgICBjb25zdCBtaW5MYXQgPSBNYXRoLm1heCgtOTAsIE1hdGgubWluKDkwLCBiYm94WzFdKSk7XG4gICAgICAgIGxldCBtYXhMbmcgPSBiYm94WzJdID09PSAxODAgPyAxODAgOiAoKGJib3hbMl0gKyAxODApICUgMzYwICsgMzYwKSAlIDM2MCAtIDE4MDtcbiAgICAgICAgY29uc3QgbWF4TGF0ID0gTWF0aC5tYXgoLTkwLCBNYXRoLm1pbig5MCwgYmJveFszXSkpO1xuXG4gICAgICAgIGlmIChiYm94WzJdIC0gYmJveFswXSA+PSAzNjApIHtcbiAgICAgICAgICAgIG1pbkxuZyA9IC0xODA7XG4gICAgICAgICAgICBtYXhMbmcgPSAxODA7XG4gICAgICAgIH0gZWxzZSBpZiAobWluTG5nID4gbWF4TG5nKSB7XG4gICAgICAgICAgICBjb25zdCBlYXN0ZXJuSGVtID0gdGhpcy5nZXRDbHVzdGVycyhbbWluTG5nLCBtaW5MYXQsIDE4MCwgbWF4TGF0XSwgem9vbSk7XG4gICAgICAgICAgICBjb25zdCB3ZXN0ZXJuSGVtID0gdGhpcy5nZXRDbHVzdGVycyhbLTE4MCwgbWluTGF0LCBtYXhMbmcsIG1heExhdF0sIHpvb20pO1xuICAgICAgICAgICAgcmV0dXJuIGVhc3Rlcm5IZW0uY29uY2F0KHdlc3Rlcm5IZW0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdHJlZSA9IHRoaXMudHJlZXNbdGhpcy5fbGltaXRab29tKHpvb20pXTtcbiAgICAgICAgY29uc3QgaWRzID0gdHJlZS5yYW5nZShsbmdYKG1pbkxuZyksIGxhdFkobWF4TGF0KSwgbG5nWChtYXhMbmcpLCBsYXRZKG1pbkxhdCkpO1xuICAgICAgICBjb25zdCBjbHVzdGVycyA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGlkIG9mIGlkcykge1xuICAgICAgICAgICAgY29uc3QgYyA9IHRyZWUucG9pbnRzW2lkXTtcbiAgICAgICAgICAgIGNsdXN0ZXJzLnB1c2goYy5udW1Qb2ludHMgPyBnZXRDbHVzdGVySlNPTihjKSA6IHRoaXMucG9pbnRzW2MuaW5kZXhdKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY2x1c3RlcnM7XG4gICAgfVxuXG4gICAgZ2V0Q2hpbGRyZW4oY2x1c3RlcklkKSB7XG4gICAgICAgIGNvbnN0IG9yaWdpbklkID0gdGhpcy5fZ2V0T3JpZ2luSWQoY2x1c3RlcklkKTtcbiAgICAgICAgY29uc3Qgb3JpZ2luWm9vbSA9IHRoaXMuX2dldE9yaWdpblpvb20oY2x1c3RlcklkKTtcbiAgICAgICAgY29uc3QgZXJyb3JNc2cgPSAnTm8gY2x1c3RlciB3aXRoIHRoZSBzcGVjaWZpZWQgaWQuJztcblxuICAgICAgICBjb25zdCBpbmRleCA9IHRoaXMudHJlZXNbb3JpZ2luWm9vbV07XG4gICAgICAgIGlmICghaW5kZXgpIHRocm93IG5ldyBFcnJvcihlcnJvck1zZyk7XG5cbiAgICAgICAgY29uc3Qgb3JpZ2luID0gaW5kZXgucG9pbnRzW29yaWdpbklkXTtcbiAgICAgICAgaWYgKCFvcmlnaW4pIHRocm93IG5ldyBFcnJvcihlcnJvck1zZyk7XG5cbiAgICAgICAgY29uc3QgciA9IHRoaXMub3B0aW9ucy5yYWRpdXMgLyAodGhpcy5vcHRpb25zLmV4dGVudCAqIE1hdGgucG93KDIsIG9yaWdpblpvb20gLSAxKSk7XG4gICAgICAgIGNvbnN0IGlkcyA9IGluZGV4LndpdGhpbihvcmlnaW4ueCwgb3JpZ2luLnksIHIpO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGlkIG9mIGlkcykge1xuICAgICAgICAgICAgY29uc3QgYyA9IGluZGV4LnBvaW50c1tpZF07XG4gICAgICAgICAgICBpZiAoYy5wYXJlbnRJZCA9PT0gY2x1c3RlcklkKSB7XG4gICAgICAgICAgICAgICAgY2hpbGRyZW4ucHVzaChjLm51bVBvaW50cyA/IGdldENsdXN0ZXJKU09OKGMpIDogdGhpcy5wb2ludHNbYy5pbmRleF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA9PT0gMCkgdGhyb3cgbmV3IEVycm9yKGVycm9yTXNnKTtcblxuICAgICAgICByZXR1cm4gY2hpbGRyZW47XG4gICAgfVxuXG4gICAgZ2V0TGVhdmVzKGNsdXN0ZXJJZCwgbGltaXQsIG9mZnNldCkge1xuICAgICAgICBsaW1pdCA9IGxpbWl0IHx8IDEwO1xuICAgICAgICBvZmZzZXQgPSBvZmZzZXQgfHwgMDtcblxuICAgICAgICBjb25zdCBsZWF2ZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fYXBwZW5kTGVhdmVzKGxlYXZlcywgY2x1c3RlcklkLCBsaW1pdCwgb2Zmc2V0LCAwKTtcblxuICAgICAgICByZXR1cm4gbGVhdmVzO1xuICAgIH1cblxuICAgIGdldFRpbGUoeiwgeCwgeSkge1xuICAgICAgICBjb25zdCB0cmVlID0gdGhpcy50cmVlc1t0aGlzLl9saW1pdFpvb20oeildO1xuICAgICAgICBjb25zdCB6MiA9IE1hdGgucG93KDIsIHopO1xuICAgICAgICBjb25zdCB7ZXh0ZW50LCByYWRpdXN9ID0gdGhpcy5vcHRpb25zO1xuICAgICAgICBjb25zdCBwID0gcmFkaXVzIC8gZXh0ZW50O1xuICAgICAgICBjb25zdCB0b3AgPSAoeSAtIHApIC8gejI7XG4gICAgICAgIGNvbnN0IGJvdHRvbSA9ICh5ICsgMSArIHApIC8gejI7XG5cbiAgICAgICAgY29uc3QgdGlsZSA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbXVxuICAgICAgICB9O1xuXG4gICAgICAgIHRoaXMuX2FkZFRpbGVGZWF0dXJlcyhcbiAgICAgICAgICAgIHRyZWUucmFuZ2UoKHggLSBwKSAvIHoyLCB0b3AsICh4ICsgMSArIHApIC8gejIsIGJvdHRvbSksXG4gICAgICAgICAgICB0cmVlLnBvaW50cywgeCwgeSwgejIsIHRpbGUpO1xuXG4gICAgICAgIGlmICh4ID09PSAwKSB7XG4gICAgICAgICAgICB0aGlzLl9hZGRUaWxlRmVhdHVyZXMoXG4gICAgICAgICAgICAgICAgdHJlZS5yYW5nZSgxIC0gcCAvIHoyLCB0b3AsIDEsIGJvdHRvbSksXG4gICAgICAgICAgICAgICAgdHJlZS5wb2ludHMsIHoyLCB5LCB6MiwgdGlsZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHggPT09IHoyIC0gMSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkVGlsZUZlYXR1cmVzKFxuICAgICAgICAgICAgICAgIHRyZWUucmFuZ2UoMCwgdG9wLCBwIC8gejIsIGJvdHRvbSksXG4gICAgICAgICAgICAgICAgdHJlZS5wb2ludHMsIC0xLCB5LCB6MiwgdGlsZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGlsZS5mZWF0dXJlcy5sZW5ndGggPyB0aWxlIDogbnVsbDtcbiAgICB9XG5cbiAgICBnZXRDbHVzdGVyRXhwYW5zaW9uWm9vbShjbHVzdGVySWQpIHtcbiAgICAgICAgbGV0IGV4cGFuc2lvblpvb20gPSB0aGlzLl9nZXRPcmlnaW5ab29tKGNsdXN0ZXJJZCkgLSAxO1xuICAgICAgICB3aGlsZSAoZXhwYW5zaW9uWm9vbSA8PSB0aGlzLm9wdGlvbnMubWF4Wm9vbSkge1xuICAgICAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB0aGlzLmdldENoaWxkcmVuKGNsdXN0ZXJJZCk7XG4gICAgICAgICAgICBleHBhbnNpb25ab29tKys7XG4gICAgICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoICE9PSAxKSBicmVhaztcbiAgICAgICAgICAgIGNsdXN0ZXJJZCA9IGNoaWxkcmVuWzBdLnByb3BlcnRpZXMuY2x1c3Rlcl9pZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZXhwYW5zaW9uWm9vbTtcbiAgICB9XG5cbiAgICBfYXBwZW5kTGVhdmVzKHJlc3VsdCwgY2x1c3RlcklkLCBsaW1pdCwgb2Zmc2V0LCBza2lwcGVkKSB7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5nZXRDaGlsZHJlbihjbHVzdGVySWQpO1xuXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHtcbiAgICAgICAgICAgIGNvbnN0IHByb3BzID0gY2hpbGQucHJvcGVydGllcztcblxuICAgICAgICAgICAgaWYgKHByb3BzICYmIHByb3BzLmNsdXN0ZXIpIHtcbiAgICAgICAgICAgICAgICBpZiAoc2tpcHBlZCArIHByb3BzLnBvaW50X2NvdW50IDw9IG9mZnNldCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBza2lwIHRoZSB3aG9sZSBjbHVzdGVyXG4gICAgICAgICAgICAgICAgICAgIHNraXBwZWQgKz0gcHJvcHMucG9pbnRfY291bnQ7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gZW50ZXIgdGhlIGNsdXN0ZXJcbiAgICAgICAgICAgICAgICAgICAgc2tpcHBlZCA9IHRoaXMuX2FwcGVuZExlYXZlcyhyZXN1bHQsIHByb3BzLmNsdXN0ZXJfaWQsIGxpbWl0LCBvZmZzZXQsIHNraXBwZWQpO1xuICAgICAgICAgICAgICAgICAgICAvLyBleGl0IHRoZSBjbHVzdGVyXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChza2lwcGVkIDwgb2Zmc2V0KSB7XG4gICAgICAgICAgICAgICAgLy8gc2tpcCBhIHNpbmdsZSBwb2ludFxuICAgICAgICAgICAgICAgIHNraXBwZWQrKztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gYWRkIGEgc2luZ2xlIHBvaW50XG4gICAgICAgICAgICAgICAgcmVzdWx0LnB1c2goY2hpbGQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlc3VsdC5sZW5ndGggPT09IGxpbWl0KSBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBza2lwcGVkO1xuICAgIH1cblxuICAgIF9hZGRUaWxlRmVhdHVyZXMoaWRzLCBwb2ludHMsIHgsIHksIHoyLCB0aWxlKSB7XG4gICAgICAgIGZvciAoY29uc3QgaSBvZiBpZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IGMgPSBwb2ludHNbaV07XG4gICAgICAgICAgICBjb25zdCBpc0NsdXN0ZXIgPSBjLm51bVBvaW50cztcblxuICAgICAgICAgICAgbGV0IHRhZ3MsIHB4LCBweTtcbiAgICAgICAgICAgIGlmIChpc0NsdXN0ZXIpIHtcbiAgICAgICAgICAgICAgICB0YWdzID0gZ2V0Q2x1c3RlclByb3BlcnRpZXMoYyk7XG4gICAgICAgICAgICAgICAgcHggPSBjLng7XG4gICAgICAgICAgICAgICAgcHkgPSBjLnk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IHAgPSB0aGlzLnBvaW50c1tjLmluZGV4XTtcbiAgICAgICAgICAgICAgICB0YWdzID0gcC5wcm9wZXJ0aWVzO1xuICAgICAgICAgICAgICAgIHB4ID0gbG5nWChwLmdlb21ldHJ5LmNvb3JkaW5hdGVzWzBdKTtcbiAgICAgICAgICAgICAgICBweSA9IGxhdFkocC5nZW9tZXRyeS5jb29yZGluYXRlc1sxXSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGYgPSB7XG4gICAgICAgICAgICAgICAgdHlwZTogMSxcbiAgICAgICAgICAgICAgICBnZW9tZXRyeTogW1tcbiAgICAgICAgICAgICAgICAgICAgTWF0aC5yb3VuZCh0aGlzLm9wdGlvbnMuZXh0ZW50ICogKHB4ICogejIgLSB4KSksXG4gICAgICAgICAgICAgICAgICAgIE1hdGgucm91bmQodGhpcy5vcHRpb25zLmV4dGVudCAqIChweSAqIHoyIC0geSkpXG4gICAgICAgICAgICAgICAgXV0sXG4gICAgICAgICAgICAgICAgdGFnc1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgLy8gYXNzaWduIGlkXG4gICAgICAgICAgICBsZXQgaWQ7XG4gICAgICAgICAgICBpZiAoaXNDbHVzdGVyKSB7XG4gICAgICAgICAgICAgICAgaWQgPSBjLmlkO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLm9wdGlvbnMuZ2VuZXJhdGVJZCkge1xuICAgICAgICAgICAgICAgIC8vIG9wdGlvbmFsbHkgZ2VuZXJhdGUgaWRcbiAgICAgICAgICAgICAgICBpZCA9IGMuaW5kZXg7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMucG9pbnRzW2MuaW5kZXhdLmlkKSB7XG4gICAgICAgICAgICAgICAgLy8ga2VlcCBpZCBpZiBhbHJlYWR5IGFzc2lnbmVkXG4gICAgICAgICAgICAgICAgaWQgPSB0aGlzLnBvaW50c1tjLmluZGV4XS5pZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGlkICE9PSB1bmRlZmluZWQpIGYuaWQgPSBpZDtcblxuICAgICAgICAgICAgdGlsZS5mZWF0dXJlcy5wdXNoKGYpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2xpbWl0Wm9vbSh6KSB7XG4gICAgICAgIHJldHVybiBNYXRoLm1heCh0aGlzLm9wdGlvbnMubWluWm9vbSwgTWF0aC5taW4oTWF0aC5mbG9vcigreiksIHRoaXMub3B0aW9ucy5tYXhab29tICsgMSkpO1xuICAgIH1cblxuICAgIF9jbHVzdGVyKHBvaW50cywgem9vbSkge1xuICAgICAgICBjb25zdCBjbHVzdGVycyA9IFtdO1xuICAgICAgICBjb25zdCB7cmFkaXVzLCBleHRlbnQsIHJlZHVjZSwgbWluUG9pbnRzfSA9IHRoaXMub3B0aW9ucztcbiAgICAgICAgY29uc3QgciA9IHJhZGl1cyAvIChleHRlbnQgKiBNYXRoLnBvdygyLCB6b29tKSk7XG5cbiAgICAgICAgLy8gbG9vcCB0aHJvdWdoIGVhY2ggcG9pbnRcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwb2ludHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGNvbnN0IHAgPSBwb2ludHNbaV07XG4gICAgICAgICAgICAvLyBpZiB3ZSd2ZSBhbHJlYWR5IHZpc2l0ZWQgdGhlIHBvaW50IGF0IHRoaXMgem9vbSBsZXZlbCwgc2tpcCBpdFxuICAgICAgICAgICAgaWYgKHAuem9vbSA8PSB6b29tKSBjb250aW51ZTtcbiAgICAgICAgICAgIHAuem9vbSA9IHpvb207XG5cbiAgICAgICAgICAgIC8vIGZpbmQgYWxsIG5lYXJieSBwb2ludHNcbiAgICAgICAgICAgIGNvbnN0IHRyZWUgPSB0aGlzLnRyZWVzW3pvb20gKyAxXTtcbiAgICAgICAgICAgIGNvbnN0IG5laWdoYm9ySWRzID0gdHJlZS53aXRoaW4ocC54LCBwLnksIHIpO1xuXG4gICAgICAgICAgICBjb25zdCBudW1Qb2ludHNPcmlnaW4gPSBwLm51bVBvaW50cyB8fCAxO1xuICAgICAgICAgICAgbGV0IG51bVBvaW50cyA9IG51bVBvaW50c09yaWdpbjtcblxuICAgICAgICAgICAgLy8gY291bnQgdGhlIG51bWJlciBvZiBwb2ludHMgaW4gYSBwb3RlbnRpYWwgY2x1c3RlclxuICAgICAgICAgICAgZm9yIChjb25zdCBuZWlnaGJvcklkIG9mIG5laWdoYm9ySWRzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYiA9IHRyZWUucG9pbnRzW25laWdoYm9ySWRdO1xuICAgICAgICAgICAgICAgIC8vIGZpbHRlciBvdXQgbmVpZ2hib3JzIHRoYXQgYXJlIGFscmVhZHkgcHJvY2Vzc2VkXG4gICAgICAgICAgICAgICAgaWYgKGIuem9vbSA+IHpvb20pIG51bVBvaW50cyArPSBiLm51bVBvaW50cyB8fCAxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBpZiB0aGVyZSB3ZXJlIG5laWdoYm9ycyB0byBtZXJnZSwgYW5kIHRoZXJlIGFyZSBlbm91Z2ggcG9pbnRzIHRvIGZvcm0gYSBjbHVzdGVyXG4gICAgICAgICAgICBpZiAobnVtUG9pbnRzID4gbnVtUG9pbnRzT3JpZ2luICYmIG51bVBvaW50cyA+PSBtaW5Qb2ludHMpIHtcbiAgICAgICAgICAgICAgICBsZXQgd3ggPSBwLnggKiBudW1Qb2ludHNPcmlnaW47XG4gICAgICAgICAgICAgICAgbGV0IHd5ID0gcC55ICogbnVtUG9pbnRzT3JpZ2luO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNsdXN0ZXJQcm9wZXJ0aWVzID0gcmVkdWNlICYmIG51bVBvaW50c09yaWdpbiA+IDEgPyB0aGlzLl9tYXAocCwgdHJ1ZSkgOiBudWxsO1xuXG4gICAgICAgICAgICAgICAgLy8gZW5jb2RlIGJvdGggem9vbSBhbmQgcG9pbnQgaW5kZXggb24gd2hpY2ggdGhlIGNsdXN0ZXIgb3JpZ2luYXRlZCAtLSBvZmZzZXQgYnkgdG90YWwgbGVuZ3RoIG9mIGZlYXR1cmVzXG4gICAgICAgICAgICAgICAgY29uc3QgaWQgPSAoaSA8PCA1KSArICh6b29tICsgMSkgKyB0aGlzLnBvaW50cy5sZW5ndGg7XG5cbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IG5laWdoYm9ySWQgb2YgbmVpZ2hib3JJZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgYiA9IHRyZWUucG9pbnRzW25laWdoYm9ySWRdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChiLnpvb20gPD0gem9vbSkgY29udGludWU7XG4gICAgICAgICAgICAgICAgICAgIGIuem9vbSA9IHpvb207IC8vIHNhdmUgdGhlIHpvb20gKHNvIGl0IGRvZXNuJ3QgZ2V0IHByb2Nlc3NlZCB0d2ljZSlcblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBudW1Qb2ludHMyID0gYi5udW1Qb2ludHMgfHwgMTtcbiAgICAgICAgICAgICAgICAgICAgd3ggKz0gYi54ICogbnVtUG9pbnRzMjsgLy8gYWNjdW11bGF0ZSBjb29yZGluYXRlcyBmb3IgY2FsY3VsYXRpbmcgd2VpZ2h0ZWQgY2VudGVyXG4gICAgICAgICAgICAgICAgICAgIHd5ICs9IGIueSAqIG51bVBvaW50czI7XG5cbiAgICAgICAgICAgICAgICAgICAgYi5wYXJlbnRJZCA9IGlkO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWR1Y2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY2x1c3RlclByb3BlcnRpZXMpIGNsdXN0ZXJQcm9wZXJ0aWVzID0gdGhpcy5fbWFwKHAsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVkdWNlKGNsdXN0ZXJQcm9wZXJ0aWVzLCB0aGlzLl9tYXAoYikpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcC5wYXJlbnRJZCA9IGlkO1xuICAgICAgICAgICAgICAgIGNsdXN0ZXJzLnB1c2goY3JlYXRlQ2x1c3Rlcih3eCAvIG51bVBvaW50cywgd3kgLyBudW1Qb2ludHMsIGlkLCBudW1Qb2ludHMsIGNsdXN0ZXJQcm9wZXJ0aWVzKSk7XG5cbiAgICAgICAgICAgIH0gZWxzZSB7IC8vIGxlZnQgcG9pbnRzIGFzIHVuY2x1c3RlcmVkXG4gICAgICAgICAgICAgICAgY2x1c3RlcnMucHVzaChwKTtcblxuICAgICAgICAgICAgICAgIGlmIChudW1Qb2ludHMgPiAxKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgbmVpZ2hib3JJZCBvZiBuZWlnaGJvcklkcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYiA9IHRyZWUucG9pbnRzW25laWdoYm9ySWRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGIuem9vbSA8PSB6b29tKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGIuem9vbSA9IHpvb207XG4gICAgICAgICAgICAgICAgICAgICAgICBjbHVzdGVycy5wdXNoKGIpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNsdXN0ZXJzO1xuICAgIH1cblxuICAgIC8vIGdldCBpbmRleCBvZiB0aGUgcG9pbnQgZnJvbSB3aGljaCB0aGUgY2x1c3RlciBvcmlnaW5hdGVkXG4gICAgX2dldE9yaWdpbklkKGNsdXN0ZXJJZCkge1xuICAgICAgICByZXR1cm4gKGNsdXN0ZXJJZCAtIHRoaXMucG9pbnRzLmxlbmd0aCkgPj4gNTtcbiAgICB9XG5cbiAgICAvLyBnZXQgem9vbSBvZiB0aGUgcG9pbnQgZnJvbSB3aGljaCB0aGUgY2x1c3RlciBvcmlnaW5hdGVkXG4gICAgX2dldE9yaWdpblpvb20oY2x1c3RlcklkKSB7XG4gICAgICAgIHJldHVybiAoY2x1c3RlcklkIC0gdGhpcy5wb2ludHMubGVuZ3RoKSAlIDMyO1xuICAgIH1cblxuICAgIF9tYXAocG9pbnQsIGNsb25lKSB7XG4gICAgICAgIGlmIChwb2ludC5udW1Qb2ludHMpIHtcbiAgICAgICAgICAgIHJldHVybiBjbG9uZSA/IGV4dGVuZCh7fSwgcG9pbnQucHJvcGVydGllcykgOiBwb2ludC5wcm9wZXJ0aWVzO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG9yaWdpbmFsID0gdGhpcy5wb2ludHNbcG9pbnQuaW5kZXhdLnByb3BlcnRpZXM7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMub3B0aW9ucy5tYXAob3JpZ2luYWwpO1xuICAgICAgICByZXR1cm4gY2xvbmUgJiYgcmVzdWx0ID09PSBvcmlnaW5hbCA/IGV4dGVuZCh7fSwgcmVzdWx0KSA6IHJlc3VsdDtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUNsdXN0ZXIoeCwgeSwgaWQsIG51bVBvaW50cywgcHJvcGVydGllcykge1xuICAgIHJldHVybiB7XG4gICAgICAgIHg6IGZyb3VuZCh4KSwgLy8gd2VpZ2h0ZWQgY2x1c3RlciBjZW50ZXI7IHJvdW5kIGZvciBjb25zaXN0ZW5jeSB3aXRoIEZsb2F0MzJBcnJheSBpbmRleFxuICAgICAgICB5OiBmcm91bmQoeSksXG4gICAgICAgIHpvb206IEluZmluaXR5LCAvLyB0aGUgbGFzdCB6b29tIHRoZSBjbHVzdGVyIHdhcyBwcm9jZXNzZWQgYXRcbiAgICAgICAgaWQsIC8vIGVuY29kZXMgaW5kZXggb2YgdGhlIGZpcnN0IGNoaWxkIG9mIHRoZSBjbHVzdGVyIGFuZCBpdHMgem9vbSBsZXZlbFxuICAgICAgICBwYXJlbnRJZDogLTEsIC8vIHBhcmVudCBjbHVzdGVyIGlkXG4gICAgICAgIG51bVBvaW50cyxcbiAgICAgICAgcHJvcGVydGllc1xuICAgIH07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBvaW50Q2x1c3RlcihwLCBpZCkge1xuICAgIGNvbnN0IFt4LCB5XSA9IHAuZ2VvbWV0cnkuY29vcmRpbmF0ZXM7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgeDogZnJvdW5kKGxuZ1goeCkpLCAvLyBwcm9qZWN0ZWQgcG9pbnQgY29vcmRpbmF0ZXNcbiAgICAgICAgeTogZnJvdW5kKGxhdFkoeSkpLFxuICAgICAgICB6b29tOiBJbmZpbml0eSwgLy8gdGhlIGxhc3Qgem9vbSB0aGUgcG9pbnQgd2FzIHByb2Nlc3NlZCBhdFxuICAgICAgICBpbmRleDogaWQsIC8vIGluZGV4IG9mIHRoZSBzb3VyY2UgZmVhdHVyZSBpbiB0aGUgb3JpZ2luYWwgaW5wdXQgYXJyYXksXG4gICAgICAgIHBhcmVudElkOiAtMSAvLyBwYXJlbnQgY2x1c3RlciBpZFxuICAgIH07XG59XG5cbmZ1bmN0aW9uIGdldENsdXN0ZXJKU09OKGNsdXN0ZXIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiAnRmVhdHVyZScsXG4gICAgICAgIGlkOiBjbHVzdGVyLmlkLFxuICAgICAgICBwcm9wZXJ0aWVzOiBnZXRDbHVzdGVyUHJvcGVydGllcyhjbHVzdGVyKSxcbiAgICAgICAgZ2VvbWV0cnk6IHtcbiAgICAgICAgICAgIHR5cGU6ICdQb2ludCcsXG4gICAgICAgICAgICBjb29yZGluYXRlczogW3hMbmcoY2x1c3Rlci54KSwgeUxhdChjbHVzdGVyLnkpXVxuICAgICAgICB9XG4gICAgfTtcbn1cblxuZnVuY3Rpb24gZ2V0Q2x1c3RlclByb3BlcnRpZXMoY2x1c3Rlcikge1xuICAgIGNvbnN0IGNvdW50ID0gY2x1c3Rlci5udW1Qb2ludHM7XG4gICAgY29uc3QgYWJicmV2ID1cbiAgICAgICAgY291bnQgPj0gMTAwMDAgPyBgJHtNYXRoLnJvdW5kKGNvdW50IC8gMTAwMCkgIH1rYCA6XG4gICAgICAgIGNvdW50ID49IDEwMDAgPyBgJHtNYXRoLnJvdW5kKGNvdW50IC8gMTAwKSAvIDEwICB9a2AgOiBjb3VudDtcbiAgICByZXR1cm4gZXh0ZW5kKGV4dGVuZCh7fSwgY2x1c3Rlci5wcm9wZXJ0aWVzKSwge1xuICAgICAgICBjbHVzdGVyOiB0cnVlLFxuICAgICAgICBjbHVzdGVyX2lkOiBjbHVzdGVyLmlkLFxuICAgICAgICBwb2ludF9jb3VudDogY291bnQsXG4gICAgICAgIHBvaW50X2NvdW50X2FiYnJldmlhdGVkOiBhYmJyZXZcbiAgICB9KTtcbn1cblxuLy8gbG9uZ2l0dWRlL2xhdGl0dWRlIHRvIHNwaGVyaWNhbCBtZXJjYXRvciBpbiBbMC4uMV0gcmFuZ2VcbmZ1bmN0aW9uIGxuZ1gobG5nKSB7XG4gICAgcmV0dXJuIGxuZyAvIDM2MCArIDAuNTtcbn1cbmZ1bmN0aW9uIGxhdFkobGF0KSB7XG4gICAgY29uc3Qgc2luID0gTWF0aC5zaW4obGF0ICogTWF0aC5QSSAvIDE4MCk7XG4gICAgY29uc3QgeSA9ICgwLjUgLSAwLjI1ICogTWF0aC5sb2coKDEgKyBzaW4pIC8gKDEgLSBzaW4pKSAvIE1hdGguUEkpO1xuICAgIHJldHVybiB5IDwgMCA/IDAgOiB5ID4gMSA/IDEgOiB5O1xufVxuXG4vLyBzcGhlcmljYWwgbWVyY2F0b3IgdG8gbG9uZ2l0dWRlL2xhdGl0dWRlXG5mdW5jdGlvbiB4TG5nKHgpIHtcbiAgICByZXR1cm4gKHggLSAwLjUpICogMzYwO1xufVxuZnVuY3Rpb24geUxhdCh5KSB7XG4gICAgY29uc3QgeTIgPSAoMTgwIC0geSAqIDM2MCkgKiBNYXRoLlBJIC8gMTgwO1xuICAgIHJldHVybiAzNjAgKiBNYXRoLmF0YW4oTWF0aC5leHAoeTIpKSAvIE1hdGguUEkgLSA5MDtcbn1cblxuZnVuY3Rpb24gZXh0ZW5kKGRlc3QsIHNyYykge1xuICAgIGZvciAoY29uc3QgaWQgaW4gc3JjKSBkZXN0W2lkXSA9IHNyY1tpZF07XG4gICAgcmV0dXJuIGRlc3Q7XG59XG5cbmZ1bmN0aW9uIGdldFgocCkge1xuICAgIHJldHVybiBwLng7XG59XG5mdW5jdGlvbiBnZXRZKHApIHtcbiAgICByZXR1cm4gcC55O1xufVxuIiwiKGZ1bmN0aW9uIChnbG9iYWwsIGZhY3RvcnkpIHtcbnR5cGVvZiBleHBvcnRzID09PSAnb2JqZWN0JyAmJiB0eXBlb2YgbW9kdWxlICE9PSAndW5kZWZpbmVkJyA/IG1vZHVsZS5leHBvcnRzID0gZmFjdG9yeSgpIDpcbnR5cGVvZiBkZWZpbmUgPT09ICdmdW5jdGlvbicgJiYgZGVmaW5lLmFtZCA/IGRlZmluZShmYWN0b3J5KSA6XG4oZ2xvYmFsLmdlb2pzb252dCA9IGZhY3RvcnkoKSk7XG59KHRoaXMsIChmdW5jdGlvbiAoKSB7ICd1c2Ugc3RyaWN0JztcblxuLy8gY2FsY3VsYXRlIHNpbXBsaWZpY2F0aW9uIGRhdGEgdXNpbmcgb3B0aW1pemVkIERvdWdsYXMtUGV1Y2tlciBhbGdvcml0aG1cblxuZnVuY3Rpb24gc2ltcGxpZnkoY29vcmRzLCBmaXJzdCwgbGFzdCwgc3FUb2xlcmFuY2UpIHtcbiAgICB2YXIgbWF4U3FEaXN0ID0gc3FUb2xlcmFuY2U7XG4gICAgdmFyIG1pZCA9IChsYXN0IC0gZmlyc3QpID4+IDE7XG4gICAgdmFyIG1pblBvc1RvTWlkID0gbGFzdCAtIGZpcnN0O1xuICAgIHZhciBpbmRleDtcblxuICAgIHZhciBheCA9IGNvb3Jkc1tmaXJzdF07XG4gICAgdmFyIGF5ID0gY29vcmRzW2ZpcnN0ICsgMV07XG4gICAgdmFyIGJ4ID0gY29vcmRzW2xhc3RdO1xuICAgIHZhciBieSA9IGNvb3Jkc1tsYXN0ICsgMV07XG5cbiAgICBmb3IgKHZhciBpID0gZmlyc3QgKyAzOyBpIDwgbGFzdDsgaSArPSAzKSB7XG4gICAgICAgIHZhciBkID0gZ2V0U3FTZWdEaXN0KGNvb3Jkc1tpXSwgY29vcmRzW2kgKyAxXSwgYXgsIGF5LCBieCwgYnkpO1xuXG4gICAgICAgIGlmIChkID4gbWF4U3FEaXN0KSB7XG4gICAgICAgICAgICBpbmRleCA9IGk7XG4gICAgICAgICAgICBtYXhTcURpc3QgPSBkO1xuXG4gICAgICAgIH0gZWxzZSBpZiAoZCA9PT0gbWF4U3FEaXN0KSB7XG4gICAgICAgICAgICAvLyBhIHdvcmthcm91bmQgdG8gZW5zdXJlIHdlIGNob29zZSBhIHBpdm90IGNsb3NlIHRvIHRoZSBtaWRkbGUgb2YgdGhlIGxpc3QsXG4gICAgICAgICAgICAvLyByZWR1Y2luZyByZWN1cnNpb24gZGVwdGgsIGZvciBjZXJ0YWluIGRlZ2VuZXJhdGUgaW5wdXRzXG4gICAgICAgICAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vbWFwYm94L2dlb2pzb24tdnQvaXNzdWVzLzEwNFxuICAgICAgICAgICAgdmFyIHBvc1RvTWlkID0gTWF0aC5hYnMoaSAtIG1pZCk7XG4gICAgICAgICAgICBpZiAocG9zVG9NaWQgPCBtaW5Qb3NUb01pZCkge1xuICAgICAgICAgICAgICAgIGluZGV4ID0gaTtcbiAgICAgICAgICAgICAgICBtaW5Qb3NUb01pZCA9IHBvc1RvTWlkO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG1heFNxRGlzdCA+IHNxVG9sZXJhbmNlKSB7XG4gICAgICAgIGlmIChpbmRleCAtIGZpcnN0ID4gMykgc2ltcGxpZnkoY29vcmRzLCBmaXJzdCwgaW5kZXgsIHNxVG9sZXJhbmNlKTtcbiAgICAgICAgY29vcmRzW2luZGV4ICsgMl0gPSBtYXhTcURpc3Q7XG4gICAgICAgIGlmIChsYXN0IC0gaW5kZXggPiAzKSBzaW1wbGlmeShjb29yZHMsIGluZGV4LCBsYXN0LCBzcVRvbGVyYW5jZSk7XG4gICAgfVxufVxuXG4vLyBzcXVhcmUgZGlzdGFuY2UgZnJvbSBhIHBvaW50IHRvIGEgc2VnbWVudFxuZnVuY3Rpb24gZ2V0U3FTZWdEaXN0KHB4LCBweSwgeCwgeSwgYngsIGJ5KSB7XG5cbiAgICB2YXIgZHggPSBieCAtIHg7XG4gICAgdmFyIGR5ID0gYnkgLSB5O1xuXG4gICAgaWYgKGR4ICE9PSAwIHx8IGR5ICE9PSAwKSB7XG5cbiAgICAgICAgdmFyIHQgPSAoKHB4IC0geCkgKiBkeCArIChweSAtIHkpICogZHkpIC8gKGR4ICogZHggKyBkeSAqIGR5KTtcblxuICAgICAgICBpZiAodCA+IDEpIHtcbiAgICAgICAgICAgIHggPSBieDtcbiAgICAgICAgICAgIHkgPSBieTtcblxuICAgICAgICB9IGVsc2UgaWYgKHQgPiAwKSB7XG4gICAgICAgICAgICB4ICs9IGR4ICogdDtcbiAgICAgICAgICAgIHkgKz0gZHkgKiB0O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZHggPSBweCAtIHg7XG4gICAgZHkgPSBweSAtIHk7XG5cbiAgICByZXR1cm4gZHggKiBkeCArIGR5ICogZHk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUZlYXR1cmUoaWQsIHR5cGUsIGdlb20sIHRhZ3MpIHtcbiAgICB2YXIgZmVhdHVyZSA9IHtcbiAgICAgICAgaWQ6IHR5cGVvZiBpZCA9PT0gJ3VuZGVmaW5lZCcgPyBudWxsIDogaWQsXG4gICAgICAgIHR5cGU6IHR5cGUsXG4gICAgICAgIGdlb21ldHJ5OiBnZW9tLFxuICAgICAgICB0YWdzOiB0YWdzLFxuICAgICAgICBtaW5YOiBJbmZpbml0eSxcbiAgICAgICAgbWluWTogSW5maW5pdHksXG4gICAgICAgIG1heFg6IC1JbmZpbml0eSxcbiAgICAgICAgbWF4WTogLUluZmluaXR5XG4gICAgfTtcbiAgICBjYWxjQkJveChmZWF0dXJlKTtcbiAgICByZXR1cm4gZmVhdHVyZTtcbn1cblxuZnVuY3Rpb24gY2FsY0JCb3goZmVhdHVyZSkge1xuICAgIHZhciBnZW9tID0gZmVhdHVyZS5nZW9tZXRyeTtcbiAgICB2YXIgdHlwZSA9IGZlYXR1cmUudHlwZTtcblxuICAgIGlmICh0eXBlID09PSAnUG9pbnQnIHx8IHR5cGUgPT09ICdNdWx0aVBvaW50JyB8fCB0eXBlID09PSAnTGluZVN0cmluZycpIHtcbiAgICAgICAgY2FsY0xpbmVCQm94KGZlYXR1cmUsIGdlb20pO1xuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnUG9seWdvbicgfHwgdHlwZSA9PT0gJ011bHRpTGluZVN0cmluZycpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBjYWxjTGluZUJCb3goZmVhdHVyZSwgZ2VvbVtpXSk7XG4gICAgICAgIH1cblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpUG9seWdvbicpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGdlb20ubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgZ2VvbVtpXS5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgICAgIGNhbGNMaW5lQkJveChmZWF0dXJlLCBnZW9tW2ldW2pdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuZnVuY3Rpb24gY2FsY0xpbmVCQm94KGZlYXR1cmUsIGdlb20pIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdlb20ubGVuZ3RoOyBpICs9IDMpIHtcbiAgICAgICAgZmVhdHVyZS5taW5YID0gTWF0aC5taW4oZmVhdHVyZS5taW5YLCBnZW9tW2ldKTtcbiAgICAgICAgZmVhdHVyZS5taW5ZID0gTWF0aC5taW4oZmVhdHVyZS5taW5ZLCBnZW9tW2kgKyAxXSk7XG4gICAgICAgIGZlYXR1cmUubWF4WCA9IE1hdGgubWF4KGZlYXR1cmUubWF4WCwgZ2VvbVtpXSk7XG4gICAgICAgIGZlYXR1cmUubWF4WSA9IE1hdGgubWF4KGZlYXR1cmUubWF4WSwgZ2VvbVtpICsgMV0pO1xuICAgIH1cbn1cblxuLy8gY29udmVydHMgR2VvSlNPTiBmZWF0dXJlIGludG8gYW4gaW50ZXJtZWRpYXRlIHByb2plY3RlZCBKU09OIHZlY3RvciBmb3JtYXQgd2l0aCBzaW1wbGlmaWNhdGlvbiBkYXRhXG5cbmZ1bmN0aW9uIGNvbnZlcnQoZGF0YSwgb3B0aW9ucykge1xuICAgIHZhciBmZWF0dXJlcyA9IFtdO1xuICAgIGlmIChkYXRhLnR5cGUgPT09ICdGZWF0dXJlQ29sbGVjdGlvbicpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBkYXRhLmZlYXR1cmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBjb252ZXJ0RmVhdHVyZShmZWF0dXJlcywgZGF0YS5mZWF0dXJlc1tpXSwgb3B0aW9ucywgaSk7XG4gICAgICAgIH1cblxuICAgIH0gZWxzZSBpZiAoZGF0YS50eXBlID09PSAnRmVhdHVyZScpIHtcbiAgICAgICAgY29udmVydEZlYXR1cmUoZmVhdHVyZXMsIGRhdGEsIG9wdGlvbnMpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc2luZ2xlIGdlb21ldHJ5IG9yIGEgZ2VvbWV0cnkgY29sbGVjdGlvblxuICAgICAgICBjb252ZXJ0RmVhdHVyZShmZWF0dXJlcywge2dlb21ldHJ5OiBkYXRhfSwgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZlYXR1cmVzO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0RmVhdHVyZShmZWF0dXJlcywgZ2VvanNvbiwgb3B0aW9ucywgaW5kZXgpIHtcbiAgICBpZiAoIWdlb2pzb24uZ2VvbWV0cnkpIHJldHVybjtcblxuICAgIHZhciBjb29yZHMgPSBnZW9qc29uLmdlb21ldHJ5LmNvb3JkaW5hdGVzO1xuICAgIHZhciB0eXBlID0gZ2VvanNvbi5nZW9tZXRyeS50eXBlO1xuICAgIHZhciB0b2xlcmFuY2UgPSBNYXRoLnBvdyhvcHRpb25zLnRvbGVyYW5jZSAvICgoMSA8PCBvcHRpb25zLm1heFpvb20pICogb3B0aW9ucy5leHRlbnQpLCAyKTtcbiAgICB2YXIgZ2VvbWV0cnkgPSBbXTtcbiAgICB2YXIgaWQgPSBnZW9qc29uLmlkO1xuICAgIGlmIChvcHRpb25zLnByb21vdGVJZCkge1xuICAgICAgICBpZCA9IGdlb2pzb24ucHJvcGVydGllc1tvcHRpb25zLnByb21vdGVJZF07XG4gICAgfSBlbHNlIGlmIChvcHRpb25zLmdlbmVyYXRlSWQpIHtcbiAgICAgICAgaWQgPSBpbmRleCB8fCAwO1xuICAgIH1cbiAgICBpZiAodHlwZSA9PT0gJ1BvaW50Jykge1xuICAgICAgICBjb252ZXJ0UG9pbnQoY29vcmRzLCBnZW9tZXRyeSk7XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aVBvaW50Jykge1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNvb3Jkcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgY29udmVydFBvaW50KGNvb3Jkc1tpXSwgZ2VvbWV0cnkpO1xuICAgICAgICB9XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdMaW5lU3RyaW5nJykge1xuICAgICAgICBjb252ZXJ0TGluZShjb29yZHMsIGdlb21ldHJ5LCB0b2xlcmFuY2UsIGZhbHNlKTtcblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpTGluZVN0cmluZycpIHtcbiAgICAgICAgaWYgKG9wdGlvbnMubGluZU1ldHJpY3MpIHtcbiAgICAgICAgICAgIC8vIGV4cGxvZGUgaW50byBsaW5lc3RyaW5ncyB0byBiZSBhYmxlIHRvIHRyYWNrIG1ldHJpY3NcbiAgICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCBjb29yZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBnZW9tZXRyeSA9IFtdO1xuICAgICAgICAgICAgICAgIGNvbnZlcnRMaW5lKGNvb3Jkc1tpXSwgZ2VvbWV0cnksIHRvbGVyYW5jZSwgZmFsc2UpO1xuICAgICAgICAgICAgICAgIGZlYXR1cmVzLnB1c2goY3JlYXRlRmVhdHVyZShpZCwgJ0xpbmVTdHJpbmcnLCBnZW9tZXRyeSwgZ2VvanNvbi5wcm9wZXJ0aWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb252ZXJ0TGluZXMoY29vcmRzLCBnZW9tZXRyeSwgdG9sZXJhbmNlLCBmYWxzZSk7XG4gICAgICAgIH1cblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGNvbnZlcnRMaW5lcyhjb29yZHMsIGdlb21ldHJ5LCB0b2xlcmFuY2UsIHRydWUpO1xuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlQb2x5Z29uJykge1xuICAgICAgICBmb3IgKGkgPSAwOyBpIDwgY29vcmRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICB2YXIgcG9seWdvbiA9IFtdO1xuICAgICAgICAgICAgY29udmVydExpbmVzKGNvb3Jkc1tpXSwgcG9seWdvbiwgdG9sZXJhbmNlLCB0cnVlKTtcbiAgICAgICAgICAgIGdlb21ldHJ5LnB1c2gocG9seWdvbik7XG4gICAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdHZW9tZXRyeUNvbGxlY3Rpb24nKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBnZW9qc29uLmdlb21ldHJ5Lmdlb21ldHJpZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGNvbnZlcnRGZWF0dXJlKGZlYXR1cmVzLCB7XG4gICAgICAgICAgICAgICAgaWQ6IGlkLFxuICAgICAgICAgICAgICAgIGdlb21ldHJ5OiBnZW9qc29uLmdlb21ldHJ5Lmdlb21ldHJpZXNbaV0sXG4gICAgICAgICAgICAgICAgcHJvcGVydGllczogZ2VvanNvbi5wcm9wZXJ0aWVzXG4gICAgICAgICAgICB9LCBvcHRpb25zLCBpbmRleCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW5wdXQgZGF0YSBpcyBub3QgYSB2YWxpZCBHZW9KU09OIG9iamVjdC4nKTtcbiAgICB9XG5cbiAgICBmZWF0dXJlcy5wdXNoKGNyZWF0ZUZlYXR1cmUoaWQsIHR5cGUsIGdlb21ldHJ5LCBnZW9qc29uLnByb3BlcnRpZXMpKTtcbn1cblxuZnVuY3Rpb24gY29udmVydFBvaW50KGNvb3Jkcywgb3V0KSB7XG4gICAgb3V0LnB1c2gocHJvamVjdFgoY29vcmRzWzBdKSk7XG4gICAgb3V0LnB1c2gocHJvamVjdFkoY29vcmRzWzFdKSk7XG4gICAgb3V0LnB1c2goMCk7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRMaW5lKHJpbmcsIG91dCwgdG9sZXJhbmNlLCBpc1BvbHlnb24pIHtcbiAgICB2YXIgeDAsIHkwO1xuICAgIHZhciBzaXplID0gMDtcblxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgcmluZy5sZW5ndGg7IGorKykge1xuICAgICAgICB2YXIgeCA9IHByb2plY3RYKHJpbmdbal1bMF0pO1xuICAgICAgICB2YXIgeSA9IHByb2plY3RZKHJpbmdbal1bMV0pO1xuXG4gICAgICAgIG91dC5wdXNoKHgpO1xuICAgICAgICBvdXQucHVzaCh5KTtcbiAgICAgICAgb3V0LnB1c2goMCk7XG5cbiAgICAgICAgaWYgKGogPiAwKSB7XG4gICAgICAgICAgICBpZiAoaXNQb2x5Z29uKSB7XG4gICAgICAgICAgICAgICAgc2l6ZSArPSAoeDAgKiB5IC0geCAqIHkwKSAvIDI7IC8vIGFyZWFcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2l6ZSArPSBNYXRoLnNxcnQoTWF0aC5wb3coeCAtIHgwLCAyKSArIE1hdGgucG93KHkgLSB5MCwgMikpOyAvLyBsZW5ndGhcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB4MCA9IHg7XG4gICAgICAgIHkwID0geTtcbiAgICB9XG5cbiAgICB2YXIgbGFzdCA9IG91dC5sZW5ndGggLSAzO1xuICAgIG91dFsyXSA9IDE7XG4gICAgc2ltcGxpZnkob3V0LCAwLCBsYXN0LCB0b2xlcmFuY2UpO1xuICAgIG91dFtsYXN0ICsgMl0gPSAxO1xuXG4gICAgb3V0LnNpemUgPSBNYXRoLmFicyhzaXplKTtcbiAgICBvdXQuc3RhcnQgPSAwO1xuICAgIG91dC5lbmQgPSBvdXQuc2l6ZTtcbn1cblxuZnVuY3Rpb24gY29udmVydExpbmVzKHJpbmdzLCBvdXQsIHRvbGVyYW5jZSwgaXNQb2x5Z29uKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCByaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICB2YXIgZ2VvbSA9IFtdO1xuICAgICAgICBjb252ZXJ0TGluZShyaW5nc1tpXSwgZ2VvbSwgdG9sZXJhbmNlLCBpc1BvbHlnb24pO1xuICAgICAgICBvdXQucHVzaChnZW9tKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHByb2plY3RYKHgpIHtcbiAgICByZXR1cm4geCAvIDM2MCArIDAuNTtcbn1cblxuZnVuY3Rpb24gcHJvamVjdFkoeSkge1xuICAgIHZhciBzaW4gPSBNYXRoLnNpbih5ICogTWF0aC5QSSAvIDE4MCk7XG4gICAgdmFyIHkyID0gMC41IC0gMC4yNSAqIE1hdGgubG9nKCgxICsgc2luKSAvICgxIC0gc2luKSkgLyBNYXRoLlBJO1xuICAgIHJldHVybiB5MiA8IDAgPyAwIDogeTIgPiAxID8gMSA6IHkyO1xufVxuXG4vKiBjbGlwIGZlYXR1cmVzIGJldHdlZW4gdHdvIGF4aXMtcGFyYWxsZWwgbGluZXM6XG4gKiAgICAgfCAgICAgICAgfFxuICogIF9fX3xfX18gICAgIHwgICAgIC9cbiAqIC8gICB8ICAgXFxfX19ffF9fX18vXG4gKiAgICAgfCAgICAgICAgfFxuICovXG5cbmZ1bmN0aW9uIGNsaXAoZmVhdHVyZXMsIHNjYWxlLCBrMSwgazIsIGF4aXMsIG1pbkFsbCwgbWF4QWxsLCBvcHRpb25zKSB7XG5cbiAgICBrMSAvPSBzY2FsZTtcbiAgICBrMiAvPSBzY2FsZTtcblxuICAgIGlmIChtaW5BbGwgPj0gazEgJiYgbWF4QWxsIDwgazIpIHJldHVybiBmZWF0dXJlczsgLy8gdHJpdmlhbCBhY2NlcHRcbiAgICBlbHNlIGlmIChtYXhBbGwgPCBrMSB8fCBtaW5BbGwgPj0gazIpIHJldHVybiBudWxsOyAvLyB0cml2aWFsIHJlamVjdFxuXG4gICAgdmFyIGNsaXBwZWQgPSBbXTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmVhdHVyZXMubGVuZ3RoOyBpKyspIHtcblxuICAgICAgICB2YXIgZmVhdHVyZSA9IGZlYXR1cmVzW2ldO1xuICAgICAgICB2YXIgZ2VvbWV0cnkgPSBmZWF0dXJlLmdlb21ldHJ5O1xuICAgICAgICB2YXIgdHlwZSA9IGZlYXR1cmUudHlwZTtcblxuICAgICAgICB2YXIgbWluID0gYXhpcyA9PT0gMCA/IGZlYXR1cmUubWluWCA6IGZlYXR1cmUubWluWTtcbiAgICAgICAgdmFyIG1heCA9IGF4aXMgPT09IDAgPyBmZWF0dXJlLm1heFggOiBmZWF0dXJlLm1heFk7XG5cbiAgICAgICAgaWYgKG1pbiA+PSBrMSAmJiBtYXggPCBrMikgeyAvLyB0cml2aWFsIGFjY2VwdFxuICAgICAgICAgICAgY2xpcHBlZC5wdXNoKGZlYXR1cmUpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH0gZWxzZSBpZiAobWF4IDwgazEgfHwgbWluID49IGsyKSB7IC8vIHRyaXZpYWwgcmVqZWN0XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBuZXdHZW9tZXRyeSA9IFtdO1xuXG4gICAgICAgIGlmICh0eXBlID09PSAnUG9pbnQnIHx8IHR5cGUgPT09ICdNdWx0aVBvaW50Jykge1xuICAgICAgICAgICAgY2xpcFBvaW50cyhnZW9tZXRyeSwgbmV3R2VvbWV0cnksIGsxLCBrMiwgYXhpcyk7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnTGluZVN0cmluZycpIHtcbiAgICAgICAgICAgIGNsaXBMaW5lKGdlb21ldHJ5LCBuZXdHZW9tZXRyeSwgazEsIGsyLCBheGlzLCBmYWxzZSwgb3B0aW9ucy5saW5lTWV0cmljcyk7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlMaW5lU3RyaW5nJykge1xuICAgICAgICAgICAgY2xpcExpbmVzKGdlb21ldHJ5LCBuZXdHZW9tZXRyeSwgazEsIGsyLCBheGlzLCBmYWxzZSk7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgICAgIGNsaXBMaW5lcyhnZW9tZXRyeSwgbmV3R2VvbWV0cnksIGsxLCBrMiwgYXhpcywgdHJ1ZSk7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlQb2x5Z29uJykge1xuICAgICAgICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBnZW9tZXRyeS5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgICAgIHZhciBwb2x5Z29uID0gW107XG4gICAgICAgICAgICAgICAgY2xpcExpbmVzKGdlb21ldHJ5W2pdLCBwb2x5Z29uLCBrMSwgazIsIGF4aXMsIHRydWUpO1xuICAgICAgICAgICAgICAgIGlmIChwb2x5Z29uLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBuZXdHZW9tZXRyeS5wdXNoKHBvbHlnb24pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChuZXdHZW9tZXRyeS5sZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChvcHRpb25zLmxpbmVNZXRyaWNzICYmIHR5cGUgPT09ICdMaW5lU3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGZvciAoaiA9IDA7IGogPCBuZXdHZW9tZXRyeS5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgICAgICAgICBjbGlwcGVkLnB1c2goY3JlYXRlRmVhdHVyZShmZWF0dXJlLmlkLCB0eXBlLCBuZXdHZW9tZXRyeVtqXSwgZmVhdHVyZS50YWdzKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ0xpbmVTdHJpbmcnIHx8IHR5cGUgPT09ICdNdWx0aUxpbmVTdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5ld0dlb21ldHJ5Lmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAgICAgICB0eXBlID0gJ0xpbmVTdHJpbmcnO1xuICAgICAgICAgICAgICAgICAgICBuZXdHZW9tZXRyeSA9IG5ld0dlb21ldHJ5WzBdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGUgPSAnTXVsdGlMaW5lU3RyaW5nJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZSA9PT0gJ1BvaW50JyB8fCB0eXBlID09PSAnTXVsdGlQb2ludCcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gbmV3R2VvbWV0cnkubGVuZ3RoID09PSAzID8gJ1BvaW50JyA6ICdNdWx0aVBvaW50JztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2xpcHBlZC5wdXNoKGNyZWF0ZUZlYXR1cmUoZmVhdHVyZS5pZCwgdHlwZSwgbmV3R2VvbWV0cnksIGZlYXR1cmUudGFncykpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGNsaXBwZWQubGVuZ3RoID8gY2xpcHBlZCA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNsaXBQb2ludHMoZ2VvbSwgbmV3R2VvbSwgazEsIGsyLCBheGlzKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICAgIHZhciBhID0gZ2VvbVtpICsgYXhpc107XG5cbiAgICAgICAgaWYgKGEgPj0gazEgJiYgYSA8PSBrMikge1xuICAgICAgICAgICAgbmV3R2VvbS5wdXNoKGdlb21baV0pO1xuICAgICAgICAgICAgbmV3R2VvbS5wdXNoKGdlb21baSArIDFdKTtcbiAgICAgICAgICAgIG5ld0dlb20ucHVzaChnZW9tW2kgKyAyXSk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGNsaXBMaW5lKGdlb20sIG5ld0dlb20sIGsxLCBrMiwgYXhpcywgaXNQb2x5Z29uLCB0cmFja01ldHJpY3MpIHtcblxuICAgIHZhciBzbGljZSA9IG5ld1NsaWNlKGdlb20pO1xuICAgIHZhciBpbnRlcnNlY3QgPSBheGlzID09PSAwID8gaW50ZXJzZWN0WCA6IGludGVyc2VjdFk7XG4gICAgdmFyIGxlbiA9IGdlb20uc3RhcnQ7XG4gICAgdmFyIHNlZ0xlbiwgdDtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZ2VvbS5sZW5ndGggLSAzOyBpICs9IDMpIHtcbiAgICAgICAgdmFyIGF4ID0gZ2VvbVtpXTtcbiAgICAgICAgdmFyIGF5ID0gZ2VvbVtpICsgMV07XG4gICAgICAgIHZhciBheiA9IGdlb21baSArIDJdO1xuICAgICAgICB2YXIgYnggPSBnZW9tW2kgKyAzXTtcbiAgICAgICAgdmFyIGJ5ID0gZ2VvbVtpICsgNF07XG4gICAgICAgIHZhciBhID0gYXhpcyA9PT0gMCA/IGF4IDogYXk7XG4gICAgICAgIHZhciBiID0gYXhpcyA9PT0gMCA/IGJ4IDogYnk7XG4gICAgICAgIHZhciBleGl0ZWQgPSBmYWxzZTtcblxuICAgICAgICBpZiAodHJhY2tNZXRyaWNzKSBzZWdMZW4gPSBNYXRoLnNxcnQoTWF0aC5wb3coYXggLSBieCwgMikgKyBNYXRoLnBvdyhheSAtIGJ5LCAyKSk7XG5cbiAgICAgICAgaWYgKGEgPCBrMSkge1xuICAgICAgICAgICAgLy8gLS0tfC0tPiAgfCAobGluZSBlbnRlcnMgdGhlIGNsaXAgcmVnaW9uIGZyb20gdGhlIGxlZnQpXG4gICAgICAgICAgICBpZiAoYiA+IGsxKSB7XG4gICAgICAgICAgICAgICAgdCA9IGludGVyc2VjdChzbGljZSwgYXgsIGF5LCBieCwgYnksIGsxKTtcbiAgICAgICAgICAgICAgICBpZiAodHJhY2tNZXRyaWNzKSBzbGljZS5zdGFydCA9IGxlbiArIHNlZ0xlbiAqIHQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoYSA+IGsyKSB7XG4gICAgICAgICAgICAvLyB8ICA8LS18LS0tIChsaW5lIGVudGVycyB0aGUgY2xpcCByZWdpb24gZnJvbSB0aGUgcmlnaHQpXG4gICAgICAgICAgICBpZiAoYiA8IGsyKSB7XG4gICAgICAgICAgICAgICAgdCA9IGludGVyc2VjdChzbGljZSwgYXgsIGF5LCBieCwgYnksIGsyKTtcbiAgICAgICAgICAgICAgICBpZiAodHJhY2tNZXRyaWNzKSBzbGljZS5zdGFydCA9IGxlbiArIHNlZ0xlbiAqIHQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhZGRQb2ludChzbGljZSwgYXgsIGF5LCBheik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGIgPCBrMSAmJiBhID49IGsxKSB7XG4gICAgICAgICAgICAvLyA8LS18LS0tICB8IG9yIDwtLXwtLS0tLXwtLS0gKGxpbmUgZXhpdHMgdGhlIGNsaXAgcmVnaW9uIG9uIHRoZSBsZWZ0KVxuICAgICAgICAgICAgdCA9IGludGVyc2VjdChzbGljZSwgYXgsIGF5LCBieCwgYnksIGsxKTtcbiAgICAgICAgICAgIGV4aXRlZCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGIgPiBrMiAmJiBhIDw9IGsyKSB7XG4gICAgICAgICAgICAvLyB8ICAtLS18LS0+IG9yIC0tLXwtLS0tLXwtLT4gKGxpbmUgZXhpdHMgdGhlIGNsaXAgcmVnaW9uIG9uIHRoZSByaWdodClcbiAgICAgICAgICAgIHQgPSBpbnRlcnNlY3Qoc2xpY2UsIGF4LCBheSwgYngsIGJ5LCBrMik7XG4gICAgICAgICAgICBleGl0ZWQgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFpc1BvbHlnb24gJiYgZXhpdGVkKSB7XG4gICAgICAgICAgICBpZiAodHJhY2tNZXRyaWNzKSBzbGljZS5lbmQgPSBsZW4gKyBzZWdMZW4gKiB0O1xuICAgICAgICAgICAgbmV3R2VvbS5wdXNoKHNsaWNlKTtcbiAgICAgICAgICAgIHNsaWNlID0gbmV3U2xpY2UoZ2VvbSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHJhY2tNZXRyaWNzKSBsZW4gKz0gc2VnTGVuO1xuICAgIH1cblxuICAgIC8vIGFkZCB0aGUgbGFzdCBwb2ludFxuICAgIHZhciBsYXN0ID0gZ2VvbS5sZW5ndGggLSAzO1xuICAgIGF4ID0gZ2VvbVtsYXN0XTtcbiAgICBheSA9IGdlb21bbGFzdCArIDFdO1xuICAgIGF6ID0gZ2VvbVtsYXN0ICsgMl07XG4gICAgYSA9IGF4aXMgPT09IDAgPyBheCA6IGF5O1xuICAgIGlmIChhID49IGsxICYmIGEgPD0gazIpIGFkZFBvaW50KHNsaWNlLCBheCwgYXksIGF6KTtcblxuICAgIC8vIGNsb3NlIHRoZSBwb2x5Z29uIGlmIGl0cyBlbmRwb2ludHMgYXJlIG5vdCB0aGUgc2FtZSBhZnRlciBjbGlwcGluZ1xuICAgIGxhc3QgPSBzbGljZS5sZW5ndGggLSAzO1xuICAgIGlmIChpc1BvbHlnb24gJiYgbGFzdCA+PSAzICYmIChzbGljZVtsYXN0XSAhPT0gc2xpY2VbMF0gfHwgc2xpY2VbbGFzdCArIDFdICE9PSBzbGljZVsxXSkpIHtcbiAgICAgICAgYWRkUG9pbnQoc2xpY2UsIHNsaWNlWzBdLCBzbGljZVsxXSwgc2xpY2VbMl0pO1xuICAgIH1cblxuICAgIC8vIGFkZCB0aGUgZmluYWwgc2xpY2VcbiAgICBpZiAoc2xpY2UubGVuZ3RoKSB7XG4gICAgICAgIG5ld0dlb20ucHVzaChzbGljZSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBuZXdTbGljZShsaW5lKSB7XG4gICAgdmFyIHNsaWNlID0gW107XG4gICAgc2xpY2Uuc2l6ZSA9IGxpbmUuc2l6ZTtcbiAgICBzbGljZS5zdGFydCA9IGxpbmUuc3RhcnQ7XG4gICAgc2xpY2UuZW5kID0gbGluZS5lbmQ7XG4gICAgcmV0dXJuIHNsaWNlO1xufVxuXG5mdW5jdGlvbiBjbGlwTGluZXMoZ2VvbSwgbmV3R2VvbSwgazEsIGsyLCBheGlzLCBpc1BvbHlnb24pIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdlb20ubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY2xpcExpbmUoZ2VvbVtpXSwgbmV3R2VvbSwgazEsIGsyLCBheGlzLCBpc1BvbHlnb24sIGZhbHNlKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGFkZFBvaW50KG91dCwgeCwgeSwgeikge1xuICAgIG91dC5wdXNoKHgpO1xuICAgIG91dC5wdXNoKHkpO1xuICAgIG91dC5wdXNoKHopO1xufVxuXG5mdW5jdGlvbiBpbnRlcnNlY3RYKG91dCwgYXgsIGF5LCBieCwgYnksIHgpIHtcbiAgICB2YXIgdCA9ICh4IC0gYXgpIC8gKGJ4IC0gYXgpO1xuICAgIG91dC5wdXNoKHgpO1xuICAgIG91dC5wdXNoKGF5ICsgKGJ5IC0gYXkpICogdCk7XG4gICAgb3V0LnB1c2goMSk7XG4gICAgcmV0dXJuIHQ7XG59XG5cbmZ1bmN0aW9uIGludGVyc2VjdFkob3V0LCBheCwgYXksIGJ4LCBieSwgeSkge1xuICAgIHZhciB0ID0gKHkgLSBheSkgLyAoYnkgLSBheSk7XG4gICAgb3V0LnB1c2goYXggKyAoYnggLSBheCkgKiB0KTtcbiAgICBvdXQucHVzaCh5KTtcbiAgICBvdXQucHVzaCgxKTtcbiAgICByZXR1cm4gdDtcbn1cblxuZnVuY3Rpb24gd3JhcChmZWF0dXJlcywgb3B0aW9ucykge1xuICAgIHZhciBidWZmZXIgPSBvcHRpb25zLmJ1ZmZlciAvIG9wdGlvbnMuZXh0ZW50O1xuICAgIHZhciBtZXJnZWQgPSBmZWF0dXJlcztcbiAgICB2YXIgbGVmdCAgPSBjbGlwKGZlYXR1cmVzLCAxLCAtMSAtIGJ1ZmZlciwgYnVmZmVyLCAgICAgMCwgLTEsIDIsIG9wdGlvbnMpOyAvLyBsZWZ0IHdvcmxkIGNvcHlcbiAgICB2YXIgcmlnaHQgPSBjbGlwKGZlYXR1cmVzLCAxLCAgMSAtIGJ1ZmZlciwgMiArIGJ1ZmZlciwgMCwgLTEsIDIsIG9wdGlvbnMpOyAvLyByaWdodCB3b3JsZCBjb3B5XG5cbiAgICBpZiAobGVmdCB8fCByaWdodCkge1xuICAgICAgICBtZXJnZWQgPSBjbGlwKGZlYXR1cmVzLCAxLCAtYnVmZmVyLCAxICsgYnVmZmVyLCAwLCAtMSwgMiwgb3B0aW9ucykgfHwgW107IC8vIGNlbnRlciB3b3JsZCBjb3B5XG5cbiAgICAgICAgaWYgKGxlZnQpIG1lcmdlZCA9IHNoaWZ0RmVhdHVyZUNvb3JkcyhsZWZ0LCAxKS5jb25jYXQobWVyZ2VkKTsgLy8gbWVyZ2UgbGVmdCBpbnRvIGNlbnRlclxuICAgICAgICBpZiAocmlnaHQpIG1lcmdlZCA9IG1lcmdlZC5jb25jYXQoc2hpZnRGZWF0dXJlQ29vcmRzKHJpZ2h0LCAtMSkpOyAvLyBtZXJnZSByaWdodCBpbnRvIGNlbnRlclxuICAgIH1cblxuICAgIHJldHVybiBtZXJnZWQ7XG59XG5cbmZ1bmN0aW9uIHNoaWZ0RmVhdHVyZUNvb3JkcyhmZWF0dXJlcywgb2Zmc2V0KSB7XG4gICAgdmFyIG5ld0ZlYXR1cmVzID0gW107XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZlYXR1cmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciBmZWF0dXJlID0gZmVhdHVyZXNbaV0sXG4gICAgICAgICAgICB0eXBlID0gZmVhdHVyZS50eXBlO1xuXG4gICAgICAgIHZhciBuZXdHZW9tZXRyeTtcblxuICAgICAgICBpZiAodHlwZSA9PT0gJ1BvaW50JyB8fCB0eXBlID09PSAnTXVsdGlQb2ludCcgfHwgdHlwZSA9PT0gJ0xpbmVTdHJpbmcnKSB7XG4gICAgICAgICAgICBuZXdHZW9tZXRyeSA9IHNoaWZ0Q29vcmRzKGZlYXR1cmUuZ2VvbWV0cnksIG9mZnNldCk7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlMaW5lU3RyaW5nJyB8fCB0eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgICAgIG5ld0dlb21ldHJ5ID0gW107XG4gICAgICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGZlYXR1cmUuZ2VvbWV0cnkubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICBuZXdHZW9tZXRyeS5wdXNoKHNoaWZ0Q29vcmRzKGZlYXR1cmUuZ2VvbWV0cnlbal0sIG9mZnNldCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aVBvbHlnb24nKSB7XG4gICAgICAgICAgICBuZXdHZW9tZXRyeSA9IFtdO1xuICAgICAgICAgICAgZm9yIChqID0gMDsgaiA8IGZlYXR1cmUuZ2VvbWV0cnkubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgbmV3UG9seWdvbiA9IFtdO1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGsgPSAwOyBrIDwgZmVhdHVyZS5nZW9tZXRyeVtqXS5sZW5ndGg7IGsrKykge1xuICAgICAgICAgICAgICAgICAgICBuZXdQb2x5Z29uLnB1c2goc2hpZnRDb29yZHMoZmVhdHVyZS5nZW9tZXRyeVtqXVtrXSwgb2Zmc2V0KSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5ld0dlb21ldHJ5LnB1c2gobmV3UG9seWdvbik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBuZXdGZWF0dXJlcy5wdXNoKGNyZWF0ZUZlYXR1cmUoZmVhdHVyZS5pZCwgdHlwZSwgbmV3R2VvbWV0cnksIGZlYXR1cmUudGFncykpO1xuICAgIH1cblxuICAgIHJldHVybiBuZXdGZWF0dXJlcztcbn1cblxuZnVuY3Rpb24gc2hpZnRDb29yZHMocG9pbnRzLCBvZmZzZXQpIHtcbiAgICB2YXIgbmV3UG9pbnRzID0gW107XG4gICAgbmV3UG9pbnRzLnNpemUgPSBwb2ludHMuc2l6ZTtcblxuICAgIGlmIChwb2ludHMuc3RhcnQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBuZXdQb2ludHMuc3RhcnQgPSBwb2ludHMuc3RhcnQ7XG4gICAgICAgIG5ld1BvaW50cy5lbmQgPSBwb2ludHMuZW5kO1xuICAgIH1cblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcG9pbnRzLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICAgIG5ld1BvaW50cy5wdXNoKHBvaW50c1tpXSArIG9mZnNldCwgcG9pbnRzW2kgKyAxXSwgcG9pbnRzW2kgKyAyXSk7XG4gICAgfVxuICAgIHJldHVybiBuZXdQb2ludHM7XG59XG5cbi8vIFRyYW5zZm9ybXMgdGhlIGNvb3JkaW5hdGVzIG9mIGVhY2ggZmVhdHVyZSBpbiB0aGUgZ2l2ZW4gdGlsZSBmcm9tXG4vLyBtZXJjYXRvci1wcm9qZWN0ZWQgc3BhY2UgaW50byAoZXh0ZW50IHggZXh0ZW50KSB0aWxlIHNwYWNlLlxuZnVuY3Rpb24gdHJhbnNmb3JtVGlsZSh0aWxlLCBleHRlbnQpIHtcbiAgICBpZiAodGlsZS50cmFuc2Zvcm1lZCkgcmV0dXJuIHRpbGU7XG5cbiAgICB2YXIgejIgPSAxIDw8IHRpbGUueixcbiAgICAgICAgdHggPSB0aWxlLngsXG4gICAgICAgIHR5ID0gdGlsZS55LFxuICAgICAgICBpLCBqLCBrO1xuXG4gICAgZm9yIChpID0gMDsgaSA8IHRpbGUuZmVhdHVyZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIGZlYXR1cmUgPSB0aWxlLmZlYXR1cmVzW2ldLFxuICAgICAgICAgICAgZ2VvbSA9IGZlYXR1cmUuZ2VvbWV0cnksXG4gICAgICAgICAgICB0eXBlID0gZmVhdHVyZS50eXBlO1xuXG4gICAgICAgIGZlYXR1cmUuZ2VvbWV0cnkgPSBbXTtcblxuICAgICAgICBpZiAodHlwZSA9PT0gMSkge1xuICAgICAgICAgICAgZm9yIChqID0gMDsgaiA8IGdlb20ubGVuZ3RoOyBqICs9IDIpIHtcbiAgICAgICAgICAgICAgICBmZWF0dXJlLmdlb21ldHJ5LnB1c2godHJhbnNmb3JtUG9pbnQoZ2VvbVtqXSwgZ2VvbVtqICsgMV0sIGV4dGVudCwgejIsIHR4LCB0eSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZm9yIChqID0gMDsgaiA8IGdlb20ubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgcmluZyA9IFtdO1xuICAgICAgICAgICAgICAgIGZvciAoayA9IDA7IGsgPCBnZW9tW2pdLmxlbmd0aDsgayArPSAyKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpbmcucHVzaCh0cmFuc2Zvcm1Qb2ludChnZW9tW2pdW2tdLCBnZW9tW2pdW2sgKyAxXSwgZXh0ZW50LCB6MiwgdHgsIHR5KSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZlYXR1cmUuZ2VvbWV0cnkucHVzaChyaW5nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHRpbGUudHJhbnNmb3JtZWQgPSB0cnVlO1xuXG4gICAgcmV0dXJuIHRpbGU7XG59XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybVBvaW50KHgsIHksIGV4dGVudCwgejIsIHR4LCB0eSkge1xuICAgIHJldHVybiBbXG4gICAgICAgIE1hdGgucm91bmQoZXh0ZW50ICogKHggKiB6MiAtIHR4KSksXG4gICAgICAgIE1hdGgucm91bmQoZXh0ZW50ICogKHkgKiB6MiAtIHR5KSldO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVUaWxlKGZlYXR1cmVzLCB6LCB0eCwgdHksIG9wdGlvbnMpIHtcbiAgICB2YXIgdG9sZXJhbmNlID0geiA9PT0gb3B0aW9ucy5tYXhab29tID8gMCA6IG9wdGlvbnMudG9sZXJhbmNlIC8gKCgxIDw8IHopICogb3B0aW9ucy5leHRlbnQpO1xuICAgIHZhciB0aWxlID0ge1xuICAgICAgICBmZWF0dXJlczogW10sXG4gICAgICAgIG51bVBvaW50czogMCxcbiAgICAgICAgbnVtU2ltcGxpZmllZDogMCxcbiAgICAgICAgbnVtRmVhdHVyZXM6IDAsXG4gICAgICAgIHNvdXJjZTogbnVsbCxcbiAgICAgICAgeDogdHgsXG4gICAgICAgIHk6IHR5LFxuICAgICAgICB6OiB6LFxuICAgICAgICB0cmFuc2Zvcm1lZDogZmFsc2UsXG4gICAgICAgIG1pblg6IDIsXG4gICAgICAgIG1pblk6IDEsXG4gICAgICAgIG1heFg6IC0xLFxuICAgICAgICBtYXhZOiAwXG4gICAgfTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZlYXR1cmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHRpbGUubnVtRmVhdHVyZXMrKztcbiAgICAgICAgYWRkRmVhdHVyZSh0aWxlLCBmZWF0dXJlc1tpXSwgdG9sZXJhbmNlLCBvcHRpb25zKTtcblxuICAgICAgICB2YXIgbWluWCA9IGZlYXR1cmVzW2ldLm1pblg7XG4gICAgICAgIHZhciBtaW5ZID0gZmVhdHVyZXNbaV0ubWluWTtcbiAgICAgICAgdmFyIG1heFggPSBmZWF0dXJlc1tpXS5tYXhYO1xuICAgICAgICB2YXIgbWF4WSA9IGZlYXR1cmVzW2ldLm1heFk7XG5cbiAgICAgICAgaWYgKG1pblggPCB0aWxlLm1pblgpIHRpbGUubWluWCA9IG1pblg7XG4gICAgICAgIGlmIChtaW5ZIDwgdGlsZS5taW5ZKSB0aWxlLm1pblkgPSBtaW5ZO1xuICAgICAgICBpZiAobWF4WCA+IHRpbGUubWF4WCkgdGlsZS5tYXhYID0gbWF4WDtcbiAgICAgICAgaWYgKG1heFkgPiB0aWxlLm1heFkpIHRpbGUubWF4WSA9IG1heFk7XG4gICAgfVxuICAgIHJldHVybiB0aWxlO1xufVxuXG5mdW5jdGlvbiBhZGRGZWF0dXJlKHRpbGUsIGZlYXR1cmUsIHRvbGVyYW5jZSwgb3B0aW9ucykge1xuXG4gICAgdmFyIGdlb20gPSBmZWF0dXJlLmdlb21ldHJ5LFxuICAgICAgICB0eXBlID0gZmVhdHVyZS50eXBlLFxuICAgICAgICBzaW1wbGlmaWVkID0gW107XG5cbiAgICBpZiAodHlwZSA9PT0gJ1BvaW50JyB8fCB0eXBlID09PSAnTXVsdGlQb2ludCcpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICAgICAgICBzaW1wbGlmaWVkLnB1c2goZ2VvbVtpXSk7XG4gICAgICAgICAgICBzaW1wbGlmaWVkLnB1c2goZ2VvbVtpICsgMV0pO1xuICAgICAgICAgICAgdGlsZS5udW1Qb2ludHMrKztcbiAgICAgICAgICAgIHRpbGUubnVtU2ltcGxpZmllZCsrO1xuICAgICAgICB9XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdMaW5lU3RyaW5nJykge1xuICAgICAgICBhZGRMaW5lKHNpbXBsaWZpZWQsIGdlb20sIHRpbGUsIHRvbGVyYW5jZSwgZmFsc2UsIGZhbHNlKTtcblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpTGluZVN0cmluZycgfHwgdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhZGRMaW5lKHNpbXBsaWZpZWQsIGdlb21baV0sIHRpbGUsIHRvbGVyYW5jZSwgdHlwZSA9PT0gJ1BvbHlnb24nLCBpID09PSAwKTtcbiAgICAgICAgfVxuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlQb2x5Z29uJykge1xuXG4gICAgICAgIGZvciAodmFyIGsgPSAwOyBrIDwgZ2VvbS5sZW5ndGg7IGsrKykge1xuICAgICAgICAgICAgdmFyIHBvbHlnb24gPSBnZW9tW2tdO1xuICAgICAgICAgICAgZm9yIChpID0gMDsgaSA8IHBvbHlnb24ubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBhZGRMaW5lKHNpbXBsaWZpZWQsIHBvbHlnb25baV0sIHRpbGUsIHRvbGVyYW5jZSwgdHJ1ZSwgaSA9PT0gMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc2ltcGxpZmllZC5sZW5ndGgpIHtcbiAgICAgICAgdmFyIHRhZ3MgPSBmZWF0dXJlLnRhZ3MgfHwgbnVsbDtcbiAgICAgICAgaWYgKHR5cGUgPT09ICdMaW5lU3RyaW5nJyAmJiBvcHRpb25zLmxpbmVNZXRyaWNzKSB7XG4gICAgICAgICAgICB0YWdzID0ge307XG4gICAgICAgICAgICBmb3IgKHZhciBrZXkgaW4gZmVhdHVyZS50YWdzKSB0YWdzW2tleV0gPSBmZWF0dXJlLnRhZ3Nba2V5XTtcbiAgICAgICAgICAgIHRhZ3NbJ21hcGJveF9jbGlwX3N0YXJ0J10gPSBnZW9tLnN0YXJ0IC8gZ2VvbS5zaXplO1xuICAgICAgICAgICAgdGFnc1snbWFwYm94X2NsaXBfZW5kJ10gPSBnZW9tLmVuZCAvIGdlb20uc2l6ZTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgdGlsZUZlYXR1cmUgPSB7XG4gICAgICAgICAgICBnZW9tZXRyeTogc2ltcGxpZmllZCxcbiAgICAgICAgICAgIHR5cGU6IHR5cGUgPT09ICdQb2x5Z29uJyB8fCB0eXBlID09PSAnTXVsdGlQb2x5Z29uJyA/IDMgOlxuICAgICAgICAgICAgICAgIHR5cGUgPT09ICdMaW5lU3RyaW5nJyB8fCB0eXBlID09PSAnTXVsdGlMaW5lU3RyaW5nJyA/IDIgOiAxLFxuICAgICAgICAgICAgdGFnczogdGFnc1xuICAgICAgICB9O1xuICAgICAgICBpZiAoZmVhdHVyZS5pZCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgdGlsZUZlYXR1cmUuaWQgPSBmZWF0dXJlLmlkO1xuICAgICAgICB9XG4gICAgICAgIHRpbGUuZmVhdHVyZXMucHVzaCh0aWxlRmVhdHVyZSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBhZGRMaW5lKHJlc3VsdCwgZ2VvbSwgdGlsZSwgdG9sZXJhbmNlLCBpc1BvbHlnb24sIGlzT3V0ZXIpIHtcbiAgICB2YXIgc3FUb2xlcmFuY2UgPSB0b2xlcmFuY2UgKiB0b2xlcmFuY2U7XG5cbiAgICBpZiAodG9sZXJhbmNlID4gMCAmJiAoZ2VvbS5zaXplIDwgKGlzUG9seWdvbiA/IHNxVG9sZXJhbmNlIDogdG9sZXJhbmNlKSkpIHtcbiAgICAgICAgdGlsZS5udW1Qb2ludHMgKz0gZ2VvbS5sZW5ndGggLyAzO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIHJpbmcgPSBbXTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZ2VvbS5sZW5ndGg7IGkgKz0gMykge1xuICAgICAgICBpZiAodG9sZXJhbmNlID09PSAwIHx8IGdlb21baSArIDJdID4gc3FUb2xlcmFuY2UpIHtcbiAgICAgICAgICAgIHRpbGUubnVtU2ltcGxpZmllZCsrO1xuICAgICAgICAgICAgcmluZy5wdXNoKGdlb21baV0pO1xuICAgICAgICAgICAgcmluZy5wdXNoKGdlb21baSArIDFdKTtcbiAgICAgICAgfVxuICAgICAgICB0aWxlLm51bVBvaW50cysrO1xuICAgIH1cblxuICAgIGlmIChpc1BvbHlnb24pIHJld2luZChyaW5nLCBpc091dGVyKTtcblxuICAgIHJlc3VsdC5wdXNoKHJpbmcpO1xufVxuXG5mdW5jdGlvbiByZXdpbmQocmluZywgY2xvY2t3aXNlKSB7XG4gICAgdmFyIGFyZWEgPSAwO1xuICAgIGZvciAodmFyIGkgPSAwLCBsZW4gPSByaW5nLmxlbmd0aCwgaiA9IGxlbiAtIDI7IGkgPCBsZW47IGogPSBpLCBpICs9IDIpIHtcbiAgICAgICAgYXJlYSArPSAocmluZ1tpXSAtIHJpbmdbal0pICogKHJpbmdbaSArIDFdICsgcmluZ1tqICsgMV0pO1xuICAgIH1cbiAgICBpZiAoYXJlYSA+IDAgPT09IGNsb2Nrd2lzZSkge1xuICAgICAgICBmb3IgKGkgPSAwLCBsZW4gPSByaW5nLmxlbmd0aDsgaSA8IGxlbiAvIDI7IGkgKz0gMikge1xuICAgICAgICAgICAgdmFyIHggPSByaW5nW2ldO1xuICAgICAgICAgICAgdmFyIHkgPSByaW5nW2kgKyAxXTtcbiAgICAgICAgICAgIHJpbmdbaV0gPSByaW5nW2xlbiAtIDIgLSBpXTtcbiAgICAgICAgICAgIHJpbmdbaSArIDFdID0gcmluZ1tsZW4gLSAxIC0gaV07XG4gICAgICAgICAgICByaW5nW2xlbiAtIDIgLSBpXSA9IHg7XG4gICAgICAgICAgICByaW5nW2xlbiAtIDEgLSBpXSA9IHk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGdlb2pzb252dChkYXRhLCBvcHRpb25zKSB7XG4gICAgcmV0dXJuIG5ldyBHZW9KU09OVlQoZGF0YSwgb3B0aW9ucyk7XG59XG5cbmZ1bmN0aW9uIEdlb0pTT05WVChkYXRhLCBvcHRpb25zKSB7XG4gICAgb3B0aW9ucyA9IHRoaXMub3B0aW9ucyA9IGV4dGVuZChPYmplY3QuY3JlYXRlKHRoaXMub3B0aW9ucyksIG9wdGlvbnMpO1xuXG4gICAgdmFyIGRlYnVnID0gb3B0aW9ucy5kZWJ1ZztcblxuICAgIGlmIChkZWJ1ZykgY29uc29sZS50aW1lKCdwcmVwcm9jZXNzIGRhdGEnKTtcblxuICAgIGlmIChvcHRpb25zLm1heFpvb20gPCAwIHx8IG9wdGlvbnMubWF4Wm9vbSA+IDI0KSB0aHJvdyBuZXcgRXJyb3IoJ21heFpvb20gc2hvdWxkIGJlIGluIHRoZSAwLTI0IHJhbmdlJyk7XG4gICAgaWYgKG9wdGlvbnMucHJvbW90ZUlkICYmIG9wdGlvbnMuZ2VuZXJhdGVJZCkgdGhyb3cgbmV3IEVycm9yKCdwcm9tb3RlSWQgYW5kIGdlbmVyYXRlSWQgY2Fubm90IGJlIHVzZWQgdG9nZXRoZXIuJyk7XG5cbiAgICB2YXIgZmVhdHVyZXMgPSBjb252ZXJ0KGRhdGEsIG9wdGlvbnMpO1xuXG4gICAgdGhpcy50aWxlcyA9IHt9O1xuICAgIHRoaXMudGlsZUNvb3JkcyA9IFtdO1xuXG4gICAgaWYgKGRlYnVnKSB7XG4gICAgICAgIGNvbnNvbGUudGltZUVuZCgncHJlcHJvY2VzcyBkYXRhJyk7XG4gICAgICAgIGNvbnNvbGUubG9nKCdpbmRleDogbWF4Wm9vbTogJWQsIG1heFBvaW50czogJWQnLCBvcHRpb25zLmluZGV4TWF4Wm9vbSwgb3B0aW9ucy5pbmRleE1heFBvaW50cyk7XG4gICAgICAgIGNvbnNvbGUudGltZSgnZ2VuZXJhdGUgdGlsZXMnKTtcbiAgICAgICAgdGhpcy5zdGF0cyA9IHt9O1xuICAgICAgICB0aGlzLnRvdGFsID0gMDtcbiAgICB9XG5cbiAgICBmZWF0dXJlcyA9IHdyYXAoZmVhdHVyZXMsIG9wdGlvbnMpO1xuXG4gICAgLy8gc3RhcnQgc2xpY2luZyBmcm9tIHRoZSB0b3AgdGlsZSBkb3duXG4gICAgaWYgKGZlYXR1cmVzLmxlbmd0aCkgdGhpcy5zcGxpdFRpbGUoZmVhdHVyZXMsIDAsIDAsIDApO1xuXG4gICAgaWYgKGRlYnVnKSB7XG4gICAgICAgIGlmIChmZWF0dXJlcy5sZW5ndGgpIGNvbnNvbGUubG9nKCdmZWF0dXJlczogJWQsIHBvaW50czogJWQnLCB0aGlzLnRpbGVzWzBdLm51bUZlYXR1cmVzLCB0aGlzLnRpbGVzWzBdLm51bVBvaW50cyk7XG4gICAgICAgIGNvbnNvbGUudGltZUVuZCgnZ2VuZXJhdGUgdGlsZXMnKTtcbiAgICAgICAgY29uc29sZS5sb2coJ3RpbGVzIGdlbmVyYXRlZDonLCB0aGlzLnRvdGFsLCBKU09OLnN0cmluZ2lmeSh0aGlzLnN0YXRzKSk7XG4gICAgfVxufVxuXG5HZW9KU09OVlQucHJvdG90eXBlLm9wdGlvbnMgPSB7XG4gICAgbWF4Wm9vbTogMTQsICAgICAgICAgICAgLy8gbWF4IHpvb20gdG8gcHJlc2VydmUgZGV0YWlsIG9uXG4gICAgaW5kZXhNYXhab29tOiA1LCAgICAgICAgLy8gbWF4IHpvb20gaW4gdGhlIHRpbGUgaW5kZXhcbiAgICBpbmRleE1heFBvaW50czogMTAwMDAwLCAvLyBtYXggbnVtYmVyIG9mIHBvaW50cyBwZXIgdGlsZSBpbiB0aGUgdGlsZSBpbmRleFxuICAgIHRvbGVyYW5jZTogMywgICAgICAgICAgIC8vIHNpbXBsaWZpY2F0aW9uIHRvbGVyYW5jZSAoaGlnaGVyIG1lYW5zIHNpbXBsZXIpXG4gICAgZXh0ZW50OiA0MDk2LCAgICAgICAgICAgLy8gdGlsZSBleHRlbnRcbiAgICBidWZmZXI6IDY0LCAgICAgICAgICAgICAvLyB0aWxlIGJ1ZmZlciBvbiBlYWNoIHNpZGVcbiAgICBsaW5lTWV0cmljczogZmFsc2UsICAgICAvLyB3aGV0aGVyIHRvIGNhbGN1bGF0ZSBsaW5lIG1ldHJpY3NcbiAgICBwcm9tb3RlSWQ6IG51bGwsICAgICAgICAvLyBuYW1lIG9mIGEgZmVhdHVyZSBwcm9wZXJ0eSB0byBiZSBwcm9tb3RlZCB0byBmZWF0dXJlLmlkXG4gICAgZ2VuZXJhdGVJZDogZmFsc2UsICAgICAgLy8gd2hldGhlciB0byBnZW5lcmF0ZSBmZWF0dXJlIGlkcy4gQ2Fubm90IGJlIHVzZWQgd2l0aCBwcm9tb3RlSWRcbiAgICBkZWJ1ZzogMCAgICAgICAgICAgICAgICAvLyBsb2dnaW5nIGxldmVsICgwLCAxIG9yIDIpXG59O1xuXG5HZW9KU09OVlQucHJvdG90eXBlLnNwbGl0VGlsZSA9IGZ1bmN0aW9uIChmZWF0dXJlcywgeiwgeCwgeSwgY3osIGN4LCBjeSkge1xuXG4gICAgdmFyIHN0YWNrID0gW2ZlYXR1cmVzLCB6LCB4LCB5XSxcbiAgICAgICAgb3B0aW9ucyA9IHRoaXMub3B0aW9ucyxcbiAgICAgICAgZGVidWcgPSBvcHRpb25zLmRlYnVnO1xuXG4gICAgLy8gYXZvaWQgcmVjdXJzaW9uIGJ5IHVzaW5nIGEgcHJvY2Vzc2luZyBxdWV1ZVxuICAgIHdoaWxlIChzdGFjay5sZW5ndGgpIHtcbiAgICAgICAgeSA9IHN0YWNrLnBvcCgpO1xuICAgICAgICB4ID0gc3RhY2sucG9wKCk7XG4gICAgICAgIHogPSBzdGFjay5wb3AoKTtcbiAgICAgICAgZmVhdHVyZXMgPSBzdGFjay5wb3AoKTtcblxuICAgICAgICB2YXIgejIgPSAxIDw8IHosXG4gICAgICAgICAgICBpZCA9IHRvSUQoeiwgeCwgeSksXG4gICAgICAgICAgICB0aWxlID0gdGhpcy50aWxlc1tpZF07XG5cbiAgICAgICAgaWYgKCF0aWxlKSB7XG4gICAgICAgICAgICBpZiAoZGVidWcgPiAxKSBjb25zb2xlLnRpbWUoJ2NyZWF0aW9uJyk7XG5cbiAgICAgICAgICAgIHRpbGUgPSB0aGlzLnRpbGVzW2lkXSA9IGNyZWF0ZVRpbGUoZmVhdHVyZXMsIHosIHgsIHksIG9wdGlvbnMpO1xuICAgICAgICAgICAgdGhpcy50aWxlQ29vcmRzLnB1c2goe3o6IHosIHg6IHgsIHk6IHl9KTtcblxuICAgICAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlYnVnID4gMSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygndGlsZSB6JWQtJWQtJWQgKGZlYXR1cmVzOiAlZCwgcG9pbnRzOiAlZCwgc2ltcGxpZmllZDogJWQpJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHosIHgsIHksIHRpbGUubnVtRmVhdHVyZXMsIHRpbGUubnVtUG9pbnRzLCB0aWxlLm51bVNpbXBsaWZpZWQpO1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLnRpbWVFbmQoJ2NyZWF0aW9uJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBrZXkgPSAneicgKyB6O1xuICAgICAgICAgICAgICAgIHRoaXMuc3RhdHNba2V5XSA9ICh0aGlzLnN0YXRzW2tleV0gfHwgMCkgKyAxO1xuICAgICAgICAgICAgICAgIHRoaXMudG90YWwrKztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHNhdmUgcmVmZXJlbmNlIHRvIG9yaWdpbmFsIGdlb21ldHJ5IGluIHRpbGUgc28gdGhhdCB3ZSBjYW4gZHJpbGwgZG93biBsYXRlciBpZiB3ZSBzdG9wIG5vd1xuICAgICAgICB0aWxlLnNvdXJjZSA9IGZlYXR1cmVzO1xuXG4gICAgICAgIC8vIGlmIGl0J3MgdGhlIGZpcnN0LXBhc3MgdGlsaW5nXG4gICAgICAgIGlmICghY3opIHtcbiAgICAgICAgICAgIC8vIHN0b3AgdGlsaW5nIGlmIHdlIHJlYWNoZWQgbWF4IHpvb20sIG9yIGlmIHRoZSB0aWxlIGlzIHRvbyBzaW1wbGVcbiAgICAgICAgICAgIGlmICh6ID09PSBvcHRpb25zLmluZGV4TWF4Wm9vbSB8fCB0aWxlLm51bVBvaW50cyA8PSBvcHRpb25zLmluZGV4TWF4UG9pbnRzKSBjb250aW51ZTtcblxuICAgICAgICAvLyBpZiBhIGRyaWxsZG93biB0byBhIHNwZWNpZmljIHRpbGVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIHN0b3AgdGlsaW5nIGlmIHdlIHJlYWNoZWQgYmFzZSB6b29tIG9yIG91ciB0YXJnZXQgdGlsZSB6b29tXG4gICAgICAgICAgICBpZiAoeiA9PT0gb3B0aW9ucy5tYXhab29tIHx8IHogPT09IGN6KSBjb250aW51ZTtcblxuICAgICAgICAgICAgLy8gc3RvcCB0aWxpbmcgaWYgaXQncyBub3QgYW4gYW5jZXN0b3Igb2YgdGhlIHRhcmdldCB0aWxlXG4gICAgICAgICAgICB2YXIgbSA9IDEgPDwgKGN6IC0geik7XG4gICAgICAgICAgICBpZiAoeCAhPT0gTWF0aC5mbG9vcihjeCAvIG0pIHx8IHkgIT09IE1hdGguZmxvb3IoY3kgLyBtKSkgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBpZiB3ZSBzbGljZSBmdXJ0aGVyIGRvd24sIG5vIG5lZWQgdG8ga2VlcCBzb3VyY2UgZ2VvbWV0cnlcbiAgICAgICAgdGlsZS5zb3VyY2UgPSBudWxsO1xuXG4gICAgICAgIGlmIChmZWF0dXJlcy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXG4gICAgICAgIGlmIChkZWJ1ZyA+IDEpIGNvbnNvbGUudGltZSgnY2xpcHBpbmcnKTtcblxuICAgICAgICAvLyB2YWx1ZXMgd2UnbGwgdXNlIGZvciBjbGlwcGluZ1xuICAgICAgICB2YXIgazEgPSAwLjUgKiBvcHRpb25zLmJ1ZmZlciAvIG9wdGlvbnMuZXh0ZW50LFxuICAgICAgICAgICAgazIgPSAwLjUgLSBrMSxcbiAgICAgICAgICAgIGszID0gMC41ICsgazEsXG4gICAgICAgICAgICBrNCA9IDEgKyBrMSxcbiAgICAgICAgICAgIHRsLCBibCwgdHIsIGJyLCBsZWZ0LCByaWdodDtcblxuICAgICAgICB0bCA9IGJsID0gdHIgPSBiciA9IG51bGw7XG5cbiAgICAgICAgbGVmdCAgPSBjbGlwKGZlYXR1cmVzLCB6MiwgeCAtIGsxLCB4ICsgazMsIDAsIHRpbGUubWluWCwgdGlsZS5tYXhYLCBvcHRpb25zKTtcbiAgICAgICAgcmlnaHQgPSBjbGlwKGZlYXR1cmVzLCB6MiwgeCArIGsyLCB4ICsgazQsIDAsIHRpbGUubWluWCwgdGlsZS5tYXhYLCBvcHRpb25zKTtcbiAgICAgICAgZmVhdHVyZXMgPSBudWxsO1xuXG4gICAgICAgIGlmIChsZWZ0KSB7XG4gICAgICAgICAgICB0bCA9IGNsaXAobGVmdCwgejIsIHkgLSBrMSwgeSArIGszLCAxLCB0aWxlLm1pblksIHRpbGUubWF4WSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBibCA9IGNsaXAobGVmdCwgejIsIHkgKyBrMiwgeSArIGs0LCAxLCB0aWxlLm1pblksIHRpbGUubWF4WSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBsZWZ0ID0gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyaWdodCkge1xuICAgICAgICAgICAgdHIgPSBjbGlwKHJpZ2h0LCB6MiwgeSAtIGsxLCB5ICsgazMsIDEsIHRpbGUubWluWSwgdGlsZS5tYXhZLCBvcHRpb25zKTtcbiAgICAgICAgICAgIGJyID0gY2xpcChyaWdodCwgejIsIHkgKyBrMiwgeSArIGs0LCAxLCB0aWxlLm1pblksIHRpbGUubWF4WSwgb3B0aW9ucyk7XG4gICAgICAgICAgICByaWdodCA9IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZGVidWcgPiAxKSBjb25zb2xlLnRpbWVFbmQoJ2NsaXBwaW5nJyk7XG5cbiAgICAgICAgc3RhY2sucHVzaCh0bCB8fCBbXSwgeiArIDEsIHggKiAyLCAgICAgeSAqIDIpO1xuICAgICAgICBzdGFjay5wdXNoKGJsIHx8IFtdLCB6ICsgMSwgeCAqIDIsICAgICB5ICogMiArIDEpO1xuICAgICAgICBzdGFjay5wdXNoKHRyIHx8IFtdLCB6ICsgMSwgeCAqIDIgKyAxLCB5ICogMik7XG4gICAgICAgIHN0YWNrLnB1c2goYnIgfHwgW10sIHogKyAxLCB4ICogMiArIDEsIHkgKiAyICsgMSk7XG4gICAgfVxufTtcblxuR2VvSlNPTlZULnByb3RvdHlwZS5nZXRUaWxlID0gZnVuY3Rpb24gKHosIHgsIHkpIHtcbiAgICB2YXIgb3B0aW9ucyA9IHRoaXMub3B0aW9ucyxcbiAgICAgICAgZXh0ZW50ID0gb3B0aW9ucy5leHRlbnQsXG4gICAgICAgIGRlYnVnID0gb3B0aW9ucy5kZWJ1ZztcblxuICAgIGlmICh6IDwgMCB8fCB6ID4gMjQpIHJldHVybiBudWxsO1xuXG4gICAgdmFyIHoyID0gMSA8PCB6O1xuICAgIHggPSAoKHggJSB6MikgKyB6MikgJSB6MjsgLy8gd3JhcCB0aWxlIHggY29vcmRpbmF0ZVxuXG4gICAgdmFyIGlkID0gdG9JRCh6LCB4LCB5KTtcbiAgICBpZiAodGhpcy50aWxlc1tpZF0pIHJldHVybiB0cmFuc2Zvcm1UaWxlKHRoaXMudGlsZXNbaWRdLCBleHRlbnQpO1xuXG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS5sb2coJ2RyaWxsaW5nIGRvd24gdG8geiVkLSVkLSVkJywgeiwgeCwgeSk7XG5cbiAgICB2YXIgejAgPSB6LFxuICAgICAgICB4MCA9IHgsXG4gICAgICAgIHkwID0geSxcbiAgICAgICAgcGFyZW50O1xuXG4gICAgd2hpbGUgKCFwYXJlbnQgJiYgejAgPiAwKSB7XG4gICAgICAgIHowLS07XG4gICAgICAgIHgwID0gTWF0aC5mbG9vcih4MCAvIDIpO1xuICAgICAgICB5MCA9IE1hdGguZmxvb3IoeTAgLyAyKTtcbiAgICAgICAgcGFyZW50ID0gdGhpcy50aWxlc1t0b0lEKHowLCB4MCwgeTApXTtcbiAgICB9XG5cbiAgICBpZiAoIXBhcmVudCB8fCAhcGFyZW50LnNvdXJjZSkgcmV0dXJuIG51bGw7XG5cbiAgICAvLyBpZiB3ZSBmb3VuZCBhIHBhcmVudCB0aWxlIGNvbnRhaW5pbmcgdGhlIG9yaWdpbmFsIGdlb21ldHJ5LCB3ZSBjYW4gZHJpbGwgZG93biBmcm9tIGl0XG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS5sb2coJ2ZvdW5kIHBhcmVudCB0aWxlIHolZC0lZC0lZCcsIHowLCB4MCwgeTApO1xuXG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS50aW1lKCdkcmlsbGluZyBkb3duJyk7XG4gICAgdGhpcy5zcGxpdFRpbGUocGFyZW50LnNvdXJjZSwgejAsIHgwLCB5MCwgeiwgeCwgeSk7XG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS50aW1lRW5kKCdkcmlsbGluZyBkb3duJyk7XG5cbiAgICByZXR1cm4gdGhpcy50aWxlc1tpZF0gPyB0cmFuc2Zvcm1UaWxlKHRoaXMudGlsZXNbaWRdLCBleHRlbnQpIDogbnVsbDtcbn07XG5cbmZ1bmN0aW9uIHRvSUQoeiwgeCwgeSkge1xuICAgIHJldHVybiAoKCgxIDw8IHopICogeSArIHgpICogMzIpICsgejtcbn1cblxuZnVuY3Rpb24gZXh0ZW5kKGRlc3QsIHNyYykge1xuICAgIGZvciAodmFyIGkgaW4gc3JjKSBkZXN0W2ldID0gc3JjW2ldO1xuICAgIHJldHVybiBkZXN0O1xufVxuXG5yZXR1cm4gZ2VvanNvbnZ0O1xuXG59KSkpO1xuIixudWxsLG51bGwsbnVsbF0sIm5hbWVzIjpbInJlZlByb3BlcnRpZXMiLCJjcmVhdGVTdHlsZUxheWVyIiwiZmVhdHVyZUZpbHRlciIsInBvdHBhY2siLCJBbHBoYUltYWdlIiwicmVnaXN0ZXIiLCJPdmVyc2NhbGVkVGlsZUlEIiwiQ29sbGlzaW9uQm94QXJyYXkiLCJEaWN0aW9uYXJ5Q29kZXIiLCJGZWF0dXJlSW5kZXgiLCJ3YXJuT25jZSIsIm1hcE9iamVjdCIsIkltYWdlQXRsYXMiLCJTeW1ib2xCdWNrZXQiLCJwZXJmb3JtU3ltYm9sTGF5b3V0IiwiTGluZUJ1Y2tldCIsIkZpbGxCdWNrZXQiLCJGaWxsRXh0cnVzaW9uQnVja2V0IiwiRXZhbHVhdGlvblBhcmFtZXRlcnMiLCJnZXRBcnJheUJ1ZmZlciIsInZ0IiwiUHJvdG9idWYiLCJSZXF1ZXN0UGVyZm9ybWFuY2UiLCJleHRlbmQiLCJpc0ltYWdlQml0bWFwIiwiREVNRGF0YSIsIlJHQkFJbWFnZSIsIm12dCIsIkVYVEVOVCIsIlBvaW50IiwiRmVhdHVyZVdyYXBwZXIiLCJyZXF1aXJlJCQwIiwicmVxdWlyZSQkMSIsIkdlb0pTT05XcmFwcGVyIiwidnRQYmZNb2R1bGUiLCJ2dFBiZiIsIktEQnVzaCIsImRlZmluZSIsInZ0cGJmIiwiZ2V0SlNPTiIsInJld2luZCIsImNyZWF0ZUV4cHJlc3Npb24iLCJBY3RvciIsImdsb2JhbFJUTFRleHRQbHVnaW4iLCJpc1dvcmtlciJdLCJtYXBwaW5ncyI6Ijs7QUFHQSxTQUFTLFNBQVMsQ0FBQyxHQUFHLEVBQUE7QUFDbEIsSUFBQSxNQUFNLElBQUksR0FBRyxPQUFPLEdBQUcsQ0FBQztBQUN4QixJQUFBLElBQUksSUFBSSxLQUFLLFFBQVEsSUFBSSxJQUFJLEtBQUssU0FBUyxJQUFJLElBQUksS0FBSyxRQUFRLElBQUksR0FBRyxLQUFLLFNBQVMsSUFBSSxHQUFHLEtBQUssSUFBSTtBQUNqRyxRQUFBLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUUvQixJQUFBLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENB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T0FBTyxFQUFFLElBQUk7QUFDckIsUUFBUSxVQUFVLEVBQUUsT0FBTyxDQUFDLEVBQUU7QUFDOUIsUUFBUSxXQUFXLEVBQUUsS0FBSztBQUMxQixRQUFRLHVCQUF1QixFQUFFLE1BQU07QUFDdkMsS0FBSyxDQUFDLENBQUM7QUFDUCxDQUFDO0FBQ0Q7QUFDQTtBQUNBLFNBQVMsSUFBSSxDQUFDLEdBQUcsRUFBRTtBQUNuQixJQUFJLE9BQU8sR0FBRyxHQUFHLEdBQUcsR0FBRyxHQUFHLENBQUM7QUFDM0IsQ0FBQztBQUNELFNBQVMsSUFBSSxDQUFDLEdBQUcsRUFBRTtBQUNuQixJQUFJLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxHQUFHLElBQUksQ0FBQyxFQUFFLEdBQUcsR0FBRyxDQUFDLENBQUM7QUFDOUMsSUFBSSxNQUFNLENBQUMsSUFBSSxHQUFHLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxLQUFLLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN2RSxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3JDLENBQUM7QUFDRDtBQUNBO0FBQ0EsU0FBUyxJQUFJLENBQUMsQ0FBQyxFQUFFO0FBQ2pCLElBQUksT0FBTyxDQUFDLENBQUMsR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDO0FBQzNCLENBQUM7QUFDRCxTQUFTLElBQUksQ0FBQyxDQUFDLEVBQUU7QUFDakIsSUFBSSxNQUFNLEVBQUUsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsR0FBRyxJQUFJLElBQUksQ0FBQyxFQUFFLEdBQUcsR0FBRyxDQUFDO0FBQy9DLElBQUksT0FBTyxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFD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R0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDO0VBQ3RCO0FBQ0Q7Q0FDQSxTQUFTLFlBQVksQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUU7QUFDeEQsS0FBSSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtBQUMzQyxTQUFRLElBQUksSUFBSSxHQUFHLEVBQUUsQ0FBQztBQUN0QixTQUFRLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxTQUFTLENBQUMsQ0FBQztBQUMxRCxTQUFRLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7TUFDbEI7RUFDSjtBQUNEO0NBQ0EsU0FBUyxRQUFRLENBQUMsQ0FBQyxFQUFFO0FBQ3JCLEtBQUksT0FBTyxDQUFDLEdBQUcsR0FBRyxHQUFHLEdBQUcsQ0FBQztFQUN4QjtBQUNEO0NBQ0EsU0FBUyxRQUFRLENBQUMsQ0FBQyxFQUFFO0FBQ3JCLEtBQUksSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEVBQUUsR0FBRyxHQUFHLENBQUMsQ0FBQztLQUN0QyxJQUFJLEVBQUUsR0FBRyxHQUFHLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxLQUFLLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7QUFDcEUsS0FBSSxPQUFPLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztFQUN2QztBQUNEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxDQUFBLFNBQVMsSUFBSSxDQUFDLFFBQVEsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFB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TCxDQUFDLEVBQUUsQ0FBQztTQUNKLFdBQVcsRUFBRSxLQUFLO1NBQ2xCLElBQUksRUFBRSxDQUFDO1NBQ1AsSUFBSSxFQUFFLENBQUM7U0FDUCxJQUFJLEVBQUUsQ0FBQyxDQUFDO1NBQ1IsSUFBSSxFQUFFLENBQUM7QUFDZixNQUFLLENBQUM7QUFDTixLQUFJLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO0FBQzlDLFNBQVEsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO0FBQzNCLFNBQVEsVUFBVSxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsU0FBUyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQzFEO1NBQ1EsSUFBSSxJQUFJLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztTQUM1QixJQUFJLElBQUksR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1NBQzVCLElBQUksSUFBSSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7U0FDNUIsSUFBSSxJQUFJLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNwQztBQUNBLFNBQVEsSUFBSSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztBQUMvQyxTQUFRLElBQUksSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7QUFDL0MsU0FBUSxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQy9DLFNBQVEsSUFBSSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztNQUMxQztLQUNELE9BQU8sSUFBSSxD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QixJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2FBQ25CLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1VBQzFCO0FBQ1QsU0FBUSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7TUFDcEI7QUFDTDtLQUNJLElBQUksU0FBUyxFQUFFLE1BQU0sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDekM7QUFDQSxLQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7RUFDckI7QUFDRDtBQUNBLENBQUEsU0FBUyxNQUFNLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtBQUNqQyxLQUFJLElBQUksSUFBSSxHQUFHLENBQUMsQ0FBQztBQUNqQixLQUFJLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEdBQUcsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFO1NBQ3BFLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7TUFDN0Q7QUFDTCxLQUFJLElBQUksSUFBSSxHQUFHLENBQUMsS0FBSyxTQUFTLEVBQUU7U0FDeEIsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEdBQUcsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUU7QUFDNUQsYUFBWSxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDaEIsSUFBSSxD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
