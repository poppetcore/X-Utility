/* Follower storage is bundled here so the service worker starts without importScripts.
 * Keep this copy identical to follower_storage.js; the existing database schema is preserved. */
globalThis.FollowerStorage = (function () {
    "use strict";

    const DB_NAME = "x-cleaner";
    const DB_VERSION = 1;

    class FollowerStorageError extends Error {
        constructor(operation, message, cause) {
            super(message);
            this.name = "FollowerStorageError";
            this.operation = operation;
            if (cause !== undefined) this.cause = cause;
        }
    }

    function storageError(operation, error) {
        if (error instanceof FollowerStorageError) return error;
        const detail = error && error.message ? error.message : String(error || "Unknown storage error");
        return new FollowerStorageError(operation, `${operation} failed: ${detail}`, error);
    }

    function requireId(value, label) {
        const id = value == null ? "" : String(value).trim();
        if (!id) {
            throw new FollowerStorageError("validation", `${label} is required`);
        }
        return id;
    }

    function toIso(value) {
        const date = value == null ? new Date() : new Date(value);
        if (Number.isNaN(date.getTime())) {
            throw new FollowerStorageError("validation", "capturedAt must be a valid date");
        }
        return date.toISOString();
    }

    function makeSnapshotId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
            return globalThis.crypto.randomUUID();
        }
        const randomPart = function () {
            return Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
        };
        return `${Date.now().toString(36)}-${randomPart()}${randomPart()}-${randomPart()}-${randomPart()}-${randomPart()}${randomPart()}${randomPart()}`;
    }

    function userIdOf(user) {
        if (typeof user === "string" || typeof user === "number" || typeof user === "bigint") {
            return requireId(user, "follower userId");
        }
        if (!user || typeof user !== "object") {
            throw new FollowerStorageError("validation", "each follower must be an object or userId");
        }
        return requireId(user.userId, "follower userId");
    }

    function normalizeAccount(account) {
        if (typeof account === "string" || typeof account === "number" || typeof account === "bigint") {
            return { accountUserId: requireId(account, "accountUserId") };
        }
        if (!account || typeof account !== "object") {
            throw new FollowerStorageError("validation", "account must contain accountUserId");
        }
        return Object.assign({}, account, {
            accountUserId: requireId(account.accountUserId, "accountUserId")
        });
    }

    function requestPromise(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    function transactionDone(transaction) {
        return new Promise(function (resolve, reject) {
            transaction.oncomplete = function () { resolve(); };
            transaction.onabort = function () {
                reject(transaction.error || new Error("IndexedDB transaction was aborted"));
            };
            transaction.onerror = function () {
                reject(transaction.error || new Error("IndexedDB transaction failed"));
            };
        });
    }

    let databasePromise;

    function openDatabase() {
        if (databasePromise) return databasePromise;
        databasePromise = new Promise(function (resolve, reject) {
            if (!globalThis.indexedDB) {
                reject(new FollowerStorageError(
                    "openDatabase",
                    "IndexedDB is unavailable; follower data must be accessed from an extension page or service worker"
                ));
                return;
            }

            const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function () {
                const db = request.result;

                const accounts = db.createObjectStore("accounts", { keyPath: "accountUserId" });
                accounts.createIndex("byUpdatedAt", "updatedAt");

                const snapshots = db.createObjectStore("snapshots", { keyPath: "snapshotId" });
                snapshots.createIndex("byAccountUserId", "accountUserId");
                snapshots.createIndex("byAccountCapturedAt", ["accountUserId", "capturedAt"]);

                const followers = db.createObjectStore(
                    "snapshotFollowers",
                    { keyPath: ["snapshotId", "userId"] }
                );
                followers.createIndex("bySnapshotId", "snapshotId");
                followers.createIndex("byAccountUserId", "accountUserId");
                followers.createIndex("byAccountAndSnapshot", ["accountUserId", "snapshotId"]);
                followers.createIndex("byAccountAndUser", ["accountUserId", "userId"]);
            };
            request.onsuccess = function () {
                const db = request.result;
                db.onversionchange = function () {
                    db.close();
                    databasePromise = undefined;
                };
                resolve(db);
            };
            request.onerror = function () {
                databasePromise = undefined;
                reject(storageError("openDatabase", request.error));
            };
            request.onblocked = function () {
                databasePromise = undefined;
                reject(new FollowerStorageError(
                    "openDatabase",
                    "Database upgrade is blocked by another open extension context"
                ));
            };
        });
        return databasePromise;
    }

    async function withTransaction(storeNames, mode, operation, work) {
        try {
            const db = await openDatabase();
            const transaction = db.transaction(storeNames, mode);
            const done = transactionDone(transaction);
            let result;
            try {
                result = await work(transaction);
            } catch (error) {
                try { transaction.abort(); } catch (_) {}
                await done.catch(function () {});
                throw error;
            }
            await done;
            return result;
        } catch (error) {
            throw storageError(operation, error);
        }
    }

    async function saveSnapshot(account, followerList, options) {
        const accountRecord = normalizeAccount(account);
        if (!Array.isArray(followerList)) {
            throw new FollowerStorageError("validation", "followers must be an array");
        }
        options = options && typeof options === "object" ? options : {};

        const accountUserId = accountRecord.accountUserId;
        const snapshotId = requireId(options.snapshotId || makeSnapshotId(), "snapshotId");
        const capturedAt = toIso(options.capturedAt);
        const uniqueFollowers = new Map();

        followerList.forEach(function (user) {
            const userId = userIdOf(user);
            const value = user && typeof user === "object"
                ? Object.assign({}, user, { userId: userId })
                : { userId: userId };
            uniqueFollowers.set(userId, value);
        });

        const snapshot = {
            snapshotId: snapshotId,
            accountUserId: accountUserId,
            accountScreenName: accountRecord.screenName || "",
            capturedAt: capturedAt,
            createdAt: capturedAt,
            followerCount: uniqueFollowers.size,
            metadata: options.metadata && typeof options.metadata === "object"
                ? Object.assign({}, options.metadata)
                : {}
        };
        const now = new Date().toISOString();
        const savedAccount = Object.assign({}, accountRecord, {
            accountUserId: accountUserId,
            updatedAt: now
        });

        return withTransaction(
            ["accounts", "snapshots", "snapshotFollowers"],
            "readwrite",
            "saveSnapshot",
            async function (transaction) {
                const accounts = transaction.objectStore("accounts");
                const snapshots = transaction.objectStore("snapshots");
                const followers = transaction.objectStore("snapshotFollowers");
                const existing = await requestPromise(accounts.get(accountUserId));

                if (existing && existing.createdAt) {
                    savedAccount.createdAt = existing.createdAt;
                } else {
                    savedAccount.createdAt = now;
                }

                accounts.put(savedAccount);
                snapshots.add(snapshot);
                uniqueFollowers.forEach(function (user, userId) {
                    followers.add(Object.assign({}, user, {
                        snapshotId: snapshotId,
                        accountUserId: accountUserId,
                        userId: userId
                    }));
                });
                return Object.assign({}, snapshot);
            }
        );
    }

    async function listAccounts() {
        return withTransaction(["accounts"], "readonly", "listAccounts", async function (transaction) {
            const rows = await requestPromise(transaction.objectStore("accounts").getAll());
            return rows.sort(function (a, b) {
                return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
            });
        });
    }

    async function listSnapshots(accountUserId) {
        accountUserId = requireId(accountUserId, "accountUserId");
        return withTransaction(["snapshots"], "readonly", "listSnapshots", async function (transaction) {
            const index = transaction.objectStore("snapshots").index("byAccountUserId");
            const rows = await requestPromise(index.getAll(accountUserId));
            return rows.sort(function (a, b) {
                return b.capturedAt.localeCompare(a.capturedAt);
            });
        });
    }

    async function getSnapshot(accountUserId, snapshotId) {
        accountUserId = requireId(accountUserId, "accountUserId");
        snapshotId = requireId(snapshotId, "snapshotId");
        return withTransaction(["snapshots"], "readonly", "getSnapshot", async function (transaction) {
            const row = await requestPromise(transaction.objectStore("snapshots").get(snapshotId));
            return row && row.accountUserId === accountUserId ? row : null;
        });
    }

    function publicFollower(row) {
        const copy = Object.assign({}, row);
        delete copy.snapshotId;
        delete copy.accountUserId;
        return copy;
    }

    async function getFollowers(accountUserId, snapshotId) {
        accountUserId = requireId(accountUserId, "accountUserId");
        snapshotId = requireId(snapshotId, "snapshotId");
        return withTransaction(
            ["snapshots", "snapshotFollowers"],
            "readonly",
            "getFollowers",
            async function (transaction) {
                const snapshot = await requestPromise(transaction.objectStore("snapshots").get(snapshotId));
                if (!snapshot || snapshot.accountUserId !== accountUserId) return [];
                const index = transaction.objectStore("snapshotFollowers").index("byAccountAndSnapshot");
                const rows = await requestPromise(index.getAll([accountUserId, snapshotId]));
                return rows.map(publicFollower);
            }
        );
    }

    async function getLatestSnapshot(accountUserId) {
        accountUserId = requireId(accountUserId, "accountUserId");
        return withTransaction(["snapshots"], "readonly", "getLatestSnapshot", async function (transaction) {
            const index = transaction.objectStore("snapshots").index("byAccountCapturedAt");
            const range = globalThis.IDBKeyRange.bound(
                [accountUserId, ""],
                [accountUserId, "\uffff"]
            );
            return requestPromise(index.openCursor(range, "prev")).then(function (cursor) {
                return cursor ? cursor.value : null;
            });
        });
    }

    async function deleteSnapshot(accountUserId, snapshotId) {
        accountUserId = requireId(accountUserId, "accountUserId");
        snapshotId = requireId(snapshotId, "snapshotId");
        return withTransaction(
            ["snapshots", "snapshotFollowers"],
            "readwrite",
            "deleteSnapshot",
            async function (transaction) {
                const snapshots = transaction.objectStore("snapshots");
                const snapshot = await requestPromise(snapshots.get(snapshotId));
                if (!snapshot || snapshot.accountUserId !== accountUserId) return false;

                const followers = transaction.objectStore("snapshotFollowers");
                const index = followers.index("byAccountAndSnapshot");
                await new Promise(function (resolve, reject) {
                    const request = index.openKeyCursor(
                        globalThis.IDBKeyRange.only([accountUserId, snapshotId])
                    );
                    request.onerror = function () { reject(request.error); };
                    request.onsuccess = function () {
                        const cursor = request.result;
                        if (!cursor) {
                            resolve();
                            return;
                        }
                        followers.delete(cursor.primaryKey);
                        cursor.continue();
                    };
                });
                snapshots.delete(snapshotId);
                return true;
            }
        );
    }

    async function getUserHistoryRows(accountUserId, userId) {
        accountUserId = requireId(accountUserId, "accountUserId");
        userId = requireId(userId, "userId");
        return withTransaction(
            ["snapshots", "snapshotFollowers"],
            "readonly",
            "getUserHistoryRows",
            async function (transaction) {
                const snapshotsRequest = transaction.objectStore("snapshots")
                    .index("byAccountUserId").getAll(accountUserId);
                const membershipsRequest = transaction.objectStore("snapshotFollowers")
                    .index("byAccountAndUser").getAll([accountUserId, userId]);
                const results = await Promise.all([
                    requestPromise(snapshotsRequest),
                    requestPromise(membershipsRequest)
                ]);
                const membershipBySnapshot = new Map();
                results[1].forEach(function (row) {
                    membershipBySnapshot.set(row.snapshotId, publicFollower(row));
                });
                return results[0]
                    .sort(function (a, b) { return a.capturedAt.localeCompare(b.capturedAt); })
                    .map(function (snapshot) {
                        const follower = membershipBySnapshot.get(snapshot.snapshotId) || null;
                        return {
                            snapshotId: snapshot.snapshotId,
                            accountUserId: accountUserId,
                            userId: userId,
                            capturedAt: snapshot.capturedAt,
                            isFollowing: Boolean(follower),
                            present: Boolean(follower),
                            follower: follower
                        };
                    });
            }
        );
    }

    return Object.freeze({
        DB_NAME: DB_NAME,
        DB_VERSION: DB_VERSION,
        FollowerStorageError: FollowerStorageError,
        saveSnapshot: saveSnapshot,
        listAccounts: listAccounts,
        listSnapshots: listSnapshots,
        getSnapshot: getSnapshot,
        getFollowers: getFollowers,
        getLatestSnapshot: getLatestSnapshot,
        deleteSnapshot: deleteSnapshot,
        getUserHistoryRows: getUserHistoryRows
    });
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = globalThis.FollowerStorage;
}

