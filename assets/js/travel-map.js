(function () {
    "use strict";

    function initializeTravelMap() {
        var root = document.getElementById("travel-map");
        if (!root) return;

        var elements = {
            canvas: document.getElementById("travel-map-canvas"),
            status: document.getElementById("travel-map-status"),
            placeCount: document.getElementById("travel-place-count"),
            countryCount: document.getElementById("travel-country-count"),
            visitCount: document.getElementById("travel-visit-count"),
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

        var visits;
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

        var map = null;
        var markers = [];
        var selectedIndex = -1;
        var playback = null;
        var statusMessages = [];

        updateCounts();
        elements.range.max = Math.max(visits.length - 1, 0);

        if (typeof window.L === "undefined") {
            addStatus("The map library could not load. Check your connection; your travel data is still available.");
        } else {
            map = window.L.map(elements.canvas, {
                scrollWheelZoom: false,
                worldCopyJump: true
            }).setView([20, 0], 2);

            var tiles = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19
            }).addTo(map);

            var tileErrorShown = false;
            tiles.on("tileerror", function () {
                if (tileErrorShown) return;
                tileErrorShown = true;
                addStatus("Some map tiles could not load. Check your connection to OpenStreetMap.");
            });
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

        visits.forEach(function (visit, index) {
            if (!map) return;
            var marker = window.L.marker(visit.coordinates, {
                title: visit.city + ", " + visit.country,
                alt: visit.city + ", " + visit.country,
                icon: window.L.divIcon({
                    className: "",
                    html: '<span class="travel-map__marker" aria-hidden="true"></span>',
                    iconSize: [19, 19],
                    iconAnchor: [9, 9]
                })
            }).addTo(map);
            marker.on("click", function () {
                selectVisit(index, false);
            });
            markers[index] = marker;
        });

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

        function selectVisit(index, moveMap) {
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
            updateMarkerStyles();

            if (moveMap && map) {
                map.setView(visit.coordinates, Math.max(map.getZoom(), 5), { animate: true });
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

            var baseurl = root.getAttribute("data-baseurl") || "";
            var source = path.charAt(0) === "/" ? baseurl + path : path;
            elements.photo.alt = visit.photo_alt || ("A photo from " + visit.city);
            elements.photo.onload = function () {
                elements.photoWrap.hidden = false;
            };
            elements.photo.onerror = function () {
                elements.photoWrap.hidden = true;
            };
            elements.photo.src = source;
        }

        function updateMarkerStyles() {
            markers.forEach(function (marker, index) {
                if (!marker) return;
                var active = index === selectedIndex;
                marker.setIcon(window.L.divIcon({
                    className: "",
                    html: '<span class="travel-map__marker' + (active ? " travel-map__marker--active" : "") + '" aria-hidden="true"></span>',
                    iconSize: [active ? 23 : 19, active ? 23 : 19],
                    iconAnchor: [active ? 11 : 9, active ? 11 : 9]
                }));
            });
        }

        function togglePlayback() {
            if (playback) {
                window.clearInterval(playback);
                playback = null;
                elements.play.innerHTML = '<span aria-hidden="true">▶</span> Play timeline';
                elements.play.setAttribute("aria-pressed", "false");
                return;
            }

            if (selectedIndex === visits.length - 1) {
                selectVisit(0, true);
            }
            elements.play.innerHTML = '<span aria-hidden="true">Ⅱ</span> Pause timeline';
            elements.play.setAttribute("aria-pressed", "true");
            playback = window.setInterval(function () {
                if (selectedIndex >= visits.length - 1) {
                    window.clearInterval(playback);
                    playback = null;
                    elements.play.innerHTML = '<span aria-hidden="true">▶</span> Play timeline';
                    elements.play.setAttribute("aria-pressed", "false");
                    return;
                }
                selectVisit(selectedIndex + 1, true);
            }, 1800);
        }

        function updateCounts() {
            var places = new Set(visits.map(function (visit) {
                return visit.city.toLocaleLowerCase() + "|" + visit.country.toLocaleLowerCase();
            }));
            var countries = new Set(visits.map(function (visit) {
                return visit.country.toLocaleLowerCase();
            }));
            elements.placeCount.textContent = places.size;
            elements.countryCount.textContent = countries.size;
            elements.visitCount.textContent = visits.length;
        }

        function showError(message) {
            elements.empty.hidden = true;
            elements.content.hidden = true;
            elements.storyError.textContent = message;
            elements.storyError.hidden = false;
        }

        function addStatus(message) {
            statusMessages.push(message);
            elements.status.textContent = statusMessages.join(" ");
            elements.status.hidden = false;
        }
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
