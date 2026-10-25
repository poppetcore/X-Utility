/* X cleanup engine. It reuses the authenticated X web session; tokens are never stored. */
const DEFAULT_DELETE_QUERY_ID = "VaenaVgh5q5ih7kvyVjgtg";
let cleanupRunning = false;

function cleanupSleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(new Error("CANCELLED"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
        const cancelled = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancelled);
            reject(new Error("CANCELLED"));
        };
        function done() {
            signal?.removeEventListener("abort", cancelled);
            resolve();
        }
        signal?.addEventListener("abort", cancelled, { once: true });
    });
}

function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}

function getOwnUserId() {
    const twid = getCookie("twid");
    return twid ? twid.replace(/^u=/, "") : null;
}

function getLegacy(tweet) {
    return tweet && tweet.legacy ? tweet.legacy : tweet || {};
}

function getTweetId(tweet) {
    const legacy = getLegacy(tweet);
    return String(tweet?.rest_id || tweet?.id_str || legacy.id_str || "");
}

function getTweetText(tweet) {
    const legacy = getLegacy(tweet);
    return legacy.full_text || tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.text || "";
}

function getTweetOwnerId(tweet) {
    const ownerId = tweet?.core?.user_results?.result?.rest_id ||
        tweet?.core?.user_results?.result?.id_str ||
        tweet?.user_results?.result?.rest_id ||
        tweet?.user_result?.result?.rest_id ||
        tweet?.user_id_str ||
        getLegacy(tweet).user_id_str ||
        getLegacy(tweet).user_id ||
        "";
    return String(ownerId);
}

function isOwnedTweet(tweet, userId) {
    return getTweetOwnerId(tweet) === String(userId);
}

function getOperation(headers, names) {
    const operations = headers.operations || {};
    for (const name of names) {
        if (operations[name]?.queryId) return operations[name];
    }
    return null;
}

function buildHeaders(session, csrf) {
    const headers = {
        accept: "*/*",
        authorization: session.authorization,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": session.clientLanguage || navigator.language.split("-")[0]
    };
    if (session.clientTid) headers["x-client-transaction-id"] = session.clientTid;
    if (session.clientUuid) headers["x-client-uuid"] = session.clientUuid;
    return headers;
}

function parseEntries(data) {
    let instructionSources = [
        data?.data?.user?.result?.timeline?.timeline?.instructions,
        data?.data?.user?.result?.timeline_v2?.timeline?.instructions,
        data?.data?.user_result?.result?.timeline_v2?.timeline?.instructions
    ].filter(Array.isArray);
    if (!instructionSources.length) {
        const visited = new Set();
        function findInstructions(value) {
            if (!value || typeof value !== "object" || visited.has(value)) return null;
            visited.add(value);
            if (Array.isArray(value.instructions) &&
                value.instructions.some(item => /^Timeline/.test(item?.type || ""))) {
                return value.instructions;
            }
            for (const child of Object.values(value)) {
                const found = findInstructions(child);
                if (found) return found;
            }
            return null;
        }
        const fallback = findInstructions(data);
        if (fallback) instructionSources = [fallback];
    }
    const instructions = instructionSources.flat();
    return instructions.flatMap(instruction => {
        if (instruction.type === "TimelineAddEntries") return instruction.entries || [];
        if (instruction.type === "TimelineAddToModule") {
            return (instruction.moduleItems || []).map(item =>
                item?.item || item?.entry || item
            );
        }
        if (instruction.type === "TimelineReplaceEntry" && instruction.entry) return [instruction.entry];
        if (instruction.type === "TimelinePinEntry" && instruction.entry) {
            instruction.entry.__cleanerPinnedEntry = true;
            return [instruction.entry];
        }
        return [];
    });
}