function extractGraphQLOperation(url) {
    const match = url.match(/\/i\/api\/graphql\/([^/]+)\/([^?/#]+)/);
    return match ? { queryId: match[1], operation: match[2] } : null;
}

function extractFeaturesFromUrl(url) {
    const match = url.match(/[?&]features=([^&]+)/);
    return match ? match[1] : null;
}

let savedHeaders = {
    authorization: null,
    clientTid: null,
    clientUuid: null,
    platform: null,
    clientLanguage: null
};

let savedOperations = {};
const sessionsByTab = new Map();

function sessionForTab(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return null;
    if (!sessionsByTab.has(tabId)) {
        sessionsByTab.set(tabId, {
            headers: {
                authorization: null,
                clientTid: null,
                clientUuid: null,
                platform: null,
                clientLanguage: null
            },
            operations: {}
        });
    }
    return sessionsByTab.get(tabId);
}

chrome.tabs.onRemoved.addListener(tabId => {
    sessionsByTab.delete(tabId);
});

chrome.webRequest.onBeforeSendHeaders.addListener(
    function (details) {
        const operation = extractGraphQLOperation(details.url);
        if (!operation || !/(^|:\/\/)([^/]+\.)?(x|twitter)\.com\//.test(details.url)) {
            return { requestHeaders: details.requestHeaders };
        }

        const tabSession = sessionForTab(details.tabId);
        const operationValue = {
            queryId: operation.queryId,
            features: extractFeaturesFromUrl(details.url),
            operation: operation.operation
        };
        savedOperations[operation.operation] = operationValue;
        if (tabSession) tabSession.operations[operation.operation] = operationValue;

        (details.requestHeaders || []).forEach(header => {
            const targets = tabSession ? [savedHeaders, tabSession.headers] : [savedHeaders];
            switch (header.name.toLowerCase()) {
                case 'authorization':
                    targets.forEach(target => { target.authorization = header.value; });
                    break;
                case 'x-client-transaction-id':
                    targets.forEach(target => { target.clientTid = header.value; });
                    break;
                case 'x-client-uuid':
                    targets.forEach(target => { target.clientUuid = header.value; });
                    break;
                case 'sec-ch-ua-platform':
                    targets.forEach(target => { target.platform = header.value; });
                    break;
                case 'x-twitter-client-language':
                    targets.forEach(target => { target.clientLanguage = header.value; });
                    break;
            }
        });

        return { requestHeaders: details.requestHeaders };
    },
    { urls: ["*://*.twitter.com/*", "*://*.x.com/*"] },
    ["requestHeaders", "extraHeaders"]
);

async function findXTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
        if (!tab.id || !tab.url) return false;
        try {
            return /(^|\.)((x|twitter)\.com)$/.test(new URL(tab.url).hostname);
        } catch (_) {
            return false;
        }
    }).sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
}

