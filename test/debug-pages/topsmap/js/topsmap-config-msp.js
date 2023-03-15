var api_config = {
    "traffic_source": {
        "raster": {
            "tiles": ["http://114.215.68.185:8883/img/?t={z}-{x}-{y}"],
            "tileSize": "256",
            "type": "raster"
        },
        "vector": {"tiles": ["http://202.93.255.51:8884/traffic?t={z}-{x}-{y}"], "type": "vector"}
    },
    "url": "http://202.93.255.51:35001",
    "events_url": "/events/v2",
    "session": "/map-sessions/v1",
    "feedback": "/feedback"
};

mapboxgl.config.API_URL = api_config.url;
mapboxgl.config.TRAFFIC_SOURCE = api_config.traffic_source;
mapboxgl.config.TRAFFIC_SOURCE = api_config.traffic_source;
// mapboxgl.config.API_URL_EVENTS = api_config.events_url;
// mapboxgl.config.API_URL_SESSION = api_config.session;
// mapboxgl.config.API_URL_FEEDBACK = api_config.feedback;
//
// mapboxgl.config.REPORT_MAP_EVENTS = false;
// mapboxgl.config.REPORT_MAP_SESSION = false;
// mapboxgl.config.API_VERSION = '2';

mapboxgl.config.DEBUG = true;
mapboxgl.accessToken = 'ec85d3648154874552835438ac6a02b2';
console.log(mapboxgl.config);