function findTweets(value, result = [], seen = new Set(), pinned = false) {
    if (!value || typeof value !== "object") return result;
    const isPinned = pinned || value.__type === "TimelinePinEntry" ||
        value.type === "TimelinePinEntry" || value.__cleanerPinnedEntry === true;
    if (value.__typename === "TweetWithVisibilityResults" && value.tweet) {
        findTweets(value.tweet, result, seen, isPinned);
    } else if (value.__typename === "Tweet" || value.rest_id || value.legacy?.id_str) {
        const id = getTweetId(value);
        if (id && !seen.has(id)) {
            seen.add(id);
            value.__cleanerPinned = isPinned;
            result.push(value);
        }
    }
    for (const child of Object.values(value)) {
        if (child && typeof child === "object") findTweets(child, result, seen, isPinned);
    }
    return result;
}

function findTimelineTweets(entries, result = [], seen = new Set()) {
    const nestedTweetFields = new Set([
        "quoted_status_result", "retweeted_status_result",
        "quoted_tweet_result", "retweeted_tweet_result",
        "quoted_status", "retweeted_status"
    ]);
    function collect(value, pinned = false, visited = new Set()) {
        if (!value || typeof value !== "object" || visited.has(value)) return;
        visited.add(value);
        const isPinned = pinned || value.__type === "TimelinePinEntry" ||
            value.type === "TimelinePinEntry" || value.__cleanerPinnedEntry === true;
        const candidates = [
            value.tweet_results?.result,
            value.tweetResult?.result
        ].filter(Boolean);
        if (value.__typename === "Tweet" ||
            (value.legacy?.id_str && (value.legacy?.user_id_str || value.legacy?.user_id))) {
            candidates.push(value);
        }
        for (const candidate of candidates) {
            const tweet = candidate.__typename === "TweetWithVisibilityResults"
                ? candidate.tweet
                : candidate;
            const tweetId = getTweetId(tweet);
            if (!tweetId || seen.has(tweetId)) continue;
            seen.add(tweetId);
            if (isPinned) tweet.__cleanerPinned = true;
            result.push(tweet);
        }
        for (const [key, child] of Object.entries(value)) {
            if (nestedTweetFields.has(key)) continue;
            if (Array.isArray(child)) {
                child.forEach(item => collect(item, isPinned, visited));
            } else if (child && typeof child === "object") {
                collect(child, isPinned, visited);
            }
        }
    }

    for (const entry of entries || []) {
        if (!entry || entry.entryId?.startsWith("cursor-")) continue;
        collect(entry, entry.__cleanerPinnedEntry === true);
    }
    return result;
}

function matchesFilter(tweet, options, userId) {
    const id = getTweetId(tweet);
    if (!id || !isOwnedTweet(tweet, userId)) return false;
    return true;
}

async function fetchTweets(options, operation, cursor) {
    const variables = {
        userId: options.userId,
        count: 20,
        includePromotedContent: true,
        withCommunity: true,
        withVoice: true
    };
    if (cursor) variables.cursor = cursor;
    const params = new URLSearchParams({ variables: JSON.stringify(variables) });
    if (operation.features) params.set("features", decodeURIComponent(operation.features));

    if (globalThis.XApi) {
        try {
            return await globalThis.XApi.graphQL({
                method: "GET",
                operation,
                variables,
                session: options.session,
                signal: options.signal,
                rateLimitRetry: true,
                minIntervalMs: 300,
                onRateLimit: options.onRateLimit,
                onDiagnostic: options.onDiagnostic,
                cleanupDebug: {
                    operation: operation.operation,
                    phase: options.currentPhase || "initial-scan",
                    page: options.currentPage || 1,
                    requestSequence: options.currentRequestSequence,
                    hasCursor: Boolean(cursor)
                }
            });
        } catch (error) {
            recordCleanupFailure(options, operation, error);
            throw error;
        }
    }
    const response = await fetch(
        `https://x.com/i/api/graphql/${operation.queryId}/${operation.operation}?${params}`,
        {
            headers: buildHeaders(options.session, options.csrf),
            credentials: "include",
            signal: options.signal
        }
    );
    if (response.status === 429) {
        const error = new Error("RATE_LIMIT");
        error.type = "RATE_LIMIT";
        throw error;
    }
    if (response.status === 401 || response.status === 403) {
        const error = new Error("LOGIN_REQUIRED");
        error.type = "LOGIN_REQUIRED";
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`게시글 조회 실패 (${response.status})`);
        error.type = "API_CHANGED";
        throw error;
    }
    return response.json();
}

