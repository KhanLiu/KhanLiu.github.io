const MAX_TRIPS = 2000;
const MAX_FLIGHTS = 2000;
const MAX_AIRPORTS = 500;
const MAX_REQUEST_BYTES = 500000;
const MAX_LOGIN_ATTEMPTS = 10;
const SESSION_TTL_SECONDS = 7200;
const STATE_TTL_SECONDS = 600;
const TRIP_KEYS = ["date", "date_precision", "city", "country", "coordinates", "stay_days"];
const OPTIONAL_TRIP_KEYS = ["title", "description", "photo"];
const OPTIONAL_BOOLEAN_TRIP_KEYS = ["lived_here"];
const YAML_HEADER = [
    "# Travel records use stay_days for overnight nights; 0 means the place was visited without staying overnight.",
    "# Overnight stays may be inferred locally from fixes with <=100 m accuracy and <=2 m/s speed.",
    "# The night window is 20:00-05:59 in the location's local timezone.",
    "# Each local night is assigned to its most common gazetteer place; a single night counts once.",
    "# Stays with at most one unobserved night between fixes are combined, including across months.",
    "# Public dates are month-level and coordinates are approximate city centres rounded to two decimals;",
    "# raw fixes are not published."
].join("\n");

function jsonResponse(body, status, headers) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: Object.assign({
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }, headers || {})
    });
}

function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin"
    };
}

function encodeBase64Url(bytes) {
    let binary = "";
    bytes.forEach(function (byte) {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return encodeBase64Url(bytes);
}

function requireConfiguration(env) {
    const required = ["SITE_ORIGIN", "ADMIN_GITHUB_LOGIN", "GITHUB_REPOSITORY", "GITHUB_BRANCH",
        "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_WRITE_TOKEN"];
    const missing = required.filter(function (key) {
        return typeof env[key] !== "string" || !env[key].trim();
    });
    if (!env.TRAVEL_ADMIN_AUTHy) {
        missing.unshift("TRAVEL_ADMIN_AUTHy");
    }
    if (missing.length) {
        throw new Error("Admin worker is missing required configuration: " + missing.join(", ") + ".");
    }
}

function parseYamlString(value, field) {
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== "string") {
            throw new Error("Expected a quoted string.");
        }
        return parsed;
    } catch (error) {
        throw new Error("Invalid " + field + " in travel data.");
    }
}

function parseTripYaml(source) {
    const trips = [];
    let current = null;
    const recognized = new Set(TRIP_KEYS.concat(OPTIONAL_TRIP_KEYS, OPTIONAL_BOOLEAN_TRIP_KEYS));

    function finish() {
        if (current) {
            trips.push(current);
            current = null;
        }
    }

    source.split(/\r?\n/).forEach(function (line, index) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return;
        }
        if (trimmed.startsWith("- ")) {
            finish();
            current = {};
            line = trimmed.slice(2);
        } else if (!current) {
            throw new Error("Unexpected content in travel data at line " + (index + 1) + ".");
        }

        const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line.trim());
        if (!match || !recognized.has(match[1]) || Object.prototype.hasOwnProperty.call(current, match[1])) {
            throw new Error("Unsupported travel data at line " + (index + 1) + ".");
        }
        const key = match[1];
        const value = match[2];
        if (key === "date" || key === "city" || key === "country" || OPTIONAL_TRIP_KEYS.includes(key)) {
            current[key] = parseYamlString(value, key);
        } else if (key === "date_precision") {
            current[key] = value;
        } else if (key === "coordinates") {
            const coordinates = /^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/.exec(value);
            if (!coordinates) {
                throw new Error("Invalid coordinates in travel data.");
            }
            current[key] = [Number(coordinates[1]), Number(coordinates[2])];
        } else if (key === "stay_days") {
            current[key] = Number(value);
        } else if (OPTIONAL_BOOLEAN_TRIP_KEYS.includes(key)) {
            if (value !== "true" && value !== "false") {
                throw new Error("Invalid " + key + " in travel data.");
            }
            current[key] = value === "true";
        }
    });
    finish();
    return validateTrips(trips);
}

