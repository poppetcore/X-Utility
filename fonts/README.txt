Freesentation bundled web fonts

Source: https://github.com/Freesentation/freesentation
Official WOFF2 directory: https://github.com/Freesentation/freesentation/tree/main/woff2
License source: https://github.com/Freesentation/freesentation/blob/main/OFL%20license.txt
Retrieved: 2026-10-25
License: SIL Open Font License 1.1; original bytes preserved in OFL.txt.
Font binaries are unmodified. No CDN, system installation, or build step is needed.

File                              Weight  Git blob SHA-1
Freesentation-4Regular.woff2       400     cf61a81e7c68fa85a23705c11dbdcf2d9a3068c6
Freesentation-5Medium.woff2        500     88fda4239546c28185f3fab9b46e88c2f2bc784f
Freesentation-6SemiBold.woff2      600     263ff4093ee845bece30554caa068be06ebbddab
Freesentation-7Bold.woff2          700     995f0754256a9894289517d4b644d9a145a2811f
Freesentation-8ExtraBold.woff2     800     1f404ce473ab38b6c69b464eb21e7bedcf41e171
OFL.txt                                  84a5d92f9800503fa2d6d28e20824e0b7f24ba2f

fonts.css registers the static files with @font-face for extension pages.
The CSS family alias XUtilityFreesentation prevents collisions with host pages.
Existing numeric weights (including 450/550/650/750) remain unchanged;
the browser selects the closest provided static weight under CSS font matching.
These static fonts do not interpolate intermediate weights.

content-fonts.js loads bundled bytes through chrome.runtime.getURL and registers
FontFace objects when an extension overlay opens. Buffer sources avoid relying
on a host page's font-src policy. content.css targets only the three existing
extension overlay IDs and their descendants. No X page typography is targeted.
Only WOFF2 files are web accessible, and only on the existing X/Twitter hosts.
