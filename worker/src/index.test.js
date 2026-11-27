import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    decodeBase64Utf8,
    encodeBase64Utf8,
    handleRequest,
    parseFlightYaml,
    parseTripYaml,
    serializeFlightYaml,
    serializeTripYaml,
    validateFlightData,
    validateTrips
} from "./index.js";

const realTripsYaml = await readFile(new URL("../../_data/trips.yml", import.meta.url), "utf8");
const realFlightsYaml = await readFile(new URL("../../_data/flights.yml", import.meta.url), "utf8");

test("parses and serializes all provided flights and accepts future records", () => {
    const data = parseFlightYaml(realFlightsYaml);
    assert.equal(data.flights.length, 60);
    assert.equal(Object.keys(data.airports).length, 40);
    assert.deepEqual(data.flights.find((flight) => flight.flight_number === "SC4799"), {
        date: "2017-07-24",
        origin: "TNA",
        destination: "CKG",
        airline: "Shandong Airlines",
        flight_number: "SC4799"
    });
    assert.deepEqual(parseFlightYaml(serializeFlightYaml(data)), data);

    const future = Object.assign({}, data, {
        flights: data.flights.concat({
            date: "2027-01-15",
            origin: "MUC",
            destination: "BUD",
            airline: "Future Air",
            flight_number: "FA123"
        })
    });
    assert.equal(validateFlightData(future).flights.length, 61);
});

test("rejects flight records with unknown airports or invalid dates", () => {
    const data = parseFlightYaml(realFlightsYaml);
    const unknownAirport = Object.assign({}, data, {
        flights: data.flights.concat({
            date: "2027-01-15",
            origin: "MUC",
            destination: "XYZ"
        })
    });
    assert.throws(() => validateFlightData(unknownAirport), /two different airports from the airport directory/);

    const invalidDate = Object.assign({}, data, {
        flights: data.flights.concat({
            date: "2027-02-30",
            origin: "MUC",
            destination: "BUD"
        })
    });
    assert.throws(() => validateFlightData(invalidDate), /valid date in YYYY-MM-DD format/);
});

test("parses the current public stay data and preserves month-level dates", () => {
    const trips = parseTripYaml(realTripsYaml);
    assert.equal(trips.length, 576);
    assert.ok(trips.every((trip) => trip.date_precision === "month"));
    assert.ok(trips.every((trip) => Number.isInteger(trip.stay_days) && trip.stay_days > 0));
    assert.ok(trips.every((trip) => !/\sarea$/i.test(trip.city)));
    assert.ok(trips.every((trip) => trip.coordinates.every((value) =>
        Math.abs(value * 100 - Math.round(value * 100)) < 1e-7)));
    const livedPlaces = new Set(trips.filter((trip) => trip.lived_here === true)
        .map((trip) => trip.city + "|" + trip.country));
    assert.deepEqual(Array.from(livedPlaces).sort(), [
        "Dresden|Germany",
        "Jinan|China",
        "Munich|Germany",
        "Vienna|Austria",
        "Wuhan|China",
        "Xintai|China"
    ]);
});

test("serializes and parses edited unicode travel records", () => {
    const trips = [{
        date: "2025-03-01",
        date_precision: "month",
        city: "æ±äº¬",
        country: "Japan",
        coordinates: [35.68, 139.69],
        stay_days: 4,
        description: "A short stay",
        lived_here: true
    }];
    const yaml = serializeTripYaml(trips);
    assert.deepEqual(parseTripYaml(yaml), trips);
    assert.equal(decodeBase64Utf8(encodeBase64Utf8(yaml)), yaml);
});

test("rejects exact dates and overly precise coordinates", () => {
    const base = {
        date: "2025-03-01",
        date_precision: "month",
        city: "Tokyo",
        country: "Japan",
        coordinates: [35.68123, 139.69],
        stay_days: 4
    };
    assert.throws(() => validateTrips([base]), /rounded to two decimal places/);
    assert.throws(() => validateTrips([Object.assign({}, base, {
        date: "2025-03-17",
        coordinates: [35.68, 139.69]
    })]), /first day of a month/);
    assert.throws(() => validateTrips([Object.assign({}, base, {
        coordinates: [35.68, 139.69],
        lived_here: "true"
    })]), /lived_here must be a boolean/);
});

