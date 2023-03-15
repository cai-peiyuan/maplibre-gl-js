import fs from 'fs';
import sourcemaps from 'rollup-plugin-sourcemaps';
import {plugins} from './build/rollup_plugins';
import replace from '@rollup/plugin-replace';
import banner from './build/banner';
import bannerTopsMap from './build/banner-topsmap';
import {RollupOptions} from 'rollup';
//import {importAssertions} from 'acorn-import-assertions';

const {BUILD, TOPSMAP} = process.env;
const production = BUILD === 'production';

// 是否打包成topsmapgl命名空间
const buildTopsMap = TOPSMAP === 'true';

const nameSpace = buildTopsMap ? 'topsmap' : 'maplibre';

let fileBanner = (buildTopsMap ? bannerTopsMap : banner);

/**
 * 根据配置的变量计算生成的文件名称
 * @param production
 * @param buildTopsMap
 */
function getOutputFile(production, buildTopsMap) {
    return production ? 'dist/' + nameSpace + '-gl.js' : 'dist/' + nameSpace + '-gl-dev.js';
}

// 文件名称
const outputFile = getOutputFile(production, buildTopsMap);

/**
 * 打包配置插件
 */
let pluginsForRollup = plugins(production);
let pluginsForRollup2 = production? []:[
    // Ingest the sourcemaps produced in the first step of the build.
    // This is the only reason we use Rollup for this second pass
    sourcemaps()
];

if (buildTopsMap) {

    const forReplaceOption = {
        'https://maplibre.org/maplibre-gl-js-docs': 'https://www.topsmap.com/topsmap-gl-js-docs',
        'github.com/maplibre/maplibre-gl-js': 'github.com/topsmap/topsmap-gl-js',
        'https://www.maplibre.org': 'https://www.topsmap.com',
        '.maplibre.org': '.topsmap.com',
        'maplibre.org': 'topsmap.com',
        'maplibregl': 'topsmapgl',
        'maplibre-gl': 'topsmap-gl',
        'MapLibre': 'TOPSMAP',
        'maplibre': 'topsmap',
        'mapboxGlSupported': 'topsmapGlSupported',
        'mapboxgl': 'topsmapgl',
        'mapbox-gl': 'topsmap-gl',
        'mapbox': 'topsmap',
        'Mapbox': 'TOPSMAP',
    };

    for (const forReplaceOptionKey in forReplaceOption) {
        console.log(`打包类库替换字符串 ${forReplaceOptionKey}  ->  ${forReplaceOption[forReplaceOptionKey]}`);
    }

    /**
     * 设置类库打包时源码中替换的字符串
     * 源字符串 -> 目标字符串
     */
    pluginsForRollup2.push(replace({
        preventAssignment: true,
        __buildDate__: () => JSON.stringify(new Date()),
        delimiters: ['', ''],
        values: forReplaceOption
    }));
}

const config: RollupOptions[] = [{
    // Before rollup you should run build-tsc to transpile from typescript to javascript (except when running rollup in watch mode)
    // Rollup will use code splitting to bundle GL JS into three "chunks":
    // - staging/maplibregl/index.js: the main module, plus all its dependencies not shared by the worker module
    // - staging/maplibregl/worker.js: the worker module, plus all dependencies not shared by the main module
    // - staging/maplibregl/shared.js: the set of modules that are dependencies of both the main module and the worker module
    //
    // This is also where we do all of our source transformations using the plugins.
    input: ['src/index.ts', 'src/source/worker.ts'],
    output: {
        dir: 'staging/' + nameSpace + 'gl',
        format: 'amd',
        sourcemap: 'inline',
        indent: false,
        chunkFileNames: 'shared.js'
    },
    onwarn: (message) => {
        console.error(message);
        throw message;
    },
    treeshake: production,
    //acornInjectPlugins: [importAssertions],
    plugins: pluginsForRollup
}, {
    // Next, bundle together the three "chunks" produced in the previous pass
    // into a single, final bundle. See rollup/bundle_prelude.js and
    // rollup/maplibregl.js for details.
    input: 'build/rollup/' + nameSpace + 'gl.js',
    output: {
        name: nameSpace + 'gl', // 生成命名空间名称
        file: outputFile,
        format: 'umd',
        sourcemap: true,
        indent: false,
        intro: fs.readFileSync('./build/rollup/bundle_prelude_' + nameSpace + 'gl.js', 'utf8'),
        banner: fileBanner
    },
    treeshake: false,
    plugins: pluginsForRollup2, //替換字符插件用在第二部打包
}];

export default config;