function parseFlightYamlString(value, field) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("\"")) {
        return trimmed;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== "string") {
            throw new Error("Expected a string.");
        }
        return parsed;
    } catch (error) {
        throw new Error("Invalid " + field + " in flight data.");
    }
}

function parseFlightYaml(source) {
    const airports = Object.create(null);
    const flights = [];
    const airportPattern = /^\s{2}([A-Z0-9]{3}):\s*\{city:\s*("(?:\\.|[^"\\])*"|[^,{}]+),\s*country:\s*("(?:\\.|[^"\\])*"|[^,{}]+),\s*coordinates:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*\}\s*$/;
    const flightKeys = new Set(["date", "airline", "flight_number", "origin", "destination"]);
    let section = "";
    let currentFlight = null;

    function finishFlight() {
        if (currentFlight) {
            flights.push(currentFlight);
            currentFlight = null;
        }
    }

    source.split(/\r?\n/).forEach(function (line, index) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return;
        }
        if (trimmed === "airports:") {
            finishFlight();
            section = "airports";
            return;
        }
        if (trimmed === "flights:") {
            finishFlight();
            section = "flights";
            return;
        }
        if (section === "airports") {
            const match = airportPattern.exec(line);
            if (!match || Object.prototype.hasOwnProperty.call(airports, match[1])) {
                throw new Error("Unsupported airport data at line " + (index + 1) + ".");
            }
            airports[match[1]] = {
                city: parseFlightYamlString(match[2], "city"),
                country: parseFlightYamlString(match[3], "country"),
                coordinates: [Number(match[4]), Number(match[5])]
            };
            return;
        }
        if (section !== "flights") {
            throw new Error("Unexpected content in flight data at line " + (index + 1) + ".");
        }
        let fieldLine = line.trim();
        if (fieldLine.startsWith("- ")) {
            finishFlight();
            currentFlight = {};
            fieldLine = fieldLine.slice(2);
        } else if (!currentFlight) {
            throw new Error("Unexpected flight data at line " + (index + 1) + ".");
        }
        const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(fieldLine);
        if (!match || !flightKeys.has(match[1]) || Object.prototype.hasOwnProperty.call(currentFlight, match[1])) {
            throw new Error("Unsupported flight data at line " + (index + 1) + ".");
        }
        currentFlight[match[1]] = parseFlightYamlString(match[2], match[1]);
    });
    finishFlight();
    return validateFlightData({ airports: airports, flights: flights });
}

