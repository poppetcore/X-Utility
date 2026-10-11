(function (root) {
    "use strict";
    root.createCleanupOverlay = function (id, titleText, color = "#364F6B", hoverColor = "#283D54") {
        document.getElementById(id)?.remove();
        const overlay = document.createElement("div");
        overlay.id = id;
        overlay.style.cssText = "box-sizing:border-box;position:fixed;inset:0;background:#000e;color:#fff;display:flex;justify-content:center;align-items:center;z-index:2147483647;padding:24px;overflow:auto;font:16px Pretendard,'Noto Sans KR','맑은 고딕',Arial,sans-serif";
        const content = document.createElement("div");
        content.style.cssText = "box-sizing:border-box;display:flex;flex-direction:column;align-items:center;text-align:center;width:100%;max-width:440px;gap:18px;margin:auto;padding:28px 0;overflow-wrap:anywhere";
        const title = document.createElement("strong");
        title.textContent = titleText;
        title.style.cssText = "display:block;margin:0;font:750 20px Pretendard,'Noto Sans KR','맑은 고딕',Arial,sans-serif;line-height:1.4";
        const stats = document.createElement("div");
        stats.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px;margin:0;line-height:1.5";
        const phase = document.createElement("div");
        phase.style.cssText = "display:none;margin:0;width:100%;color:#e5e7eb;line-height:1.6;text-align:center;white-space:pre-line";
        const button = document.createElement("button");
        button.textContent = "취소";
        button.style.cssText = "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;align-self:center;margin:0;width:auto;min-width:88px;min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#364F6B;color:#fff;cursor:pointer;font:650 13px Pretendard,'Noto Sans KR','맑은 고딕',Arial,sans-serif;line-height:1;text-align:center";
        button.style.background = color;
        button.onmouseenter = () => { if (!button.disabled) button.style.background = hoverColor; };
        button.onmouseleave = () => { button.style.background = color; };
        content.append(title, stats, phase, button);
        overlay.appendChild(content);
        document.body.appendChild(overlay);
        return { overlay, title, stats, phase, button };
    };
})(globalThis);