async function findXTab() {
    const xTabs = await findXTabs();
    return xTabs[0] || null;
}

async function handleStorageMessage(message) {
    switch (message.type) {
        case "saveFollowerSnapshot": {
            const input = message.snapshot || {};
            const snapshot = await FollowerStorage.saveSnapshot(
                {
                    accountUserId: input.accountUserId,
                    screenName: input.accountScreenName || ""
                },
                input.followers || [],
                {
                    snapshotId: input.snapshotId,
                    capturedAt: input.createdAt,
                    metadata: input.metadata
                }
            );
            return {
                snapshot: {
                    ...snapshot,
                    createdAt: snapshot.capturedAt,
                    accountScreenName: input.accountScreenName || ""
                }
            };
        }
        case "getLatestFollowerSnapshot": {
            const snapshot = await FollowerStorage.getLatestSnapshot(message.accountUserId);
            if (!snapshot) return { snapshot: null };
            const accounts = await FollowerStorage.listAccounts();
            const account = accounts.find(item => item.accountUserId === snapshot.accountUserId);
            return {
                snapshot: {
                    ...snapshot,
                    createdAt: snapshot.capturedAt,
                    accountScreenName: account?.screenName || ""
                }
            };
        }
        case "listFollowerAccounts":
            return { accounts: await FollowerStorage.listAccounts() };
        case "listFollowerSnapshots":
            return { snapshots: await FollowerStorage.listSnapshots(message.accountUserId) };
        case "getSnapshotFollowers":
            return {
                followers: await FollowerStorage.getFollowers(
                    message.accountUserId,
                    message.snapshotId
                )
            };
        case "getFollowerHistory":
            return {
                rows: await FollowerStorage.getUserHistoryRows(
                    message.accountUserId,
                    message.userId
                )
            };
        case "deleteFollowerSnapshot":
            await FollowerStorage.deleteSnapshot(message.accountUserId, message.snapshotId);
            return { ok: true };
        default:
            return null;
    }
}

