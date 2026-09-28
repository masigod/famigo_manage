// Famigo Office 화면 입히기 — 앞단(front/server.mjs)이 엔진(DeskRPG) 화면에 붙인다.
// 규칙: 제품 이름·소개 문구만 바꾼다. 라이선스·저작권 표시(Dante Labs · License · © · Copyright)가 든 곳은
// 건드리지 않는다(Sustainable Use License). 수정했다는 고지는 로그인 화면에 눈에 띄게 단다.
(() => {
  "use strict";
  const BRAND = "Famigo Office";
  const REPLACE = [
    [/DeskRPG for Hermes/g, BRAND],
    [/DeskRPG/g, BRAND],
    [/The Office Where AI Coworkers Work/g, "아울러스 업무 사무실"],
    [/AI 직원이 일하는 오피스/g, "아울러스 업무 사무실"],
    [/AI Coworking Space/g, "아울러스 업무 사무실"],
    [/Hermes AI 동료와 함께 일하는, 나만의 3D 오피스/g, "Lark 의 실제 업무가 살아 움직이는 아울러스 3D 사무실"],
    [/AI 동료가 기다리는 우리의 작은 오피스/g, "아울러스 팀의 일이 보이는 사무실"],
    [/HERMES × YOUR LITTLE WORLD/gi, "FAMIGO × LARK"],
  ];
  const PROTECTED = /dante\s*-?\s*labs|licen[cs]e|라이선스|copyright|©|sustainable use/i;
  const HIDE_TEXT = /github\s*star/i;
  const HIDE_HREF = /github\.com\/dandacompany|feedback\.deskrpg\.com|buymeacoffee\.com/i;

  const rewrite = (s) => REPLACE.reduce((t, [re, to]) => t.replace(re, to), s);
  const isProtected = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const block = el && el.closest("footer, [role=contentinfo], a[href*='dante-labs'], small, p, div");
    return PROTECTED.test(node.textContent || "") || (block && PROTECTED.test(block.textContent || "") && (block.textContent || "").length < 400);
  };

  function fixText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue || !/DeskRPG|Coworking|Hermes AI|AI 동료|AI 직원|LITTLE WORLD|AI Coworkers/i.test(n.nodeValue) || isProtected(n)) continue;
      const next = rewrite(n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    }
  }

  function fixAttributes(root) {
    const scope = root.nodeType === 1 ? [root, ...root.querySelectorAll("[alt],[title],[aria-label],[placeholder]")] : [];
    for (const el of scope) {
      for (const a of ["alt", "title", "aria-label", "placeholder"]) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && /DeskRPG/.test(v) && !PROTECTED.test(v)) el.setAttribute(a, rewrite(v));
      }
    }
  }

  function hideExternal(root) {
    if (root.nodeType !== 1) return;
    for (const el of [root, ...root.querySelectorAll("a,button")]) {
      if (!el.matches || !el.matches("a,button")) continue;
      const href = el.getAttribute("href") || "";
      if ((HIDE_TEXT.test(el.textContent || "") || HIDE_HREF.test(href)) && !PROTECTED.test(el.textContent || "")) {
        el.setAttribute("data-famigo-hidden", "");
      }
    }
  }

  function notice() {
    if (!/^\/auth/.test(location.pathname) || document.getElementById("famigo-notice")) return;
    const box = document.createElement("div");
    box.id = "famigo-notice";
    box.setAttribute("role", "note");
    const strong = document.createElement("strong");
    strong.textContent = BRAND;
    const link = document.createElement("a");
    link.href = "/__famigo/license";
    link.textContent = "Sustainable Use License";
    box.append(strong, " 는 Dante Labs 의 DeskRPG 를 수정해 아울러스 내부 업무용으로 사용합니다 · ", link,
      " · 원본의 저작권·라이선스 표시는 그대로 둡니다 · 모든 데이터는 이 사무실 서버 안에만 있습니다");
    document.body.append(box);
  }

  const apply = (root) => {
    fixText(root);
    fixAttributes(root);
    hideExternal(root);
  };
  const title = () => {
    const next = rewrite(document.title);
    if (next !== document.title) document.title = next;
  };

  function start() {
    apply(document.body);
    title();
    notice();
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData" && r.target.parentNode) apply(r.target.parentNode);
        for (const n of r.addedNodes || []) apply(n.nodeType === 3 ? n.parentNode || n : n);
      }
      title();
      notice();
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
