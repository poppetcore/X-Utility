/* Shared X web API primitives. Authentication material is read on demand and is never persisted. */
(function installXApi(root) {
    "use strict";

    if (root.XApi) return;

    const X_ORIGIN = "https://x.com";
    const WEB_BUNDLE = /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\//;
    const ERROR_TYPES = Object.freeze({
        RATE_LIMIT: "RATE_LIMIT",
        LOGIN_REQUIRED: "LOGIN_REQUIRED",
        API_CHANGED: "API_CHANGED",
        CANCELLED: "CANCELLED",
        NETWORK: "NETWORK"
    });
    const taskLocks = new Map();
    const operationCache = new Map();
    const requestBudgets = new Map();
    let lastCleanupRequestAt = 0;
    let transactionContextPromise = null;
    let bundleSourcesPromise = null;

    class XApiError extends Error {
        constructor(type, message, details) {
            super(message || type);
            this.name = "XApiError";
            this.type = type;
            this.code = type;
            if (details !== undefined) this.details = details;
        }
    }

    const apiError = (type, message, details) => new XApiError(type, message, details);

    function getCookie(name) {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
        if (!match) return null;
        try {
            return decodeURIComponent(match[1]);
        } catch {
            return match[1];
        }
    }

    function getOwnUserId() {
        const value = getCookie("twid");
        return value ? value.replace(/^u=/, "") : null;
    }

    function sleep(ms, signal) {
        if (signal?.aborted) return Promise.reject(apiError(ERROR_TYPES.CANCELLED));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
            function done() {
                signal?.removeEventListener("abort", cancelled);
                resolve();
            }
            function cancelled() {
                clearTimeout(timer);
                signal?.removeEventListener("abort", cancelled);
                reject(apiError(ERROR_TYPES.CANCELLED));
            }
            signal?.addEventListener("abort", cancelled, { once: true });
        });
    }

    function throwIfCancelled(signal) {
        if (signal?.aborted) throw apiError(ERROR_TYPES.CANCELLED);
    }

    function getHeaders() {
        if (!root.chrome?.runtime?.sendMessage) {
            return Promise.reject(apiError(ERROR_TYPES.API_CHANGED, "확장 런타임에서 헤더를 읽을 수 없습니다."));
        }
        return new Promise((resolve, reject) => {
            try {
                root.chrome.runtime.sendMessage({ type: "getHeaders" }, response => {
                    const runtimeError = root.chrome.runtime.lastError;
                    if (runtimeError) {
                        reject(apiError(ERROR_TYPES.API_CHANGED, runtimeError.message));
                        return;
                    }
                    const headers = response?.headers || {};
                    resolve({ ...headers, operations: response?.operations || headers.operations || {} });
                });
            } catch (error) {
                reject(apiError(ERROR_TYPES.API_CHANGED, "헤더 요청에 실패했습니다.", error));
            }
        });
    }

    function normaliseOperation(value, fallbackName) {
        if (!value || typeof value !== "object") return null;
        const queryId = value.queryId;
        const operation = value.operation || value.operationName || fallbackName;
        if (!/^[A-Za-z0-9_-]{8,}$/.test(queryId || "") || !operation) return null;
        return { queryId, operation, features: value.features || null };
    }

    function observedOperation(session, names) {
        const operations = session?.operations || {};
        for (const name of names) {
            const found = normaliseOperation(operations[name], name);
            if (found) return found;
        }
        return null;
    }

    function scriptUrls(doc) {
        const domUrls = Array.from(doc.querySelectorAll("script[src]"))
            .map(script => {
                try {
                    return new URL(script.src, location.href).href;
                } catch {
                    return "";
                }
            })
            .filter(url => WEB_BUNDLE.test(url));
        const performanceUrls = doc === document && root.performance?.getEntriesByType
            ? root.performance.getEntriesByType("resource")
                .map(entry => entry.name || "")
                .filter(url => WEB_BUNDLE.test(url) && /\.js(?:$|\?)/.test(url))
            : [];
        return [...new Set([...domUrls, ...performanceUrls])];
    }

    async function fetchText(url) {
        if (root.chrome?.runtime?.sendMessage && /^https:\/\/abs\.twimg\.com\//.test(url)) {
            const result = await new Promise((resolve, reject) => {
                try {
                    root.chrome.runtime.sendMessage({ type: "fetchXResource", url }, response => {
                        const runtimeError = root.chrome.runtime.lastError;
                        if (runtimeError) reject(runtimeError);
                        else resolve(response || {});
                    });
                } catch (error) {
                    reject(error);
                }
            });
            if (result.error) {
                throw apiError(ERROR_TYPES.API_CHANGED, `X 웹 번들을 가져오지 못했습니다: ${url}`, result.error);
            }
            if (!result.ok) {
                throw apiError(ERROR_TYPES.API_CHANGED, `X 웹 번들 응답이 변경되었습니다 (${result.status}).`);
            }
            return result.text;
        }
        let response;
        try {
            response = await fetch(url, { credentials: "include", cache: "no-cache" });
        } catch (error) {
            throw apiError(ERROR_TYPES.NETWORK, `X 웹 번들을 가져오지 못했습니다: ${url}`, error);
        }
        if (!response.ok) {
            throw apiError(ERROR_TYPES.API_CHANGED, `X 웹 번들 응답이 변경되었습니다 (${response.status}).`);
        }
        return response.text();
    }

    async function getBundleSources() {
        if (bundleSourcesPromise) return bundleSourcesPromise;
        bundleSourcesPromise = (async () => {
            const urls = [...new Set(scriptUrls(document))];
            if (!urls.length) {
                throw apiError(ERROR_TYPES.API_CHANGED, "현재 X 페이지에서 responsive-web 스크립트를 찾지 못했습니다.");
            }
            const settled = await Promise.allSettled(urls.map(async url => ({ url, text: await fetchText(url) })));
            const sources = settled.filter(item => item.status === "fulfilled").map(item => item.value);
            if (!sources.length) {
                throw apiError(ERROR_TYPES.API_CHANGED, "현재 X responsive-web 스크립트를 읽지 못했습니다.");
            }
            return sources;
        })();
        try {
            return await bundleSourcesPromise;
        } catch (error) {
            bundleSourcesPromise = null;
            throw error;
        }
    }

    function operationFromSource(source, name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
            new RegExp(`queryId\\s*:\\s*["']([A-Za-z0-9_-]{8,})["'][\\s\\S]{0,300}?operationName\\s*:\\s*["']${escaped}["']`),
            new RegExp(`operationName\\s*:\\s*["']${escaped}["'][\\s\\S]{0,300}?queryId\\s*:\\s*["']([A-Za-z0-9_-]{8,})["']`),
            new RegExp(`["']${escaped}["']\\s*:\\s*\\{[\\s\\S]{0,300}?queryId\\s*:\\s*["']([A-Za-z0-9_-]{8,})["']`)
        ];
        for (const pattern of patterns) {
            const match = pattern.exec(source);
            if (match) return { queryId: match[1], operation: name, features: null };
        }
        return null;
    }

    async function resolveOperation(names, session, options = {}) {
        const candidates = (Array.isArray(names) ? names : [names])
            .filter(name => typeof name === "string" && name.length);
        if (!candidates.length) {
            throw apiError(ERROR_TYPES.API_CHANGED, "확인할 GraphQL operationName이 없습니다.");
        }
        const observed = observedOperation(session, candidates);
        if (observed) return observed;

        if (!options.refresh) {
            for (const name of candidates) {
                if (operationCache.has(name)) return operationCache.get(name);
            }
        } else {
            candidates.forEach(name => operationCache.delete(name));
        }
        const sources = await getBundleSources();
        for (const name of candidates) {
            for (const source of sources) {
                const found = operationFromSource(source.text, name);
                if (found) {
                    operationCache.set(name, found);
                    return found;
                }
            }
        }
        throw apiError(
            ERROR_TYPES.API_CHANGED,
            `현재 X 웹 앱에서 GraphQL 작업을 확인하지 못했습니다: ${candidates.join(", ")}`
        );
    }

    function decodeBase64(value) {
        try {
            return Uint8Array.from(atob(value), char => char.charCodeAt(0));
        } catch (error) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X verification key 형식이 변경되었습니다.", error);
        }
    }

    function floatToHex(value) {
        const result = [];
        let quotient = Math.floor(value);
        let fraction = value - quotient;
        while (quotient > 0) {
            quotient = Math.floor(value / 16);
            const remainder = Math.floor(value - quotient * 16);
            result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
            value = quotient;
        }
        if (fraction === 0) return result.join("");
        result.push(".");
        while (fraction > 0) {
            fraction *= 16;
            const integer = Math.floor(fraction);
            fraction -= integer;
            result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
        }
        return result.join("");
    }

    function solve(value, min, max, floor) {
        const result = value * (max - min) / 255 + min;
        return floor ? Math.floor(result) : Math.round(result * 100) / 100;
    }

    function cubicValue(curves, time) {
        const calculate = (a, b, m) =>
            3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
        if (time <= 0) {
            const gradient = curves[0] > 0 ? curves[1] / curves[0] :
                curves[1] === 0 && curves[2] > 0 ? curves[3] / curves[2] : 0;
            return gradient * time;
        }
        if (time >= 1) {
            const gradient = curves[2] < 1 ? (curves[3] - 1) / (curves[2] - 1) :
                curves[2] === 1 && curves[0] < 1 ? (curves[1] - 1) / (curves[0] - 1) : 0;
            return 1 + gradient * (time - 1);
        }
        let start = 0;
        let end = 1;
        let mid = 0;
        while (start < end) {
            mid = (start + end) / 2;
            const estimate = calculate(curves[0], curves[2], mid);
            if (Math.abs(time - estimate) < 0.00001) return calculate(curves[1], curves[3], mid);
            if (estimate < time) start = mid;
            else end = mid;
        }
        return calculate(curves[1], curves[3], mid);
    }

    function animationKey(frame, targetTime) {
        if (frame.length < 11) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X SVG animation frame 형식이 변경되었습니다.");
        }
        const fromColor = frame.slice(0, 3).concat(1);
        const toColor = frame.slice(3, 6).concat(1);
        const toRotation = solve(frame[6], 60, 360, true);
        const curves = frame.slice(7).map((item, index) => solve(item, index % 2 ? -1 : 0, 1, false));
        if (curves.length !== 4) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X SVG animation curve 형식이 변경되었습니다.");
        }
        const progress = cubicValue(curves, targetTime);
        const color = fromColor.map((value, index) =>
            Math.max(0, value * (1 - progress) + toColor[index] * progress));
        const rotation = toRotation * progress * Math.PI / 180;
        const matrix = [Math.cos(rotation), -Math.sin(rotation), Math.sin(rotation), Math.cos(rotation)];
        const values = color.slice(0, -1).map(value => Math.round(value).toString(16));
        for (const value of matrix) {
            const rounded = Math.abs(Math.round(value * 100) / 100);
            const hex = floatToHex(rounded);
            values.push(hex.startsWith(".") ? `0${hex}`.toLowerCase() : hex || "0");
        }
        return values.concat("0", "0").join("").replace(/[.-]/g, "");
    }

    function parseIndices(source) {
        const matches = [...source.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map(match => Number(match[1]));
        if (matches.length < 2 || matches.some(index => !Number.isInteger(index) || index < 0)) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X ondemand.s key index 형식이 변경되었습니다.");
        }
        return { rowIndex: matches[0], keyIndices: matches.slice(1) };
    }

    function resolveOndemandUrl(doc, sources) {
        const direct = scriptUrls(doc).find(url => /\/ondemand\.s\.[A-Za-z0-9_-]+a\.js(?:$|\?)/.test(url));
        if (direct) return direct;
        const texts = [
            ...Array.from(doc.scripts).map(script => script.textContent || ""),
            doc.documentElement.outerHTML,
            ...sources.map(source => source.text)
        ];
        const modern = /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([A-Za-z0-9_-]+)["']/;
        for (const text of texts) {
            const old = text.match(/["']ondemand\.s["']\s*:\s*["']([A-Fa-f0-9]+)["']/);
            if (old) return `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${old[1]}a.js`;
            const match = modern.exec(text);
            if (match) return `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${match[2]}a.js`;
        }
        throw apiError(ERROR_TYPES.API_CHANGED, "X ondemand.s 위치를 동적으로 확인하지 못했습니다.");
    }

    async function fetchTransactionDocument() {
        const currentKey = document.querySelector("meta[name='twitter-site-verification']");
        const currentFrames = document.querySelectorAll("[id^='loading-x-anim']");
        if (currentKey?.content && currentFrames.length >= 4) return document;

        let response;
        try {
            response = await fetch(`${X_ORIGIN}/home`, {
                credentials: "include",
                cache: "no-cache",
                headers: { accept: "text/html,application/xhtml+xml" }
            });
        } catch (error) {
            throw apiError(ERROR_TYPES.NETWORK, "X verification 페이지를 가져오지 못했습니다.", error);
        }
        if (response.status === 401 || response.status === 403) {
            throw apiError(ERROR_TYPES.LOGIN_REQUIRED, "X 로그인이 필요합니다.");
        }
        if (!response.ok) {
            throw apiError(ERROR_TYPES.API_CHANGED, `X verification 페이지 응답이 변경되었습니다 (${response.status}).`);
        }
        const html = await response.text();
        const parsed = new DOMParser().parseFromString(html, "text/html");
        if (!parsed?.documentElement) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X verification 페이지 형식이 변경되었습니다.");
        }
        return parsed;
    }

    async function createTransactionContext() {
        const doc = await fetchTransactionDocument();
        const key = doc.querySelector("meta[name='twitter-site-verification']")?.getAttribute("content");
        const frames = Array.from(doc.querySelectorAll("[id^='loading-x-anim']"));
        if (!key || frames.length < 4) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X verification key 또는 SVG animation을 찾지 못했습니다.");
        }
        const keyBytes = decodeBase64(key);
        if (keyBytes.length < 6) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X verification key 길이가 변경되었습니다.");
        }

        let sources = [];
        try {
            sources = await getBundleSources();
        } catch {
            const urls = [...new Set(scriptUrls(doc))];
            const settled = await Promise.allSettled(urls.map(async url => ({ url, text: await fetchText(url) })));
            sources = settled.filter(item => item.status === "fulfilled").map(item => item.value);
        }
        const ondemandUrl = resolveOndemandUrl(doc, sources);
        const indices = parseIndices(await fetchText(ondemandUrl));
        if (indices.rowIndex >= keyBytes.length ||
            indices.keyIndices.some(index => index >= keyBytes.length)) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X ondemand.s key index 범위가 변경되었습니다.");
        }

        const frameElement = frames[keyBytes[5] % 4];
        const path = frameElement?.querySelector("svg path:nth-of-type(2)") ||
            frameElement?.querySelectorAll("path")?.[1];
        const pathData = path?.getAttribute("d");
        if (!pathData || pathData.length <= 9) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X SVG animation path 구조가 변경되었습니다.");
        }
        const rows = pathData.substring(9).split("C").map(item => {
            const values = item.replace(/[^\d]+/g, " ").trim();
            return values ? values.split(/\s+/).map(Number) : [];
        });
        const row = keyBytes[indices.rowIndex] % 16;
        if (!rows[row] || rows[row].some(value => !Number.isFinite(value))) {
            throw apiError(ERROR_TYPES.API_CHANGED, "X SVG animation row 구조가 변경되었습니다.");
        }
        let frameTime = indices.keyIndices.reduce((value, index) => value * (keyBytes[index] % 16), 1);
        frameTime = Math.round(frameTime / 10) * 10;
        return {
            keyBytes,
            animation: animationKey(rows[row], frameTime / 4096)
        };
    }

    async function getTransactionContext() {
        if (!transactionContextPromise) transactionContextPromise = createTransactionContext();
        try {
            return await transactionContextPromise;
        } catch (error) {
            transactionContextPromise = null;
            throw error;
        }
    }

    function encodeBase64(bytes) {
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary).replace(/=/g, "");
    }

    async function createTransactionId(method, path) {
        if (!root.crypto?.subtle || !root.crypto?.getRandomValues) {
            throw apiError(ERROR_TYPES.API_CHANGED, "Web Crypto를 사용할 수 없습니다.");
        }
        const context = await getTransactionContext();
        const time = Math.floor((Date.now() - 1682924400000) / 1000);
        const timeBytes = [time & 255, time >> 8 & 255, time >> 16 & 255, time >> 24 & 255];
        const payload = `${String(method).toUpperCase()}!${path}!${time}obfiowerehiring${context.animation}`;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
        const random = crypto.getRandomValues(new Uint8Array(1))[0];
        const source = [...context.keyBytes, ...timeBytes, ...digest.slice(0, 16), 3];
        return encodeBase64(Uint8Array.from([random, ...source.map(value => value ^ random)]));
    }

    async function buildHeaders(session, options = {}) {
        throwIfCancelled(options.signal);
        const csrf = getCookie("ct0");
        if (!session?.authorization || !csrf || !getOwnUserId()) {
            throw apiError(ERROR_TYPES.LOGIN_REQUIRED, "X 로그인 세션을 확인할 수 없습니다.");
        }
        const headers = {
            accept: "*/*",
            authorization: session.authorization,
            "content-type": "application/json",
            "x-csrf-token": csrf,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
            "x-twitter-client-language": session.clientLanguage ||
                (navigator.language || "en").split("-")[0]
        };
        if (session.clientUuid) headers["x-client-uuid"] = session.clientUuid;
        if (options.transaction !== false) {
            if (!options.path) {
                throw apiError(ERROR_TYPES.API_CHANGED, "transaction id 생성에 요청 path가 필요합니다.");
            }
            headers["x-client-transaction-id"] =
                await createTransactionId(options.method || "GET", options.path);
        } else if (session.clientTid) {
            headers["x-client-transaction-id"] = session.clientTid;
        }
        return headers;
    }

    function rateLimitDetails(response) {
        const localNow = Date.now();
        const read = name => response.headers?.get(name) ?? null;
        const rateHeaders = {
            retryAfter: read("retry-after"),
            limit: read("x-rate-limit-limit"),
            remaining: read("x-rate-limit-remaining"),
            reset: read("x-rate-limit-reset"),
            date: read("date")
        };
        const serverNow = Date.parse(rateHeaders.date);
        const referenceNow = Number.isFinite(serverNow) ? serverNow : localNow;
        const reset = Number(rateHeaders.reset) * 1000;
        let retryAt = 0;
        let waitSource = "default-60-seconds";
        if (rateHeaders.retryAfter && /^\d+$/.test(rateHeaders.retryAfter.trim())) {
            retryAt = localNow + Number(rateHeaders.retryAfter) * 1000;
            waitSource = "retry-after-seconds";
        } else if (rateHeaders.retryAfter && Number.isFinite(Date.parse(rateHeaders.retryAfter))) {
            retryAt = localNow + Math.max(0, Date.parse(rateHeaders.retryAfter) - referenceNow);
            waitSource = "retry-after-date";
        } else if (rateHeaders.reset && Number.isFinite(reset) && reset > 0) {
            retryAt = localNow + Math.max(0, reset - referenceNow);
            waitSource = Number.isFinite(serverNow) ? "rate-limit-reset-server-clock" : "rate-limit-reset-local-clock";
        }
        return {
            status: response.status,
            retryAt,
            waitSource,
            waitSeconds: retryAt ? Math.max(0, Math.ceil((retryAt - localNow) / 1000)) : 60,
            rateHeaders,
            clockSkewSeconds: Number.isFinite(serverNow) ? Math.round((localNow - serverNow) / 1000) : null
        };
    }

    function classifyResponse(response, data) {
        if (response.status === 429) {
            throw apiError(ERROR_TYPES.RATE_LIMIT, "X 요청 제한에 도달했습니다.", rateLimitDetails(response));
        }
        if (response.status === 401 || response.status === 403) {
            throw apiError(ERROR_TYPES.LOGIN_REQUIRED, "X 로그인이 만료되었거나 필요합니다.", { status: response.status });
        }
        const errors = Array.isArray(data?.errors)
            ? data.errors.map(error => ({ code: Number(error?.code) })).filter(error => Number.isFinite(error.code))
            : [];
        const hasErrors = Array.isArray(data?.errors) && data.errors.length > 0;
        if (errors.some(error => Number(error?.code) === 88)) {
            throw apiError(
                ERROR_TYPES.RATE_LIMIT,
                "X 요청 제한에 도달했습니다.",
                { ...rateLimitDetails(response), errors }
            );
        }
        if (errors.some(error => [32, 89, 215, 220, 326].includes(Number(error?.code)))) {
            throw apiError(
                ERROR_TYPES.LOGIN_REQUIRED,
                "X 로그인이 만료되었거나 필요합니다.",
                { status: response.status, errors }
            );
        }
        if (!response.ok || hasErrors) {
            throw apiError(
                ERROR_TYPES.API_CHANGED,
                `X GraphQL 응답을 처리할 수 없습니다 (${response.status}).`,
                { status: response.status, errors }
            );
        }
    }

    async function waitForBudget(until, options, operation) {
        if (until > Date.now()) options.onDiagnostic?.({ kind: "wait-plan", operation,
            seconds: Math.ceil((until - Date.now()) / 1000), maxAutomaticSeconds: 60 });
        if (until - Date.now() > 60000) {
            throw apiError(ERROR_TYPES.RATE_LIMIT, "X가 요청을 제한하고 있습니다. 자동 대기 범위를 넘어 작업을 멈췄습니다.", { retryAt: until });
        }
        try {
            while (until > Date.now()) {
                throwIfCancelled(options.signal);
                options.onRateLimit?.({ operation, seconds: Math.ceil((until - Date.now()) / 1000) });
                await sleep(Math.min(1000, until - Date.now()), options.signal);
            }
        } finally {
            options.onRateLimit?.(null);
        }
    }

    // An explicit new task checks the current server response once. Cached
    // limits from a previous task must not be reported as a fresh rejection.
    // Within the task, server cooldowns and the one-retry cap remain in force.
    function beginCleanup(token, onDiagnostic) {
        if (!token || taskLocks.get("x-cleaner") !== token) {
            throw apiError(ERROR_TYPES.CANCELLED, "정리 작업 잠금을 확인할 수 없습니다.");
        }
        const prefix = `${getOwnUserId()}:`;
        for (const [key, until] of requestBudgets) {
            if (!key.startsWith(prefix)) continue;
            if (until > Date.now()) onDiagnostic?.({
                kind: "previous-limit", operation: key.slice(prefix.length),
                secondsRemaining: Math.ceil((until - Date.now()) / 1000),
                freshCheck: true
            });
            requestBudgets.delete(key);
        }
    }

    // Retry only explicit rate-limit rejections, never ambiguous network errors.
    // Budgets are per operation: a timeline read is separate from a deletion.
    async function graphQL(options) {
        if (!options.rateLimitRetry) return graphQLOnce(options);
        throwIfCancelled(options.signal);
        const session = options.session || await getHeaders();
        const operation = options.operation?.queryId
            ? normaliseOperation(options.operation, options.operation.operation || options.operationName)
            : await resolveOperation(options.operationNames || options.operationName, session);
        if (!operation) throw apiError(ERROR_TYPES.API_CHANGED, "GraphQL 작업 정보가 올바르지 않습니다.");
        const key = `${getOwnUserId()}:${operation.operation}`;
        const requestOptions = { ...options, session, operation };
        for (let attempt = 0; ; attempt++) {
            await waitForBudget(requestBudgets.get(key) || 0, options, operation.operation);
            const interval = Math.max(0, Number(options.minIntervalMs) ||
                (String(options.method || "GET").toUpperCase() === "POST" ? 500 : 300));
            await sleep(Math.max(0, lastCleanupRequestAt + interval - Date.now()), options.signal);
            throwIfCancelled(options.signal);
            lastCleanupRequestAt = Date.now();
            try {
                return await graphQLOnce({ ...requestOptions, diagnosticAttempt: attempt + 1 });
            } catch (error) {
                if (error.type !== ERROR_TYPES.RATE_LIMIT) throw error;
                const serverRetryAt = Number(error.details?.retryAt);
                const until = (serverRetryAt > Date.now()
                    ? serverRetryAt : Date.now() + 60000);
                requestBudgets.set(key, until);
                if (attempt >= 1) throw error;
            }
        }
    }

    async function graphQLOnce(options) {
        const method = String(options?.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "POST") {
            throw apiError(ERROR_TYPES.API_CHANGED, `지원하지 않는 GraphQL 방식입니다: ${method}`);
        }
        throwIfCancelled(options?.signal);
        const session = options.session || await getHeaders();
        const operation = options.operation?.queryId
            ? normaliseOperation(options.operation, options.operation.operation || options.operationName)
            : await resolveOperation(options.operationNames || options.operationName, session);
        if (!operation) throw apiError(ERROR_TYPES.API_CHANGED, "GraphQL 작업 정보가 올바르지 않습니다.");

        const path = `/i/api/graphql/${operation.queryId}/${operation.operation}`;
        const params = new URLSearchParams();
        const variables = options.variables || {};
        const features = options.features ?? operation.features;
        if (method === "GET") {
            params.set("variables", JSON.stringify(variables));
            if (features) {
                let featureValue = features;
                if (typeof features === "string") {
                    try {
                        featureValue = decodeURIComponent(features);
                    } catch {
                        featureValue = features;
                    }
                } else {
                    featureValue = JSON.stringify(features);
                }
                params.set("features", featureValue);
            }
            if (options.fieldToggles) params.set("fieldToggles", JSON.stringify(options.fieldToggles));
        }
        let headers;
        try {
            headers = await buildHeaders(session, {
                method,
                path,
                signal: options.signal,
                transaction: options.transaction
            });
        } catch (error) {
            if (options.cleanupDebug) {
                console.warn("[X-Utility][PostCleanup] request preparation failed", {
                    phase: options.cleanupDebug.phase || "request-preparation",
                    operationName: options.cleanupDebug.operation || operation.operation,
                    requestSequence: options.cleanupDebug.requestSequence || null,
                    httpStatus: error?.details?.status || null,
                    graphqlErrorCodes: [],
                    graphqlErrorMessages: [],
                    classifiedAs: error?.type || error?.code || "UNKNOWN"
                });
            }
            throw error;
        }
        const request = {
            method,
            headers,
            credentials: "include",
            signal: options.signal
        };
        if (method === "POST") {
            request.body = JSON.stringify({
                variables,
                ...(features ? { features } : {}),
                ...(options.fieldToggles ? { fieldToggles: options.fieldToggles } : {}),
                queryId: operation.queryId
            });
        }

        const requestStartedAt = performance.now();
        let response;
        try {
            response = await fetch(`${X_ORIGIN}${path}${params.size ? `?${params}` : ""}`, request);
        } catch (error) {
            if (error?.name === "AbortError" || options.signal?.aborted) {
                throw apiError(ERROR_TYPES.CANCELLED);
            }
            if (options.cleanupDebug) {
                console.warn("[X-Utility][PostCleanup] request failed", {
                    phase: options.cleanupDebug.phase || "request",
                    operationName: options.cleanupDebug.operation || operation.operation,
                    requestSequence: options.cleanupDebug.requestSequence || null,
                    httpStatus: "NETWORK_ERROR",
                    graphqlErrorCodes: [],
                    graphqlErrorMessages: [],
                    page: options.cleanupDebug.page || null,
                    durationMs: Math.round(performance.now() - requestStartedAt),
                    classifiedAs: "NETWORK"
                });
            }
            throw apiError(ERROR_TYPES.NETWORK, "X와 통신하지 못했습니다.", error);
        }
        let data = null;
        const diagnostic = {
            kind: "response",
            operation: operation.operation,
            method,
            phase: options.cleanupDebug?.phase || null,
            page: options.cleanupDebug?.page || null,
            hasCursor: Boolean(variables.cursor),
            attempt: options.diagnosticAttempt || 1,
            durationMs: Math.round(performance.now() - requestStartedAt),
            ...rateLimitDetails(response)
        };
        if (options.rateLimitRetry && response.headers?.get("x-rate-limit-remaining") === "0") {
            const until = rateLimitDetails(response).retryAt;
            if (until > Date.now()) {
                requestBudgets.set(`${getOwnUserId()}:${operation.operation}`, until);
            }
        }
        try {
            data = await response.json();
        } catch {
            options.onDiagnostic?.({ ...diagnostic, json: false, errorCodes: [] });
            if (options.cleanupDebug) {
                console.warn("[X-Utility][PostCleanup] request failed", {
                    phase: options.cleanupDebug.phase || "request",
                    operationName: options.cleanupDebug.operation || operation.operation,
                    requestSequence: options.cleanupDebug.requestSequence || null,
                    httpStatus: response.status,
                    graphqlErrorCodes: [],
                    graphqlErrorMessages: [],
                    page: options.cleanupDebug.page || null,
                    durationMs: Math.round(performance.now() - requestStartedAt),
                    classifiedAs: response.ok ? ERROR_TYPES.API_CHANGED : "HTTP_ERROR"
                });
            }
            if (!response.ok || [401, 403, 429].includes(response.status)) {
                classifyResponse(response, null);
            }
            throw apiError(ERROR_TYPES.API_CHANGED, "X GraphQL 응답 형식이 JSON이 아닙니다.", { status: response.status });
        }
        options.onDiagnostic?.({ ...diagnostic, json: true,
            errorCodes: (Array.isArray(data?.errors) ? data.errors : [])
                .map(error => Number(error?.code)).filter(Number.isFinite) });
        try {
            classifyResponse(response, data);
        } catch (error) {
            if (options.cleanupDebug) {
                console.warn("[X-Utility][PostCleanup] request failed", {
                    phase: options.cleanupDebug.phase || "request",
                    operationName: options.cleanupDebug.operation || operation.operation,
                    requestSequence: options.cleanupDebug.requestSequence || null,
                    httpStatus: response.status,
                    graphqlErrorCodes: (data?.errors || [])
                        .map(item => Number(item?.code))
                        .filter(Number.isFinite),
                    graphqlErrorMessages: [],
                    page: options.cleanupDebug.page || null,
                    durationMs: Math.round(performance.now() - requestStartedAt),
                    classifiedAs: error.type || error.code || "UNKNOWN"
                });
            }
            throw error;
        }
        return data;
    }

    function timelineInstructions(data) {
        const known = [
            data?.data?.user?.result?.timeline?.timeline?.instructions,
            data?.data?.user?.result?.timeline_v2?.timeline?.instructions,
            data?.data?.user_result?.result?.timeline_v2?.timeline?.instructions
        ].find(Array.isArray);
        if (known) return known;
        const visited = new Set();
        function search(value) {
            if (!value || typeof value !== "object" || visited.has(value)) return null;
            visited.add(value);
            if (Array.isArray(value.instructions) &&
                value.instructions.some(item => /^Timeline/.test(item?.type || ""))) {
                return value.instructions;
            }
            for (const child of Object.values(value)) {
                const found = search(child);
                if (found) return found;
            }
            return null;
        }
        return search(data) || [];
    }

    function timelineEntries(value) {
        const instructions = Array.isArray(value) ? value : timelineInstructions(value);
        return instructions.flatMap(instruction => {
            if (instruction?.type === "TimelineAddEntries") return instruction.entries || [];
            if (instruction?.type === "TimelineAddToModule") {
                return (instruction.moduleItems || []).map(item =>
                    item?.item || item?.entry || item
                );
            }
            if (instruction?.type === "TimelineReplaceEntry" && instruction.entry) return [instruction.entry];
            if (instruction?.type === "TimelinePinEntry" && instruction.entry) return [instruction.entry];
            return [];
        });
    }

    function timelineCursor(value, direction = "bottom") {
        const entries = Array.isArray(value) ? value : timelineEntries(value);
        const prefix = `cursor-${direction}`;
        const entry = entries.find(item => item?.entryId?.startsWith(prefix));
        return entry?.content?.value || entry?.content?.itemContent?.value || null;
    }

    function acquireTaskLock(name = "global") {
        if (taskLocks.has(name)) return null;
        const token = Object.freeze({ name, id: Symbol(name) });
        taskLocks.set(name, token);
        return token;
    }

    function releaseTaskLock(token) {
        if (!token || taskLocks.get(token.name) !== token) return false;
        taskLocks.delete(token.name);
        return true;
    }

    function isTaskLocked(name = "global") {
        return taskLocks.has(name);
    }

    async function withTaskLock(name, task) {
        if (typeof name === "function") {
            task = name;
            name = "global";
        }
        const token = acquireTaskLock(name);
        if (!token) throw apiError(ERROR_TYPES.CANCELLED, `이미 실행 중인 작업입니다: ${name}`);
        try {
            return await task(token);
        } finally {
            releaseTaskLock(token);
        }
    }

    root.XApi = Object.freeze({
        Error: XApiError,
        ErrorTypes: ERROR_TYPES,
        getCookie,
        getOwnUserId,
        getHeaders,
        buildHeaders,
        resolveOperation,
        createTransactionId,
        graphQL,
        beginCleanup,
        timelineInstructions,
        timelineEntries,
        timelineCursor,
        sleep,
        throwIfCancelled,
        acquireTaskLock,
        releaseTaskLock,
        isTaskLocked,
        withTaskLock
    });
})(globalThis);
