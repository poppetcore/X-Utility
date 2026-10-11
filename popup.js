function isXTab(tab) {
    try {
        const url = new URL(tab?.url || "");
        return url.protocol === "https:" && /(^|\.)(x|twitter)\.com$/.test(url.hostname);
    } catch (_) {
        return false;
    }
}

function getXPageContext(url) {
    const context = {
        isPostCleanupPage: false,
        isLikesPage: false,
        isFollowersPage: false,
        isVerifiedFollowersPage: false
    };
    if (!url) return context;

    try {
        const parsed = new URL(url);
        if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(parsed.hostname)) {
            return context;
        }
        const segments = parsed.pathname.split("/").filter(Boolean).map(segment => segment.toLowerCase());
        const reserved = new Set([
            "home", "explore", "notifications", "messages", "bookmarks",
            "lists", "settings", "search", "compose", "i"
        ]);
        const appLikesRoute = segments[0] === "i" && segments[1] === "likes";
        const historyRoute = segments.includes("history") || appLikesRoute;
        if (!segments.length || (reserved.has(segments[0]) && !historyRoute)) return context;
        if (historyRoute) {
            const historyTab = parsed.searchParams.get("tab")?.toLowerCase() || "";
            context.isLikesPage = segments.includes("likes") || historyTab === "likes";
            return context;
        }

        const profileRoute = segments.length === 1 || segments.length === 2;
        if (!profileRoute) return context;

        const route = segments[1] || "";
        context.isPostCleanupPage = segments.length === 1 || route === "with_replies";
        context.isFollowersPage = route === "followers";
        context.isVerifiedFollowersPage = route === "verified_followers";
        return context;
    } catch (_) {
        return context;
    }
}

function showConfirmation(title, message, theme = "") {
    return new Promise(resolve => {
        const backdrop = document.createElement("div");
        backdrop.className = "confirm-backdrop";
        const card = document.createElement("section");
        card.className = "confirm-card";
        const heading = document.createElement("h2");
        heading.className = "confirm-title";
        heading.textContent = title;
        const content = document.createElement("p");
        content.className = "confirm-message";
        content.textContent = message;
        const actions = document.createElement("div");
        actions.className = "confirm-actions";
        const start = document.createElement("button");
        start.className = `button-17${theme ? ` confirm-start-${theme}` : ""}`;
        start.textContent = "청소 시작";
        const cancel = document.createElement("button");
        cancel.className = "button-17 button-secondary";
        cancel.textContent = "취소";
        const finish = value => {
            backdrop.remove();
            resolve(value);
        };
        start.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        actions.append(start, cancel);
        card.append(heading, content, actions);
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
    });
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ currentWindow: true, active: true });
    return tabs[0];
}

