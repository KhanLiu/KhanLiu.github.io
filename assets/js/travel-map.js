(function () {
    "use strict";

    var visits = [];
    var flights = [];
    var airports = Object.create(null);
    var livedAirportCodes = { WUH: true, TNA: true, MUC: true, VIE: true };
    var map = null;
    var mapReady = false;
    var selectedIndex = -1;
    var selectedPlaceKey = "";
    var selectedFlightIndex = -1;
    var selectedAirportCode = "";
    var viewMode = "cities";
    var statusMessages = [];
    var renderedPlaceVisitsKey = "";
    var placeRadiusStops = [1, 4, 7, 5, 30, 7, 100, 9, 500, 11];
    var placeHaloStops = [1, 10, 7, 12, 30, 15, 100, 18, 500, 21];
    var maxTravelPlaceRadius = 4;
    var maxTravelHaloRadius = 12;
    var elements;
    var demoNotice;

    function initializeTravelMap() {
        var root = document.getElementById("travel-map");
        if (!root) return;

        elements = {
            canvas: document.getElementById("travel-map-canvas"),
            status: document.getElementById("travel-map-status"),
            cityView: document.getElementById("travel-city-view"),
            flightView: document.getElementById("travel-flight-view"),
            citiesButton: document.getElementById("travel-view-cities"),
            flightsButton: document.getElementById("travel-view-flights"),
            empty: document.getElementById("travel-story-empty"),
            content: document.getElementById("travel-story-content"),
            storyError: document.getElementById("travel-story-error"),
            summary: document.getElementById("travel-summary"),
            summaryList: document.getElementById("travel-summary-list"),
            cityStory: document.getElementById("travel-city-story"),
            storyDate: document.getElementById("travel-story-date"),
            storyTitle: document.getElementById("travel-story-title"),
            livedHere: document.getElementById("travel-story-lived-here"),
            storyPlace: document.getElementById("travel-story-place"),
            cityStats: document.getElementById("travel-story-stats"),
            description: document.getElementById("travel-story-description"),
            placeVisits: document.getElementById("travel-city-visits"),
            placeVisitsSummary: document.getElementById("travel-city-visits-summary"),
            placeVisitsList: document.getElementById("travel-city-visits-list"),
            photoWrap: document.getElementById("travel-photo-wrap"),
            photo: document.getElementById("travel-photo"),
            flightEmpty: document.getElementById("travel-flight-empty"),
            flightContent: document.getElementById("travel-flight-content"),
            flightTitle: document.getElementById("travel-flight-title"),
            flightAirports: document.getElementById("travel-flight-airports"),
            flightNumber: document.getElementById("travel-flight-number"),
            airportFlights: document.getElementById("travel-airport-flights"),
            flightStats: document.getElementById("travel-flight-stats"),
            flightStatsList: document.getElementById("travel-flight-stats-list")
        };
        demoNotice = document.getElementById("travel-demo-notice");

        try {
            visits = JSON.parse(document.getElementById("travel-data").textContent);
        } catch (error) {
            showError("The travel data could not be read. Check the YAML syntax in _data/trips.yml.");
            return;
        }

        if (!Array.isArray(visits)) {
            showError("Travel data must be a list of visits in _data/trips.yml.");
            return;
        }

        try {
            var flightData = JSON.parse(document.getElementById("flight-data").textContent);
            if (Array.isArray(flightData)) {
                flights = flightData;
            } else if (flightData && typeof flightData === "object") {
                airports = flightData.airports || Object.create(null);
                flights = flightData.flights;
            } else {
                flights = flightData;
            }
        } catch (error) {
            flights = [];
            addStatus("Flight data could not be read. Check the YAML syntax in _data/flights.yml.");
        }

        if (!Array.isArray(flights)) {
            flights = [];
            addStatus("Flight data must be a list in _data/flights.yml.");
        }

        var rejectedVisits = visits.length - visits.filter(isValidVisit).length;
        visits = visits.map(function (visit, index) {
            return Object.assign({ _index: index }, visit);
        }).filter(isValidVisit).sort(function (a, b) {
            return a.date.localeCompare(b.date) || a._index - b._index;
        });
        visits.forEach(function (visit) {
            visit._placeKey = visit.city.toLocaleLowerCase() + "|" + visit.country.toLocaleLowerCase();
        });
        var livedPlaces = Object.create(null);
        visits.forEach(function (visit) {
            if (visit.lived_here === true) {
                livedPlaces[visit._placeKey] = true;
            }
        });
        visits.forEach(function (visit) {
            visit._livedHere = Boolean(livedPlaces[visit._placeKey]);
        });
        renderSummary(visits);
        var rejectedFlights = flights.length;
        flights = flights.map(function (flight, index) {
            return Object.assign({ _index: index }, flight, {
                origin: resolveFlightEndpoint(flight && flight.origin),
                destination: resolveFlightEndpoint(flight && flight.destination)
            });
        }).filter(isValidFlight).sort(function (a, b) {
            return a.date.localeCompare(b.date) || a._index - b._index;
        });
        var today = getLocalDateString();
        flights.forEach(function (flight) {
            flight._upcoming = flight.date >= today;
        });
        rejectedFlights -= flights.length;
        renderFlightStats(flights);
        demoNotice.hidden = !visits.some(function (visit) {
            return visit.demo === true;
        });

        if (typeof window.maplibregl === "undefined" || typeof window.maplibregl.Map !== "function") {
            addStatus("The interactive globe could not load. Check your connection; your travel data is still available.");
        } else {
            try {
                initializeGlobe();
            } catch (error) {
                addStatus("The globe could not start. Check that WebGL is enabled in your browser.");
            }
        }

        if (rejectedVisits) {
            addStatus(rejectedVisits + " visit" + (rejectedVisits === 1 ? " was" : "s were")
                + " skipped because its data is incomplete or invalid. Check _data/trips.yml.");
        }
        if (rejectedFlights) {
            addStatus(rejectedFlights + " flight" + (rejectedFlights === 1 ? " was" : "s were")
                + " skipped because its data is incomplete or invalid. Check _data/flights.yml.");
        }

        elements.citiesButton.addEventListener("click", function () {
            setViewMode("cities");
        });
        elements.flightsButton.addEventListener("click", function () {
            setViewMode("flights");
        });
        if (visits.length) {
            elements.empty.hidden = true;
            elements.cityStory.hidden = true;
        }
    }

    function initializeGlobe() {
        map = new window.maplibregl.Map({
            container: elements.canvas,
            style: "https://tiles.openfreemap.org/styles/positron",
            center: initialMapCenter(),
            zoom: 1.5,
            minZoom: 0.8,
            maxZoom: 12,
            projection: { type: "globe" },
            attributionControl: false,
            renderWorldCopies: false,
            cooperativeGestures: true
        });

        map.addControl(new window.maplibregl.NavigationControl({
            showCompass: true,
            showZoom: true,
            visualizePitch: false
        }), "top-right");
        map.addControl(new window.maplibregl.AttributionControl({
            compact: true,
            customAttribution: "Map data © OpenStreetMap contributors · OpenFreeMap"
        }), "bottom-right");

        map.on("error", function (event) {
            if (event && event.error) {
                addStatus("The globe is having trouble loading map data. Check your connection to OpenFreeMap.");
            }
        });

        map.on("load", function () {
            mapReady = true;
            map.setProjection({ type: "globe" });
            map.addSource("travel-places", {
                type: "geojson",
                data: createVisitFeatures()
            });
            map.addSource("travel-flights", {
                type: "geojson",
                data: createFlightFeatures()
            });
            map.addLayer({
                id: "travel-place-halo",
                type: "circle",
                source: "travel-places",
                paint: {
                    "circle-radius": placeRadiusExpression(true),
                    "circle-color": ["case", ["==", ["get", "livedHere"], true], "#0065bd", "#72c4e8"],
                    "circle-opacity": 0.24,
                    "circle-blur": 0.7
                }
            });
            map.addLayer({
                id: "travel-place-point",
                type: "circle",
                source: "travel-places",
                paint: {
                    "circle-radius": placeRadiusExpression(false),
                    "circle-color": ["case", ["==", ["get", "livedHere"], true], "#0065bd", "#72c4e8"],
                    "circle-stroke-width": ["case", ["==", ["get", "placeKey"], selectedPlaceKey], 2.5,
                        1.5],
                    "circle-stroke-color": "#f8fbfa"
                }
            });
            map.addLayer({
                id: "travel-flight-route",
                type: "line",
                source: "travel-flights",
                filter: ["all",
                    ["==", ["get", "kind"], "route"],
                    ["==", ["get", "upcoming"], false]
                ],
                layout: {
                    visibility: "none",
                    "line-join": "round",
                    "line-cap": "round"
                },
                paint: {
                    "line-color": "#7c3aed",
                    "line-width": ["case", ["==", ["get", "selected"], true], 3.5, 1.5],
                    "line-opacity": ["case", ["==", ["get", "selected"], true], 0.95, 0.22]
                }
            });
            map.addLayer({
                id: "travel-flight-route-upcoming",
                type: "line",
                source: "travel-flights",
                filter: ["all",
                    ["==", ["get", "kind"], "route"],
                    ["==", ["get", "upcoming"], true]
                ],
                layout: {
                    visibility: "none",
                    "line-join": "round",
                    "line-cap": "round"
                },
                paint: {
                    "line-color": "#9b7be5",
                    "line-dasharray": [2, 1.5],
                    "line-width": ["case", ["==", ["get", "selected"], true], 3.5, 1.75],
                    "line-opacity": ["case", ["==", ["get", "selected"], true], 0.95, 0.8]
                }
            });
            map.addLayer({
                id: "travel-flight-direction",
                type: "symbol",
                source: "travel-flights",
                filter: ["all",
                    ["==", ["get", "kind"], "route"],
                    ["==", ["get", "upcoming"], false]
                ],
                layout: {
                    visibility: "none",
                    "symbol-placement": "line",
                    "symbol-spacing": 260,
                    "text-field": "▶",
                    "text-size": 10,
                    "text-rotation-alignment": "map",
                    "text-keep-upright": false
                },
                paint: {
                    "text-color": "#7c3aed",
                    "text-opacity": ["case", ["==", ["get", "selected"], true], 0.95, 0.25],
                    "text-halo-color": "#fffdfb",
                    "text-halo-width": 1
                }
            });
            map.addLayer({
                id: "travel-flight-direction-upcoming",
                type: "symbol",
                source: "travel-flights",
                filter: ["all",
                    ["==", ["get", "kind"], "route"],
                    ["==", ["get", "upcoming"], true]
                ],
                layout: {
                    visibility: "none",
                    "symbol-placement": "line",
                    "symbol-spacing": 260,
                    "text-field": "▶",
                    "text-size": 10,
                    "text-rotation-alignment": "map",
                    "text-keep-upright": false
                },
                paint: {
                    "text-color": "#9b7be5",
                    "text-opacity": ["case", ["==", ["get", "selected"], true], 0.95, 0.8],
                    "text-halo-color": "#fffdfb",
                    "text-halo-width": 1
                }
            });
            map.addLayer({
                id: "travel-flight-airport",
                type: "circle",
                source: "travel-flights",
                filter: ["==", ["get", "kind"], "airport"],
                layout: { visibility: "none" },
                paint: {
                    "circle-radius": ["case", ["==", ["get", "selected"], true], 6, 4],
                    "circle-color": ["case",
                        ["==", ["get", "livedHere"], true], "#0065bd",
                        ["==", ["get", "visitedBefore"], true], "#72c4e8",
                        "#8296a3"
                    ],
                    "circle-opacity": 0.95,
                    "circle-stroke-width": ["case", ["==", ["get", "selected"], true], 2, 1],
                    "circle-stroke-color": "#fffdfb"
                }
            });
            map.addLayer({
                id: "travel-flight-airport-code",
                type: "symbol",
                source: "travel-flights",
                filter: ["==", ["get", "kind"], "airport"],
                layout: {
                    visibility: "none",
                    "text-field": ["get", "airport"],
                    "text-font": ["Noto Sans Bold"],
                    "text-size": 9,
                    "text-offset": [0, 1.2],
                    "text-anchor": "top",
                    "text-allow-overlap": false,
                    "text-ignore-placement": false
                },
                paint: {
                    "text-color": ["case",
                        ["==", ["get", "livedHere"], true], "#0065bd",
                        ["==", ["get", "visitedBefore"], true], "#72c4e8",
                        "#6f8796"
                    ],
                    "text-halo-color": "#fffdfb",
                    "text-halo-width": 1.25
                }
            });
            ["travel-place-point"].forEach(function (layerId) {
                map.on("mouseenter", layerId, function () {
                    map.getCanvas().style.cursor = "pointer";
                });
                map.on("mouseleave", layerId, function () {
                    map.getCanvas().style.cursor = "";
                });
                map.on("click", layerId, function (event) {
                    var feature = event.features && event.features[0];
                    if (feature) {
                        selectPlace(feature.properties.placeKey, true, true);
                    }
                });
            });
            ["travel-flight-route", "travel-flight-route-upcoming",
                "travel-flight-airport", "travel-flight-airport-code"].forEach(function (layerId) {
                map.on("mouseenter", layerId, function () {
                    map.getCanvas().style.cursor = "pointer";
                });
                map.on("mouseleave", layerId, function () {
                    map.getCanvas().style.cursor = "";
                });
            });
            map.on("click", function (event) {
                if (viewMode !== "flights") return;
                var features = map.queryRenderedFeatures(event.point, {
                    layers: ["travel-flight-airport-code", "travel-flight-airport",
                        "travel-flight-route-upcoming", "travel-flight-route"]
                });
                var airportFeature = features.find(function (feature) {
                    return feature.properties.kind === "airport";
                });
                if (airportFeature) {
                    showAirportFlights(airportFeature.properties.airport, true);
                    return;
                }
                var routeFeature = features.find(function (feature) {
                    return feature.properties.kind === "route";
                });
                if (routeFeature) {
                    selectFlight(Number(routeFeature.properties.index), true);
                }
            });
            setMapViewVisibility();
            updateSelectedPoint();
            updateFlightSelection();
        });
    }

    function createVisitFeatures() {
        var places = Object.create(null);
        var features = [];
        visits.forEach(function (visit) {
            var place = places[visit._placeKey];
            if (!place) {
                place = places[visit._placeKey] = {
                    placeKey: visit._placeKey,
                    livedHere: visit._livedHere,
                    stayDays: 0,
                    stayCount: 0,
                    coordinates: visit.coordinates
                };
            }
            place.stayDays += visit.stay_days;
            place.stayCount += 1;
        });
        maxTravelPlaceRadius = 4;
        maxTravelHaloRadius = 12;
        Object.keys(places).forEach(function (placeKey) {
            var place = places[placeKey];
            if (place.livedHere) return;
            maxTravelPlaceRadius = Math.max(maxTravelPlaceRadius,
                getPlaceRadius(place.stayDays, placeRadiusStops));
            maxTravelHaloRadius = Math.max(maxTravelHaloRadius,
                getPlaceRadius(place.stayDays, placeHaloStops));
        });
        Object.keys(places).forEach(function (placeKey) {
            var place = places[placeKey];
            features.push({
                type: "Feature",
                properties: {
                    placeKey: place.placeKey,
                    livedHere: place.livedHere,
                    stayDays: place.stayDays,
                    stayCount: place.stayCount
                },
                geometry: {
                    type: "Point",
                    coordinates: [place.coordinates[1], place.coordinates[0]]
                }
            });
        });
        return {
            type: "FeatureCollection",
            features: features
        };
    }

    function initialMapCenter() {
        if (visits.length) {
            var visit = visits[initialVisitIndex()];
            return [visit.coordinates[1], visit.coordinates[0]];
        }
        if (flights.length) {
            return [flights[0].origin.coordinates[1], flights[0].origin.coordinates[0]];
        }
        return [0, 20];
    }

    function initialVisitIndex() {
        var munichIndex = visits.findIndex(function (visit) {
            return /^munich(?:\s|$)/i.test(visit.city.trim());
        });
        return munichIndex >= 0 ? munichIndex : 0;
    }

    function createFlightFeatures() {
        var features = [];
        var airportsByCode = Object.create(null);
        var routeDirections = Object.create(null);
        flights.forEach(function (flight) {
            routeDirections[flight.origin.airport + ">" + flight.destination.airport] = true;
        });
        flights.forEach(function (flight, index) {
            var origin = [flight.origin.coordinates[1], flight.origin.coordinates[0]];
            var destination = [flight.destination.coordinates[1], flight.destination.coordinates[0]];
            var hasReturnRoute = Boolean(routeDirections[
                flight.destination.airport + ">" + flight.origin.airport
            ]);
            [flight.origin, flight.destination].forEach(function (endpoint) {
                if (!airportsByCode[endpoint.airport]) {
                    airportsByCode[endpoint.airport] = {
                        airport: endpoint.airport,
                        endpoint: endpoint,
                        flightCount: 0,
                        visitedBefore: false
                    };
                }
                airportsByCode[endpoint.airport].flightCount += 1;
                if (!flight._upcoming) airportsByCode[endpoint.airport].visitedBefore = true;
            });
            var routeSelected = index === selectedFlightIndex || (selectedAirportCode
                && (flight.origin.airport === selectedAirportCode
                    || flight.destination.airport === selectedAirportCode));
            features.push({
                type: "Feature",
                properties: {
                    kind: "route",
                    index: index,
                    selected: Boolean(routeSelected),
                    upcoming: flight._upcoming
                },
                geometry: {
                    type: "MultiLineString",
                    coordinates: createGreatCircleSegments(origin, destination, hasReturnRoute ? 2.2 : 0)
                }
            });
        });
        Object.keys(airportsByCode).forEach(function (code) {
            var airport = airportsByCode[code];
            var selected = selectedAirportCode === code || (selectedFlightIndex >= 0
                && (flights[selectedFlightIndex].origin.airport === code
                    || flights[selectedFlightIndex].destination.airport === code));
            features.push({
                type: "Feature",
                properties: {
                    kind: "airport",
                    airport: airport.airport,
                    flightCount: airport.flightCount,
                    livedHere: Boolean(livedAirportCodes[code]),
                    visitedBefore: airport.visitedBefore,
                    selected: selected
                },
                geometry: {
                    type: "Point",
                    coordinates: [airport.endpoint.coordinates[1], airport.endpoint.coordinates[0]]
                }
            });
        });
        return { type: "FeatureCollection", features: features };
    }

    function placeRadiusExpression(halo) {
        var selected = ["==", ["get", "placeKey"], selectedPlaceKey];
        var livedRadius = halo ? maxTravelHaloRadius : maxTravelPlaceRadius;
        var travelRadii = ["interpolate", ["linear"], ["get", "stayDays"]]
            .concat(halo ? placeHaloStops : placeRadiusStops);
        return ["case",
            ["==", ["get", "livedHere"], true],
            livedRadius,
            selected,
            ["+", travelRadii, 2],
            travelRadii
        ];
    }

    function getPlaceRadius(stayDays, stops) {
        for (var index = 0; index < stops.length - 2; index += 2) {
            var nextDays = stops[index + 2];
            if (stayDays <= nextDays) {
                var fraction = (stayDays - stops[index]) / (nextDays - stops[index]);
                return stops[index + 1] + fraction * (stops[index + 3] - stops[index + 1]);
            }
        }
        return stops[stops.length - 1];
    }

    function createGreatCircleSegments(start, end, offsetDegrees) {
        var startVector = coordinateToVector(start);
        var endVector = coordinateToVector(end);
        var normalVector = [
            startVector[1] * endVector[2] - startVector[2] * endVector[1],
            startVector[2] * endVector[0] - startVector[0] * endVector[2],
            startVector[0] * endVector[1] - startVector[1] * endVector[0]
        ];
        var normalLength = Math.sqrt(normalVector[0] * normalVector[0]
            + normalVector[1] * normalVector[1] + normalVector[2] * normalVector[2]);
        if (normalLength < 0.000001) {
            var reference = Math.abs(startVector[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
            normalVector = normalizeVector([
                startVector[1] * reference[2] - startVector[2] * reference[1],
                startVector[2] * reference[0] - startVector[0] * reference[2],
                startVector[0] * reference[1] - startVector[1] * reference[0]
            ]);
        } else {
            normalVector = normalVector.map(function (component) {
                return component / normalLength;
            });
        }
        var dot = Math.max(-1, Math.min(1,
            startVector[0] * endVector[0] + startVector[1] * endVector[1] + startVector[2] * endVector[2]));
        var angle = Math.acos(dot);
        var segments = [[]];
        var previous = null;
        var steps = 48;

        for (var i = 0; i <= steps; i += 1) {
            var fraction = i / steps;
            var vector;
            if (angle < 0.000001) {
                vector = normalizeVector([
                    startVector[0] + (endVector[0] - startVector[0]) * fraction,
                    startVector[1] + (endVector[1] - startVector[1]) * fraction,
                    startVector[2] + (endVector[2] - startVector[2]) * fraction
                ]);
            } else if (angle > Math.PI - 0.000001) {
                var perpendicular = [
                    endVector[0] - dot * startVector[0],
                    endVector[1] - dot * startVector[1],
                    endVector[2] - dot * startVector[2]
                ];
                var perpendicularLength = Math.sqrt(
                    perpendicular[0] * perpendicular[0]
                    + perpendicular[1] * perpendicular[1]
                    + perpendicular[2] * perpendicular[2]
                );
                if (perpendicularLength < 0.000001) {
                    perpendicular = [
                        -startVector[1],
                        startVector[0],
                        0
                    ];
                    perpendicularLength = Math.sqrt(
                        perpendicular[0] * perpendicular[0]
                        + perpendicular[1] * perpendicular[1]
                        + perpendicular[2] * perpendicular[2]
                    );
                    if (perpendicularLength < 0.000001) {
                        perpendicular = [0, -startVector[2], startVector[1]];
                        perpendicularLength = Math.sqrt(
                            perpendicular[0] * perpendicular[0]
                            + perpendicular[1] * perpendicular[1]
                            + perpendicular[2] * perpendicular[2]
                        );
                    }
                }
                perpendicular = perpendicular.map(function (component) {
                    return component / perpendicularLength;
                });
                vector = fraction === 1 ? endVector : [
                    startVector[0] * Math.cos(angle * fraction) + perpendicular[0] * Math.sin(angle * fraction),
                    startVector[1] * Math.cos(angle * fraction) + perpendicular[1] * Math.sin(angle * fraction),
                    startVector[2] * Math.cos(angle * fraction) + perpendicular[2] * Math.sin(angle * fraction)
                ];
            } else {
                var scaleA = Math.sin((1 - fraction) * angle) / Math.sin(angle);
                var scaleB = Math.sin(fraction * angle) / Math.sin(angle);
                vector = [
                    startVector[0] * scaleA + endVector[0] * scaleB,
                    startVector[1] * scaleA + endVector[1] * scaleB,
                    startVector[2] * scaleA + endVector[2] * scaleB
                ];
            }
            if (offsetDegrees && fraction > 0 && fraction < 1) {
                var offset = offsetDegrees * Math.PI / 180 * Math.sin(Math.PI * fraction);
                var offsetCosine = Math.cos(offset);
                var offsetSine = Math.sin(offset);
                vector = normalizeVector([
                    vector[0] * offsetCosine + normalVector[0] * offsetSine,
                    vector[1] * offsetCosine + normalVector[1] * offsetSine,
                    vector[2] * offsetCosine + normalVector[2] * offsetSine
                ]);
            }
            var coordinate = vectorToCoordinate(vector);

            if (previous && Math.abs(coordinate[0] - previous[0]) > 180) {
                var adjustedLongitude = coordinate[0] + (previous[0] > 0 ? 360 : -360);
                var boundary = previous[0] > 0 ? 180 : -180;
                var crossingFraction = (boundary - previous[0]) / (adjustedLongitude - previous[0]);
                var crossingLatitude = previous[1] + (coordinate[1] - previous[1]) * crossingFraction;
                segments[segments.length - 1].push([boundary, crossingLatitude]);
                segments.push([[-boundary, crossingLatitude]]);
            }

            segments[segments.length - 1].push(coordinate);
            previous = coordinate;
        }

        return segments.filter(function (segment) {
            return segment.length > 1;
        });
    }

    function coordinateToVector(coordinate) {
        var latitude = coordinate[1] * Math.PI / 180;
        var longitude = coordinate[0] * Math.PI / 180;
        return [
            Math.cos(latitude) * Math.cos(longitude),
            Math.cos(latitude) * Math.sin(longitude),
            Math.sin(latitude)
        ];
    }

    function vectorToCoordinate(vector) {
        return [
            Math.atan2(vector[1], vector[0]) * 180 / Math.PI,
            Math.atan2(vector[2], Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1])) * 180 / Math.PI
        ];
    }

    function normalizeVector(vector) {
        var length = Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
        return vector.map(function (component) {
            return component / length;
        });
    }

    function setViewMode(mode) {
        if (mode === viewMode) return;

        viewMode = mode;
        var showCities = mode === "cities";
        elements.cityView.hidden = !showCities;
        elements.flightView.hidden = showCities;
        elements.flightStats.hidden = showCities;
        elements.citiesButton.classList.toggle("is-active", showCities);
        elements.citiesButton.setAttribute("aria-pressed", String(showCities));
        elements.flightsButton.classList.toggle("is-active", !showCities);
        elements.flightsButton.setAttribute("aria-pressed", String(!showCities));
        setMapViewVisibility();

        if (!showCities && selectedFlightIndex < 0 && !selectedAirportCode) {
            showFlightEmpty();
            if (map && mapReady) {
                map.easeTo({
                    center: defaultFlightMapCenter(),
                    zoom: 1.45,
                    duration: 900,
                    essential: true
                });
            }
        }
    }

    function defaultFlightMapCenter() {
        var munich = airports.MUC;
        if (munich && Array.isArray(munich.coordinates)) {
            return [munich.coordinates[1], munich.coordinates[0]];
        }
        return initialMapCenter();
    }

    function renderFlightStats(flightList) {
        var completedFlightList = flightList.filter(function (flight) {
            return !flight._upcoming;
        });
        var completedCounts = collectFlightCounts(completedFlightList);
        var totalCounts = collectFlightCounts(flightList);
        [
            ["Countries / regions", completedCounts.countries,
                totalCounts.countries - completedCounts.countries],
            ["Airports", completedCounts.airports,
                totalCounts.airports - completedCounts.airports],
            ["Flights", completedFlightList.length, flightList.length - completedFlightList.length],
            ["Airlines", completedCounts.airlines, totalCounts.airlines - completedCounts.airlines]
        ].forEach(function (stat) {
            var row = document.createElement("tr");
            var label = document.createElement("th");
            label.scope = "row";
            label.textContent = stat[0];
            var value = document.createElement("td");
            value.textContent = String(stat[1]);
            if (stat[2] > 0) {
                var upcomingCount = document.createElement("span");
                upcomingCount.className = "travel-map__flight-stat-upcoming";
                upcomingCount.textContent = "+" + stat[2];
                upcomingCount.title = stat[2] + " upcoming";
                value.appendChild(upcomingCount);
                value.setAttribute("aria-label", stat[1] + " completed, "
                    + stat[2] + " upcoming");
            }
            row.appendChild(label);
            row.appendChild(value);
            elements.flightStatsList.appendChild(row);
        });
    }

    function collectFlightCounts(flightList) {
        var countries = Object.create(null);
        var airportCodes = Object.create(null);
        var airlines = Object.create(null);
        flightList.forEach(function (flight) {
            [flight.origin, flight.destination].forEach(function (endpoint) {
                if (endpoint.country) countries[endpoint.country.trim().toLocaleLowerCase()] = true;
                airportCodes[endpoint.airport] = true;
            });
            if (flight.airline && flight.airline.trim()) {
                airlines[flight.airline.trim().toLocaleLowerCase()] = true;
            }
        });
        return {
            countries: Object.keys(countries).length,
            airports: Object.keys(airportCodes).length,
            airlines: Object.keys(airlines).length
        };
    }

    function getLocalDateString() {
        var date = new Date();
        var month = date.getMonth() + 1;
        var day = date.getDate();
        return date.getFullYear() + "-"
            + (month < 10 ? "0" : "") + month + "-"
            + (day < 10 ? "0" : "") + day;
    }

    function setMapViewVisibility() {
        if (!mapReady) return;
        var cityVisibility = viewMode === "cities" ? "visible" : "none";
        var flightVisibility = viewMode === "flights" ? "visible" : "none";
        setGeographicLabelsVisibility(cityVisibility);
        ["travel-place-halo", "travel-place-point"]
            .forEach(function (layerId) {
            map.setLayoutProperty(layerId, "visibility", cityVisibility);
        });
        ["travel-flight-route", "travel-flight-route-upcoming",
            "travel-flight-direction", "travel-flight-direction-upcoming",
            "travel-flight-airport", "travel-flight-airport-code"]
            .forEach(function (layerId) {
                map.setLayoutProperty(layerId, "visibility", flightVisibility);
            });
    }

    function setGeographicLabelsVisibility(visibility) {
        map.getStyle().layers.forEach(function (layer) {
            if (layer["source-layer"] === "place" || layer["source-layer"] === "aerodrome_label") {
                map.setLayoutProperty(layer.id, "visibility", visibility);
            }
        });
    }

    function renderSummary(allVisits) {
        var destinations = Object.create(null);
        var livedDestinations = Object.create(null);
        var countries = Object.create(null);
        allVisits.forEach(function (visit) {
            destinations[visit._placeKey] = true;
            if (visit._livedHere) livedDestinations[visit._placeKey] = true;
            countries[visit.country.trim().toLocaleLowerCase()] = visit.country.trim();
        });

        var destinationCount = Object.keys(destinations).length;
        elements.summary.hidden = destinationCount === 0;
        elements.summaryList.textContent = "";
        [
            ["Countries / regions", Object.keys(countries).length],
            ["Cities visited", destinationCount],
            ["Cities lived in", Object.keys(livedDestinations).length]
        ].forEach(function (stat) {
            var row = document.createElement("tr");
            var label = document.createElement("th");
            label.scope = "row";
            label.textContent = stat[0];
            var value = document.createElement("td");
            value.textContent = String(stat[1]);
            row.appendChild(label);
            row.appendChild(value);
            elements.summaryList.appendChild(row);
        });
    }

    function selectFlight(index, moveGlobe) {
        if (index < 0 || index >= flights.length) return;
        selectedFlightIndex = index;
        selectedAirportCode = "";
        var flight = flights[index];
        var origin = flight.origin.airport;
        var destination = flight.destination.airport;

        elements.flightTitle.textContent = origin + " → " + destination;
        elements.flightAirports.textContent = "";
        elements.flightAirports.hidden = true;
        var flightDetails = [];
        if (flight.airline) flightDetails.push(flight.airline);
        if (flight.flight_number) flightDetails.push("Flight " + flight.flight_number);
        flightDetails.push(flight._upcoming ? "Upcoming" : "Completed");
        elements.flightNumber.textContent = flightDetails.join(" · ");
        elements.flightNumber.hidden = !flightDetails.length;
        elements.airportFlights.hidden = true;
        elements.flightEmpty.hidden = true;
        elements.flightContent.hidden = false;
        updateFlightSelection();

        if (moveGlobe && map && mapReady) {
            var originVector = coordinateToVector([flight.origin.coordinates[1], flight.origin.coordinates[0]]);
            var destinationVector = coordinateToVector([flight.destination.coordinates[1], flight.destination.coordinates[0]]);
            var midpointVector = [
                originVector[0] + destinationVector[0],
                originVector[1] + destinationVector[1],
                originVector[2] + destinationVector[2]
            ];
            var midpointLength = Math.sqrt(
                midpointVector[0] * midpointVector[0]
                + midpointVector[1] * midpointVector[1]
                + midpointVector[2] * midpointVector[2]
            );
            var midpoint = vectorToCoordinate(midpointLength < 0.000001
                ? originVector
                : normalizeVector(midpointVector));
            map.easeTo({
                center: midpoint,
                zoom: 2,
                duration: 1100,
                essential: true
            });
        }
    }

    function showAirportFlights(code, moveGlobe) {
        var indexes = [];
        flights.forEach(function (flight, index) {
            if (flight.origin.airport === code || flight.destination.airport === code) {
                indexes.push(index);
            }
        });
        indexes.sort(function (a, b) {
            return flights[b].date.localeCompare(flights[a].date) || b - a;
        });
        if (!indexes.length) return;

        selectedAirportCode = code;
        selectedFlightIndex = -1;
        elements.flightTitle.textContent = code;
        elements.flightAirports.textContent = indexes.length + " flights on record";
        elements.flightAirports.hidden = false;
        elements.flightNumber.textContent = "";
        elements.flightNumber.hidden = true;
        elements.airportFlights.textContent = "";
        indexes.forEach(function (index) {
            var flight = flights[index];
            var details = [flight.airline, flight.flight_number && "Flight " + flight.flight_number]
                .filter(Boolean).join(" · ");
            var button = document.createElement("button");
            button.type = "button";
            button.textContent = flight.origin.airport + " → " + flight.destination.airport
                + (details ? " · " + details : "")
                + " · " + (flight._upcoming ? "Upcoming" : "Completed");
            if (flight._upcoming) button.classList.add("is-upcoming");
            button.addEventListener("click", function () {
                selectFlight(index, true);
            });
            var item = document.createElement("li");
            item.appendChild(button);
            elements.airportFlights.appendChild(item);
        });
        elements.airportFlights.hidden = false;
        elements.flightEmpty.hidden = true;
        elements.flightContent.hidden = false;
        updateFlightSelection();

        if (moveGlobe && map && mapReady) {
            var airport = flights[indexes[0]].origin.airport === code
                ? flights[indexes[0]].origin
                : flights[indexes[0]].destination;
            map.easeTo({
                center: [airport.coordinates[1], airport.coordinates[0]],
                zoom: Math.max(map.getZoom(), 3),
                duration: 900,
                essential: true
            });
        }
    }

    function showFlightEmpty() {
        elements.flightEmpty.hidden = false;
        elements.flightContent.hidden = true;
    }

    function updateFlightSelection() {
        if (!mapReady) return;
        var source = map.getSource("travel-flights");
        if (source) {
            source.setData(createFlightFeatures());
        }
    }

    function selectPlace(placeKey, moveGlobe, expandVisits) {
        var index = -1;
        if (selectedPlaceKey === placeKey) {
            index = selectedIndex;
        } else {
            index = visits.findIndex(function (visit) {
                return visit._placeKey === placeKey;
            });
        }
        if (index >= 0) {
            selectVisit(index, moveGlobe, expandVisits);
        }
    }

    function selectVisit(index, moveGlobe, expandVisits) {
        selectedIndex = index;
        var visit = visits[index];
        var preserveExpandedVisits = selectedPlaceKey === visit._placeKey && elements.placeVisits.open;
        selectedPlaceKey = visit._placeKey;

        elements.storyDate.textContent = formatStayDays(visit.stay_days);
        elements.storyTitle.textContent = visit.city;
        elements.livedHere.hidden = !visit._livedHere;
        elements.storyPlace.textContent = visit.country;
        elements.cityStats.hidden = visit._livedHere;
        elements.description.textContent = visit.description || "";
        elements.description.hidden = !visit.description;
        elements.empty.hidden = true;
        elements.cityStory.hidden = false;
        elements.content.hidden = false;

        renderPlaceVisits(visit, Boolean(expandVisits || preserveExpandedVisits));
        renderPhoto(visit);
        updateSelectedPoint();

        if (moveGlobe && map) {
            map.easeTo({
                center: [visit.coordinates[1], visit.coordinates[0]],
                zoom: Math.max(map.getZoom(), 4),
                duration: 1100,
                essential: true
            });
        }
    }

    function updateSelectedPoint() {
        if (!mapReady) return;
        var source = map.getSource("travel-places");
        if (source) {
            source.setData(createVisitFeatures());
        }
        map.setPaintProperty("travel-place-halo", "circle-radius", placeRadiusExpression(true));
        map.setPaintProperty("travel-place-point", "circle-radius", placeRadiusExpression(false));
        map.setPaintProperty("travel-place-point", "circle-stroke-width",
            ["case", ["==", ["get", "placeKey"], selectedPlaceKey], 2.5, 1.5]);
    }

    function renderPlaceVisits(visit, expanded) {
        var indexes = [];
        visits.forEach(function (candidate, index) {
            if (candidate._placeKey === visit._placeKey) {
                indexes.push(index);
            }
        });

        var totalDays = indexes.reduce(function (sum, index) {
            return sum + visits[index].stay_days;
        }, 0);
        elements.cityStats.textContent = indexes.length + (indexes.length === 1 ? " visit" : " visits")
            + " · ~" + totalDays + (totalDays === 1 ? " day" : " days") + " total";
        elements.placeVisits.hidden = visit._livedHere || indexes.length < 2;
        if (visit._livedHere || indexes.length < 2) {
            elements.placeVisits.open = false;
            renderedPlaceVisitsKey = "";
            return;
        }

        elements.placeVisitsSummary.textContent = indexes.length + " visits · ~" + totalDays
            + (totalDays === 1 ? " day" : " days");
        elements.placeVisits.open = expanded;

        if (renderedPlaceVisitsKey !== visit._placeKey) {
            elements.placeVisitsList.textContent = "";
            indexes.forEach(function (index) {
                var button = document.createElement("button");
                button.type = "button";
                button.addEventListener("click", function () {
                    selectVisit(index, true, true);
                });
                var item = document.createElement("li");
                item.appendChild(button);
                elements.placeVisitsList.appendChild(item);
            });
            renderedPlaceVisitsKey = visit._placeKey;
        }

        Array.prototype.forEach.call(elements.placeVisitsList.children, function (item, position) {
            var button = item.firstElementChild;
            var index = indexes[position];
            var candidate = visits[index];
            button.textContent = formatDate(candidate.date, candidate.date_precision)
                + " · " + formatStayDays(candidate.stay_days);
            button.classList.toggle("is-current", index === selectedIndex);
            if (index === selectedIndex) {
                button.setAttribute("aria-current", "true");
            } else {
                button.removeAttribute("aria-current");
            }
        });
    }

    function formatStayDays(days) {
        return "~" + days + (days === 1 ? " day" : " days");
    }

    function renderPhoto(visit) {
        if (!visit.photo) {
            elements.photoWrap.hidden = true;
            elements.photo.removeAttribute("src");
            return;
        }

        var path = String(visit.photo).trim();
        if (!path) {
            elements.photoWrap.hidden = true;
            return;
        }

        var baseurl = document.getElementById("travel-map").getAttribute("data-baseurl") || "";
        elements.photo.alt = visit.photo_alt || ("A photo from " + visit.city);
        elements.photo.onload = function () {
            elements.photoWrap.hidden = false;
        };
        elements.photo.onerror = function () {
            elements.photoWrap.hidden = true;
        };
        elements.photo.src = path.charAt(0) === "/" ? baseurl + path : path;
    }

    function showError(message) {
        elements.empty.hidden = true;
        elements.cityStory.hidden = false;
        elements.content.hidden = true;
        elements.storyError.textContent = message;
        elements.storyError.hidden = false;
    }

    function addStatus(message) {
        if (statusMessages.indexOf(message) !== -1) return;
        statusMessages.push(message);
        elements.status.textContent = statusMessages.join(" ");
        elements.status.hidden = false;
    }

    function isValidVisit(visit) {
        return visit
            && isValidDate(visit.date)
            && (!visit.date_precision || ["day", "month", "year"].indexOf(visit.date_precision) !== -1)
            && typeof visit.city === "string"
            && visit.city.trim().length > 0
            && typeof visit.country === "string"
            && visit.country.trim().length > 0
            && (visit.lived_here === undefined || typeof visit.lived_here === "boolean")
            && Array.isArray(visit.coordinates)
            && visit.coordinates.length === 2
            && visit.coordinates.every(function (coordinate) {
                return typeof coordinate === "number" && Number.isFinite(coordinate);
            })
            && visit.coordinates[0] >= -90
            && visit.coordinates[0] <= 90
            && visit.coordinates[1] >= -180
            && visit.coordinates[1] <= 180
            && Number.isInteger(visit.stay_days)
            && visit.stay_days > 0;
    }

    function isValidFlight(flight) {
        return flight
            && isValidDate(flight.date)
            && (!flight.date_precision || ["day", "month", "year"].indexOf(flight.date_precision) !== -1)
            && isValidFlightEndpoint(flight.origin)
            && isValidFlightEndpoint(flight.destination)
            && (!flight.airline || typeof flight.airline === "string")
            && (!flight.flight_number || typeof flight.flight_number === "string");
    }

    function resolveFlightEndpoint(endpoint) {
        if (typeof endpoint !== "string") return endpoint;
        if (!Object.prototype.hasOwnProperty.call(airports, endpoint)) return null;
        return Object.assign({ airport: endpoint }, airports[endpoint]);
    }

    function isValidFlightEndpoint(endpoint) {
        return endpoint
            && typeof endpoint.airport === "string"
            && endpoint.airport.trim().length > 0
            && typeof endpoint.city === "string"
            && endpoint.city.trim().length > 0
            && (!endpoint.country || typeof endpoint.country === "string")
            && Array.isArray(endpoint.coordinates)
            && endpoint.coordinates.length === 2
            && endpoint.coordinates.every(function (coordinate) {
                return typeof coordinate === "number" && Number.isFinite(coordinate);
            })
            && endpoint.coordinates[0] >= -90
            && endpoint.coordinates[0] <= 90
            && endpoint.coordinates[1] >= -180
            && endpoint.coordinates[1] <= 180;
    }

    function isValidDate(date) {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return false;
        }
        var parsedDate = new Date(date + "T00:00:00.000Z");
        return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
    }

    function formatDate(date, precision) {
        if (precision === "year") {
            return date.slice(0, 4);
        }
        if (precision === "month") {
            return new Date(date + "T12:00:00").toLocaleDateString(undefined, {
                year: "numeric",
                month: "long"
            });
        }
        return new Date(date + "T12:00:00").toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric"
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeTravelMap);
    } else {
        initializeTravelMap();
    }
}());
