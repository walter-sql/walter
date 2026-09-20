export function initializeDocs() {
  const sidebar = document.querySelector<HTMLElement>(".docs-sidebar")!;
  const currentPage = sidebar.querySelector<HTMLAnchorElement>(
    '[aria-current="page"]'
  )!;
  const sidebarBounds = sidebar.getBoundingClientRect();
  const currentBounds = currentPage.getBoundingClientRect();
  if (
    sidebar.clientHeight &&
    currentBounds.bottom > sidebarBounds.bottom - 16
  ) {
    sidebar.scrollTop += currentBounds.bottom - sidebarBounds.bottom + 16;
  }

  const menu = document.querySelector<HTMLDialogElement>("#docs-menu")!;
  const openMenu =
    document.querySelector<HTMLButtonElement>("#docs-menu-open")!;
  const closeMenu =
    document.querySelector<HTMLButtonElement>("#docs-menu-close")!;
  let previousOverflow = "";

  openMenu.addEventListener("click", () => {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    openMenu.setAttribute("aria-expanded", "true");
    menu.showModal();
  });
  closeMenu.addEventListener("click", () => menu.close());
  menu.addEventListener("click", event => {
    if (event.target !== menu) return;
    const bounds = menu.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      menu.close();
  });
  menu.addEventListener("close", () => {
    document.body.style.overflow = previousOverflow;
    openMenu.setAttribute("aria-expanded", "false");
    openMenu.focus({ preventScroll: true });
  });
  matchMedia("(min-width: 861px)").addEventListener("change", event => {
    if (event.matches && menu.open) menu.close();
  });

  const mobileToc =
    document.querySelector<HTMLDetailsElement>(".docs-mobile-toc");
  mobileToc?.addEventListener("click", event => {
    if ((event.target as Element).closest("a")) mobileToc.open = false;
  });
  document.addEventListener("click", event => {
    if (mobileToc?.open && !mobileToc.contains(event.target as Node))
      mobileToc.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && mobileToc?.open) {
      mobileToc.open = false;
      mobileToc.querySelector("summary")?.focus();
    }
  });

  document
    .querySelectorAll<HTMLHeadingElement>(".docs-prose :is(h2, h3, h4)[id]")
    .forEach(heading => {
      const anchor = document.createElement("a");
      anchor.className = "docs-heading-anchor";
      anchor.href = `#${heading.id}`;
      anchor.setAttribute("aria-label", `Link to ${heading.textContent}`);
      anchor.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0)" /></svg>';
      heading.append(anchor);
    });

  const tocLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>(".docs-toc a")
  ];
  const tocTargets = tocLinks.map(link =>
    document.getElementById(decodeURIComponent(link.hash.slice(1)))
  );
  let scrollPending = false;
  function updateToc() {
    const headerHeight =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--header-height"
        )
      ) || 72;
    let active = 0;
    tocTargets.forEach((target, index) => {
      if (target && target.getBoundingClientRect().top <= headerHeight + 48)
        active = index;
    });
    tocLinks.forEach((link, index) => {
      if (index === active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    scrollPending = false;
  }
  document.addEventListener(
    "scroll",
    () => {
      if (!scrollPending) {
        scrollPending = true;
        requestAnimationFrame(updateToc);
      }
    },
    { passive: true }
  );
  window.addEventListener("resize", updateToc, { passive: true });
  updateToc();
  document.fonts.ready.then(updateToc);

  document
    .querySelectorAll<HTMLTableElement>(".docs-prose table")
    .forEach(table => {
      table.tabIndex = 0;
    });

  async function copyText(text: string) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {}
    }
    const active = document.activeElement as HTMLElement | null;
    const selection = document.getSelection();
    const range = selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null;
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(field);
    field.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      field.remove();
      if (range && selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      active?.focus({ preventScroll: true });
    }
    if (!copied) throw new Error("Clipboard unavailable");
  }

  const languageNames: Record<string, string> = {
    bash: "Terminal",
    sh: "Terminal",
    shell: "Terminal",
    js: "JavaScript",
    javascript: "JavaScript",
    ts: "TypeScript",
    typescript: "TypeScript",
    sql: "SQL",
    json: "JSON",
    jsonc: "JSONC",
    tsx: "TSX",
    dockerfile: "Dockerfile",
    yaml: "YAML",
    toml: "TOML",
    text: "Plain text",
    plaintext: "Plain text"
  };
  document
    .querySelectorAll<HTMLPreElement>(".docs-prose pre")
    .forEach((pre, index) => {
      const code = pre.querySelector("code");
      if (!code) return;
      const wrapper = document.createElement("div");
      wrapper.className = "docs-code-block";
      const toolbar = document.createElement("div");
      toolbar.className = "docs-code-toolbar";
      const language = document.createElement("span");
      language.textContent =
        languageNames[pre.dataset.language ?? ""] ??
        pre.dataset.language ??
        "Code";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "docs-code-copy";
      button.setAttribute("aria-label", `Copy code block ${index + 1}`);
      button.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3"/></svg><span aria-live="polite">Copy</span>';
      const status = button.querySelector("span")!;
      let reset: ReturnType<typeof setTimeout>;
      button.addEventListener("click", async () => {
        clearTimeout(reset);
        try {
          await copyText(code.textContent ?? "");
          status.textContent = "Copied";
          button.dataset.copied = "true";
        } catch {
          status.textContent = "Select to copy";
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        reset = setTimeout(() => {
          status.textContent = "Copy";
          delete button.dataset.copied;
        }, 2200);
      });
      toolbar.append(language, button);
      pre.before(wrapper);
      wrapper.append(toolbar, pre);
    });
}