function validateFlightData(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).some(function (key) { return key !== "airports" && key !== "flights"; })) {
        throw new Error("Flight data must contain an airport directory and flight list.");
    }
    const sourceAirports = input.airports;
    if (!sourceAirports || typeof sourceAirports !== "object" || Array.isArray(sourceAirports)
            || Object.keys(sourceAirports).length > MAX_AIRPORTS) {
        throw new Error("Flight data must contain no more than " + MAX_AIRPORTS + " airports.");
    }
    const airports = Object.create(null);
    Object.keys(sourceAirports).forEach(function (code) {
        const airport = sourceAirports[code];
        if (!/^[A-Z0-9]{3}$/.test(code) || !airport || typeof airport !== "object"
                || Array.isArray(airport)
                || Object.keys(airport).some(function (key) {
                    return !["city", "country", "coordinates"].includes(key);
                })) {
            throw new Error("Airport " + code + " must use a three-character IATA code and supported fields.");
        }
        if (typeof airport.city !== "string" || !airport.city.trim() || airport.city.length > 120
                || typeof airport.country !== "string" || !airport.country.trim() || airport.country.length > 120
                || !Array.isArray(airport.coordinates) || airport.coordinates.length !== 2
                || !airport.coordinates.every(Number.isFinite)
                || airport.coordinates[0] < -90 || airport.coordinates[0] > 90
                || airport.coordinates[1] < -180 || airport.coordinates[1] > 180) {
            throw new Error("Airport " + code + " needs a city, country / region, and valid coordinates.");
        }
        airports[code] = {
            city: airport.city.trim(),
            country: airport.country.trim(),
            coordinates: airport.coordinates.slice()
        };
    });

    if (!Array.isArray(input.flights) || input.flights.length < 1 || input.flights.length > MAX_FLIGHTS) {
        throw new Error("Flight data must contain between 1 and " + MAX_FLIGHTS + " flights.");
    }
    const flights = input.flights.map(function (flight, index) {
        const row = index + 1;
        if (!flight || typeof flight !== "object" || Array.isArray(flight)
                || Object.keys(flight).some(function (key) {
                    return !["date", "airline", "flight_number", "origin", "destination"].includes(key);
                })) {
            throw new Error("Flight " + row + " contains unsupported data.");
        }
        if (typeof flight.date !== "string" || !isValidFlightDate(flight.date)) {
            throw new Error("Flight " + row + " must have a valid date in YYYY-MM-DD format.");
        }
        if (typeof flight.origin !== "string" || !Object.prototype.hasOwnProperty.call(airports, flight.origin)
                || typeof flight.destination !== "string"
                || !Object.prototype.hasOwnProperty.call(airports, flight.destination)
                || flight.origin === flight.destination) {
            throw new Error("Flight " + row + " must use two different airports from the airport directory.");
        }
        if (flight.airline !== undefined
                && (typeof flight.airline !== "string" || flight.airline.length > 120)) {
            throw new Error("Flight " + row + " has an invalid airline.");
        }
        if (flight.flight_number !== undefined
                && (typeof flight.flight_number !== "string" || flight.flight_number.length > 40)) {
            throw new Error("Flight " + row + " has an invalid flight number.");
        }
        const normalized = {
            date: flight.date,
            origin: flight.origin,
            destination: flight.destination
        };
        if (flight.airline && flight.airline.trim()) {
            normalized.airline = flight.airline.trim();
        }
        if (flight.flight_number && flight.flight_number.trim()) {
            normalized.flight_number = flight.flight_number.trim();
        }
        return normalized;
    });
    return { airports: airports, flights: flights };
}

function isValidFlightDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return false;
    }
    const parsedDate = new Date(date + "T00:00:00.000Z");
    return Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
}

function serializeFlightYaml(input) {
    const data = validateFlightData(input);
    const lines = [
        "# Personal flight routes. Coordinates are approximate airport locations.",
        "# Ticket numbers are intentionally not stored.",
        "airports:"
    ];
    Object.keys(data.airports).sort().forEach(function (code) {
        const airport = data.airports[code];
        lines.push("  " + code + ": {city: " + JSON.stringify(airport.city)
            + ", country: " + JSON.stringify(airport.country)
            + ", coordinates: [" + airport.coordinates.join(", ") + "]}");
    });
    lines.push("", "flights:");
    data.flights.slice().sort(function (a, b) {
        return b.date.localeCompare(a.date);
    }).forEach(function (flight) {
        lines.push(
            "  - date: " + JSON.stringify(flight.date),
            "    origin: " + flight.origin,
            "    destination: " + flight.destination
        );
        if (flight.airline) {
            lines.push("    airline: " + JSON.stringify(flight.airline));
        }
        if (flight.flight_number) {
            lines.push("    flight_number: " + JSON.stringify(flight.flight_number));
        }
    });
    return lines.join("\n") + "\n";
}

function normalizeTrip(trip) {
    const result = {
        date: trip.date,
        date_precision: "month",
        city: trip.city.trim(),
        country: trip.country.trim(),
        coordinates: trip.coordinates.map(function (coordinate) {
            return Math.round(coordinate * 100) / 100;
        }),
        stay_days: trip.stay_days
    };
    OPTIONAL_TRIP_KEYS.forEach(function (key) {
        if (trip[key] !== undefined && trip[key] !== "") {
            result[key] = trip[key].trim();
        }
    });
    if (trip.lived_here === true) {
        result.lived_here = true;
    }
    return result;
}

