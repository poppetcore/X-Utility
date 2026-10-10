(() => {
    "use strict";

    const PAGE_SIZE = 200;
    const state = {
        accounts: [],
        snapshots: [],
        comparison: { added: [], removed: [], retained: [] },
        activeTab: "added",
        visibleCount: PAGE_SIZE,
        selectedKey: null
    };

    const ui = {};

    document.addEventListener("DOMContentLoaded", () => {
        Object.assign(ui, {
            account: document.getElementById("account-select"),
            previous: document.getElementById("previous-select"),
            current: document.getElementById("current-select"),
            compare: document.getElementById("compare-button"),
            refresh: document.getElementById("refresh-button"),
            help: document.getElementById("selection-help"),
            notice: document.getElementById("notice"),
            results: document.getElementById("results"),
            range: document.getElementById("range-label"),
            followerList: document.getElementById("follower-list"),
            emptyList: document.getElementById("empty-list"),
            loadMore: document.getElementById("load-more-button"),
            visibleLabel: document.getElementById("visible-label"),
            historyEmpty: document.getElementById("history-empty"),
            historyContent: document.getElementById("history-content"),
            historyPerson: document.getElementById("history-person"),
            historyList: document.getElementById("history-list"),
            historySubtitle: document.getElementById("history-subtitle")
        });

        ui.account.addEventListener("change", loadSnapshots);
        ui.previous.addEventListener("change", updateCompareAvailability);
        ui.current.addEventListener("change", updateCompareAvailability);
        ui.compare.addEventListener("click", compareSelected);
        ui.refresh.addEventListener("click", loadAccounts);
        ui.loadMore.addEventListener("click", () => {
            state.visibleCount += PAGE_SIZE;
            renderActiveList();
        });
        document.querySelector(".tabs").addEventListener("click", onTabClick);

        loadAccounts();
    });

    function storageApi() {
        if (!globalThis.FollowerStorage) {
            throw new Error("FollowerStorage를 불러오지 못했습니다. 확장 프로그램을 다시 로드해 주세요.");
        }
        return globalThis.FollowerStorage;
    }

    function compareApi() {
        if (!globalThis.FollowerCompare) {
            throw new Error("FollowerCompare를 불러오지 못했습니다. 확장 프로그램을 다시 로드해 주세요.");
        }
        return globalThis.FollowerCompare;
    }

    async function callApi(api, method, ...args) {
        if (typeof api[method] !== "function") {
            throw new Error(`${method} API를 사용할 수 없습니다.`);
        }
        return api[method](...args);
    }

    async function currentXAccount() {
        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                    { type: "getCurrentFollowerAccount" },
                    value => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        resolve(value || {});
                    }
                );
            });
            if (response?.account?.accountUserId) {
                return response.account;
            }
            const error = new Error(response?.reason || "CURRENT_ACCOUNT_UNAVAILABLE");
            error.reason = response?.reason || "CURRENT_ACCOUNT_UNAVAILABLE";
            throw error;
        } catch (error) {
            return null;
        }
    }

    async function loadAccounts() {
        setNotice("계정 목록을 불러오는 중입니다.", "info");
        setBusy(true);
        ui.results.hidden = true;
        try {
            const rows = await callApi(storageApi(), "listAccounts");
            const storedAccounts = Array.isArray(rows) ? rows : [];
            const currentAccount = await currentXAccount();
            const currentAccountId = currentAccount?.accountUserId
                ? String(currentAccount.accountUserId)
                : "";

            if (currentAccountId) {
                state.accounts = storedAccounts.filter(account =>
                    accountKey(account) === currentAccountId);
            } else {
                state.accounts = storedAccounts;
            }
            fillSelect(
                ui.account,
                state.accounts,
                accountKey,
                accountLabel,
                "저장된 계정이 없습니다."
            );
            ui.account.disabled = state.accounts.length === 0;
            if (!state.accounts.length) {
                setNotice("저장된 팔로워 기록이 없습니다. 먼저 현재 팔로워를 기록해 주세요.", "info");
                clearSnapshotSelects();
                return;
            }
            if (!currentAccountId && state.accounts.length > 1) {
                ui.account.disabled = false;
                ui.account.value = "";
                const placeholder = document.createElement("option");
                placeholder.value = "";
                placeholder.textContent = "계정을 선택해 주세요.";
                placeholder.disabled = true;
                ui.account.insertBefore(placeholder, ui.account.firstChild);
                clearSnapshotSelects();
                setNotice("현재 X 계정을 확인하지 못했습니다. 계정을 직접 선택해 주세요.", "info");
                return;
            }
            await loadSnapshots();
            if (currentAccountId) {
                clearNotice();
            } else {
                setNotice("현재 X 계정을 확인하지 못해 저장된 계정을 표시합니다.", "info");
            }
        } catch (error) {
            setNotice("저장된 팔로워 기록을 불러오지 못했습니다.", "error");
            clearSnapshotSelects();
        } finally {
            setBusy(false);
        }
    }

    async function loadSnapshots() {
        const account = selectedAccount();
        clearSnapshotSelects();
        ui.results.hidden = true;
        resetHistory();
        if (!account) return;

        setNotice("팔로워 기록을 불러오는 중입니다.", "info");
        try {
            const rows = await callApi(storageApi(), "listSnapshots", accountKey(account));
            state.snapshots = (Array.isArray(rows) ? rows : [])
                .filter(row => {
                    const rowAccountId = row.accountUserId || row.accountId;
                    return !rowAccountId || String(rowAccountId) === accountKey(account);
                })
                .sort((a, b) => snapshotTime(b) - snapshotTime(a));

            fillSelect(ui.current, state.snapshots, snapshotKey, snapshotLabel, "저장된 팔로워 기록 없음");
            fillSelect(ui.previous, state.snapshots, snapshotKey, snapshotLabel, "저장된 팔로워 기록 없음");

            if (state.snapshots.length >= 2) {
                ui.current.value = snapshotKey(state.snapshots[0]);
                ui.previous.value = snapshotKey(state.snapshots[1]);
                ui.help.textContent = "최근 기록과 직전 기록이 선택되었습니다.";
                clearNotice();
            } else {
                setNotice("변화를 확인하려면 같은 계정의 기록이 두 개 이상 필요합니다.", "info");
                ui.help.textContent = "이 계정에는 비교할 기록이 충분하지 않습니다.";
            }
            ui.current.disabled = state.snapshots.length < 2;
            ui.previous.disabled = state.snapshots.length < 2;
            updateCompareAvailability();
        } catch (error) {
            showError("팔로워 기록을 불러오지 못했습니다.", error);
        }
    }

    function clearSnapshotSelects() {
        state.snapshots = [];
        fillSelect(ui.previous, [], snapshotKey, snapshotLabel, "저장된 팔로워 기록 없음");
        fillSelect(ui.current, [], snapshotKey, snapshotLabel, "저장된 팔로워 기록 없음");
        ui.previous.disabled = true;
        ui.current.disabled = true;
        ui.compare.disabled = true;
    }

    function updateCompareAvailability() {
        const sameSnapshot = !ui.previous.value || ui.previous.value === ui.current.value;
        ui.compare.disabled = state.snapshots.length < 2 || sameSnapshot;
        ui.help.textContent = sameSnapshot && ui.previous.value
            ? "서로 다른 두 기록을 선택해 주세요."
            : "선택한 계정 안의 기록만 비교됩니다.";
    }

    async function compareSelected() {
        const account = selectedAccount();
        const previousSnapshot = selectedSnapshot(ui.previous.value);
        const currentSnapshot = selectedSnapshot(ui.current.value);
        if (!account || !previousSnapshot || !currentSnapshot) return;
        if (ui.previous.value === ui.current.value) {
            setNotice("서로 다른 두 기록을 선택해 주세요.", "error");
            return;
        }

        ui.compare.disabled = true;
        ui.compare.textContent = "비교 중…";
        setNotice("팔로워 기록을 비교하는 중입니다.", "info");
        try {
            const accountId = accountKey(account);
            const [previousRows, currentRows] = await Promise.all([
                callApi(storageApi(), "getFollowers", accountId, snapshotKey(previousSnapshot)),
                callApi(storageApi(), "getFollowers", accountId, snapshotKey(currentSnapshot))
            ]);
            const result = await callApi(
                compareApi(),
                "compare",
                Array.isArray(previousRows) ? previousRows : [],
                Array.isArray(currentRows) ? currentRows : []
            );

            state.comparison = normalizeComparison(result);
            const previousUsers = normalizeUsers(previousRows);
            const previousById = new Map(previousUsers.map(user => [user.id, user]));
            state.comparison.removed.forEach(user => {
                const previousUser = previousById.get(user.id);
                if (previousUser) mergeUserIdentity(user, previousUser);
            });
            state.activeTab = "added";
            state.visibleCount = PAGE_SIZE;
            state.selectedKey = null;
            renderSummary(previousRows, currentRows, previousSnapshot, currentSnapshot);
            activateTab("added");
            await enrichRemovedUsers(accountId, state.comparison.removed);
            if (state.activeTab === "removed") renderActiveList();
            resetHistory();
            ui.results.hidden = false;
            clearNotice();
        } catch (error) {
            showError("팔로워 기록을 비교하지 못했습니다.", error);
        } finally {
        ui.compare.textContent = "변화 확인";
            updateCompareAvailability();
        }
    }

    function normalizeComparison(result) {
        const value = result || {};
        return {
            added: normalizeUsers(value.added || value.newFollowers || value.new || []),
            removed: normalizeUsers(value.removed || value.lostFollowers || value.lost || []),
            retained: normalizeUsers(value.retained || value.unchanged || value.common || [])
        };
    }

    function normalizeUsers(rows) {
        return (Array.isArray(rows) ? rows : []).map((row) => {
            const source = row && (row.user || row.follower) ? (row.user || row.follower) : (row || {});
            const legacy = source.legacy || {};
            const core = source.core || {};
            return {
                raw: source,
                id: String(source.userId || source.rest_id || legacy.id_str || ""),
                name: source.name || source.displayName || legacy.name || core.name || "이름 없음",
                screenName: String(
                    source.screenName || source.screen_name || source.username ||
                    legacy.screen_name || core.screen_name || ""
                ).replace(/^@/, ""),
                image: source.profileImageUrl || source.profile_image_url_https ||
                    source.avatarUrl || source.image || legacy.profile_image_url_https ||
                    source.avatar?.image_url || "",
                status: source.status || source.state || row.status || ""
            };
        });
    }

    async function enrichRemovedUsers(accountId, users) {
        await Promise.all(users.map(async user => {
            if (user.name !== "이름 없음" && user.screenName) return;

            try {
                const historyRows = await callApi(
                    storageApi(),
                    "getUserHistoryRows",
                    accountId,
                    user.id
                );
                const known = historyRows
                    .map(row => row?.follower)
                    .filter(Boolean)
                    .map(row => normalizeUsers([row])[0])
                    .filter(row => row && (row.name !== "이름 없음" || row.screenName))
                    .sort((a, b) => {
                        const score = value => (value.name !== "이름 없음" ? 2 : 0) +
                            (value.screenName ? 1 : 0);
                        return score(b) - score(a);
                    })[0];
                if (known) mergeUserIdentity(user, known);
            } catch (_) {
                // Continue with the live profile lookup below.
            }

            if (user.name !== "이름 없음" && user.screenName) return;
            try {
                const resolved = await chrome.runtime.sendMessage({
                    type: "resolveFollowerIdentity",
                    userId: user.id
                });
                if (resolved && !resolved.unavailable) mergeUserIdentity(user, resolved);
            } catch (_) {
                // The user ID remains available for profile navigation.
            }
        }));
    }

    function mergeUserIdentity(user, source) {
        const name = source.name || source.displayName || "";
        const screenName = source.screenName || source.screen_name || source.username || "";
        const image = source.image || source.profileImageUrl || source.profile_image_url_https || "";
        if (name && name !== "이름 없음") user.name = name;
        if (screenName) user.screenName = String(screenName).replace(/^@/, "");
        if (image) user.image = image;
        user.raw = Object.assign({}, user.raw, source, {
            userId: user.id,
            screenName: user.screenName,
            displayName: user.name,
            profileImageUrl: user.image
        });
    }

    function renderSummary(previousRows, currentRows, previousSnapshot, currentSnapshot) {
        setText("previous-count", arrayLength(previousRows));
        setText("current-count", arrayLength(currentRows));
        setText("added-count", state.comparison.added.length);
        setText("removed-count", state.comparison.removed.length);
        setText("tab-added-count", state.comparison.added.length);
        setText("tab-removed-count", state.comparison.removed.length);
        setText("tab-retained-count", state.comparison.retained.length);
        ui.range.textContent = `${formatDate(snapshotDate(previousSnapshot))} → ${formatDate(snapshotDate(currentSnapshot))}`;
    }

    function onTabClick(event) {
        const button = event.target.closest("[data-tab]");
        if (button) activateTab(button.dataset.tab);
    }

    function activateTab(tabName) {
        state.activeTab = tabName;
        state.visibleCount = PAGE_SIZE;
        document.querySelectorAll("[data-tab]").forEach((button) => {
            const active = button.dataset.tab === tabName;
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", String(active));
        });
        ui.followerList.setAttribute("aria-labelledby", `tab-${tabName}`);
        renderActiveList();
    }

    function renderActiveList() {
        const rows = state.comparison[state.activeTab] || [];
        const shown = rows.slice(0, state.visibleCount);
        const fragment = document.createDocumentFragment();
        shown.forEach(user => fragment.appendChild(createFollowerRow(user)));
        ui.followerList.replaceChildren(fragment);
        ui.emptyList.hidden = rows.length !== 0;
        ui.loadMore.hidden = shown.length >= rows.length;
        ui.loadMore.textContent = `더 보기 (${Math.min(PAGE_SIZE, rows.length - shown.length).toLocaleString()}명)`;
        if (ui.visibleLabel) {
            ui.visibleLabel.textContent = rows.length
                ? `${shown.length.toLocaleString()} / ${rows.length.toLocaleString()}명 표시`
                : "0명";
        }
    }

    function createFollowerRow(user) {
        const row = document.createElement("div");
        row.className = "follower-row";
        row.tabIndex = 0;
        row.dataset.key = userKey(user);
        if (state.selectedKey === row.dataset.key) row.classList.add("selected");

        row.append(
            createAvatar(user),
            createIdentity(user),
            createStatus(user)
        );
        row.addEventListener("click", () => selectUser(user, row));
        row.addEventListener("dblclick", () => openProfile(user));
        row.addEventListener("keydown", event => {
            if (event.key === "Enter") selectUser(user, row);
        });
        return row;
    }

    function createAvatar(user, className = "avatar") {
        if (!user.image) {
            const fallback = document.createElement("div");
            fallback.className = `${className} avatar-fallback`;
            fallback.textContent = (user.name || "?").slice(0, 1).toUpperCase();
            return fallback;
        }
        const image = document.createElement("img");
        image.className = className;
        image.src = user.image;
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => {
            image.replaceWith(createAvatar({ ...user, image: "" }, className));
        }, { once: true });
        return image;
    }

    function createIdentity(user) {
        const wrapper = document.createElement("div");
        wrapper.className = "identity";
        const name = document.createElement("div");
        name.className = "display-name";
        name.textContent = user.name;
        const screenName = document.createElement("div");
        screenName.className = "screen-name";
        screenName.textContent = user.screenName ? `@${user.screenName}` : "사용자명 없음";
        wrapper.append(name, screenName);
        return wrapper;
    }

    function createStatus(user) {
        const status = statusInfo(user.status, state.activeTab);
        const badge = document.createElement("span");
        badge.className = `status ${status.className}`;
        badge.textContent = status.label;
        return badge;
    }

    async function selectUser(user, selectedRow) {
        state.selectedKey = userKey(user);
        document.querySelectorAll(".follower-row").forEach(row => {
            row.classList.toggle("selected", row === selectedRow);
        });
        ui.historyEmpty.hidden = true;
        ui.historyContent.hidden = false;
        ui.historySubtitle.textContent = "개인 기록을 불러오는 중…";
        renderHistoryPerson(user);
        ui.historyList.replaceChildren();

        try {
            const rows = await callApi(
                storageApi(),
                "getUserHistoryRows",
                accountKey(selectedAccount()),
                user.id
            );
            let history = Array.isArray(rows) ? rows : [];
            if (typeof compareApi().buildHistory === "function") {
                history = await compareApi().buildHistory(history);
            }
            if (state.selectedKey !== userKey(user)) return;
            renderHistory(Array.isArray(history) ? history : []);
        } catch (error) {
            if (state.selectedKey !== userKey(user)) return;
            ui.historySubtitle.textContent = "개인 기록 조회 실패";
            appendHistoryItem({
                status: "failed",
                description: errorMessage(error),
                timestamp: ""
            });
        }
    }

    function renderHistoryPerson(user) {
        ui.historyPerson.replaceChildren(createAvatar(user), createIdentity(user));
    }

    function renderHistory(rows) {
        ui.historyList.replaceChildren();
        ui.historySubtitle.textContent = rows.length
            ? `${rows.length.toLocaleString()}개 기록`
            : "저장된 개인 기록이 없습니다.";
        if (!rows.length) {
            appendHistoryItem({ status: "unknown", description: "이 사용자의 상태 기록이 없습니다." });
            return;
        }
        rows.slice().sort((a, b) => historyTime(b) - historyTime(a)).forEach(appendHistoryItem);
    }

    function appendHistoryItem(row) {
        const item = document.createElement("li");
        const date = document.createElement("div");
        date.className = "history-date";
        date.textContent = row.timestamp || row.capturedAt || row.date
            ? formatDate(row.timestamp || row.capturedAt || row.date)
            : "시점 알 수 없음";
        const description = document.createElement("div");
        description.className = "history-description";
        const info = statusInfo(row.status || row.state, "");
        description.textContent = row.description || row.message || info.history;
        item.append(date, description);
        ui.historyList.appendChild(item);
    }

    async function openProfile(user) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: "openFollowerProfile",
                user: user.raw
            });
            if (!result?.ok) {
                setNotice(result?.message || "현재 접근할 수 없는 계정입니다.", "error");
            } else if (result.fallback && result.message) {
                setNotice(result.message, "info");
            }
        } catch (error) {
            showError("프로필을 열지 못했습니다.", error);
        }
    }

    function statusInfo(value, tab) {
        const key = String(value || "").toLowerCase();
        if (/delet|not.?found|존재하지|삭제/.test(key)) {
            return { label: "삭제됨", className: "deleted", history: "삭제된 계정으로 확인되었습니다." };
        }
        if (/suspend|정지|잠김/.test(key)) {
            return { label: "정지됨", className: "suspended", history: "정지된 계정으로 확인되었습니다." };
        }
        if (/fail|error|unknown|조회.?실패/.test(key)) {
            return { label: "조회 실패", className: "failed", history: "이 시점에는 계정 정보를 조회하지 못했습니다." };
        }
        if (/remove|lost|absent|사라/.test(key) || tab === "removed") {
            return { label: "사라진 팔로워", className: "removed", history: "팔로워 목록에서 사라졌습니다." };
        }
        if (/add|new|present|active|팔로/.test(key) || tab === "added") {
            return { label: tab === "added" ? "새 팔로워" : "팔로우 중", className: tab === "added" ? "added" : "", history: "팔로워 목록에 있습니다." };
        }
        if (tab === "retained") {
            return { label: "계속 팔로우 중", className: "", history: "팔로워 관계가 유지되었습니다." };
        }
        return { label: "상태 미상", className: "", history: "상태를 확인할 수 없습니다." };
    }

    function fillSelect(select, rows, valueOf, labelOf, emptyLabel) {
        const fragment = document.createDocumentFragment();
        if (!rows.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = emptyLabel;
            fragment.appendChild(option);
        } else {
            rows.forEach(row => {
                const option = document.createElement("option");
                option.value = valueOf(row);
                option.textContent = labelOf(row);
                fragment.appendChild(option);
            });
        }
        select.replaceChildren(fragment);
    }

    function selectedAccount() {
        return state.accounts.find(account => accountKey(account) === ui.account.value) || null;
    }

    function selectedSnapshot(key) {
        return state.snapshots.find(snapshot => snapshotKey(snapshot) === key) || null;
    }

    function accountKey(account) {
        return String(account?.accountUserId || account?.userId || account?.id || account?.accountId || "");
    }

    function accountLabel(account) {
        const name = account?.name || account?.displayName || "";
        const screenName = String(account?.screenName || account?.screen_name || account?.username || "").replace(/^@/, "");
        return [name, screenName ? `@${screenName}` : ""].filter(Boolean).join(" · ") || accountKey(account);
    }

    function snapshotKey(snapshot) {
        return String(snapshot?.id || snapshot?.snapshotId || snapshot?.key || snapshotDate(snapshot) || "");
    }

    function snapshotDate(snapshot) {
        return snapshot?.capturedAt || snapshot?.createdAt || snapshot?.timestamp || snapshot?.date || "";
    }

    function snapshotTime(snapshot) {
        const date = new Date(snapshotDate(snapshot)).getTime();
        return Number.isFinite(date) ? date : 0;
    }

    function snapshotLabel(snapshot) {
        const count = snapshot?.count ?? snapshot?.followerCount ?? snapshot?.total;
        const suffix = Number.isFinite(Number(count)) ? ` · ${Number(count).toLocaleString()}명` : "";
        return `${formatDate(snapshotDate(snapshot))}${suffix}`;
    }

    function historyTime(row) {
        const value = row?.timestamp || row?.capturedAt || row?.date;
        const date = new Date(value).getTime();
        return Number.isFinite(date) ? date : 0;
    }

    function userKey(user) {
        return user.id;
    }

    function formatDate(value) {
        if (!value) return "시점 알 수 없음";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat("ko-KR", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        }).format(date);
    }

    function arrayLength(value) {
        return Array.isArray(value) ? value.length : 0;
    }

    function setBusy(busy) {
        ui.refresh.disabled = busy;
        if (busy) ui.compare.disabled = true;
    }

    function setText(id, value) {
        document.getElementById(id).textContent = Number(value).toLocaleString();
    }

    function setNotice(message, type) {
        ui.notice.textContent = message;
        ui.notice.classList.toggle("error", type === "error");
        ui.notice.hidden = false;
    }

    function clearNotice() {
        ui.notice.hidden = true;
        ui.notice.textContent = "";
        ui.notice.classList.remove("error");
    }

    function showError(prefix, error) {
        setNotice(`${prefix} ${errorMessage(error)}`, "error");
    }

    function errorMessage(error) {
        const message = error instanceof Error ? error.message : String(error || "");
        if (/RATE_LIMIT|429|요청 제한/.test(message)) {
            return "X에서 요청이 많아 잠시 이용이 제한되었습니다. 잠시 후 다시 시도해 주세요.";
        }
        if (/LOGIN_REQUIRED|로그인/.test(message)) {
            return "X에 로그인한 뒤 다시 시도해 주세요.";
        }
        if (/API_CHANGED|GraphQL|operation|IndexedDB|store|failed|snapshot/i.test(message)) {
            return "팔로워 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
        }
        return "알 수 없는 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    }

    function resetHistory() {
        state.selectedKey = null;
        ui.historyContent.hidden = true;
        ui.historyEmpty.hidden = false;
        ui.historySubtitle.textContent = "목록에서 팔로워를 선택하세요.";
        ui.historyList.replaceChildren();
        ui.historyPerson.replaceChildren();
    }
})();
