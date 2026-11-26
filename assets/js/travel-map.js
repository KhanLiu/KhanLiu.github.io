(function () {
    "use strict";

    var visits = [];
    var map = null;
    var mapReady = false;
    var selectedIndex = -1;
    var playback = null;
    var statusMessages = [];
    var elements;
    var demoNotice;

    function initializeTravelMap() {
        var root = document.getElementById("travel-map");
        if (!root) return;

        elements = {
            canvas: document.getElementById("travel-map-canvas"),
            status: document.getElementById("travel-map-status"),
            date: document.getElementById("travel-timeline-date"),
            count: document.getElementById("travel-timeline-count"),
            range: document.getElementById("travel-timeline-range"),
            previous: document.getElementById("travel-previous"),
            next: document.getElementById("travel-next"),
            play: document.getElementById("travel-play"),
            empty: document.getElementById("travel-story-empty"),
            content: document.getElementById("travel-story-content"),
            storyError: document.getElementById("travel-story-error"),
            storyDate: document.getElementById("travel-story-date"),
            storyTitle: document.getElementById("travel-story-title"),
            storyPlace: document.getElementById("travel-story-place"),
            description: document.getElementById("travel-story-description"),
            photoWrap: document.getElementById("travel-photo-wrap"),
            photo: document.getElementById("travel-photo")
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

        var rejectedVisits = visits.length - visits.filter(isValidVisit).length;
        visits = visits.map(function (visit, index) {
            return Object.assign({ _index: index }, visit);
        }).filter(isValidVisit).sort(function (a, b) {
            return a.date.localeCompare(b.date) || a._index - b._index;
        });
        demoNotice.hidden = !visits.some(function (visit) {
            return visit.demo === true;
        });

        elements.range.max = Math.max(visits.length - 1, 0);

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

        if (!visits.length) {
            return;
        }

        elements.range.disabled = false;
        elements.previous.disabled = false;
        elements.next.disabled = false;
        elements.play.disabled = false;

        elements.range.addEventListener("input", function () {
            selectVisit(Number(elements.range.value), true);
        });
        elements.previous.addEventListener("click", function () {
            selectVisit(Math.max(0, selectedIndex - 1), true);
        });
        elements.next.addEventListener("click", function () {
            selectVisit(Math.min(visits.length - 1, selectedIndex + 1), true);
        });
        elements.play.addEventListener("click", togglePlayback);

        selectVisit(0, false);
    }

    function initializeGlobe() {
        map = new window.maplibregl.Map({
            container: elements.canvas,
            style: "https://tiles.openfreemap.org/styles/positron",
            center: [0, 20],
            zoom: 1.1,
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
            map.addLayer({
                id: "travel-place-halo",
                type: "circle",
                source: "travel-places",
                paint: {
                    "circle-radius": ["case", ["==", ["get", "index"], selectedIndex], 19, 13],
                    "circle-color": ["case", ["==", ["get", "index"], selectedIndex], "#e99672", "#78cfc3"],
                    "circle-opacity": 0.24,
                    "circle-blur": 0.7
                }
            });
            map.addLayer({
                id: "travel-place-point",
                type: "circle",
                source: "travel-places",
                paint: {
                    "circle-radius": ["case", ["==", ["get", "index"], selectedIndex], 7, 4.5],
                    "circle-color": ["case", ["==", ["get", "index"], selectedIndex], "#f09b75", "#8ce1d2"],
                    "circle-stroke-width": ["case", ["==", ["get", "index"], selectedIndex], 2.5, 1.5],
                    "circle-stroke-color": "#f8fbfa"
                }
            });
            map.on("mouseenter", "travel-place-point", function () {
                map.getCanvas().style.cursor = "pointer";
            });
            map.on("mouseleave", "travel-place-point", function () {
                map.getCanvas().style.cursor = "";
            });
            map.on("click", "travel-place-point", function (event) {
                var feature = event.features && event.features[0];
                if (feature) {
                    selectVisit(Number(feature.properties.index), true);
                }
            });
            updateSelectedPoint();
        });
    }

    function createVisitFeatures() {
        return {
            type: "FeatureCollection",
            features: visits.map(function (visit, index) {
                return {
                    type: "Feature",
                    properties: {
                        index: index,
                        title: visit.title || visit.city,
                        city: visit.city,
                        country: visit.country
                    },
                    geometry: {
                        type: "Point",
                        coordinates: [visit.coordinates[1], visit.coordinates[0]]
                    }
                };
            })
        };
    }

    function selectVisit(index, moveGlobe) {
        selectedIndex = index;
        var visit = visits[index];

        elements.range.value = index;
        elements.date.textContent = formatDate(visit.date);
        elements.count.textContent = (index + 1) + " / " + visits.length;
        elements.storyDate.textContent = formatDate(visit.date);
        elements.storyTitle.textContent = visit.title || visit.city;
        elements.storyPlace.textContent = [visit.city, visit.country].filter(Boolean).join(", ");
        elements.description.textContent = visit.description || "";
        elements.description.hidden = !visit.description;
        elements.empty.hidden = true;
        elements.content.hidden = false;

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
        if (selectedIndex >= 0) {
            map.setPaintProperty("travel-place-halo", "circle-radius",
                ["case", ["==", ["get", "index"], selectedIndex], 19, 13]);
            map.setPaintProperty("travel-place-halo", "circle-color",
                ["case", ["==", ["get", "index"], selectedIndex], "#e99672", "#78cfc3"]);
            map.setPaintProperty("travel-place-point", "circle-radius",
                ["case", ["==", ["get", "index"], selectedIndex], 7, 4.5]);
            map.setPaintProperty("travel-place-point", "circle-color",
                ["case", ["==", ["get", "index"], selectedIndex], "#f09b75", "#8ce1d2"]);
            map.setPaintProperty("travel-place-point", "circle-stroke-width",
                ["case", ["==", ["get", "index"], selectedIndex], 2.5, 1.5]);
        }
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

    function togglePlayback() {
        if (playback) {
            window.clearInterval(playback);
            playback = null;
            setPlaybackButton(false);
            return;
        }

        if (selectedIndex === visits.length - 1) {
            selectVisit(0, true);
        }
        setPlaybackButton(true);
        playback = window.setInterval(function () {
            if (selectedIndex >= visits.length - 1) {
                window.clearInterval(playback);
                playback = null;
                setPlaybackButton(false);
                return;
            }
            selectVisit(selectedIndex + 1, true);
        }, 1800);
    }

    function setPlaybackButton(isPlaying) {
        elements.play.innerHTML = isPlaying
            ? '<span aria-hidden="true">Ⅱ</span> Pause timeline'
            : '<span aria-hidden="true">▶</span> Play timeline';
        elements.play.setAttribute("aria-pressed", String(isPlaying));
    }

    function showError(message) {
        elements.empty.hidden = true;
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
            && typeof visit.city === "string"
            && visit.city.trim().length > 0
            && typeof visit.country === "string"
            && visit.country.trim().length > 0
            && Array.isArray(visit.coordinates)
            && visit.coordinates.length === 2
            && visit.coordinates.every(function (coordinate) {
                return typeof coordinate === "number" && Number.isFinite(coordinate);
            })
            && visit.coordinates[0] >= -90
            && visit.coordinates[0] <= 90
            && visit.coordinates[1] >= -180
            && visit.coordinates[1] <= 180;
    }

    function isValidDate(date) {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return false;
        }
        var parsedDate = new Date(date + "T00:00:00.000Z");
        return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
    }

    function formatDate(date) {
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