test("requires the configured Pages origin before serving admin APIs", async () => {
    const response = await handleRequest(new Request("https://admin.workers.dev/api/trips", {
        headers: { Origin: "https://attacker.example" }
    }), {
        SITE_ORIGIN: "https://khanliu.github.io",
        ADMIN_GITHUB_LOGIN: "KhanLiu",
        GITHUB_REPOSITORY: "KhanLiu/KhanLiu.github.io",
        GITHUB_BRANCH: "main",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_WRITE_TOKEN: "token",
        TRAVEL_ADMIN_AUTHy: {}
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "origin_not_allowed");
});

test("identifies missing Worker binding names without exposing secret values", async () => {
    const response = await handleRequest(new Request("https://admin.workers.dev/api/session", {
        headers: { Origin: "https://khanliu.github.io" }
    }), {
        SITE_ORIGIN: "https://khanliu.github.io",
        ADMIN_GITHUB_LOGIN: "KhanLiu",
        GITHUB_REPOSITORY: "KhanLiu/KhanLiu.github.io",
        GITHUB_BRANCH: "main",
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_WRITE_TOKEN: "private-token-placeholder",
        TRAVEL_ADMIN_AUTHy: {}
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error, /GITHUB_CLIENT_SECRET/);
    assert.doesNotMatch(body.error, /private-token-placeholder/);
});

test("consumes OAuth state once and issues a short session only to the configured GitHub login", async () => {
    const store = new Map();
    const kv = {
        async get(key) { return store.get(key) || null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); }
    };
    const env = {
        SITE_ORIGIN: "https://khanliu.github.io",
        ADMIN_GITHUB_LOGIN: "KhanLiu",
        GITHUB_REPOSITORY: "KhanLiu/KhanLiu.github.io",
        GITHUB_BRANCH: "main",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_WRITE_TOKEN: "fine-grained-token",
        TRAVEL_ADMIN_AUTHy: kv
    };
    const originalFetch = globalThis.fetch;
    let githubLogin = "KhanLiu";
    let tokenResult = { access_token: "oauth-user-token" };
    globalThis.fetch = async (input) => {
        if (String(input) === "https://github.com/login/oauth/access_token") {
            return new Response(JSON.stringify(tokenResult), { status: 200 });
        }
        if (String(input) === "https://api.github.com/user") {
            return new Response(JSON.stringify({ login: githubLogin }), { status: 200 });
        }
        throw new Error("Unexpected OAuth request.");
    };

    try {
        const loginResponse = await handleRequest(new Request("https://admin.workers.dev/auth/login"), env);
        const authorizationUrl = new URL(loginResponse.headers.get("Location"));
        const state = authorizationUrl.searchParams.get("state");
        assert.ok(store.has("oauth-state:" + state));
        assert.equal(authorizationUrl.searchParams.get("scope"), "read:user");

        const callback = "https://admin.workers.dev/auth/callback?code=one-time-code&state="
            + encodeURIComponent(state);
        const callbackResponse = await handleRequest(new Request(callback), env);
        assert.match(callbackResponse.headers.get("Location"), /^https:\/\/khanliu\.github\.io\/admin\/#session=/);
        assert.equal(store.has("oauth-state:" + state), false);

        const replayResponse = await handleRequest(new Request(callback), env);
        assert.match(replayResponse.headers.get("Location"), /#error=invalid_state$/);

        const secondLogin = await handleRequest(new Request("https://admin.workers.dev/auth/login"), env);
        const secondState = new URL(secondLogin.headers.get("Location")).searchParams.get("state");
        githubLogin = "someone-else";
        const rejected = await handleRequest(new Request(
            "https://admin.workers.dev/auth/callback?code=another-code&state=" + encodeURIComponent(secondState)
        ), env);
        assert.match(rejected.headers.get("Location"), /#error=not_authorized$/);
        assert.equal(Array.from(store.keys()).filter((key) => key.startsWith("session:")).length, 1);

        const credentialsLogin = await handleRequest(new Request("https://admin.workers.dev/auth/login"), env);
        const credentialsState = new URL(credentialsLogin.headers.get("Location")).searchParams.get("state");
        tokenResult = { error: "incorrect_client_credentials" };
        const invalidCredentials = await handleRequest(new Request(
            "https://admin.workers.dev/auth/callback?code=credentials-code&state="
                + encodeURIComponent(credentialsState)
        ), env);
        assert.match(invalidCredentials.headers.get("Location"), /#error=oauth_credentials$/);

        const codeLogin = await handleRequest(new Request("https://admin.workers.dev/auth/login"), env);
        const codeState = new URL(codeLogin.headers.get("Location")).searchParams.get("state");
        tokenResult = { error: "bad_verification_code" };
        const invalidCode = await handleRequest(new Request(
            "https://admin.workers.dev/auth/callback?code=expired-code&state=" + encodeURIComponent(codeState)
        ), env);
        assert.match(invalidCode.headers.get("Location"), /#error=oauth_code$/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("limits repeated public OAuth initiation requests per Cloudflare client address", async () => {
    const store = new Map();
    const kv = {
        async get(key) { return store.get(key) || null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); }
    };
    const env = {
        SITE_ORIGIN: "https://khanliu.github.io",
        ADMIN_GITHUB_LOGIN: "KhanLiu",
        GITHUB_REPOSITORY: "KhanLiu/KhanLiu.github.io",
        GITHUB_BRANCH: "main",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_WRITE_TOKEN: "fine-grained-token",
        TRAVEL_ADMIN_AUTHy: kv
    };
    let response;
    for (let attempt = 0; attempt < 11; attempt += 1) {
        response = await handleRequest(new Request("https://admin.workers.dev/auth/login", {
            headers: { "CF-Connecting-IP": "192.0.2.10" }
        }), env);
    }
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "https://khanliu.github.io/admin/#error=rate_limited");
    assert.equal(Array.from(store.keys()).filter((key) => key.startsWith("oauth-state:")).length, 10);
});

test("reads and writes travel data only after validating the signed-in session", async () => {
    const sessionToken = "A".repeat(43);
    const store = new Map([["session:" + sessionToken, JSON.stringify({
        login: "KhanLiu",
        expiresAt: Date.now() + 60000
    })]]);
    const kv = {
        async get(key) { return store.get(key) || null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); }
    };
    const env = {
        SITE_ORIGIN: "https://khanliu.github.io",
        ADMIN_GITHUB_LOGIN: "khanliu",
        GITHUB_REPOSITORY: "KhanLiu/KhanLiu.github.io",
        GITHUB_BRANCH: "main",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_WRITE_TOKEN: "fine-grained-token",
        TRAVEL_ADMIN_AUTHy: kv
    };
    const originalFetch = globalThis.fetch;
    const calls = [];
    const originalYaml = serializeTripYaml(parseTripYaml(realTripsYaml));
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), init });
        if (init && init.method === "PUT") {
            return new Response(JSON.stringify({ commit: { sha: "new-sha" } }), { status: 201 });
        }
        return new Response(JSON.stringify({
            sha: "old-sha",
            encoding: "base64",
            content: Buffer.from(originalYaml, "utf8").toString("base64")
        }), { status: 200 });
    };

    try {
        const headers = {
            Origin: env.SITE_ORIGIN,
            Authorization: "Bearer " + sessionToken,
            "Content-Type": "application/json"
        };
        const getResponse = await handleRequest(new Request("https://admin.workers.dev/api/trips", {
            headers: headers
        }), env);
        assert.equal(getResponse.status, 200);
        assert.equal(getResponse.headers.get("Access-Control-Allow-Origin"), env.SITE_ORIGIN);
        const body = await getResponse.json();
        assert.equal(body.trips.length, 576);
        assert.equal(body.login, "KhanLiu");

        const edited = body.trips.slice(0, 1);
        edited[0].city = "Updated City";
        const putResponse = await handleRequest(new Request("https://admin.workers.dev/api/trips", {
            method: "PUT",
            headers: headers,
            body: JSON.stringify({ trips: edited })
        }), env);
        assert.equal(putResponse.status, 200);
        assert.equal(calls.filter((call) => call.init && call.init.method === "PUT").length, 1);
        assert.equal(calls.at(-1).url, "https://api.github.com/repos/KhanLiu/KhanLiu.github.io/contents/_data/trips.yml");
        const savedRequest = JSON.parse(calls.at(-1).init.body);
        assert.equal(savedRequest.sha, "old-sha");
        assert.match(Buffer.from(savedRequest.content, "base64").toString("utf8"), /Updated City/);

        const invalidResponse = await handleRequest(new Request("https://admin.workers.dev/api/trips", {
            method: "PUT",
            headers: headers,
            body: JSON.stringify({ trips: [{ date: "2025-03-12" }] })
        }), env);
        assert.equal(invalidResponse.status, 400);
        assert.equal(calls.filter((call) => call.init && call.init.method === "PUT").length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("reads and writes flight records and airports only after validating the signed-in session", async () => {
    const sessionToken = "B".repeat(43);
    const store = new Map([["session:" + sessionToken, JSON.stringify({
        login: "KhanLiu",
        expiresAt: Date.now() + 60000
    })]]);
    const kv = {
        async get(key) { return store.get(key) || null; },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); }
    };
    const env = {
        SITE_ORIGIN: "https://khanliu.github.io",
        ADMIN_GITHUB_LOGIN: "KhanLiu",
        GITHUB_REPOSITORY: "KhanLiu/KhanLiu.github.io",
        GITHUB_BRANCH: "main",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_WRITE_TOKEN: "fine-grained-token",
        TRAVEL_ADMIN_AUTHy: kv
    };
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), init });
        if (init && init.method === "PUT") {
            return new Response(JSON.stringify({ commit: { sha: "new-sha" } }), { status: 201 });
        }
        return new Response(JSON.stringify({
            sha: "old-sha",
            encoding: "base64",
            content: Buffer.from(realFlightsYaml, "utf8").toString("base64")
        }), { status: 200 });
    };

    try {
        const headers = {
            Origin: env.SITE_ORIGIN,
            Authorization: "Bearer " + sessionToken,
            "Content-Type": "application/json"
        };
        const getResponse = await handleRequest(new Request("https://admin.workers.dev/api/flights", {
            headers: headers
        }), env);
        assert.equal(getResponse.status, 200);
        const data = await getResponse.json();
        assert.equal(data.flights.length, 60);
        assert.equal(Object.keys(data.airports).length, 40);

        const upcoming = {
            date: "2027-01-15",
            origin: "MUC",
            destination: "BUD",
            airline: "Future Air",
            flight_number: "FA123"
        };
        const putResponse = await handleRequest(new Request("https://admin.workers.dev/api/flights", {
            method: "PUT",
            headers: headers,
            body: JSON.stringify({
                airports: data.airports,
                flights: data.flights.concat(upcoming)
            })
        }), env);
        assert.equal(putResponse.status, 200);
        assert.equal((await putResponse.json()).flights.length, 61);
        assert.equal(calls.filter((call) => call.init && call.init.method === "PUT").length, 1);
        assert.equal(calls.at(-1).url,
            "https://api.github.com/repos/KhanLiu/KhanLiu.github.io/contents/_data/flights.yml");
        const savedRequest = JSON.parse(calls.at(-1).init.body);
        const savedYaml = Buffer.from(savedRequest.content, "base64").toString("utf8");
        assert.equal(savedRequest.sha, "old-sha");
        assert.match(savedYaml, /flight_number: "FA123"/);
        assert.doesNotMatch(savedYaml, /ticket(?:\s+number)?\s*:\s*\d+/i);

        const invalidResponse = await handleRequest(new Request("https://admin.workers.dev/api/flights", {
            method: "PUT",
            headers: headers,
            body: JSON.stringify({
                airports: data.airports,
                flights: data.flights.concat(Object.assign({}, upcoming, { destination: "XYZ" }))
            })
        }), env);
        assert.equal(invalidResponse.status, 400);
        assert.equal(calls.filter((call) => call.init && call.init.method === "PUT").length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
