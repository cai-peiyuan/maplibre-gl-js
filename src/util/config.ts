type Config = {
    REPORT_MAP_EVENTS: boolean, //上报地图初始化事件开关
    REPORT_MAP_SESSION: boolean, //上报地图会话开关
    API_URL: string,
    API_VERSION: string, //api版本信息，根据版本信息可不同的获取地图资源下载的url  如地图样式、字体、图标等
    API_URL_EVENTS: string,
    API_URL_SESSION: string,
    API_URL_FEEDBACK: string,
    API_URL_REGEX: RegExp,
    EVENTS_URL: string,
    SESSION_PATH: string,
    FEEDBACK_URL: string,
    REQUIRE_ACCESS_TOKEN: boolean,
    TILE_URL_VERSION: string,
    RASTER_URL_PREFIX: string,
    ACCESS_TOKEN: string,
    TRAFFIC_SOURCE: { raster: Object, vector: Object },
    TRAFFIC_SOURCE_: { raster: Object, vector: Object },
    MAX_PARALLEL_IMAGE_REQUESTS: number;
    MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME: number;
    REGISTERED_PROTOCOLS: { [x: string]: any };
    WORKER_URL: string;
};
let mapboxHTTPURLRegex;
const config: Config = {
    MAX_PARALLEL_IMAGE_REQUESTS: 16,
    MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME: 8,
    REGISTERED_PROTOCOLS: {},
    API_VERSION: '2', //默认为 2 是mapbox的接口url  2为旧版本的msp的接口url  3 为 erupt版本的msp接口url
    REPORT_MAP_EVENTS: false, // 默认不上报
    REPORT_MAP_SESSION: false, // 默认不上报
    API_URL: 'https://api.mapbox.com', // api地址
    API_URL_EVENTS: '/events/v2', //配置地图初始化事件上报数据接口地址
    API_URL_SESSION: '/map-sessions/v1', //配置地图初始化事件上报数据接口地址
    API_URL_FEEDBACK: '/feedback',
    get API_URL_REGEX() {
        if (mapboxHTTPURLRegex == null) {
            const prodMapboxHTTPURLRegex = /^((https?:)?\/\/)?([^\/]+\.)?mapbox\.c(n|om)(\/|\?|$)/i;
            try {
                mapboxHTTPURLRegex = (process.env.API_URL_REGEX != null) ? new RegExp(process.env.API_URL_REGEX) : prodMapboxHTTPURLRegex;
            } catch (e) {
                mapboxHTTPURLRegex = prodMapboxHTTPURLRegex;
            }
        }

        return mapboxHTTPURLRegex;
    },
    /**
     * 获取事件数据上报地址
     * @returns {string|null}
     * @constructor
     */
    get EVENTS_URL() {
        if (!this.API_URL || !this.REPORT_MAP_EVENTS) {
            //不上报地图初始化事件
            return null;
        } else {
            return this.API_URL + this.API_URL_EVENTS;
        }
    },
    /**
     * 获取地图会话
     * @returns {string}
     * @constructor
     */
    get SESSION_PATH() {
        if (!this.REPORT_MAP_SESSION) {
            //不上报地图会话
            return null;
        }
        return this.API_URL_SESSION;
    },

    /**
     * 获取交通路况数据源url
     * @returns {{raster: {tiles: [string], tileSize: string, type: string}, vector: {tiles: [string], type: string}}}
     * @constructor
     */
    get TRAFFIC_SOURCE_() {
        if (this.TRAFFIC_SOURCE) {
            return this.TRAFFIC_SOURCE;
        }
        const source = {
            'raster': {
                'tiles': [`${this.API_URL}/tile/r/amaptraffic?t={z}-{x}-{y}`],
                'tileSize': 256,
                'type': 'raster'
            }, 'vector': {'tiles': [`${this.API_URL}/tile/v/amaptraffic/{z}/{x}/{y}`], 'type': 'vector'}
        };
        return source;
    },
    /**
     * 获取地图反馈链接url
     * @returns {string}
     * @constructor
     */
    get FEEDBACK_URL() {
        if (!this.API_URL) {
            return '/feedback';
        } else {
            return this.API_URL + this.API_URL_FEEDBACK;
        }
    },
    TILE_URL_VERSION: 'v4',
    RASTER_URL_PREFIX: 'raster/v1',
    REQUIRE_ACCESS_TOKEN: true,
    ACCESS_TOKEN: null,
    TRAFFIC_SOURCE: null,
    WORKER_URL: ''
}

export default config;
