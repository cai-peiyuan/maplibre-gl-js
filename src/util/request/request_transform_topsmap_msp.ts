import {makeAPIURL, parseUrl, RequestTransformFunction, ResourceType} from '../request_manager';
import config from '../config';

/**
 * 处理和转换资源url
 * 适配msp的url转换器
 * @param url
 * @param resourceType
 * http://121.36.99.212:35001/webglapi/styles?n=topsmap80&addSource=true&sourceType=http&ak=ec85d3648154874552835438ac6a02b2
 * return {
 *     url: string;
 *     headers?: any;
 *     method?: 'GET' | 'POST' | 'PUT';
 *     body?: string;
 *     type?: 'string' | 'json' | 'arrayBuffer';
 *     credentials?: 'same-origin' | 'include';
 *     collectResourceTiming?: boolean;
 * }
 */
const topsMapMspTransformRequestFunc: RequestTransformFunction = (url: string, resourceType?: ResourceType) => {
    //console.log('private protocol url =>' ,url, resourceType)
    let resultRequest = {
        url: url
    };
    /**
     * 地图样式资源url
     */
    if (resourceType === 'Style') {
        if (!isMapboxURL(url) && !isHttpURL(url)) {
            url = `topsmap://style/${url}`;
        }
        if (isHttpURL(url)) {
            resultRequest.url = url;
        } else {
            const urlObject = parseUrl(url);
            //urlObject.path = `/styles/v1${urlObject.path}`;
            let styleName = urlObject.path.replace('/', '');
            urlObject.params.push(`n=${styleName}`);
            urlObject.params.push(`addSource=true`);
            urlObject.params.push(`sourceType=http`);
            urlObject.authority = config.API_URL;
            urlObject.path = '/webglapi/styles';
            resultRequest.url = makeAPIURL(urlObject);//`${config.API_URL}/webglapi/styles?n=${url}&addSource=true&sourceType=http&ak=${config.ACCESS_TOKEN}`;
        }
    }
    /**
     * 图标集合json文件
     */
    if (resourceType === 'SpriteJSON' || resourceType === 'SpriteImage') {
        let spriteFileType = resourceType === 'SpriteJSON' ? 'json' : 'png';
        if (!isMapboxURL(url) && !isHttpURL(url)) {
            url = `topsmap://sprites/${url}.${spriteFileType}`;
        }
        if (isHttpURL(url)) {
            resultRequest.url = url;
        } else {
            const urlObject = parseUrl(url);
            //urlObject.path = `/styles/v1${urlObject.path}`;
            let spriteName = urlObject.path.replace('/', '').replace('.json', '').replace('.png', '');
            urlObject.params.push(`n=${spriteName}`);
            urlObject.params.push(`e=${spriteFileType}`);
            urlObject.authority = config.API_URL;
            urlObject.path = '/webglapi/sprite';
            resultRequest.url = makeAPIURL(urlObject);//http://121.36.99.212:35001/webglapi/sprite?n=topsmapjt@2x&e=json&ak=ec85d3648154874552835438ac6a02b2
        }
    }

    if (resourceType === 'Glyphs') {
        if (!isMapboxURL(url) && !isHttpURL(url)) {
            url = `topsmap://glyphs/${url}/{range}.pbf`;
        }
        if (isHttpURL(url)) {
            resultRequest.url = url;
        } else {
            const urlObject = parseUrl(url);
            //path: "/sourcehansanscn-normal/8192-8447.pbf"
            let fontInfoArr = urlObject.path.split('/');
            let fontstack = fontInfoArr[1];
            let range = fontInfoArr[2].split('.')[0];
            urlObject.params.push(`n=${fontstack}`);
            urlObject.params.push(`r=${range}`);
            urlObject.authority = config.API_URL;
            urlObject.path = '/webglapi/fonts';
            resultRequest.url = makeAPIURL(urlObject); // Request URL: http://121.36.99.212:35001/webglapi/fonts?n=sourcehansanscn-normal&r=0-255&ak=ec85d3648154874552835438ac6a02b2
        }
    }

    if (resourceType === 'Image') {

    }
    if (resourceType === 'Tile') {

    }
    if (resourceType === 'Unknown') {

    }

    if (resourceType === 'Source' && url.indexOf('http://myHost') > -1) {
        return {
            url: url.replace('http', 'https'),
            headers: {'my-custom-header': true},
            credentials: 'include'  // Include cookies for cross-origin requests
        }
    }
//console.log('target resource url =>' ,resultRequest.url, resourceType)
    return resultRequest
}


function isMapboxURL(url: string) {
    return url.indexOf('mapbox:') === 0 || url.indexOf('topsmap:') === 0;
}

function isHttpURL(url: string) {
    return url.indexOf('http:') === 0 || url.indexOf('https:') === 0;
}

function isMapboxHTTPURL(url: string): boolean {
    return config.API_URL_REGEX.test(url);
}

function hasCacheDefeatingSku(url: string) {
    return url.indexOf('sku=') > 0 && isMapboxHTTPURL(url);
}

export {isMapboxURL, isHttpURL, isMapboxHTTPURL, hasCacheDefeatingSku, topsMapMspTransformRequestFunc};
