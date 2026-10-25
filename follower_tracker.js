/* Followers timeline collector. Snapshot persistence is delegated to the extension service worker. */
(function installFollowerTracker(root) {
    "use strict";

    let trackerRunning = false;

    function normalizeUser(result, capturedAt) {
        const user = result?.result || result;
        const legacy = user?.legacy || {};
        const core = user?.core || {};
        const avatar = user?.avatar || {};
        const userId = String(user?.rest_id || user?.id_str || legacy.id_str || "");
        if (!userId) return null;
        return {
            userId,
            screenName: legacy.screen_name || core.screen_name || user.screen_name || "",
            displayName: legacy.name || core.name || user.name || "",
            profileImageUrl: legacy.profile_image_url_https || avatar.image_url ||
                user.profile_image_url_https || "",
            capturedAt
        };
    }

    function usersFromEntries(entries, capturedAt) {
        const byId = new Map();
        const visited = new Set();
        function walk(value) {
            if (!value || typeof value !== "object" || visited.has(value)) return;
            visited.add(value);
            if (value.user_results?.result) {
                const user = normalizeUser(value.user_results.result, capturedAt);
                if (user) byId.set(user.userId, user);
            }
            if (value.userResult?.result) {
                const user = normalizeUser(value.userResult.result, capturedAt);
                if (user) byId.set(user.userId, user);
            }
            if (value.itemContent?.user_results?.result) {
                const user = normalizeUser(value.itemContent.user_results.result, capturedAt);
                if (user) byId.set(user.userId, user);
            }
            for (const child of Object.values(value)) walk(child);
        }
        for (const entry of entries) {
            if (!entry?.entryId?.startsWith("cursor-")) walk(entry);
        }
        return [...byId.values()];
    }

    function ownScreenName() {
        const profileLink = document.querySelector(
            'a[data-testid="AppTabBar_Profile_Link"], a[aria-label="프로필"]'
        );
        const path = profileLink?.getAttribute("href") || "";
        const candidate = path.split("/").filter(Boolean)[0] || "";
        return /^[A-Za-z0-9_]{1,15}$/.test(candidate) ? candidate : "";
    }

    function runtimeMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else if (response?.error) reject(new Error(response.error));
                else resolve(response);
            });
        });
    }

    async function collectFollowers(options = {}) {
        const api = root.XApi;
        if (!api) throw new Error("공통 X API 모듈을 불러오지 못했습니다.");
        if (trackerRunning) throw new Error("팔로워 수집이 이미 실행 중입니다.");
        trackerRunning = true;
        const signal = options.signal;
        const token = api.acquireTaskLock("x-cleaner");
        if (!token) {
            trackerRunning = false;
            throw new Error("다른 X 정리 작업이 이미 실행 중입니다.");
        }
        try {
            const accountUserId = api.getOwnUserId();
            if (!accountUserId) {
                throw new api.Error(api.ErrorTypes.LOGIN_REQUIRED, "X에 로그인한 후 다시 시도해주세요.");
            }
            const session = await api.getHeaders();
            const operation = await api.resolveOperation(["Followers"], session);
            const followers = new Map();
            const visitedCursors = new Set();
            let cursor = null;
            let pages = 0;
            const createdAt = new Date().toISOString();

            do {
                api.throwIfCancelled(signal);
                if (++pages > 500) {
                    throw new api.Error(api.ErrorTypes.API_CHANGED, "팔로워 목록을 모두 확인하지 못했습니다. 기존 기록은 유지됩니다.");
                }
                const variables = {
                    userId: accountUserId,
                    count: 50,
                    includePromotedContent: false
                };
                if (cursor) variables.cursor = cursor;
                const data = await api.graphQL({
                    method: "GET",
                    operation,
                    variables,
                    session,
                    signal
                });
                const instructions = api.timelineInstructions(data);
                if (!Array.isArray(instructions) || instructions.length === 0) {
                    throw new api.Error(
                        api.ErrorTypes.API_CHANGED,
                        "Followers timeline instructions를 찾지 못했습니다."
                    );
                }
                const entries = api.timelineEntries(instructions);
                const pageUsers = usersFromEntries(entries, createdAt);
                for (const user of pageUsers) {
                    followers.set(user.userId, user);
                }
                options.onProgress?.(followers.size);
                const terminated = instructions.some(item =>
                    item?.type === "TimelineTerminateTimeline" && item.direction === "Bottom");
                const cursorOnly = entries.length > 0 && entries.every(entry =>
                    entry?.entryId?.startsWith("cursor-") || entry?.content?.cursorType);
                if (terminated || (pageUsers.length === 0 && cursorOnly)) break;
                const nextCursor = api.timelineCursor(entries);
                if (!nextCursor) break;
                if (visitedCursors.has(nextCursor)) {
                    throw new api.Error(api.ErrorTypes.API_CHANGED, "팔로워 목록이 반복되어 수집을 중단했습니다. 기존 기록은 유지됩니다.");
                }
                visitedCursors.add(nextCursor);
                cursor = nextCursor;
                await api.sleep(650, signal);
            } while (cursor);

            const snapshot = {
                snapshotId: root.crypto?.randomUUID?.() ||
                    `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                createdAt,
                accountUserId,
                accountScreenName: ownScreenName(),
                followers: [...followers.values()]
            };
            const saved = await runtimeMessage({ type: "saveFollowerSnapshot", snapshot });
            options.onComplete?.(followers.size, saved?.snapshot);
            return saved?.snapshot || snapshot;
        } finally {
            api.releaseTaskLock(token);
            trackerRunning = false;
        }
    }

    function createOverlay() {
        root.ensureXUtilityFonts();
        document.getElementById("follower-tracker-overlay")?.remove();
        const overlay = document.createElement("div");
        overlay.id = "follower-tracker-overlay";
        overlay.style.cssText = "position:fixed;inset:0;background:#000e;color:#fff;display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:2147483647;font:16px XUtilityFreesentation,sans-serif;gap:14px";
        const title = document.createElement("strong");
        title.textContent = "팔로워를 불러오는 중";
        const status = document.createElement("div");
        status.textContent = "로그인 상태와 팔로워 정보를 확인하는 중...";
        const button = document.createElement("button");
        button.textContent = "취소";
        button.style.cssText = "padding:10px 24px;cursor:pointer";
        overlay.append(title, status, button);
        document.body.appendChild(overlay);
        return { overlay, title, status, button };
    }

    async function startFollowerCapture() {
        const ui = createOverlay();
        const controller = new AbortController();
        let collectedCount = 0;
        ui.overlay.style.fontFamily = '"XUtilityFreesentation", sans-serif';
        ui.title.style.fontSize = "20px";
        ui.title.style.fontWeight = "750";
        ui.status.style.color = "#e5e7eb";
        ui.status.style.textAlign = "center";
        ui.status.style.maxWidth = "90%";
        ui.button.style.display = "inline-flex";
        ui.button.style.alignItems = "center";
        ui.button.style.justifyContent = "center";
        ui.button.style.alignSelf = "center";
        ui.button.style.minWidth = "88px";
        ui.button.style.width = "auto";
        ui.button.style.minHeight = "36px";
        ui.button.style.padding = "0 18px";
        ui.button.style.border = "0";
        ui.button.style.borderRadius = "10px";
        ui.button.style.background = "#3FC1C9";
        ui.button.style.color = "#fff";
        ui.button.style.textAlign = "center";
        ui.button.style.font = '650 13px "XUtilityFreesentation", sans-serif';
        ui.button.style.boxShadow = "none";
        ui.button.onmouseenter = () => {
            if (!ui.button.disabled) ui.button.style.background = "#2eaab2";
        };
        ui.button.onmouseleave = () => {
            if (!ui.button.disabled) ui.button.style.background = "#3FC1C9";
        };
        ui.button.onclick = () => {
            controller.abort();
            ui.status.textContent = "취소하는 중...";
            ui.button.disabled = true;
        };
        try {
            const snapshot = await collectFollowers({
                signal: controller.signal,
                onProgress: count => {
                    collectedCount = count;
                    ui.status.textContent = `팔로워를 불러오는 중... ${count.toLocaleString()}명`;
                }
            });
            ui.title.textContent = "팔로워 기록 완료";
            ui.status.textContent = `${Number(snapshot.followerCount ?? snapshot.followers?.length ?? 0).toLocaleString()}명을 저장했습니다.`;
        } catch (error) {
            ui.title.textContent = error?.type === root.XApi?.ErrorTypes?.CANCELLED
                ? "팔로워 기록 취소됨"
                : "팔로워 기록 실패";
            ui.status.textContent = followerErrorMessage(error, collectedCount);
        }
        ui.button.disabled = false;
        ui.button.textContent = "닫기";
        ui.button.style.background = "#3FC1C9";
        ui.button.onclick = () => ui.overlay.remove();
    }

    function followerErrorMessage(error, collectedCount = 0) {
        if (error?.type === root.XApi?.ErrorTypes?.RATE_LIMIT) {
            return `X에서 요청 제한을 감지했습니다. 현재까지 ${collectedCount.toLocaleString()}명을 확인했습니다. 잠시 후 다시 실행해주세요.`;
        }
        if (error?.type === root.XApi?.ErrorTypes?.LOGIN_REQUIRED) {
            return "X에 로그인한 후 다시 시도해주세요.";
        }
        if (error?.type === root.XApi?.ErrorTypes?.CANCELLED) return "팔로워 기록을 취소했습니다.";
        return "팔로워 정보를 불러오지 못했습니다. X의 변경으로 일시적으로 사용할 수 없거나 잠시 후 다시 시도해야 할 수 있습니다.";
    }

    async function resolveFollowerProfile(userId) {
        const api = root.XApi;
        const id = String(userId || "");
        if (!api || !id) return { unavailable: true };
        try {
            const session = await api.getHeaders();
            const operation = await api.resolveOperation(["UserByRestId"], session);
            const data = await api.graphQL({
                method: "GET",
                operation,
                variables: { userId: id, withSafetyModeUserFields: true },
                session
            });
            const result = data?.data?.user?.result || data?.data?.user_result?.result;
            if (!result || /Unavailable|Tombstone|Suspended/.test(result.__typename || "")) {
                return { unavailable: true };
            }
            const screenName = result.legacy?.screen_name ||
                result.core?.screen_name || result.screen_name || "";
            const displayName = result.legacy?.name || result.core?.name || result.name || "";
            const profileImageUrl = result.legacy?.profile_image_url_https ||
                result.avatar?.image_url || result.profile_image_url_https || "";
            return screenName
                ? { screenName, displayName, profileImageUrl, userId: id }
                : { unavailable: true };
        } catch (error) {
            if (error?.details?.errors?.some(item => [50, 63, 64].includes(Number(item.code)))) {
                return { unavailable: true };
            }
            return { error: error?.message || String(error) };
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === "captureFollowers") {
            startFollowerCapture();
            sendResponse({ started: true });
            return;
        }
        if (message?.type === "resolveFollowerProfile") {
            resolveFollowerProfile(message.userId).then(sendResponse);
            return true;
        }
        if (message?.type === "getCurrentXAccount") {
            sendResponse({
                accountUserId: root.XApi?.getOwnUserId() || "",
                accountScreenName: ownScreenName()
            });
        }
    });

    root.FollowerTracker = Object.freeze({ collectFollowers, usersFromEntries, normalizeUser });
})(globalThis);