function validateTrips(input) {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TRIPS) {
        throw new Error("Travel data must contain between 1 and " + MAX_TRIPS + " stays.");
    }
    return input.map(function (trip, index) {
        const row = index + 1;
        if (!trip || typeof trip !== "object" || Array.isArray(trip)) {
            throw new Error("Record " + row + " must be an object.");
        }
        const allowed = new Set(TRIP_KEYS.concat(OPTIONAL_TRIP_KEYS, OPTIONAL_BOOLEAN_TRIP_KEYS));
        if (Object.keys(trip).some(function (key) { return !allowed.has(key); })) {
            throw new Error("Record " + row + " contains an unsupported field.");
        }
        if (typeof trip.date !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(trip.date)) {
            throw new Error("Record " + row + " must use the first day of a month as its date.");
        }
        const monthDate = new Date(trip.date + "T00:00:00Z");
        if (!Number.isFinite(monthDate.getTime()) || monthDate.toISOString().slice(0, 10) !== trip.date) {
            throw new Error("Record " + row + " has an invalid month.");
        }
        if (trip.date_precision !== "month") {
            throw new Error("Record " + row + " must keep month-level date precision.");
        }
        if (typeof trip.city !== "string" || !trip.city.trim() || trip.city.length > 120
                || typeof trip.country !== "string" || !trip.country.trim() || trip.country.length > 120) {
            throw new Error("Record " + row + " needs a city and country / area (up to 120 characters each).");
        }
        if (!Array.isArray(trip.coordinates) || trip.coordinates.length !== 2
                || !trip.coordinates.every(Number.isFinite)
                || trip.coordinates[0] < -90 || trip.coordinates[0] > 90
                || trip.coordinates[1] < -180 || trip.coordinates[1] > 180
                || trip.coordinates.some(function (value) {
                    return Math.abs(value * 100 - Math.round(value * 100)) > 1e-7;
                })) {
            throw new Error("Record " + row + " coordinates must be valid and rounded to two decimal places.");
        }
        if (!Number.isInteger(trip.stay_days) || trip.stay_days < 0 || trip.stay_days > 3660) {
            throw new Error("Record " + row + " stay_days must be a whole number from 0 to 3660.");
        }
        if (trip.lived_here !== undefined && typeof trip.lived_here !== "boolean") {
            throw new Error("Record " + row + " lived_here must be a boolean.");
        }
        if (trip.title !== undefined && (typeof trip.title !== "string" || trip.title.length > 120)) {
            throw new Error("Record " + row + " has an invalid title.");
        }
        if (trip.description !== undefined
                && (typeof trip.description !== "string" || trip.description.length > 2000)) {
            throw new Error("Record " + row + " has an invalid description.");
        }
        if (trip.photo !== undefined) {
            let photoUrl;
            try {
                photoUrl = new URL(trip.photo);
            } catch (error) {
                throw new Error("Record " + row + " has an invalid photo URL.");
            }
            if (photoUrl.protocol !== "https:" || trip.photo.length > 2048) {
                throw new Error("Record " + row + " photo URLs must use HTTPS and be under 2048 characters.");
            }
        }
        return normalizeTrip(trip);
    });
}

function serializeTripYaml(input) {
    const trips = validateTrips(input).sort(function (a, b) {
        return a.date.localeCompare(b.date) || a.city.localeCompare(b.city) || a.country.localeCompare(b.country);
    });
    const lines = [YAML_HEADER];
    trips.forEach(function (trip) {
        lines.push(
            "- date: " + JSON.stringify(trip.date),
            "  date_precision: month",
            "  city: " + JSON.stringify(trip.city),
            "  country: " + JSON.stringify(trip.country),
            "  coordinates: [" + trip.coordinates.map(function (value) { return value.toFixed(2); }).join(", ") + "]",
            "  stay_days: " + trip.stay_days
        );
        OPTIONAL_TRIP_KEYS.forEach(function (key) {
            if (trip[key] !== undefined) {
                lines.push("  " + key + ": " + JSON.stringify(trip[key]));
            }
        });
        if (trip.lived_here === true) {
            lines.push("  lived_here: true");
        }
    });
    return lines.join("\n") + "\n";
}

