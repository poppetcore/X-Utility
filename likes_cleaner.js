/* GraphQL Likes timeline cleanup. It never deletes a Tweet; only UnfavoriteTweet is called. */
(function installLikesCleaner(root) {
    "use strict";

    let likesRunning = false;

    function tweetIdsFromEntries(entries) {
        const ids = new Set();
        const visited = new Set();
        function addTweet(result) {
            const tweet = result?.__typename === "TweetWithVisibilityResults"
                ? result.tweet
                : result;
            const id = String(tweet?.rest_id || tweet?.legacy?.id_str || "");
            if (id) ids.add(id);
        }
        function walk(value) {
            if (!value || typeof value !== "object" || visited.has(value)) return;
            visited.add(value);
            if (value.tweet_results?.result) addTweet(value.tweet_results.result);
            if (value.tweetResult?.result) addTweet(value.tweetResult.result);
            for (const [key, child] of Object.entries(value)) {
                if (key !== "tweet_results" && key !== "tweetResult") walk(child);
            }
        }
        entries.forEach(entry => {
            if (!entry?.entryId?.startsWith("cursor-")) walk(entry);
        });
        return [...ids];
    }

    async function collectLikeIds(context) {
        const { api, session, signal, onProgress } = context;
        const operation = await api.resolveOperation(["Likes", "UserLikes"], session);
        const ids = new Set();
        const visitedCursors = new Set();
        let cursor = null;
        let unchangedPages = 0;
        do {
            api.throwIfCancelled(signal);
            const variables = {
                userId: api.getOwnUserId(),
                count: 100,
                includePromotedContent: false,
                withClientEventToken: false,
                withBirdwatchNotes: false
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
                    "Likes timeline instructions를 찾지 못했습니다."
                );
            }
            const entries = api.timelineEntries(instructions);
            const pageIds = tweetIdsFromEntries(entries);
            const previousCount = ids.size;
            for (const id of pageIds) ids.add(id);
            unchangedPages = ids.size === previousCount ? unchangedPages + 1 : 0;
            onProgress?.({ checked: ids.size, completed: 0, failed: 0, phase: "collect" });
            const terminated = instructions.some(instruction =>
                instruction?.type === "TimelineTerminateTimeline" &&
                instruction.direction === "Bottom"
            );
            // X can return a fresh bottom cursor even after the timeline is exhausted.
            if (terminated || pageIds.length === 0 || unchangedPages >= 3) break;
            const nextCursor = api.timelineCursor(entries);
            if (!nextCursor || visitedCursors.has(nextCursor)) break;
            visitedCursors.add(nextCursor);
            cursor = nextCursor;
            await api.sleep(650, signal);
        } while (cursor);
        return [...ids];
    }

    function tweetIdFromElement(element) {
        const link = element?.closest("article")?.querySelector('a[href*="/status/"]');
        const match = link?.href?.match(/\/status\/(\d+)/);
        return match ? match[1] : "";
    }

    async function runDomLikesCleanup(options, knownIds = [], initialStats = {}) {
        const api = root.XApi;
        const timeline = document.querySelector('[aria-label^="타임라인"]');
        if (!timeline) {
            throw new Error("Likes 타임라인을 찾지 못했습니다.");
        }
        const targetIds = new Set(knownIds);
        const actedIds = new Set();
        const stats = {
            checked: initialStats.checked ?? targetIds.size,
            completed: initialStats.completed || 0,
            failed: initialStats.failed || 0,
            lastError: initialStats.lastError || "",
            phase: "unlike"
        };
        let idleRounds = 0;
        let stalledRounds = 0;
        // Scan from the beginning even if cleanup was started at the bottom of the page.
        window.scrollTo(0, 0);
        await api.sleep(900, options.signal);

        while (actedIds.size < targetIds.size && stalledRounds < 3 && idleRounds < 30) {
            api.throwIfCancelled(options.signal);
            const previousCount = actedIds.size;
            const buttons = Array.from(timeline.querySelectorAll('[data-testid="unlike"]'));
            for (const button of buttons) {
                api.throwIfCancelled(options.signal);
                const tweetId = tweetIdFromElement(button);
                if (!tweetId || actedIds.has(tweetId) ||
                    !targetIds.has(tweetId)) continue;
                actedIds.add(tweetId);
                const article = button.closest("article");
                button.click();
                await api.sleep(Math.max(700, Number(options.delay) || 900), options.signal);
                if (button.isConnected && article?.querySelector('[data-testid="unlike"]')) {
                    stats.failed++;
                    if (!stats.lastError) stats.lastError = "좋아요 취소 후에도 버튼이 유지됩니다.";
                } else {
                    stats.completed++;
                }
                options.onProgress?.({ ...stats });
            }

            if (actedIds.size >= targetIds.size) break;
            const before = window.scrollY;
            window.scrollBy(0, Math.max(500, window.innerHeight * 0.8));
            await api.sleep(900, options.signal);
            const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
            if (actedIds.size === previousCount) {
                idleRounds++;
                stalledRounds = atBottom || window.scrollY === before ? stalledRounds + 1 : 0;
            } else {
                idleRounds = 0;
                stalledRounds = 0;
            }
        }
        const missing = targetIds.size - actedIds.size;
        stats.failed += missing;
        if (missing && !stats.lastError) stats.lastError = "화면에서 일부 좋아요를 찾지 못했습니다.";
        options.onProgress?.({ ...stats });
        return stats;
    }

    async function runLikesCleanup(options = {}) {
        const api = root.XApi;
        if (!api) throw new Error("공통 X API 모듈을 불러오지 못했습니다.");
        if (likesRunning) throw new Error("마음에 들어요 청소가 이미 실행 중입니다.");
        likesRunning = true;
        const token = api.acquireTaskLock("x-cleaner");
        if (!token) {
            likesRunning = false;
            throw new Error("다른 X 정리 작업이 이미 실행 중입니다.");
        }
        const stats = { checked: 0, completed: 0, failed: 0, lastError: "" };
        try {
            if (!api.getOwnUserId()) {
                throw new api.Error(api.ErrorTypes.LOGIN_REQUIRED, "X에 로그인한 후 다시 시도해주세요.");
            }
            const session = await api.getHeaders();
            const tweetIds = await collectLikeIds({
                api,
                session,
                signal: options.signal,
                onProgress: value => {
                    stats.checked = value.checked;
                    options.onProgress?.({ ...stats, phase: "collect" });
                }
            });
            stats.checked = tweetIds.length;
            if (options.dryRun) return { ...stats, tweetIds };
            if (tweetIds.length === 0) return { ...stats };

            let operation = await api.resolveOperation(["UnfavoriteTweet"], session);
            for (const [index, tweetId] of tweetIds.entries()) {
                api.throwIfCancelled(options.signal);
                try {
                    const request = () => api.graphQL({
                        method: "POST",
                        operation,
                        variables: { tweet_id: tweetId, dark_request: false },
                        session,
                        signal: options.signal
                    });
                    try {
                        await request();
                    } catch (error) {
                        if (error?.details?.status !== 422) throw error;
                        // Await the fallback so the finally block keeps the lock until it ends.
                        return await runDomLikesCleanup(options, tweetIds.slice(index), stats);
                    }
                    stats.completed++;
                } catch (error) {
                    if (error?.type === api.ErrorTypes.RATE_LIMIT ||
                        error?.type === api.ErrorTypes.LOGIN_REQUIRED ||
                        error?.type === api.ErrorTypes.CANCELLED ||
                        error?.details?.status === 422) {
                        if (!stats.lastError) {
                            const firstError = error?.details?.errors?.[0];
                            const code = firstError?.code ? ` (code ${firstError.code})` : "";
                            const status = error?.details?.status ? ` [HTTP ${error.details.status}]` : "";
                            stats.lastError = `${error?.message || String(error)}${code}${status}`;
                        }
                        error.stats = { ...stats };
                        throw error;
                    }
                    stats.failed++;
                    if (!stats.lastError) {
                        const firstError = error?.details?.errors?.[0];
                        const code = firstError?.code ? ` (code ${firstError.code})` : "";
                        const status = error?.details?.status ? ` [HTTP ${error.details.status}]` : "";
                        stats.lastError = `${error?.message || String(error)}${code}${status}`;
                    }
                }
                options.onProgress?.({ ...stats, phase: "unlike" });
                await api.sleep(Math.max(500, Number(options.delay) || 700), options.signal);
            }
            return { ...stats };
        } finally {
            api.releaseTaskLock(token);
            likesRunning = false;
        }
    }

    function createOverlay() {
        document.getElementById("likes-cleaner-overlay")?.remove();
        const overlay = document.createElement("div");
        overlay.id = "likes-cleaner-overlay";
        overlay.style.cssText = "position:fixed;inset:0;background:#000e;color:#fff;display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:2147483647;font:16px sans-serif;gap:12px";
        const title = document.createElement("strong");
        title.textContent = "마음에 들어요 청소 중";
        const phase = document.createElement("div");
        phase.textContent = "마음에 들어요 내역을 확인하는 중...";
        const checked = document.createElement("div");
        const completed = document.createElement("div");
        const failed = document.createElement("div");
        const button = document.createElement("button");
        button.textContent = "취소";
        button.style.cssText = "padding:10px 24px;cursor:pointer";
        overlay.append(title, phase, checked, completed, failed, button);
        document.body.appendChild(overlay);
        return { overlay, title, phase, checked, completed, failed, button };
    }

    function renderStats(ui, stats) {
        ui.phase.textContent = stats.phase === "collect"
            ? "마음에 들어요 내역을 확인하는 중..."
            : "좋아요를 순차적으로 취소하는 중...";
        ui.checked.textContent = `확인한 좋아요: ${stats.checked.toLocaleString()}개`;
        ui.completed.textContent = `취소한 좋아요: ${stats.completed.toLocaleString()}개`;
        ui.failed.textContent = `취소하지 못한 좋아요: ${stats.failed.toLocaleString()}개`;
    }

    async function startLikesCleanup(delay) {
        if (likesRunning) return;
        const ui = createOverlay();
        const controller = new AbortController();
        let completedSuccessfully = false;
        let lastStats = { checked: 0, completed: 0, failed: 0, phase: "collect" };
        ui.overlay.style.fontFamily = '"Pretendard", "Noto Sans KR", "맑은 고딕", Arial, sans-serif';
        ui.title.style.fontSize = "20px";
        ui.title.style.fontWeight = "750";
        ui.phase.style.color = "#e5e7eb";
        ui.phase.style.textAlign = "center";
        ui.phase.style.maxWidth = "90%";
        ui.button.style.display = "inline-flex";
        ui.button.style.alignItems = "center";
        ui.button.style.justifyContent = "center";
        ui.button.style.alignSelf = "center";
        ui.button.style.minWidth = "88px";
        ui.button.style.width = "auto";
        ui.button.style.height = "36px";
        ui.button.style.minHeight = "36px";
        ui.button.style.padding = "0 18px";
        ui.button.style.border = "0";
        ui.button.style.borderRadius = "10px";
        ui.button.style.background = "#FC5185";
        ui.button.style.color = "#fff";
        ui.button.style.font = '650 13px "Pretendard", "Noto Sans KR", "맑은 고딕", Arial, sans-serif';
        ui.button.style.textAlign = "center";
        ui.button.style.lineHeight = "1";
        ui.button.style.boxSizing = "border-box";
        ui.button.style.verticalAlign = "middle";
        ui.button.onmouseenter = () => {
            if (!ui.button.disabled) ui.button.style.background = "#d83f6e";
        };
        ui.button.onmouseleave = () => {
            if (!ui.button.disabled) ui.button.style.background = "#FC5185";
        };
        renderStats(ui, lastStats);
        ui.button.onclick = () => {
            controller.abort();
            ui.button.disabled = true;
            ui.phase.textContent = "취소하는 중...";
        };
        try {
            const result = await runLikesCleanup({
                delay,
                signal: controller.signal,
                onProgress: stats => {
                    lastStats = stats;
                    renderStats(ui, stats);
                }
            });
            lastStats = { ...result, phase: "unlike" };
            renderStats(ui, lastStats);
            ui.title.textContent = result.failed ? "마음에 들어요 청소 일부 실패" : "마음에 들어요 청소 완료";
            ui.phase.textContent = result.failed
                ? `취소하지 못한 좋아요가 ${result.failed.toLocaleString()}개 있습니다.`
                : result.checked ? "좋아요 취소가 끝났습니다." : "취소할 좋아요가 없습니다.";
            completedSuccessfully = result.failed === 0;
        } catch (error) {
            const stats = error?.stats || lastStats;
            renderStats(ui, stats);
            if (error?.type === root.XApi?.ErrorTypes?.RATE_LIMIT) {
                ui.title.textContent = "잠시 이용이 제한되었습니다";
                ui.phase.textContent =
                    `X에서 요청이 많아 잠시 제한했습니다. 현재까지 ${stats.completed.toLocaleString()}개의 좋아요를 취소했습니다. 잠시 후 다시 시도해 주세요.`;
            } else if (error?.type === root.XApi?.ErrorTypes?.CANCELLED) {
                ui.title.textContent = "마음에 들어요 청소 취소됨";
                ui.phase.textContent = "사용자가 작업을 취소했습니다.";
            } else if (error?.type === root.XApi?.ErrorTypes?.LOGIN_REQUIRED) {
                ui.title.textContent = "로그인이 필요합니다";
                ui.phase.textContent = "X에 로그인한 후 다시 시도해주세요.";
            } else {
                ui.title.textContent = "마음에 들어요 청소 실패";
                ui.phase.textContent =
                    "좋아요 내역을 불러오지 못했습니다. X의 변경으로 일시적으로 사용할 수 없거나 잠시 후 다시 시도해야 할 수 있습니다.";
            }
        }
        ui.button.disabled = false;
        ui.button.textContent = completedSuccessfully ? "완료" : "닫기";
        ui.button.style.background = "#FC5185";
        ui.button.onclick = () => ui.overlay.remove();
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "startLikesCleanup") return;
        if (likesRunning) {
            sendResponse({ started: false, error: "마음에 들어요 청소가 이미 실행 중입니다." });
            return;
        }
        startLikesCleanup(message.delay);
        sendResponse({ started: true });
    });

    root.LikesCleaner = Object.freeze({
        runLikesCleanup,
        collectLikeIds,
        tweetIdsFromEntries
    });
})(globalThis);
