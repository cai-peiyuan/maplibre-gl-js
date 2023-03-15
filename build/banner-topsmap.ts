import fs from 'fs';

const version = JSON.parse(fs.readFileSync('package.json').toString()).version;
export default `/* TOPSMAP GL JS 矢量地图服务 JavaScript. https://www.topsmap.com/sdk/topsmap-gl-js/v${version}.txt */`;
