import config from '../config';
import {extend} from '../util';
import {getJSON} from '../ajax';
import {ErrorEvent} from '../evented';

/**
 * Poi搜索（关键字、多边形、周边）.
 * @param requestParams
 * @param callback
 */
function poiSearch(requestParams: {}, callback: Function, accessToken: string) {
    let defaultParams = {
        query: '', //关键字，关键字的首字母、拼音格式如，公园/gy/gongyuan（必填）
        scope: 1, //检索结果详细程度,1返回基本信息；2返回POI详细信息。（必填）
        region: '', //检索区域名称,可输入城市名或省份名或全国（必填）
        type: '', //关键字类型
        page_size: 20, //每页记录数,最大值为50，超过50则按照50处理。
        page_num: 1, //分页页码,
        location: '', //中心点(周边搜索必填)
        radius: '', //半径，取值范围0~50000，超过50000时，按默认值1000进行搜搜，单位米。(周边搜索必填)
        regionType: '', //几何对象类型,可选rectangle（矩形）、polygon(多边形)、circle（圆）、ellipse(椭圆)
        bounds: '', //地理坐标点集合,目前支持四种图形类型：
        // 坐标点经、纬度间使用半角“,”隔开，坐标对间使用半角“;”分隔。 如： x1,y1;x2,y2; x3,y3;x4,y4;x5,y5;
        // regionType=rectangle，矩形左下、右上（或左上、右下）两个顶点的坐标；
        // regionType=polygon，多边形所有顶点的顺序坐标，且首尾坐标相同；
        // regionType=circle，圆形外接矩形左下、右上（或左上、右下）两个顶点的坐标；
        // regionType=ellipse，椭圆外接矩形左下、右上（或左上、右下）两个顶点的坐标。
        ak: accessToken
    };
    requestParams = extend({}, defaultParams, requestParams);
    let paramsArray = [];
    for (const key in requestParams) {
        if (requestParams[key] != '') {
            paramsArray.push(`${key}=${requestParams[key]}`);
        }
    }
    let request = {
        url: `${config.API_URL}/as/search/poi?${paramsArray.join('&')}`
    }
    getJSON(request, (error?: Error | null, json?: any | null) => {
        if (error) {
            this.fire(new ErrorEvent(error));
        } else if (json) {
            callback(json);
        }
    });
}

/**
 * 步行路径规划
 * @param options
 * @param callback
 * @example
 */
function walking(requestOptions: Object, callback: Function, accessToken: string) {
    let defaultOptions = {
        origin: '', //起点经纬度，或起点名称+经纬度（必填）
        destination: '', //终点经纬度，或终点名称+经纬度（必填）
        coord_type: '', //坐标类型 见文档
        tactics: '', //路径规划策略 见文档
        ak: accessToken
    };
    requestOptions = extend({}, defaultOptions, requestOptions);
    let paramsArray = [];
    for (const key in requestOptions) {
        if (requestOptions[key] != '') {
            paramsArray.push(`${key}=${requestOptions[key]}`);
        }
    }
    let request = {
        url: `${config.API_URL}/as/route/walk?${paramsArray.join('&')}`
    }
    getJSON(request, (error?: Error | null, json?: any | null) => {
        if (error) {
            this.fire(new ErrorEvent(error));
        } else if (json) {
            callback(json);
        }
    });
}

/**
 * 车行路径规划
 * @param options
 * @param callback
 * @example
 */
function driving(requestOptions: Object, callback: Function, accessToken: string) {
    let defaultOptions = {
        origin: '', //起点经纬度，或起点名称+经纬度（必填）
        destination: '', //终点经纬度，或终点名称+经纬度（必填）
        waypoints: '', //最多支持设置16组途经点。经、纬度之间用“,”分隔，坐标点之间用"；"分隔
        coord_type: '', //坐标类型 见文档
        tactics: '', //路径规划策略 见文档
        avoidpolygons: '', //区域避让，支持32个避让区域，每个区域最多可有16个顶点 例 x,y;x,y|x,y;x,y
        ak: accessToken
    };
    requestOptions = extend({}, defaultOptions, requestOptions);
    let paramsArray = [];
    for (const key in requestOptions) {
        if (requestOptions[key] != '') {
            paramsArray.push(`${key}=${requestOptions[key]}`);
        }
    }
    let request = {
        url: `${config.API_URL}/as/route/car?${paramsArray.join('&')}`
    }
    getJSON(request, (error?: Error | null, json?: any | null) => {
        if (error) {
            this.fire(new ErrorEvent(error));
        } else if (json) {
            callback(json);
        }
    });
}

/**
 * 地理编码与逆地理编码
 * @param requestOptions
 * @param callback
 * @example
 */
function geocoder(requestOptions: Object, callback: Function, accessToken: string) {
    let defaultOptions = {
        address: '',
        city: '',
        location: '',
        ak: accessToken
    };
    requestOptions = extend({}, defaultOptions, requestOptions);
    let paramsArray = [];
    for (const key in requestOptions) {
        if (requestOptions[key] != '') {
            paramsArray.push(`${key}=${requestOptions[key]}`);
        }
    }
    let request = {
        url: `${config.API_URL}/gss/geocode/v2?${paramsArray.join('&')}`
    }
    getJSON(request, (error?: Error | null, json?: any | null) => {
        if (error) {
            this.fire(new ErrorEvent(error));
        } else if (json) {
            callback(json);
        }
    });
}

/**
 * 行政区划查询
 * @param requestOptions
 * @param callback
 * @param accessToken
 */
function districtSearch(requestOptions: Object, callback: Function, accessToken: string) {
    let defaultOptions = {
        query: '', //关键字，关键字的首字母、拼音格式如，公园/gy/gongyuan（必填）
        city: '', //所在的城市名称
        level: '', //只查询该级的行政区划，可选province(省)、cit有(城市)、district(区县)。说明：当参数city有效时，该参数无效
        ak: accessToken
    };
    requestOptions = extend({}, defaultOptions, requestOptions);
    let paramsArray = [];
    for (const key in requestOptions) {
        if (requestOptions[key] != '') {
            paramsArray.push(`${key}=${requestOptions[key]}`);
        }
    }
    let request = {
        url: `${config.API_URL}/gss/district/v2?${paramsArray.join('&')}`
    }
    getJSON(request, (error?: Error | null, json?: any | null) => {
        if (error) {
            this.fire(new ErrorEvent(error));
        } else if (json) {
            callback(json);
        }
    });
}

export {poiSearch, walking, driving, districtSearch, geocoder}