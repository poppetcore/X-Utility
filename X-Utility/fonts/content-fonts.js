(function (root) {
    "use strict";
    let loading;
    const faces = [
        [400, "4Regular"],
        [500, "5Medium"],
        [600, "6SemiBold"],
        [700, "7Bold"],
        [800, "8ExtraBold"]
    ];

    // Register the bundled bytes only when an extension overlay is opened.
    // The private family name and scoped CSS leave X's own typography alone.
    // Buffer sources also avoid depending on the site's font-src policy.
    root.ensureXUtilityFonts = function () {
        if (!loading) {
            loading = Promise.all(faces.map(async ([weight, name]) => {
                try {
                    const response = await fetch(chrome.runtime.getURL(`fonts/Freesentation-${name}.woff2`));
                    if (!response.ok) throw new Error(`Font HTTP ${response.status}`);
                    const face = new FontFace("XUtilityFreesentation", await response.arrayBuffer(), {
                        style: "normal", weight: String(weight), display: "swap"
                    });
                    await face.load();
                    document.fonts.add(face);
                } catch (error) {
                    // A font-loading failure must never interrupt an existing task.
                    console.warn("X Utility: bundled Freesentation font could not load", error);
                }
            }));
        }
        return loading;
    };
})(globalThis);