function decodeBase64Utf8(value) {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, function (character) { return character.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function githubHeaders(token) {
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "KhanLiu-travel-admin"
    };
}

function fileUrl(env, path) {
    return "https://api.github.com/repos/" + env.GITHUB_REPOSITORY
        + "/contents/" + (path || "_data/trips.yml") + "?ref=" + encodeURIComponent(env.GITHUB_BRANCH);
}

async function getTripsFromGithub(env) {
    const response = await fetch(fileUrl(env), { headers: githubHeaders(env.GITHUB_WRITE_TOKEN) });
    if (!response.ok) {
        console.error("Travel data read failed with GitHub status", response.status);
        throw new Error("GitHub could not read the travel data file (HTTP " + response.status + ").");
    }
    const file = await response.json();
    if (file.encoding !== "base64" || typeof file.content !== "string") {
        throw new Error("GitHub returned an unsupported travel data file.");
    }
    return parseTripYaml(decodeBase64Utf8(file.content));
}

async function getFlightsFromGithub(env) {
    const response = await fetch(fileUrl(env, "_data/flights.yml"), {
        headers: githubHeaders(env.GITHUB_WRITE_TOKEN)
    });
    if (!response.ok) {
        console.error("Flight data read failed with GitHub status", response.status);
        throw new Error("GitHub could not read the flight data file (HTTP " + response.status + ").");
    }
    const file = await response.json();
    if (file.encoding !== "base64" || typeof file.content !== "string") {
        throw new Error("GitHub returned an unsupported flight data file.");
    }
    return parseFlightYaml(decodeBase64Utf8(file.content));
}

async function saveDataToGithub(env, path, content, message) {
    const url = fileUrl(env, path).replace(/\?ref=.*$/, "");
    const currentResponse = await fetch(url + "?ref=" + encodeURIComponent(env.GITHUB_BRANCH), {
        headers: githubHeaders(env.GITHUB_WRITE_TOKEN)
    });
    if (!currentResponse.ok) {
        console.error("Travel data version read failed with GitHub status", currentResponse.status);
        throw new Error("GitHub could not read the current data file before saving (HTTP "
            + currentResponse.status + ").");
    }
    const currentFile = await currentResponse.json();
    const updateResponse = await fetch(url, {
        method: "PUT",
        headers: Object.assign(githubHeaders(env.GITHUB_WRITE_TOKEN), {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            message: message,
            content: encodeBase64Utf8(content),
            sha: currentFile.sha,
            branch: env.GITHUB_BRANCH
        })
    });
    if (updateResponse.status === 409 || updateResponse.status === 422) {
        console.error("Travel data save conflict or validation failure from GitHub", updateResponse.status);
        throw new Error("GitHub rejected the save, possibly because the file changed. Reload and try again.");
    }
    if (!updateResponse.ok) {
        console.error("Travel data write failed with GitHub status", updateResponse.status);
        throw new Error("GitHub could not save the data file (HTTP " + updateResponse.status + ").");
    }
}

async function saveTripsToGithub(env, trips) {
    const content = serializeTripYaml(trips);
    const savedTrips = parseTripYaml(content);
    await saveDataToGithub(env, "_data/trips.yml", content, "Update travel stays from admin editor");
    return savedTrips;
}

async function saveFlightsToGithub(env, data) {
    const content = serializeFlightYaml(data);
    const savedFlights = parseFlightYaml(content);
    await saveDataToGithub(env, "_data/flights.yml", content, "Update flight data from admin editor");
    return savedFlights;
}

async function getAuthorizedSession(request, env) {
    const authorization = request.headers.get("Authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(authorization);
    if (!match) {
        return null;
    }
    const key = "session:" + match[1];
    const value = await env.TRAVEL_ADMIN_AUTHy.get(key);
    if (!value) {
        return null;
    }
    let session;
    try {
        session = JSON.parse(value);
    } catch (error) {
        await env.TRAVEL_ADMIN_AUTHy.delete(key);
        return null;
    }
    if (!session || typeof session.login !== "string" || !Number.isFinite(session.expiresAt)
            || session.expiresAt <= Date.now()
            || session.login.toLowerCase() !== env.ADMIN_GITHUB_LOGIN.toLowerCase()) {
        await env.TRAVEL_ADMIN_AUTHy.delete(key);
        return null;
    }
    return { token: match[1], key: key, login: session.login };
}

function redirectResponse(url) {
    return new Response(null, {
        status: 302,
        headers: {
            "Location": url,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff"
        }
    });
}

async function handleLogin(request, env, url) {
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientIp));
    const rateLimitKey = "login-rate:" + encodeBase64Url(new Uint8Array(ipDigest));
    const attempts = Number(await env.TRAVEL_ADMIN_AUTHy.get(rateLimitKey) || 0);
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=rate_limited");
    }
    await env.TRAVEL_ADMIN_AUTHy.put(rateLimitKey, String(attempts + 1), { expirationTtl: STATE_TTL_SECONDS });
    const state = randomToken();
    await env.TRAVEL_ADMIN_AUTHy.put("oauth-state:" + state, "1", { expirationTtl: STATE_TTL_SECONDS });
    const callback = new URL("/auth/callback", url.origin).toString();
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    return redirectResponse(authorize.toString());
}

