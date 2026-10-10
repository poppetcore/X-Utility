importScripts("follower_storage.js");


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