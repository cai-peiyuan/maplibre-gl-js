import type {RequestParameters} from './ajax';
import config from './config';
import {topsMapMspTransformRequestFunc} from './request/request_transform_topsmap_msp';

/**
 * A type of MapLibre resource.
 */
export const enum ResourceType {
    Glyphs = 'Glyphs',
    Image = 'Image',
    Source = 'Source',
    SpriteImage = 'SpriteImage',
    SpriteJSON = 'SpriteJSON',
    Style = 'Style',
    Tile = 'Tile',
    Unknown = 'Unknown',
}

export type RequestTransformFunction = (url: string, resourceType?: ResourceType) => RequestParameters;

type UrlObject = {
    protocol: string;
    authority: string;
    path: string;
    params: Array<string>;
};

export class RequestManager {
    _transformRequestFn: RequestTransformFunction;
    _transformRequestFnTopsMap: RequestTransformFunction;
    _customAccessToken: string;

    constructor(transformRequestFn?: RequestTransformFunction, accessToken?: string) {
        this._transformRequestFn = transformRequestFn;
        this._customAccessToken = accessToken;
        this._transformRequestFnTopsMap = topsMapMspTransformRequestFunc;
    }

    transformRequest(url: string, type: ResourceType) {

        if(this._transformRequestFnTopsMap){
            url = this._transformRequestFnTopsMap(url,type)['url'];
        }
        if (this._transformRequestFn) {
            return this._transformRequestFn(url, type) || {url};
        }

        return {url};
    }

    normalizeSpriteURL(url: string, format: string, extension: string): string {
        const urlObject = parseUrl(url);
        urlObject.path += `${format}${extension}`;
        return formatUrl(urlObject);
    }

    normalizeGlyphsURL(url: string): string {
        return url;
    }

    setTransformRequest(transformRequest: RequestTransformFunction) {
        this._transformRequestFn = transformRequest;
    }

    setTransformRequestTopsMap(transformRequest: RequestTransformFunction) {
        this._transformRequestFnTopsMap = transformRequest;
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

export {parseUrl, formatUrl, makeAPIURL}