async function handleCallback(request, env, url) {
    const state = url.searchParams.get("state") || "";
    const stateKey = "oauth-state:" + state;
    const stateValue = /^[A-Za-z0-9_-]{40,64}$/.test(state)
        ? await env.TRAVEL_ADMIN_AUTHy.get(stateKey)
        : null;
    if (!stateValue) {
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=invalid_state");
    }
    await env.TRAVEL_ADMIN_AUTHy.delete(stateKey);
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=oauth_denied");
    }

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code: code,
            redirect_uri: new URL("/auth/callback", url.origin).toString()
        })
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenResult || typeof tokenResult.access_token !== "string") {
        let errorCode = "oauth_exchange";
        if (tokenResult && tokenResult.error === "incorrect_client_credentials") {
            errorCode = "oauth_credentials";
        } else if (tokenResult && tokenResult.error === "redirect_uri_mismatch") {
            errorCode = "oauth_redirect_uri";
        } else if (tokenResult && tokenResult.error === "bad_verification_code") {
            errorCode = "oauth_code";
        }
        console.error("GitHub OAuth code exchange failed with status", tokenResponse.status, errorCode);
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=" + errorCode);
    }

    const userResponse = await fetch("https://api.github.com/user", {
        headers: githubHeaders(tokenResult.access_token)
    });
    const user = userResponse.ok ? await userResponse.json() : null;
    if (!user || typeof user.login !== "string"
            || user.login.toLowerCase() !== env.ADMIN_GITHUB_LOGIN.toLowerCase()) {
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=not_authorized");
    }

    const sessionToken = randomToken();
    await env.TRAVEL_ADMIN_AUTHy.put("session:" + sessionToken, JSON.stringify({
        login: user.login,
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
    }), { expirationTtl: SESSION_TTL_SECONDS });
    return redirectResponse(env.SITE_ORIGIN + "/admin/#session=" + encodeURIComponent(sessionToken));
}

