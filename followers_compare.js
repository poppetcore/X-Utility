globalThis.FollowerCompare = (function () {
    "use strict";

    function requireUserId(value, label) {
        const id = value == null ? "" : String(value).trim();
        if (!id) throw new TypeError(`${label || "userId"} is required`);
        return id;
    }

    function userIdOf(user) {
        if (typeof user === "string" || typeof user === "number" || typeof user === "bigint") {
            return requireUserId(user, "follower userId");
        }
        if (!user || typeof user !== "object") {
            throw new TypeError("each follower must be an object or userId");
        }
        return requireUserId(user.userId, "follower userId");
    }

    function copyUser(user, userId) {
        return user && typeof user === "object"
            ? Object.assign({}, user, { userId: userId })
            : { userId: userId };
    }

    function indexFollowers(followers, label) {
        if (!Array.isArray(followers)) {
            throw new TypeError(`${label} followers must be an array`);
        }
        const indexed = new Map();
        followers.forEach(function (user) {
            const userId = userIdOf(user);
            indexed.set(userId, copyUser(user, userId));
        });
        return indexed;
    }

    function followersFrom(value, label) {
        if (Array.isArray(value)) return value;
        if (value && Array.isArray(value.followers)) return value.followers;
        throw new TypeError(`${label} must be a follower array or a snapshot with followers`);
    }

    function compare(previous, current) {
        const previousById = indexFollowers(followersFrom(previous, "previous"), "previous");
        const currentById = indexFollowers(followersFrom(current, "current"), "current");
        const added = [];
        const removed = [];
        const retained = [];

        currentById.forEach(function (user, userId) {
            if (previousById.has(userId)) retained.push(user);
            else added.push(user);
        });
        previousById.forEach(function (user, userId) {
            if (!currentById.has(userId)) removed.push(user);
        });

        return {
            added: added,
            removed: removed,
            retained: retained
        };
    }

    function membershipFor(row, userId) {
        if (!row || typeof row !== "object") {
            throw new TypeError("each history row must be an object");
        }
        if (typeof row.isFollowing === "boolean") return row.isFollowing;
        if (typeof row.present === "boolean") return row.present;

        const followers = Array.isArray(row.followers)
            ? row.followers
            : (Array.isArray(row.userIds) ? row.userIds : null);
        if (followers) {
            return followers.some(function (user) {
                return userIdOf(user) === userId;
            });
        }

        if (row.userId != null) return String(row.userId) === userId;
        throw new TypeError(
            "history rows must provide isFollowing, present, followers, userIds, or userId"
        );
    }

    function followerFor(row, userId) {
        if (row.follower && typeof row.follower === "object") {
            return copyUser(row.follower, userId);
        }
        if (Array.isArray(row.followers)) {
            for (let i = 0; i < row.followers.length; i += 1) {
                if (userIdOf(row.followers[i]) === userId) {
                    return copyUser(row.followers[i], userId);
                }
            }
        }
        return null;
    }

    function calculateHistory(snapshotMembership, userId) {
        if (!Array.isArray(snapshotMembership)) {
            throw new TypeError("snapshotMembership must be an array");
        }
        const inferredRow = snapshotMembership.find(function (row) {
            return row && row.userId != null;
        });
        userId = requireUserId(
            userId != null ? userId : (inferredRow && inferredRow.userId),
            "userId"
        );

        const rows = snapshotMembership.map(function (row, index) {
            return { row: row, index: index };
        }).sort(function (a, b) {
            const aTime = a.row && a.row.capturedAt != null ? String(a.row.capturedAt) : "";
            const bTime = b.row && b.row.capturedAt != null ? String(b.row.capturedAt) : "";
            return aTime.localeCompare(bTime) || a.index - b.index;
        });

        const transitions = [];
        let following = false;
        let hasFollowed = false;

        rows.forEach(function (entry) {
            const row = entry.row;
            const present = membershipFor(row, userId);
            if (present === following) return;

            let type;
            if (present) {
                type = hasFollowed ? "refollow" : "follow";
                hasFollowed = true;
            } else {
                type = "unfollow";
            }

            transitions.push({
                type: type,
                userId: userId,
                snapshotId: row.snapshotId == null ? null : String(row.snapshotId),
                capturedAt: row.capturedAt == null ? null : row.capturedAt,
                from: following,
                to: present,
                follower: present ? followerFor(row, userId) : null
            });
            following = present;
        });

        return transitions;
    }

    function buildHistory(snapshotMembership, userId) {
        if (!Array.isArray(snapshotMembership)) {
            throw new TypeError("snapshotMembership must be an array");
        }
        const inferred = snapshotMembership.find(function (row) {
            return row && row.userId != null;
        });
        userId = requireUserId(userId != null ? userId : inferred && inferred.userId, "userId");
        let previouslyPresent = false;
        let followedBefore = false;
        return snapshotMembership.slice().sort(function (a, b) {
            return String(a.capturedAt || "").localeCompare(String(b.capturedAt || ""));
        }).map(function (row) {
            const present = membershipFor(row, userId);
            let status = present ? "follow" : "unfollow";
            if (present && !previouslyPresent && followedBefore) status = "refollow";
            if (present) followedBefore = true;
            previouslyPresent = present;
            return {
                snapshotId: row.snapshotId || null,
                userId: userId,
                capturedAt: row.capturedAt || null,
                timestamp: row.capturedAt || null,
                status: status,
                description: status === "refollow"
                    ? "다시 팔로워가 되었습니다."
                    : present ? "팔로워입니다." : "팔로워가 아닙니다.",
                follower: present ? followerFor(row, userId) : null
            };
        });
    }

    return Object.freeze({
        compare: compare,
        compareSnapshots: compare,
        calculateHistory: calculateHistory,
        buildHistory: buildHistory,
        history: calculateHistory,
        getTransitions: calculateHistory
    });
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = globalThis.FollowerCompare;
}
