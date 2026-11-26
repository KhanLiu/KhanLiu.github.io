const MAX_TRIPS = 2000;
const MAX_REQUEST_BYTES = 500000;
const MAX_LOGIN_ATTEMPTS = 10;
const SESSION_TTL_SECONDS = 7200;
const STATE_TTL_SECONDS = 600;
const TRIP_KEYS = ["date", "date_precision", "city", "country", "coordinates", "stay_days"];
const OPTIONAL_TRIP_KEYS = ["title", "description", "photo"];
const YAML_HEADER = [
    "# Night-anchored city stays inferred from GPS fixes with horizontal accuracy <= 100 m.",
    "# Night location uses local time 20:00-05:59; other days extend a stay only when >=70% of",
    "# at least two matched fixes agree on the same city. City match is within 50 km of an",
    "# approximate city centre. Stays require a night anchor; one day without accurate fixes may be bridged.",
    "# stay_days is an estimated inclusive span from first city day to last night; no exact dates",
    "# or raw GPS fixes are published. Timeline date and city-centre coordinates remain approximate."
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
    if (!env.AUTH_STORE || required.some(function (key) { return !env[key]; })) {
        throw new Error("Admin worker is missing required configuration.");
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
    const recognized = new Set(TRIP_KEYS.concat(OPTIONAL_TRIP_KEYS));

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
        }
    });
    finish();
    return validateTrips(trips);
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
        const allowed = new Set(TRIP_KEYS.concat(OPTIONAL_TRIP_KEYS));
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
        if (!Number.isInteger(trip.stay_days) || trip.stay_days < 1 || trip.stay_days > 3660) {
            throw new Error("Record " + row + " stay_days must be a whole number from 1 to 3660.");
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

function fileUrl(env) {
    return "https://api.github.com/repos/" + env.GITHUB_REPOSITORY
        + "/contents/_data/trips.yml?ref=" + encodeURIComponent(env.GITHUB_BRANCH);
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

async function saveTripsToGithub(env, trips) {
    const url = fileUrl(env).replace(/\?ref=.*$/, "");
    const currentResponse = await fetch(url + "?ref=" + encodeURIComponent(env.GITHUB_BRANCH), {
        headers: githubHeaders(env.GITHUB_WRITE_TOKEN)
    });
    if (!currentResponse.ok) {
        console.error("Travel data version read failed with GitHub status", currentResponse.status);
        throw new Error("GitHub could not read the current file before saving (HTTP "
            + currentResponse.status + ").");
    }
    const currentFile = await currentResponse.json();
    const content = serializeTripYaml(trips);
    const savedTrips = parseTripYaml(content);
    const updateResponse = await fetch(url, {
        method: "PUT",
        headers: Object.assign(githubHeaders(env.GITHUB_WRITE_TOKEN), {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            message: "Update travel stays from admin editor",
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
        throw new Error("GitHub could not save the travel data file (HTTP " + updateResponse.status + ").");
    }
    return savedTrips;
}

async function getAuthorizedSession(request, env) {
    const authorization = request.headers.get("Authorization") || "";
    const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(authorization);
    if (!match) {
        return null;
    }
    const key = "session:" + match[1];
    const value = await env.AUTH_STORE.get(key);
    if (!value) {
        return null;
    }
    let session;
    try {
        session = JSON.parse(value);
    } catch (error) {
        await env.AUTH_STORE.delete(key);
        return null;
    }
    if (!session || typeof session.login !== "string" || !Number.isFinite(session.expiresAt)
            || session.expiresAt <= Date.now()
            || session.login.toLowerCase() !== env.ADMIN_GITHUB_LOGIN.toLowerCase()) {
        await env.AUTH_STORE.delete(key);
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
    const attempts = Number(await env.AUTH_STORE.get(rateLimitKey) || 0);
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
        return jsonResponse({ error: "Too many sign-in attempts. Try again in ten minutes." }, 429, {
            "Retry-After": String(STATE_TTL_SECONDS)
        });
    }
    await env.AUTH_STORE.put(rateLimitKey, String(attempts + 1), { expirationTtl: STATE_TTL_SECONDS });
    const state = randomToken();
    await env.AUTH_STORE.put("oauth-state:" + state, "1", { expirationTtl: STATE_TTL_SECONDS });
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
    const stateValue = /^[A-Za-z0-9_-]{40,64}$/.test(state) ? await env.AUTH_STORE.get(stateKey) : null;
    if (!stateValue) {
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=invalid_state");
    }
    await env.AUTH_STORE.delete(stateKey);
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
    if (!tokenResponse.ok || !tokenResult.access_token) {
        console.error("GitHub OAuth code exchange failed with status", tokenResponse.status);
        return redirectResponse(env.SITE_ORIGIN + "/admin/#error=oauth_exchange");
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
    await env.AUTH_STORE.put("session:" + sessionToken, JSON.stringify({
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
        await env.AUTH_STORE.delete(session.key);
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
    serializeTripYaml,
    validateTrips
};

export default {
    fetch: handleRequest
};
