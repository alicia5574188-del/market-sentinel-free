(() => {
  const ERROR_TEXT = "不是单向持仓模式";
  const BUTTON_ID = "gate-position-mode-recovery";

  function findCredentialForm() {
    return document.querySelector(".credential-form");
  }

  function hasModeError() {
    return Array.from(document.querySelectorAll(".live-error"))
      .some((node) => (node.textContent || "").includes(ERROR_TEXT));
  }

  function setTemporaryMessage(message) {
    const box = Array.from(document.querySelectorAll(".live-error"))
      .find((node) => (node.textContent || "").includes(ERROR_TEXT));
    if (box) box.textContent = message;
  }

  async function switchAndContinue(button) {
    const form = findCredentialForm();
    if (!form) return;
    const passwords = form.querySelectorAll('input[type="password"]');
    const permission = form.querySelector('input[type="checkbox"]');
    const saveButton = Array.from(form.querySelectorAll("button"))
      .find((node) => (node.textContent || "").includes("验证并加密保存"));
    const apiKey = passwords[0]?.value?.trim() || "";
    const apiSecret = passwords[1]?.value?.trim() || "";

    if (!apiKey || !apiSecret || !permission?.checked) {
      window.alert("请保留 API Key、API Secret，并勾选权限确认后再切换。");
      return;
    }
    if (!window.confirm("Gate 当前是双向持仓模式。切换为单向持仓模式后，同一合约不能同时持有多空仓位。仅在当前没有合约持仓和挂单时可以切换。确认切换并继续保存 API？")) return;

    button.disabled = true;
    const original = button.textContent;
    button.textContent = "正在切换 Gate 持仓模式…";
    try {
      const response = await fetch("/api/live/position-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, apiSecret, confirmSwitch: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Gate 持仓模式切换失败");
      setTemporaryMessage("Gate 已切换为单向持仓模式，正在重新验证并保存 API…");
      window.setTimeout(() => saveButton?.click(), 250);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Gate 持仓模式切换失败");
      button.disabled = false;
      button.textContent = original;
    }
  }

  function sync() {
    const existing = document.getElementById(BUTTON_ID);
    if (!hasModeError()) {
      existing?.remove();
      return;
    }
    const form = findCredentialForm();
    if (!form || existing) return;
    const saveButton = Array.from(form.querySelectorAll("button"))
      .find((node) => (node.textContent || "").includes("验证并加密保存"));
    if (!saveButton) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "primary-live-button";
    button.textContent = "切换为单向模式并继续保存";
    button.style.marginBottom = "12px";
    button.addEventListener("click", () => void switchAndContinue(button));
    saveButton.parentNode?.insertBefore(button, saveButton);
  }

  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  document.addEventListener("DOMContentLoaded", sync, { once: true });
  sync();
})();