async function openFollowerProfile(message) {
    const xTab = await findXTab();
    if (!xTab) {
        return {
            ok: false,
            message: "X에 로그인한 탭을 연 뒤 다시 시도해주세요."
        };
    }

    const storedScreenName = String(
        message.user?.screenName ||
        message.user?.screen_name ||
        message.user?.username ||
        message.user?.legacy?.screen_name ||
        message.user?.core?.screen_name ||
        ""
    ).replace(/^@/, "");
    if (/^[A-Za-z0-9_]{1,15}$/.test(storedScreenName)) {
        await chrome.tabs.create({ url: `https://x.com/${encodeURIComponent(storedScreenName)}` });
        return { ok: true };
    }

    let result;
    try {
        result = await chrome.tabs.sendMessage(xTab.id, {
            type: "resolveFollowerProfile",
            userId: String(message.user?.userId || "")
        });
    } catch (_) {
        return { ok: false, message: "최신 계정 정보를 조회할 수 없습니다." };
    }
    if (result?.unavailable) {
        return { ok: false, unavailable: true, message: "현재 접근할 수 없는 계정입니다." };
    }
    const screenName = String(result?.screenName || "").replace(/^@/, "");
    if (!screenName) return { ok: false, message: "최신 계정 정보를 조회할 수 없습니다." };
    await chrome.tabs.create({ url: `https://x.com/${encodeURIComponent(screenName)}` });
    return { ok: true };
}

