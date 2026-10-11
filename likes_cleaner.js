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
                signal,
                rateLimitRetry: true,
                minIntervalMs: 650,
                onRateLimit: context.onRateLimit
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
        if (likesRunning) throw new Error("마음에 들어요 정리가 이미 실행 중입니다.");
        likesRunning = true;
        const token = api.acquireTaskLock("x-cleaner");
        if (!token) {
            likesRunning = false;
            throw new Error("다른 X 정리 작업이 이미 실행 중입니다.");
        }
        const stats = { checked: 0, completed: 0, failed: 0, lastError: "" };
        try {
            api.beginCleanup(token);
            if (!api.getOwnUserId()) {
                throw new api.Error(api.ErrorTypes.LOGIN_REQUIRED, "X에 로그인한 후 다시 시도해주세요.");
            }
            const session = await api.getHeaders();
            const tweetIds = await collectLikeIds({
                api,
                session,
                signal: options.signal,
                onRateLimit: options.onRateLimit,
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
                        signal: options.signal,
                        rateLimitRetry: true,
                        minIntervalMs: Math.max(500, Number(options.delay) || 700),
                        onRateLimit: options.onRateLimit
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
        const ui = root.createCleanupOverlay("likes-cleaner-overlay", "마음에 들어요 정리 중...", "#e64b7a", "#ca3d68");
        ui.phase.style.display = "block";
        const checked = document.createElement("div");
        const completed = document.createElement("div");
        const failed = document.createElement("div");
        ui.stats.append(checked, completed, failed);
        return { ...ui, checked, completed, failed };
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
                onRateLimit: status => {
                    ui.title.textContent = status ? "X 요청 대기 중" : "마음에 들어요 정리 중...";
                    if (status) {
                        ui.phase.textContent = `X 요청 제한으로 대기 중입니다. ${status.seconds}초 후 자동으로 이어서 진행합니다.`;
                    } else {
                        renderStats(ui, lastStats);
                    }
                },
                onProgress: stats => {
                    lastStats = stats;
                    renderStats(ui, stats);
                }
            });
            lastStats = { ...result, phase: "unlike" };
            renderStats(ui, lastStats);
            ui.title.textContent = result.failed ? "마음에 들어요 정리 일부 실패" : "마음에 들어요 정리 완료";
            ui.phase.textContent = result.failed
                ? `취소하지 못한 좋아요가 ${result.failed.toLocaleString()}개 있습니다.`
                : result.checked ? "좋아요 취소가 끝났습니다." : "취소할 좋아요가 없습니다.";
            completedSuccessfully = result.failed === 0;
        } catch (error) {
            const stats = error?.stats || lastStats;
            renderStats(ui, stats);
            if (error?.type === root.XApi?.ErrorTypes?.RATE_LIMIT) {
                ui.title.textContent = "X 요청 제한으로 작업을 멈췄습니다";
                ui.phase.textContent =
                    `X에서 요청이 많아 잠시 제한했습니다. 현재까지 ${stats.completed.toLocaleString()}개의 좋아요를 취소했습니다. 잠시 후 다시 시도해 주세요.`;
            } else if (error?.type === root.XApi?.ErrorTypes?.CANCELLED) {
                ui.title.textContent = "마음에 들어요 정리 취소됨";
                ui.phase.textContent = "사용자가 작업을 취소했습니다.";
            } else if (error?.type === root.XApi?.ErrorTypes?.LOGIN_REQUIRED) {
                ui.title.textContent = "로그인이 필요합니다";
                ui.phase.textContent = "X에 로그인한 후 다시 시도해주세요.";
            } else {
                ui.title.textContent = "마음에 들어요 정리 실패";
                ui.phase.textContent =
                    "좋아요 내역을 불러오지 못했습니다. X의 변경으로 일시적으로 사용할 수 없거나 잠시 후 다시 시도해야 할 수 있습니다.";
            }
        }
        ui.button.disabled = false;
        ui.button.textContent = completedSuccessfully ? "확인" : "닫기";
        ui.button.style.background = "#e64b7a";
        ui.button.onclick = () => ui.overlay.remove();
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "startLikesCleanup") return;
        if (likesRunning) {
            sendResponse({ started: false, error: "마음에 들어요 정리가 이미 실행 중입니다." });
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