document.addEventListener("DOMContentLoaded", async () => {
    const activeTab = await getActiveTab();
    const container = document.querySelector("[name='container']");

    if (!isXTab(activeTab)) {
        container.textContent = "X에서만 사용할 수 있습니다.";
        return;
    }

    const tooltipLayer = document.createElement("div");
    tooltipLayer.id = "tooltip-layer";
    document.body.appendChild(tooltipLayer);

    const makeSection = title => {
        const section = document.createElement("section");
        section.className = "section";
        const heading = document.createElement("h2");
        heading.className = "section-title";
        heading.textContent = title;
        section.appendChild(heading);
        container.appendChild(section);
        return section;
    };
    const makeButton = (text, secondary = false) => {
        const button = document.createElement("button");
        button.className = `button-17${secondary ? " button-secondary" : ""}`;
        button.textContent = text;
        return button;
    };
    let tooltipId = 0;
    const withDisabledTooltip = (button, message) => {
        if (!message) return button;
        const wrapper = document.createElement("span");
        wrapper.className = "action-tooltip-wrap";
        wrapper.tabIndex = 0;
        wrapper.setAttribute("aria-label", message);

        const tooltip = document.createElement("span");
        tooltip.className = "action-tooltip";
        tooltip.id = `action-tooltip-${++tooltipId}`;
        tooltip.setAttribute("role", "tooltip");
        tooltip.textContent = message;
        tooltipLayer.appendChild(tooltip);
        wrapper.setAttribute("aria-describedby", tooltip.id);

        const hideTooltip = () => {
            tooltip.classList.remove("is-visible");
            tooltip.style.visibility = "hidden";
        };
        const showTooltip = () => {
            tooltip.style.visibility = "hidden";
            tooltip.classList.add("is-visible");

            const buttonRect = button.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const margin = 8;
            const gap = 8;
            const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
            const centeredLeft = buttonRect.left + (buttonRect.width - tooltipRect.width) / 2;
            const left = Math.max(margin, Math.min(centeredLeft, maxLeft));
            const aboveTop = buttonRect.top - tooltipRect.height - gap;
            const belowTop = buttonRect.bottom + gap;
            const top = aboveTop >= margin || belowTop + tooltipRect.height > window.innerHeight - margin
                ? Math.max(margin, aboveTop)
                : belowTop;

            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${Math.min(top, window.innerHeight - tooltipRect.height - margin)}px`;
            tooltip.style.visibility = "visible";
        };

        wrapper.addEventListener("mouseenter", showTooltip);
        wrapper.addEventListener("mouseleave", hideTooltip);
        wrapper.addEventListener("focus", showTooltip);
        wrapper.addEventListener("blur", hideTooltip);
        wrapper.appendChild(button);
        return wrapper;
    };
    const sendToTab = (message, tab = activeTab) => new Promise((resolve, reject) => {
        if (!tab?.id) {
            reject(new Error("X 탭을 찾을 수 없습니다."));
            return;
        }
        chrome.tabs.sendMessage(tab.id, message, response => {
            const error = chrome.runtime.lastError;
            if (error) reject(error);
            else resolve(response);
        });
    });
    const getCurrentPageContext = async () => {
        const tab = await getActiveTab();
        const context = getXPageContext(tab?.url);
        if (!isXTab(tab)) return context;
        try {
            const observed = await sendToTab({ type: "getXPageContext" }, tab);
            if (observed?.hasHistoryEvidence &&
                typeof observed.isHistoryLikesPage === "boolean") {
                context.isLikesPage = observed.isHistoryLikesPage;
            }
        } catch (_) {
            // URL-based context remains the safe fallback when the content script is unavailable.
        }
        return context;
    };
    const status = document.createElement("p");
    status.id = "popupStatus";
    status.hidden = true;
    const showStatus = text => {
        status.textContent = text;
        status.hidden = false;
    };

    const posts = makeSection("게시글 청소하기");
    const pageContext = await getCurrentPageContext();
    const pinnedLabel = document.createElement("label");
    pinnedLabel.style.cssText = "display:flex;align-items:center;gap:8px";
    const pinnedInput = document.createElement("input");
    pinnedInput.type = "checkbox";
    pinnedInput.id = "keepPinned";
    pinnedInput.checked = true;
    pinnedLabel.append(pinnedInput, "고정된 트윗 남기기");
    posts.appendChild(pinnedLabel);
    const postButton = makeButton("게시글 청소하기");
    postButton.disabled = !pageContext.isPostCleanupPage;
    postButton.onclick = async () => {
        const currentContext = await getCurrentPageContext();
        if (!currentContext.isPostCleanupPage) {
            showStatus("프로필의 게시글 또는 답글 페이지에서 사용할 수 있습니다.");
            return;
        }
        if (!pinnedInput.checked) {
            const includePinned = await showConfirmation(
                "고정 게시글 포함",
                "고정된 게시글도 삭제 대상에 포함됩니다.\n계속하시겠습니까?",
                "post"
            );
            if (!includePinned) return;
        }
        const confirmed = await showConfirmation(
            "게시글 청소",
            "본인 게시글과 답글을 삭제합니다.\n삭제 후 복구할 수 없습니다.",
            "post"
        );
        if (!confirmed) return;
        postButton.disabled = true;
        try {
            const response = await sendToTab({
                deleteMytweet: true,
                keepPinned: pinnedInput.checked,
                delay: 2000
            });
            if (!response?.started) throw new Error("content script가 시작 요청을 확인하지 못했습니다.");
            window.close();
        } catch (error) {
            postButton.disabled = false;
            showStatus("게시글 정리를 시작할 수 없습니다. X 탭을 새로고침한 후 다시 시도해 주세요.");
        }
    };
    posts.appendChild(withDisabledTooltip(
        postButton,
        pageContext.isPostCleanupPage
            ? ""
            : "프로필의 게시글 또는 답글 페이지에서 사용할 수 있습니다."
    ));

    const likes = makeSection("마음에 들어요");
    const likesButton = makeButton("마음에 들어요 청소하기");
    likesButton.disabled = !pageContext.isLikesPage;
    likesButton.onclick = async () => {
        const currentContext = await getCurrentPageContext();
        if (!currentContext.isLikesPage) {
            showStatus("역사에서 마음에 들어요를 선택한 후 사용할 수 있습니다.");
            return;
        }
        const confirmed = await showConfirmation(
            "마음에 들어요 청소",
            "과거에 누른 좋아요가 취소됩니다.\n이 작업은 자동으로 되돌릴 수 없습니다."
        );
        if (!confirmed) return;
        likesButton.disabled = true;
        try {
            const response = await sendToTab({ type: "startLikesCleanup", delay: 2000 });
            if (!response?.started) throw new Error("content script가 시작 요청을 확인하지 못했습니다.");
            window.close();
        } catch (error) {
            likesButton.disabled = false;
            showStatus("좋아요 정리를 시작할 수 없습니다. X 탭을 새로고침한 후 다시 시도해 주세요.");
        }
    };
    likes.appendChild(withDisabledTooltip(
        likesButton,
        pageContext.isLikesPage
            ? ""
            : "역사에서 마음에 들어요를 선택한 후 사용할 수 있습니다."
    ));

    const followers = makeSection("팔로워 추적");
    const summary = document.createElement("p");
    summary.className = "snapshot-summary";
    summary.style.whiteSpace = "pre-line";
    summary.textContent = "마지막 기록을 확인하는 중...";
    followers.appendChild(summary);
    const row = document.createElement("div");
    row.className = "button-row";
    const captureButton = makeButton("현재 팔로워 기록");
    captureButton.disabled = !pageContext.isFollowersPage;
    const captureTooltip = pageContext.isVerifiedFollowersPage
        ? "인증된 팔로워가 아닌 전체 팔로워 페이지에서 기록해 주세요."
        : pageContext.isFollowersPage
            ? ""
            : "프로필의 전체 팔로워 페이지에서 기록할 수 있습니다.";
    const compareButton = makeButton("변화 확인", true);
    row.append(withDisabledTooltip(captureButton, captureTooltip), compareButton);
    followers.appendChild(row);

    captureButton.onclick = async () => {
        const currentContext = getXPageContext((await getActiveTab())?.url);
        if (!currentContext.isFollowersPage) {
            showStatus(currentContext.isVerifiedFollowersPage
                ? "인증된 팔로워가 아닌 전체 팔로워 페이지에서 기록해 주세요."
                : "프로필의 전체 팔로워 페이지에서 기록할 수 있습니다.");
            return;
        }
        captureButton.disabled = true;
        try {
            const response = await sendToTab({ type: "captureFollowers" });
            if (!response?.started) throw new Error("content script가 시작 요청을 확인하지 못했습니다.");
            window.close();
        } catch (error) {
            captureButton.disabled = false;
            showStatus("팔로워 기록을 시작할 수 없습니다. X 탭을 새로고침한 후 다시 시도해 주세요.");
        }
    };
    compareButton.onclick = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("followers.html") });
    };

    container.appendChild(status);
    try {
        const account = await sendToTab({ type: "getCurrentXAccount" });
        if (!account?.accountUserId) {
            summary.textContent = "X 로그인 정보를 확인할 수 없습니다. X 탭을 새로고침해 주세요.";
            return;
        }
        chrome.runtime.sendMessage({
            type: "getLatestFollowerSnapshot",
            accountUserId: account.accountUserId
        }, response => {
            if (chrome.runtime.lastError || !response?.snapshot) {
                summary.textContent = "이 계정에 저장된 기록이 없습니다.";
                return;
            }
            const snapshot = response.snapshot;
            const date = new Date(snapshot.createdAt).toLocaleString("ko-KR");
            const accountName = snapshot.accountScreenName
                ? `@${snapshot.accountScreenName}`
                : snapshot.accountUserId;
            summary.textContent = `${accountName} · ${date}\n팔로워 ${Number(snapshot.followerCount || 0).toLocaleString()}명`;
        });
    } catch (error) {
        summary.textContent = "X 탭과 확장 프로그램 연결을 확인할 수 없습니다.\nX 탭을 새로고침해 주세요.";
    }
});
