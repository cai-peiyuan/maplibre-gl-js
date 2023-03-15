var api_config = {
    "traffic_source": {
        "raster": {
            "tiles": ["http://114.215.68.185:8883/img/?t={z}-{x}-{y}"],
            "tileSize": "256",
            "type": "raster"
        },
        "vector": {"tiles": ["http://114.215.68.185:8883/amptraffic?t={z}-{x}-{y}"], "type": "vector"}
    },
    "url": "http://192.168.2.111:35001/msp/msp-api",
    "events_url":"/events/v2",
    "session":"/map-sessions/v1",
    "feedback":"/feedback",
    "report_map_events": false,
    "report_map_session": false
};

topsmapgl.config.API_URL = api_config.url;
topsmapgl.config.TRAFFIC_SOURCE = api_config.traffic_source;
topsmapgl.config.TRAFFIC_SOURCE = api_config.traffic_source;
topsmapgl.config.API_URL_EVENTS = api_config.events_url;
topsmapgl.config.API_URL_SESSION = api_config.session;
topsmapgl.config.API_URL_FEEDBACK = api_config.feedback;

topsmapgl.config.REPORT_MAP_EVENTS = api_config.report_map_events;
topsmapgl.config.REPORT_MAP_SESSION = api_config.report_map_session;

topsmapgl.config.DEBUG = true;
topsmapgl.accessToken='topsmap_token';
console.log(topsmapgl.config);
