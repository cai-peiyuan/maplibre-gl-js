var api_config = {
    "traffic_source": {
        "raster": {
            "tiles": ["http://114.215.68.185:8883/img/?t={z}-{x}-{y}"], "tileSize": "256", "type": "raster"
        }, "vector": {"tiles": ["http://114.215.68.185:8883/amptraffic?t={z}-{x}-{y}"], "type": "vector"}
    },
    "url": "https://api.mapbox.com",
    "events_url": "/events/v2",
    "session": "/map-sessions/v1",
    "feedback": "/feedback"
};
api_config = {
    "traffic_source": {
        "raster": {
            "tiles": ["http://121.36.99.212:8883/img?t={z}-{x}-{y}"], "tileSize": "256", "type": "raster"
        }, "vector": {"tiles": ["http://121.36.99.212:8883/amptraffic?t={z}-{x}-{y}"], "type": "vector"}
    }, "url": "http://120.48.166.81:10010"
};

topsmapgl.config.API_URL = api_config.url;
topsmapgl.config.TRAFFIC_SOURCE = api_config.traffic_source;
topsmapgl.config.TRAFFIC_SOURCE = api_config.traffic_source;
topsmapgl.config.API_URL_EVENTS = api_config.events_url;
topsmapgl.config.API_URL_SESSION = api_config.session;
topsmapgl.config.API_URL_FEEDBACK = api_config.feedback;

topsmapgl.config.REPORT_MAP_EVENTS = true;
topsmapgl.config.REPORT_MAP_SESSION = true;

topsmapgl.config.DEBUG = true;
topsmapgl.accessToken = '21d133d5154d5632b9146cec98958fa8';
console.log(topsmapgl.config);