async function handleApi(request, env, url) {
    const origin = request.headers.get("Origin");
    if (origin !== env.SITE_ORIGIN) {
        return jsonResponse({ error: "origin_not_allowed" }, 403, corsHeaders(env.SITE_ORIGIN));
    }

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env.SITE_ORIGIN) });
    }

    const session = await getAuthorizedSession(request, env);
    if (!session) {
        return jsonResponse({ error: "Please sign in again." }, 401, corsHeaders(env.SITE_ORIGIN));
    }

    if (url.pathname === "/api/session" && request.method === "GET") {
        return jsonResponse({ login: session.login }, 200, corsHeaders(env.SITE_ORIGIN));
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
        await env.TRAVEL_ADMIN_AUTHy.delete(session.key);
        return jsonResponse({ signedOut: true }, 200, corsHeaders(env.SITE_ORIGIN));
    }
    if (url.pathname === "/api/trips" && request.method === "GET") {
        const trips = await getTripsFromGithub(env);
        return jsonResponse({ login: session.login, trips: trips }, 200, corsHeaders(env.SITE_ORIGIN));
    }
    if (url.pathname === "/api/trips" && request.method === "PUT") {
        const bodyText = await request.text();
        if (new TextEncoder().encode(bodyText).length > MAX_REQUEST_BYTES) {
            return jsonResponse({ error: "The submitted data is too large." }, 413, corsHeaders(env.SITE_ORIGIN));
        }
        let body;
        try {
            body = JSON.parse(bodyText);
        } catch (error) {
            return jsonResponse({ error: "The submitted data is not valid JSON." }, 400, corsHeaders(env.SITE_ORIGIN));
        }
        let trips;
        try {
            trips = validateTrips(body.trips);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400, corsHeaders(env.SITE_ORIGIN));
        }
        const savedTrips = await saveTripsToGithub(env, trips);
        return jsonResponse({ login: session.login, trips: savedTrips }, 200, corsHeaders(env.SITE_ORIGIN));
    }
    if (url.pathname === "/api/flights" && request.method === "GET") {
        const data = await getFlightsFromGithub(env);
        return jsonResponse({ login: session.login, airports: data.airports, flights: data.flights },
            200, corsHeaders(env.SITE_ORIGIN));
    }
    if (url.pathname === "/api/flights" && request.method === "PUT") {
        const bodyText = await request.text();
        if (new TextEncoder().encode(bodyText).length > MAX_REQUEST_BYTES) {
            return jsonResponse({ error: "The submitted data is too large." }, 413, corsHeaders(env.SITE_ORIGIN));
        }
        let body;
        try {
            body = JSON.parse(bodyText);
        } catch (error) {
            return jsonResponse({ error: "The submitted data is not valid JSON." }, 400, corsHeaders(env.SITE_ORIGIN));
        }
        let data;
        try {
            data = validateFlightData(body);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400, corsHeaders(env.SITE_ORIGIN));
        }
        const savedData = await saveFlightsToGithub(env, data);
        return jsonResponse({
            login: session.login,
            airports: savedData.airports,
            flights: savedData.flights
        }, 200, corsHeaders(env.SITE_ORIGIN));
    }
    return jsonResponse({ error: "Not found." }, 404, corsHeaders(env.SITE_ORIGIN));
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    try {
        requireConfiguration(env);
        if (url.pathname === "/auth/login" && request.method === "GET") {
            return await handleLogin(request, env, url);
        }
        if (url.pathname === "/auth/callback" && request.method === "GET") {
            return await handleCallback(request, env, url);
        }
        if (url.pathname.startsWith("/api/")) {
            return await handleApi(request, env, url);
        }
        return jsonResponse({ error: "Not found." }, 404);
    } catch (error) {
        console.error("Travel admin request failed:", error.message);
        const headers = url.pathname.startsWith("/api/") && env.SITE_ORIGIN
            ? corsHeaders(env.SITE_ORIGIN)
            : {};
        return jsonResponse({
            error: error.message || "The admin service could not complete the request."
        }, 500, headers);
    }
}

export {
    decodeBase64Utf8,
    encodeBase64Utf8,
    handleRequest,
    parseTripYaml,
    parseFlightYaml,
    serializeTripYaml,
    serializeFlightYaml,
    validateTrips,
    validateFlightData
};

export default {
    fetch: handleRequest
};