function getNextCursor(entries) {
    const directCursor = (entries || []).find(entry =>
        entry?.entryId?.startsWith("cursor-bottom")
    );
    if (directCursor) {
        return directCursor.content?.value ||
            directCursor.content?.itemContent?.value || null;
    }
    const visited = new Set();
    function find(value) {
        if (!value || typeof value !== "object" || visited.has(value)) return null;
        visited.add(value);
        if (value.entryId?.startsWith("cursor-bottom")) {
            return value.content?.value || value.content?.itemContent?.value || null;
        }
        for (const child of Object.values(value)) {
            const cursor = find(child);
            if (cursor) return cursor;
        }
        return null;
    }
    return find(entries);
}

async function deleteTweet(tweetId, options, deleteOperation) {
    recordCleanupRequest(options, deleteOperation, "delete");
    if (globalThis.XApi) {
        try {
            await globalThis.XApi.graphQL({
                method: "POST",
                operation: { ...deleteOperation, operation: "DeleteTweet" },
                variables: { tweet_id: tweetId, dark_request: false },
                session: options.session,
                signal: options.signal,
                rateLimitRetry: true,
                minIntervalMs: Math.max(300, Number(options.delay) || 500),
                onRateLimit: options.onRateLimit,
                onDiagnostic: options.onDiagnostic,
                cleanupDebug: {
                    operation: "DeleteTweet",
                    phase: "delete",
                    page: options.currentPage || null,
                    requestSequence: options.currentRequestSequence
                }
            });
        } catch (error) {
            recordCleanupFailure(options, { ...deleteOperation, operation: "DeleteTweet" }, error);
            throw error;
        }
        return;
    }
    const response = await fetch(
        `https://x.com/i/api/graphql/${deleteOperation.queryId}/DeleteTweet`,
        {
            method: "POST",
            headers: buildHeaders(options.session, options.csrf),
            credentials: "include",
            signal: options.signal,
            body: JSON.stringify({
                variables: { tweet_id: tweetId, dark_request: false },
                queryId: deleteOperation.queryId
            })
        }
    );
    if (response.status === 429) {
        const error = new Error("RATE_LIMIT");
        error.type = "RATE_LIMIT";
        throw error;
    }
    if (response.status === 401 || response.status === 403) {
        const error = new Error("LOGIN_REQUIRED");
        error.type = "LOGIN_REQUIRED";
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`삭제 실패 (${response.status})`);
        error.type = "API_CHANGED";
        throw error;
    }
}

const MAX_CLEANUP_PASSES = 10;
const MAX_TIMELINE_PAGES = 500;

function throwIfCleanupCancelled(options) {
    if (options.signal?.aborted || options.isCancelled?.()) {
        throw new Error("CANCELLED");
    }
}

function recordCleanupRequest(options, operation, kind) {
    const stats = options.requestStats;
    if (!stats) return;
    const operationName = operation?.operation || "unknown";
    const sequence = ++stats.sequence;
    stats.requests.push({
        sequence,
        phase: kind === "delete" ? "delete" : options.currentPhase,
        operation: operationName
    });
    options.currentRequestSequence = sequence;
    if (kind === "delete") {
        stats.deleteTweet++;
    } else {
        stats[operationName] = (stats[operationName] || 0) + 1;
        if (options.currentPhase === "initial-scan") stats.initialScan++;
        if (options.currentPhase === "verify") stats.verification++;
    }
    stats.total++;
}

function recordCleanupFailure(options, operation, error) {
    const stats = options.requestStats;
    if (!stats) return;
    const detailsErrors = Array.isArray(error?.details)
        ? error.details
        : (error?.details?.errors || []);
    const failure = {
        sequence: options.currentRequestSequence || null,
        phase: options.currentPhase,
        operation: operation?.operation || "unknown",
        httpStatus: error?.details?.status || null,
        xErrorCodes: detailsErrors
            .map(item => Number(item?.code))
            .filter(Number.isFinite),
        graphqlErrors: [],
        classification: error?.type || error?.code || "UNKNOWN"
    };
    stats.failure = failure;
    console.warn("[X-Utility][PostCleanup] request failure recorded", failure);
}