async function resolveFollowerIdentity(message) {
    const xTab = await findXTab();
    if (!xTab) return { unavailable: true };
    try {
        return await chrome.tabs.sendMessage(xTab.id, {
            type: "resolveFollowerProfile",
            userId: String(message.userId || "")
        });
    } catch (_) {
        return { unavailable: true };
    }
}

async function getCurrentFollowerAccount() {
    const xTabs = await findXTabs();
    if (!xTabs.length) return { account: null, reason: "NO_X_TAB" };

    let lastReason = "ACCOUNT_NOT_AVAILABLE";
    for (const xTab of xTabs) {
        try {
            const account = await chrome.tabs.sendMessage(xTab.id, {
                type: "getCurrentXAccount"
            });
            if (account?.accountUserId) return { account };
            lastReason = "ACCOUNT_NOT_AVAILABLE";
        } catch (error) {
            lastReason = /Receiving end does not exist/i.test(error?.message || "")
                ? "MESSAGE_RECEIVER_MISSING"
                : "MESSAGE_FAILED";
        }
    }
    return { account: null, reason: lastReason };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "fetchXResource") {
        let url;
        try {
            url = new URL(message.url);
        } catch (_) {
            sendResponse({ error: "리소스 URL이 올바르지 않습니다." });
            return;
        }
        if (url.protocol !== "https:" || url.hostname !== "abs.twimg.com") {
            sendResponse({ error: "허용되지 않은 X 리소스입니다." });
            return;
        }
        fetch(url.href, { cache: "no-cache" })
            .then(async response => ({
                ok: response.ok,
                status: response.status,
                text: response.ok ? await response.text() : ""
            }))
            .then(sendResponse)
            .catch(error => sendResponse({ error: error.message || "X 리소스를 가져오지 못했습니다." }));
        return true;
    }

    if (message.type === "getHeaders") {
        const tabSession = sessionForTab(sender.tab?.id);
        const headers = {
            ...savedHeaders,
            ...(tabSession?.headers || {})
        };
        Object.keys(headers).forEach(key => {
            if (!headers[key]) headers[key] = savedHeaders[key] || null;
        });
        sendResponse({ 
            headers,
            operations: tabSession ? tabSession.operations : savedOperations
        });
        return;
    }

    if (message.type === "getObservedOperation") {
        const tabSession = sessionForTab(sender.tab?.id);
        sendResponse({
            operation: tabSession?.operations?.[message.operationName] ||
                savedOperations[message.operationName] ||
                null
        });
        return;
    }

    if (message.type === "openFollowerProfile") {
        openFollowerProfile(message)
            .then(sendResponse)
            .catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }

    if (message.type === "resolveFollowerIdentity") {
        resolveFollowerIdentity(message)
            .then(sendResponse)
            .catch(error => sendResponse({ unavailable: true, message: error.message }));
        return true;
    }

    if (message.type === "getCurrentFollowerAccount") {
        getCurrentFollowerAccount()
            .then(sendResponse)
            .catch(error => sendResponse({
                account: null,
                reason: "BACKGROUND_ERROR",
                error: error?.message || String(error)
            }));
        return true;
    }

    if ([
        "saveFollowerSnapshot",
        "getLatestFollowerSnapshot",
        "listFollowerAccounts",
        "listFollowerSnapshots",
        "getSnapshotFollowers",
        "getFollowerHistory",
        "deleteFollowerSnapshot"
    ].includes(message.type)) {
        handleStorageMessage(message)
            .then(result => sendResponse(result || { ok: false }))
            .catch(error => sendResponse({ error: error.message || "저장 공간 오류가 발생했습니다." }));
        return true;
    }
});