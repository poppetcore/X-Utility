function getCurrentXPageContext() {
    const pathname = location.pathname.toLowerCase();
    const search = location.search.toLowerCase();
    const appLikesRoute = /^\/i\/likes(?:\/|$)/.test(pathname);
    const historyRoute = /(^|\/)history(\/|$)/.test(pathname) || appLikesRoute;
    const routeLikes = historyRoute &&
        (/(^|\/)likes(\/|$)/.test(pathname) ||
            /(?:^|[?&])tab=likes(?:&|$)/.test(search));
    const candidates = Array.from(document.querySelectorAll(
        '[role="tab"], [aria-current="page"], [aria-selected="true"], a[href]'
    ));
    const semanticText = element => [
        element.getAttribute("href"),
        element.getAttribute("data-testid"),
        element.getAttribute("aria-label"),
        element.getAttribute("aria-labelledby")
    ].filter(Boolean).join(" ").toLowerCase();
    const isLikesCandidate = element => {
        const text = semanticText(element);
        if (/(^|[/_.:-])likes?([/_.:-]|$)|liked/.test(text)) return true;
        return /마음에 들어요|좋아요/.test(element.textContent || "");
    };
    const isBookmarkCandidate = element => {
        const text = semanticText(element);
        if (/(^|[/_.:-])bookmarks?([/_.:-]|$)|bookmark/.test(text)) return true;
        return /북마크/.test(element.textContent || "");
    };
    const tabCandidates = candidates.filter(element =>
        element.getAttribute("role") === "tab" ||
        element.closest('[role="tablist"]') ||
        element.getAttribute("aria-selected") === "true" ||
        element.getAttribute("aria-current") === "page"
    );
    const selected = tabCandidates.filter(element =>
        element.getAttribute("aria-selected") === "true" ||
        element.getAttribute("aria-current") === "page"
    );
    const hasHistoryTabs = tabCandidates.some(isLikesCandidate) &&
        tabCandidates.some(isBookmarkCandidate);
    const selectedLikes = selected.some(isLikesCandidate);
    const selectedBookmarks = selected.some(isBookmarkCandidate);
    const hasHistoryEvidence = historyRoute || hasHistoryTabs || routeLikes;

    return {
        isHistoryLikesPage: !selectedBookmarks &&
            (selectedLikes || routeLikes) &&
            hasHistoryEvidence,
        hasHistoryEvidence
    };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "getXPageContext") return;
    sendResponse(getCurrentXPageContext());
});
