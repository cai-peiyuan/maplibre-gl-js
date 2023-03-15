import {ResourceType} from '../util/request_manager';
import config from '../util/config';

import type {RequestParameters} from './ajax';
import {isMapboxURL} from './request/request_transform_topsmap_msp';

export type RequestTransformFunction = (url: string, resourceType?: ResourceType) => RequestParameters;

type UrlObject = {
    protocol: string;
    authority: string;
    path: string;
    params: Array<string>;
};

export class RequestManager {
    _transformRequestFn: RequestTransformFunction;
    _customAccessToken: string;

    constructor(transformRequestFn?: RequestTransformFunction, accessToken?: string) {
        this._transformRequestFn = transformRequestFn;
        this._customAccessToken = accessToken;
    }

    transformRequest(url: string, type: ResourceType) {
        if (this._transformRequestFn) {
            return this._transformRequestFn(url, type) || {url};
        }

        return {url};
    }

    normalizeSpriteURL(url: string, format: string, extension: string): string {
        const urlObject = parseUrl(url);
        if (urlObject.protocol == 'http' || urlObject.protocol == 'http' || urlObject.protocol == 'file') {
            urlObject.path += `${format}${extension}`;
            return formatUrl(urlObject);
        } else if (urlObject.protocol == 'topsmap' || urlObject.protocol == 'mapbox') {
            return formatProperStyleUrl(urlObject, format, extension, this._customAccessToken);
        }
    }

    normalizeGlyphsURL(url: string): string {
        if (!isMapboxURL(url)) {
            return url;
        }
        const urlObject = parseUrl(url);
        urlObject.path = `/fonts/v1${urlObject.path}`;
        return formatProperGlyphsUrl(urlObject, this._customAccessToken || config.ACCESS_TOKEN);
    }

    setTransformRequest(transformRequest: RequestTransformFunction) {
        this._transformRequestFn = transformRequest;
    }

    setAccessToken(accessToken: string) {
        this._customAccessToken = accessToken;
    }

}

const urlRe = /^(\w+):\/\/([^/?]*)(\/[^?]+)?\??(.+)?/;

function parseUrl(url: string): UrlObject {
    const parts = url.match(urlRe);
    if (!parts) {
        throw new Error(`Unable to parse URL "${url}"`);
    }
    return {
        protocol: parts[1],
        authority: parts[2],
        path: parts[3] || '/',
        params: parts[4] ? parts[4].split('&') : []
    };
}

function formatUrl(obj: UrlObject): string {
    const params = obj.params.length ? `?${obj.params.join('&')}` : '';
    return `${obj.protocol}://${obj.authority}${obj.path}${params}`;
}

function formatProperGlyphsUrl(obj: UrlObject, accessToken: string): string {
    const params = obj.params.length ? `${obj.params.join('&')}` : '';
    //Request URL: http://121.36.99.212:35001/webglapi/fonts?n=sourcehansanscn-normal&r=0-255&ak=ec85d3648154874552835438ac6a02b2
    return `${config.API_URL}/webglapi/fonts?n={fontstack}&r={range}&ak=${accessToken}&${params}`;
}

function formatProperStyleUrl(obj: UrlObject, format: string, extension: string, accessToken?: string): string {
    if (obj.protocol == 'topsmap') {
        let styleName = obj.path.replace('/', '');
        let styleFileType = extension.replace('.', '');
        const params = obj.params.length ? `${obj.params.join('&')}` : '';
        accessToken = accessToken || config.ACCESS_TOKEN;
        return `${config.API_URL}/webglapi/sprite?n=${styleName}${format}&e=${styleFileType}&ak=${accessToken}&${params}`;
    } else {
        const params = obj.params.length ? `?${obj.params.join('&')}` : '';
        return `${obj.protocol}://${obj.authority}${obj.path}${params}`;
    }
}

function makeAPIURL(urlObj: UrlObject, accessToken?: string | null | void): string {
    const apiUrl = parseUrl(config.API_URL);
    urlObj.protocol = apiUrl.protocol;
    urlObj.authority = apiUrl.authority;

    if (urlObj.protocol === 'http') {
        const i = urlObj.params.indexOf('secure');
        if (i >= 0) urlObj.params.splice(i, 1);
    }

    if (apiUrl.path !== '/') {
        urlObj.path = `${apiUrl.path}${urlObj.path}`;
    }

    if (!config.REQUIRE_ACCESS_TOKEN) return formatUrl(urlObj);

    accessToken = accessToken || config.ACCESS_TOKEN;

    urlObj.params = urlObj.params.filter((d) => d.indexOf('access_token') === -1);
    urlObj.params.push(`access_token=${accessToken || ''}`);
    urlObj.params.push(`ak=${accessToken || ''}`);
    return formatUrl(urlObj);
}

export {parseUrl, formatUrl, formatProperGlyphsUrl, formatProperStyleUrl, makeAPIURL}
