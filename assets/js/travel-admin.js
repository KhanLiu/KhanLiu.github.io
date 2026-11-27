(function () {
    "use strict";

    var apiUrl = document.querySelector('meta[name="travel-admin-api"]').content.trim().replace(/\/+$/, "");
    var configured = /^https:\/\/khanliu-travel-admin\.[a-z0-9-]+\.workers\.dev$/i.test(apiUrl);
    var tokenKey = "travel-admin-session";
    var elements = {
        status: document.getElementById("admin-status"),
        login: document.getElementById("admin-login"),
        logout: document.getElementById("admin-logout"),
        editor: document.getElementById("admin-editor"),
        records: document.getElementById("admin-records"),
        count: document.getElementById("admin-count"),
        filter: document.getElementById("admin-filter"),
        add: document.getElementById("admin-add"),
        reload: document.getElementById("admin-reload"),
        save: document.getElementById("admin-save"),
        flights: document.getElementById("admin-flights"),
        flightCount: document.getElementById("admin-flight-count"),
        flightAdd: document.getElementById("admin-flight-add"),
        flightSave: document.getElementById("admin-flight-save"),
        airports: document.getElementById("admin-airports"),
        airportCount: document.getElementById("admin-airport-count"),
        airportAdd: document.getElementById("admin-airport-add")
    };
    var trips = [];
    var flights = [];
    var airports = [];

    function setStatus(message, isError) {
        elements.status.textContent = message;
        elements.status.classList.toggle("is-error", Boolean(isError));
    }

    function getToken() {
        return sessionStorage.getItem(tokenKey);
    }

    function setSignedIn(signedIn) {
        elements.editor.hidden = !signedIn;
        elements.logout.hidden = !signedIn;
        elements.login.hidden = signedIn;
    }

    function takeSessionFromFragment() {
        var fragment = new URLSearchParams(window.location.hash.slice(1));
        var session = fragment.get("session");
        var error = fragment.get("error");

        if (session) {
            sessionStorage.setItem(tokenKey, session);
            window.history.replaceState(null, "", window.location.pathname);
        }
        if (error) {
            window.history.replaceState(null, "", window.location.pathname);
            var messages = {
                rate_limited: "Too many sign-in attempts. Wait ten minutes before trying again.",
                invalid_state: "Sign-in expired or could not be verified. Start again and finish within ten minutes.",
                oauth_denied: "GitHub sign-in was cancelled or not approved.",
                oauth_credentials: "GitHub rejected the OAuth Client ID/Secret pair. Verify they belong to the same OAuth App.",
                oauth_redirect_uri: "GitHub rejected the callback URL. It must match the OAuth App callback URL.",
                oauth_code: "GitHub rejected the one-time authorization code. Start sign-in again and complete it once.",
                oauth_exchange: "GitHub could not complete sign-in. Check the OAuth app secret and callback URL.",
                not_authorized: "This GitHub account is not authorized to edit these travel records."
            };
            setStatus(messages[error] || "GitHub sign-in failed (" + error + ").", true);
        }
        return Boolean(error);
    }

    async function apiRequest(path, options) {
        var headers = Object.assign({}, options && options.headers, {
            Authorization: "Bearer " + getToken()
        });
        var response = await fetch(apiUrl + path, Object.assign({}, options, {
            headers: headers,
            cache: "no-store"
        }));
        var body = await response.json().catch(function () {
            return {};
        });

        if (!response.ok) {
            if (response.status === 401) {
                sessionStorage.removeItem(tokenKey);
                setSignedIn(false);
            }
            throw new Error(body.error || "Request failed (" + response.status + ").");
        }
        return body;
    }

    function setBusy(busy) {
        elements.add.disabled = busy;
        elements.reload.disabled = busy;
        elements.save.disabled = busy;
        elements.flightAdd.disabled = busy;
        elements.flightSave.disabled = busy;
        elements.airportAdd.disabled = busy;
        elements.login.disabled = busy || !configured;
        elements.logout.disabled = busy;
    }

    function addInput(row, type, value, options) {
        var cell = document.createElement("td");
        var input = document.createElement("input");
        input.type = type;
        input.value = value;
        input.setAttribute("aria-label", options.label);
        if (options.min !== undefined) {
            input.min = options.min;
        }
        if (options.max !== undefined) {
            input.max = options.max;
        }
        if (options.step !== undefined) {
            input.step = options.step;
        }
        input.addEventListener("input", function () {
            options.update(input.value);
        });
        if (options.change) {
            input.addEventListener("change", options.change);
        }
        cell.appendChild(input);
        row.appendChild(cell);
    }

    function addAirportSelect(row, value, label, update) {
        var cell = document.createElement("td");
        var select = document.createElement("select");
        select.setAttribute("aria-label", label);
        var placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select airport";
        select.appendChild(placeholder);
        airports.forEach(function (airport) {
            var option = document.createElement("option");
            option.value = airport.code;
            option.textContent = airport.code + " — " + airport.city + " (" + airport.country + ")";
            select.appendChild(option);
        });
        select.value = value || "";
        select.addEventListener("change", function () {
            update(select.value);
        });
        cell.appendChild(select);
        row.appendChild(cell);
    }

    function addCheckbox(row, checked, label, update) {
        var cell = document.createElement("td");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.setAttribute("aria-label", label);
        input.addEventListener("change", function () {
            update(input.checked);
        });
        cell.className = "admin__checkbox-cell";
        cell.appendChild(input);
        row.appendChild(cell);
    }

    function placeKey(trip) {
        return trip.city.trim().toLocaleLowerCase() + "|" + trip.country.trim().toLocaleLowerCase();
    }

    function renderTrips() {
        var query = elements.filter.value.trim().toLocaleLowerCase();
        elements.records.textContent = "";
        var livedPlaces = Object.create(null);
        trips.forEach(function (trip) {
            if (trip.lived_here === true) {
                livedPlaces[placeKey(trip)] = true;
            }
        });
        var visibleTrips = trips.filter(function (trip) {
            return !query || (trip.city + " " + trip.country).toLocaleLowerCase().includes(query);
        });
        elements.count.textContent = "(" + visibleTrips.length + " shown / " + trips.length + ")";

        visibleTrips.forEach(function (trip) {
            var row = document.createElement("tr");
            addInput(row, "month", trip.date.slice(0, 7), {
                label: "Month for " + trip.city,
                update: function (value) {
                    trip.date = value ? value + "-01" : "";
                }
            });
            addInput(row, "text", trip.city, {
                label: "City",
                update: function (value) { trip.city = value; }
            });
            addInput(row, "text", trip.country, {
                label: "Country or area",
                update: function (value) { trip.country = value; }
            });
            addInput(row, "number", String(trip.stay_days), {
                label: "Estimated stay days",
                min: "1",
                max: "3660",
                step: "1",
                update: function (value) {
                    trip.stay_days = value === "" ? "" : Number(value);
                }
            });
            addInput(row, "number", String(trip.coordinates[0]), {
                label: "Approximate latitude",
                min: "-90",
                max: "90",
                step: "0.01",
                update: function (value) {
                    trip.coordinates[0] = value === "" ? "" : Number(value);
                }
            });
            addInput(row, "number", String(trip.coordinates[1]), {
                label: "Approximate longitude",
                min: "-180",
                max: "180",
                step: "0.01",
                update: function (value) {
                    trip.coordinates[1] = value === "" ? "" : Number(value);
                }
            });
            var key = placeKey(trip);
            addCheckbox(row, Boolean(livedPlaces[key]), "Mark " + trip.city + " as a place you lived", function (livedHere) {
                trips.forEach(function (candidate) {
                    if (placeKey(candidate) === key) {
                        if (livedHere) {
                            candidate.lived_here = true;
                        } else {
                            delete candidate.lived_here;
                        }
                    }
                });
                renderTrips();
            });

            var actionCell = document.createElement("td");
            var removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.className = "admin__remove";
            removeButton.textContent = "Remove";
            removeButton.setAttribute("aria-label", "Remove " + trip.city + " stay");
            removeButton.addEventListener("click", function () {
                trips.splice(trips.indexOf(trip), 1);
                renderTrips();
            });
            actionCell.appendChild(removeButton);
            row.appendChild(actionCell);
            elements.records.appendChild(row);
        });
    }

    function renderFlights() {
        elements.flights.textContent = "";
        elements.flightCount.textContent = "(" + flights.length + ")";
        flights.forEach(function (flight) {
            var row = document.createElement("tr");
            addInput(row, "date", flight.date, {
                label: "Flight date",
                update: function (value) { flight.date = value; }
            });
            addInput(row, "text", flight.airline || "", {
                label: "Airline",
                update: function (value) { flight.airline = value; }
            });
            addInput(row, "text", flight.flight_number || "", {
                label: "Flight number",
                update: function (value) { flight.flight_number = value; }
            });
            addAirportSelect(row, flight.origin, "Origin airport", function (value) {
                flight.origin = value;
                renderAirports();
            });
            addAirportSelect(row, flight.destination, "Destination airport", function (value) {
                flight.destination = value;
                renderAirports();
            });
            var actionCell = document.createElement("td");
            var removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.className = "admin__remove";
            removeButton.textContent = "Remove";
            removeButton.setAttribute("aria-label", "Remove flight " + (flight.flight_number || ""));
            removeButton.addEventListener("click", function () {
                flights.splice(flights.indexOf(flight), 1);
                renderFlights();
                renderAirports();
            });
            actionCell.appendChild(removeButton);
            row.appendChild(actionCell);
            elements.flights.appendChild(row);
        });
    }

    function renderAirports() {
        elements.airports.textContent = "";
        elements.airportCount.textContent = "(" + airports.length + ")";
        airports.slice().sort(function (a, b) {
            return a.code.localeCompare(b.code);
        }).forEach(function (airport) {
            var row = document.createElement("tr");
            addInput(row, "text", airport.code, {
                label: "IATA airport code",
                update: function (value) { airport.code = value.toUpperCase(); },
                change: function () {
                    airport.code = airport.code.trim().toUpperCase();
                    renderAirports();
                    renderFlights();
                }
            });
            addInput(row, "text", airport.city, {
                label: "Airport city",
                update: function (value) { airport.city = value; }
            });
            addInput(row, "text", airport.country, {
                label: "Airport country or region",
                update: function (value) { airport.country = value; }
            });
            addInput(row, "number", String(airport.coordinates[0]), {
                label: "Airport latitude",
                min: "-90",
                max: "90",
                step: "0.0001",
                update: function (value) {
                    airport.coordinates[0] = value === "" ? "" : Number(value);
                }
            });
            addInput(row, "number", String(airport.coordinates[1]), {
                label: "Airport longitude",
                min: "-180",
                max: "180",
                step: "0.0001",
                update: function (value) {
                    airport.coordinates[1] = value === "" ? "" : Number(value);
                }
            });
            var actionCell = document.createElement("td");
            var removeButton = document.createElement("button");
            var inUse = flights.some(function (flight) {
                return flight.origin === airport.code || flight.destination === airport.code;
            });
            removeButton.type = "button";
            removeButton.className = "admin__remove";
            removeButton.textContent = "Remove";
            removeButton.disabled = inUse;
            removeButton.title = inUse ? "Remove or update flights using this airport first." : "";
            removeButton.setAttribute("aria-label", "Remove airport " + airport.code);
            removeButton.addEventListener("click", function () {
                if (inUse) return;
                airports.splice(airports.indexOf(airport), 1);
                renderAirports();
                renderFlights();
            });
            actionCell.appendChild(removeButton);
            row.appendChild(actionCell);
            elements.airports.appendChild(row);
        });
    }

    function validateBeforeSave() {
        if (!trips.length) {
            throw new Error("Keep at least one stay record.");
        }
        trips.forEach(function (trip, index) {
            var row = index + 1;
            if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(trip.date)) {
                throw new Error("Record " + row + ": choose a month.");
            }
            if (!trip.city.trim() || !trip.country.trim()) {
                throw new Error("Record " + row + ": city and country are required.");
            }
            if (!Number.isInteger(trip.stay_days) || trip.stay_days < 1 || trip.stay_days > 3660) {
                throw new Error("Record " + row + ": stay days must be a whole number from 1 to 3660.");
            }
            if (trip.lived_here !== undefined && typeof trip.lived_here !== "boolean") {
                throw new Error("Record " + row + ": lived-here must be a boolean.");
            }
            if (!Array.isArray(trip.coordinates) || trip.coordinates.length !== 2
                    || !trip.coordinates.every(Number.isFinite)
                    || Math.abs(trip.coordinates[0] * 100 - Math.round(trip.coordinates[0] * 100)) > 1e-7
                    || Math.abs(trip.coordinates[1] * 100 - Math.round(trip.coordinates[1] * 100)) > 1e-7) {
                throw new Error("Record " + row + ": coordinates must be finite and rounded to two decimal places.");
            }
        });
    }

    function getAirportDirectory() {
        var directory = Object.create(null);
        if (airports.length < 2 || airports.length > 500) {
            throw new Error("Keep between 2 and 500 airport records.");
        }
        airports.forEach(function (airport, index) {
            var row = index + 1;
            var code = airport.code.trim().toUpperCase();
            if (!/^[A-Z0-9]{3}$/.test(code) || Object.prototype.hasOwnProperty.call(directory, code)) {
                throw new Error("Airport " + row + ": use a unique three-character IATA code.");
            }
            if (!airport.city.trim() || !airport.country.trim()
                    || airport.city.length > 120 || airport.country.length > 120) {
                throw new Error("Airport " + row + ": city and country or region are required.");
            }
            if (!Array.isArray(airport.coordinates) || airport.coordinates.length !== 2
                    || !airport.coordinates.every(Number.isFinite)
                    || airport.coordinates[0] < -90 || airport.coordinates[0] > 90
                    || airport.coordinates[1] < -180 || airport.coordinates[1] > 180) {
                throw new Error("Airport " + row + ": enter valid latitude and longitude.");
            }
            airport.code = code;
            directory[code] = {
                city: airport.city.trim(),
                country: airport.country.trim(),
                coordinates: airport.coordinates.slice()
            };
        });
        return directory;
    }

    function validateFlightsBeforeSave() {
        var directory = getAirportDirectory();
        if (!flights.length || flights.length > 2000) {
            throw new Error("Keep between 1 and 2000 flight records.");
        }
        flights.forEach(function (flight, index) {
            var row = index + 1;
            var flightDate = typeof flight.date === "string"
                ? new Date(flight.date + "T00:00:00.000Z")
                : null;
            if (!flightDate || !/^\d{4}-\d{2}-\d{2}$/.test(flight.date)
                    || !Number.isFinite(flightDate.getTime())
                    || flightDate.toISOString().slice(0, 10) !== flight.date) {
                throw new Error("Flight " + row + ": choose a valid date.");
            }
            if (!Object.prototype.hasOwnProperty.call(directory, flight.origin)
                    || !Object.prototype.hasOwnProperty.call(directory, flight.destination)
                    || flight.origin === flight.destination) {
                throw new Error("Flight " + row + ": select two different airports from the directory.");
            }
            if (flight.airline && flight.airline.length > 120) {
                throw new Error("Flight " + row + ": airline names must be 120 characters or fewer.");
            }
            if (flight.flight_number && flight.flight_number.length > 40) {
                throw new Error("Flight " + row + ": flight numbers must be 40 characters or fewer.");
            }
        });
        return directory;
    }

    async function loadTrips() {
        setBusy(true);
        setStatus("Loading stays and flights from GitHub…");
        try {
            var results = await Promise.all([
                apiRequest("/api/trips", { method: "GET" }),
                apiRequest("/api/flights", { method: "GET" })
            ]);
            trips = results[0].trips;
            flights = results[1].flights;
            airports = Object.keys(results[1].airports).map(function (code) {
                var airport = results[1].airports[code];
                return {
                    code: code,
                    city: airport.city,
                    country: airport.country,
                    coordinates: airport.coordinates.slice()
                };
            });
            setSignedIn(true);
            renderTrips();
            renderFlights();
            renderAirports();
            setStatus("Signed in as " + results[0].login + ".");
        } catch (error) {
            setStatus(error.message, true);
            if (!getToken()) {
                setSignedIn(false);
            }
        } finally {
            setBusy(false);
        }
    }

    elements.login.addEventListener("click", function () {
        elements.login.disabled = true;
        setStatus("Redirecting to GitHub…");
        window.location.assign(apiUrl + "/auth/login");
    });
    elements.logout.addEventListener("click", async function () {
        setBusy(true);
        try {
            await apiRequest("/api/logout", { method: "POST" });
            setStatus("Signed out.");
        } catch (error) {
            setStatus("Signed out locally; server session revocation failed: " + error.message, true);
        } finally {
            sessionStorage.removeItem(tokenKey);
            trips = [];
            flights = [];
            airports = [];
            setSignedIn(false);
            setBusy(false);
        }
    });
    elements.reload.addEventListener("click", loadTrips);
    elements.filter.addEventListener("input", renderTrips);
    elements.flightAdd.addEventListener("click", function () {
        flights.unshift({ date: "", airline: "", flight_number: "", origin: "", destination: "" });
        renderFlights();
    });
    elements.airportAdd.addEventListener("click", function () {
        airports.push({ code: "", city: "", country: "", coordinates: ["", ""] });
        renderAirports();
        renderFlights();
    });
    elements.add.addEventListener("click", function () {
        var month = new Date();
        trips.push({
            date: month.getFullYear() + "-" + String(month.getMonth() + 1).padStart(2, "0") + "-01",
            date_precision: "month",
            city: "",
            country: "",
            coordinates: ["", ""],
            stay_days: 1
        });
        renderTrips();
    });
    elements.save.addEventListener("click", async function () {
        try {
            validateBeforeSave();
            setBusy(true);
            setStatus("Saving travel data to GitHub…");
            var result = await apiRequest("/api/trips", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trips: trips })
            });
            trips = result.trips;
            renderTrips();
            setStatus("Saved " + trips.length + " stays. GitHub Pages will redeploy automatically.");
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    });
    elements.flightSave.addEventListener("click", async function () {
        try {
            var airportDirectory = validateFlightsBeforeSave();
            setBusy(true);
            setStatus("Saving flight data to GitHub…");
            var result = await apiRequest("/api/flights", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ airports: airportDirectory, flights: flights })
            });
            flights = result.flights;
            airports = Object.keys(result.airports).map(function (code) {
                var airport = result.airports[code];
                return {
                    code: code,
                    city: airport.city,
                    country: airport.country,
                    coordinates: airport.coordinates.slice()
                };
            });
            renderFlights();
            renderAirports();
            setStatus("Saved " + flights.length + " flights and " + airports.length
                + " airports. GitHub Pages will redeploy automatically.");
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    });

    var signInFailed = takeSessionFromFragment();
    if (!configured) {
        setStatus("Admin login is not configured yet. Deploy the Cloudflare Worker and set its URL in this page.");
        elements.login.disabled = true;
    } else {
        elements.login.disabled = false;
        var token = getToken();
        setSignedIn(Boolean(token));
        if (token) {
            loadTrips();
        } else if (!signInFailed) {
            setStatus("Sign in with the authorized GitHub account to edit travel data.");
        }
    }
}());