function now() {
    return performance.now();
}

async function resolveTimelineOperations(session, requestStats) {
    const names = ["UserTweets", "UserTweetsAndReplies"];
    const operations = [];
    let lastError = null;
    for (const name of names) {
        let operation = getOperation(session, [name]);
        if (!operation && globalThis.XApi) {
            requestStats.operationDiscovery++;
            try {
                operation = await globalThis.XApi.resolveOperation([name], session);
            } catch (error) {
                lastError = error;
                const detailsErrors = Array.isArray(error?.details)
                    ? error.details
                    : (error?.details?.errors || []);
                console.warn("[X-Utility][PostCleanup] operation discovery failed", {
                    phase: "operation-discovery",
                    operation: name,
                    httpStatus: error?.details?.status || null,
                    graphqlErrorCodes: detailsErrors
                        .map(item => Number(item?.code))
                        .filter(Number.isFinite),
                    graphqlErrorMessages: [],
                    classifiedAs: error?.type || error?.code || "UNKNOWN"
                });
                operation = null;
            }
        }
        if (operation?.queryId) {
            operations.push({
                ...operation,
                operation: operation.operation || name
            });
        }
    }
    return {
        operations: [...new Map(
            operations.map(operation => [
                `${operation.queryId}:${operation.operation}`,
                operation
            ])
        ).values()],
        error: lastError
    };
}

// X can explicitly terminate a timeline without returning any entries.
function hasBottomTermination(value, visited = new Set()) {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    if (value.type === "TimelineTerminateTimeline" && value.direction === "Bottom") return true;
    return Object.values(value).some(child => hasBottomTermination(child, visited));
}

async function scanTimeline(operation, options, protectedTweetIds) {
    const tweets = new Map();
    const visitedCursors = new Set();
    const startedAt = now();
    let cursor = null;
    let pages = 0;
    let complete = true;
    let unchangedPages = 0;

    while (true) {
        throwIfCleanupCancelled(options);
        if (++pages > MAX_TIMELINE_PAGES) {
            console.warn("[X-Utility][PostCleanup] UserTweets pagination reached safety limit", {
                phase: options.currentPhase,
                operationName: operation.operation,
                page: pages - 1,
            });
            complete = false;
            break;
        }
        const cursorKey = cursor || "__initial__";
        if (visitedCursors.has(cursorKey)) {
            console.warn("[X-Utility][PostCleanup] pagination stopped: visited cursor", {
                phase: options.currentPhase,
                operationName: operation.operation,
                page: pages,
            });
            complete = false;
            break;
        }
        visitedCursors.add(cursorKey);

        options.currentPage = pages;
        recordCleanupRequest(options, operation, "timeline");
        const data = await fetchTweets(options, operation, cursor);
        const entries = parseEntries(data);
        const terminated = hasBottomTermination(data);
        if (!entries.length && terminated) break;
        if (!entries.length) {
            console.warn("[X-Utility][PostCleanup] timeline parse failed", {
                phase: options.currentPhase,
                operationName: operation.operation,
                httpStatus: null,
                graphqlErrorCodes: [],
                graphqlErrorMessages: [],
                page: pages,
                classifiedAs: "API_CHANGED"
            });
            const error = new Error("X 게시글 timeline 구조를 확인하지 못했습니다.");
            error.type = "API_CHANGED";
            recordCleanupFailure(options, operation, error);
            throw error;
        }
        const pageTweets = findTimelineTweets(entries);
        const previousTweetCount = tweets.size;
        for (const tweet of pageTweets) {
            const tweetId = getTweetId(tweet);
            if (!tweetId) continue;
            if (tweet.__cleanerPinned) protectedTweetIds.add(tweetId);
            if (!tweets.has(tweetId)) tweets.set(tweetId, tweet);
        }
        const newTweetCount = tweets.size - previousTweetCount;
        unchangedPages = newTweetCount === 0 ? unchangedPages + 1 : 0;
        const nextCursor = getNextCursor(entries);
        options.onDiagnostic?.({ kind: "page", operation: operation.operation,
            phase: options.currentPhase, page: pages, fetched: pageTweets.length,
            newTweets: newTweetCount,
            owned: pageTweets.filter(tweet => isOwnedTweet(tweet, options.userId)).length,
            unknownOwner: pageTweets.filter(tweet => !getTweetOwnerId(tweet)).length,
            pinned: pageTweets.filter(tweet => tweet.__cleanerPinned).length,
            hasNextCursor: Boolean(nextCursor), unchangedPages });
        if (options.pageCallback) {
            await options.pageCallback({
                tweets: pageTweets,
                nextCursor,
                page: pages,
                newTweetCount
            });
        }
        // A cursor-only page is the normal end of an exhausted X timeline.
        // Duplicate tweets with a fresh cursor are NOT evidence of completion:
        // continue so older posts beyond overlapping pages are still checked.
        const cursorOnly = entries.length > 0 && entries.every(entry =>
            entry?.entryId?.startsWith("cursor-") || entry?.content?.cursorType
        );
        if (terminated || (pageTweets.length === 0 && cursorOnly) || !nextCursor) break;
        // Only excluded, owned pins may end a repeated timeline early.
        // With pin exclusion disabled, pins remain deletion targets and the
        // normal pagination and stalled-timeline checks must still run.
        if (options.keepPinned === true && pages > 1 && newTweetCount === 0 &&
            pageTweets.length > 0 && pageTweets.every(tweet =>
                tweet.__cleanerPinned && isOwnedTweet(tweet, options.userId))) {
            options.onDiagnostic?.({ kind: "scan-end", operation: operation.operation,
                phase: options.currentPhase, page: pages, reason: "repeated-excluded-pinned-only" });
            break;
        }
        if (unchangedPages >= 3) {
            const error = new Error("게시글 목록이 같은 내용을 반복하여 조회를 멈췄습니다. 잠시 후 다시 시도해 주세요.");
            error.type = "TIMELINE_STALLED";
            throw error;
        }
        if (visitedCursors.has(nextCursor)) {
            console.warn("[X-Utility][PostCleanup] pagination stopped: next cursor already visited", {
                phase: options.currentPhase,
                operationName: operation.operation,
                page: pages,
            });
            complete = false;
            break;
        }
        cursor = nextCursor;
        await cleanupSleep(300, options.signal);
    }

    return {
        tweets,
        complete,
        pages,
        durationMs: Math.round(now() - startedAt)
    };
}

async function runCleanup(message, response) {
    if (cleanupRunning) throw new Error("이미 청소가 실행 중입니다.");
    const taskToken = globalThis.XApi?.acquireTaskLock("x-cleaner") || null;
    if (globalThis.XApi && !taskToken) {
        throw new Error("다른 X 정리 작업이 이미 실행 중입니다.");
    }
    cleanupRunning = true;
    const session = {
        ...(response?.headers || {}),
        operations: response?.operations || response?.headers?.operations || {}
    };
    const requestStats = {
        UserTweets: 0,
        UserTweetsAndReplies: 0,
        deleteTweet: 0,
        initialScan: 0,
        verification: 0,
        retries: 0,
        operationDiscovery: 0,
        total: 0,
        sequence: 0,
        requests: [],
        failure: null,
        result: "FAILED"
    };
    const timing = {
        startedAt: now(),
        operationDiscoveryStart: 0,
        operationReady: 0,
        deleteOperationReady: 0,
        initialScanStart: 0,
        initialScanDone: 0,
        targetsReady: 0,
        firstDeleteSent: 0,
        firstDeleteCompleted: 0,
        verifyStart: 0,
        verifyDone: 0,
        scanDetails: []
    };
    const deleteOperation = getOperation(session, ["DeleteTweet"]) || {
        queryId: DEFAULT_DELETE_QUERY_ID
    };
    timing.deleteOperationReady = now();
    const csrf = globalThis.XApi?.getCookie("ct0") || getCookie("ct0");
    const userId = globalThis.XApi?.getOwnUserId() || getOwnUserId();
    timing.operationDiscoveryStart = now();
    const timelineResolution = await resolveTimelineOperations(session, requestStats);
    timing.operationReady = now();
    const timelineOperations = timelineResolution.operations;
    if (!session.authorization || !csrf || !userId || !timelineOperations.length) {


        cleanupRunning = false;
        if (taskToken) globalThis.XApi.releaseTaskLock(taskToken);
        if (timelineResolution.error) {
            const detailsErrors = Array.isArray(timelineResolution.error?.details)
                ? timelineResolution.error.details
                : (timelineResolution.error?.details?.errors || []);
            requestStats.failure = {
                sequence: null,
                phase: "operation-discovery",
                operation: "UserTweets/UserTweetsAndReplies",
                httpStatus: timelineResolution.error?.details?.status || null,
                xErrorCodes: detailsErrors
                    .map(item => Number(item?.code))
                    .filter(Number.isFinite),
                graphqlErrors: [],
                classification: timelineResolution.error?.type ||
                    timelineResolution.error?.code || "UNKNOWN"
            };
            throw timelineResolution.error;
        }
        const error = new Error("X 페이지 정보를 확인할 수 없습니다. 프로필을 새로고침한 후 다시 시도해 주세요.");
        error.type = "API_CHANGED";
        throw error;
    }

    const options = {
        ...message,
        session,
        csrf,
        userId,
        signal: message.signal,
        keepPinned: message.keepPinned !== false,
        requestStats,
        currentPhase: "initial-scan",
        currentPage: 0,
        timing,
        hasSentDelete: false
    };
    let total = 0;
    const protectedTweetIds = new Set();
    const deletedTweetIds = new Set();
    const failedTweetIds = new Set();
    try {
        if (taskToken) globalThis.XApi.beginCleanup(taskToken, options.onDiagnostic);
        for (let pass = 0; pass < MAX_CLEANUP_PASSES; pass++) {
            throwIfCleanupCancelled(options);
            options.currentPhase = pass === 0 ? "initial-scan" : "verify";
            if (pass === 0) {
                timing.initialScanStart = now();
            } else {
                timing.verifyStart = now();
            }
            let passHadTargets = false;
            let passSuccessfulDeletes = 0;
            let unknownOwnerCount = 0;
            const scheduledTweetIds = new Set();
            options.pageCallback = async ({ tweets: pageTweets }) => {
                unknownOwnerCount += pageTweets.filter(tweet => !getTweetOwnerId(tweet)).length;
                const targets = pageTweets.filter(tweet => {
                    const tweetId = getTweetId(tweet);
                    return matchesFilter(tweet, options, userId) &&
                        !(options.keepPinned && protectedTweetIds.has(tweetId)) &&
                        !deletedTweetIds.has(tweetId) &&
                        !scheduledTweetIds.has(tweetId);
                });
                if (!targets.length) return;
                passHadTargets = true;
                if (!timing.targetsReady) timing.targetsReady = now();
                timing.targetsCollected = (timing.targetsCollected || 0) + targets.length;
                for (let index = 0; index < targets.length; index++) {
                    const tweet = targets[index];
                    throwIfCleanupCancelled(options);
                    const tweetId = getTweetId(tweet);
                    scheduledTweetIds.add(tweetId);
                    if (index > 0) {
                        await cleanupSleep(
                            Math.max(300, Number(message.delay) || 500),
                            options.signal
                        );
                    }
                    try {
                        if (!options.hasSentDelete) {
                            timing.firstDeleteSent = now();
                            options.hasSentDelete = true;
                        }
                        await deleteTweet(tweetId, options, deleteOperation);
                        if (!timing.firstDeleteCompleted) timing.firstDeleteCompleted = now();
                        deletedTweetIds.add(tweetId);
                        failedTweetIds.delete(tweetId);
                        passSuccessfulDeletes++;
                        total++;
                        options.countCallback(total);
                    } catch (error) {
                        const errorType = error?.type || error?.code || error?.message;
                        if (["RATE_LIMIT", "LOGIN_REQUIRED", "API_CHANGED", "NETWORK", "CANCELLED"]
                            .includes(errorType)) {
                            throw error;
                        }
                        failedTweetIds.add(tweetId);
                    }
                    throwIfCleanupCancelled(options);
                }
            };
            for (const operation of timelineOperations) {
                const scan = await scanTimeline(operation, options, protectedTweetIds);
                if (!scan.complete) {
                    throw new Error("게시글을 모두 확인하지 못했습니다.");
                }
                timing.scanDetails.push({
                    phase: options.currentPhase,
                    operation: operation.operation,
                    pages: scan.pages,
                    durationMs: scan.durationMs
                });
            }
            if (pass === 0) timing.initialScanDone = now();
            else timing.verifyDone = now();

            if (!passHadTargets) {
                if (unknownOwnerCount > 0) {
                    const error = new Error("조회된 게시글의 작성자를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
                    error.type = "OWNER_UNAVAILABLE";
                    throw error;
                }
                requestStats.result = "SUCCEEDED";
                return total;
            }
            if (!passSuccessfulDeletes && failedTweetIds.size) {
                throw new Error("일부 게시글을 삭제하지 못했습니다.");
            }
            await cleanupSleep(Math.max(300, Number(message.delay) || 500), options.signal);
        }
        throw new Error("일부 게시글을 삭제하지 못했습니다.");
    } finally {


        cleanupRunning = false;
        if (taskToken) globalThis.XApi.releaseTaskLock(taskToken);
    }
}

async function OnTweetClean(message) {
    const ui = globalThis.createCleanupOverlay("tweet-clean-overlay", "게시글 정리 중...");
    const { overlay, title, phase: waitStatus, button: cancel } = ui;
    const count = document.createElement("div");
    count.textContent = "삭제된 게시글: 0개";
    ui.stats.appendChild(count);
    let cancelled = false;
    const controller = new AbortController();
    cancel.onclick = () => {
        cancelled = true;
        controller.abort();
        cancel.disabled = true;
        waitStatus.style.display = "block";
        waitStatus.textContent = "취소하는 중...";
    };
    try {
        const response = await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: "getHeaders" }, resolve));
        await runCleanup({ ...message, signal: controller.signal, isCancelled: () => cancelled,
            onRateLimit: status => {
                waitStatus.style.display = status ? "block" : "none";
                title.textContent = status ? "X 요청 대기 중" : "게시글 정리 중...";
                if (status) {
                    const action = status.operation === "DeleteTweet" ? "삭제" : "게시글 목록 조회";
                    waitStatus.textContent = `X의 ${action} 요청 제한으로 대기 중입니다. ${status.seconds}초 후 자동으로 이어서 진행합니다.`;
                }
            },
            countCallback: value => {
                count.textContent = `삭제된 게시글: ${value}개`;
            } }, response || {});
        title.textContent = "게시글 정리 완료";
        waitStatus.style.display = "block";
        waitStatus.textContent = "게시글 정리가 끝났습니다.";
        cancel.textContent = "확인";
        cancel.onclick = () => overlay.remove();
    } catch (error) {
        const errorType = error.type || error.message;
        cancel.disabled = false;
        waitStatus.style.display = "block";
        waitStatus.textContent = errorType === "CANCELLED"
            ? "사용자가 작업을 취소했습니다."
            : "게시글을 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
        title.textContent = errorType === "CANCELLED"
            ? "게시글 정리 취소됨"
            : errorType === "RATE_LIMIT"
                ? "X 요청 제한으로 작업을 멈췄습니다"
                : "게시글 정리 실패";
        if (errorType === "RATE_LIMIT") {
            waitStatus.style.display = "block";
            waitStatus.textContent = "X가 요청을 제한하고 있어 작업을 멈췄습니다. 잠시 후 다시 시도해 주세요. 이미 삭제한 게시글 수는 위에 표시됩니다.";
        }
        if (["TIMELINE_STALLED", "OWNER_UNAVAILABLE"].includes(errorType)) {
            waitStatus.style.display = "block";
            waitStatus.textContent = error.message;
        }
        if (error.message.includes("세션 정보")) {
            cancel.textContent = "새로고침";
            cancel.onclick = () => window.location.reload();
        } else {
            cancel.textContent = "닫기";
            cancel.onclick = () => overlay.remove();
        }
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.deleteMytweet) {
        OnTweetClean(message);
        sendResponse({ started: true });
    }
});
