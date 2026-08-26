function isValidCoordinate(lat, lng) {
  return (
    !isNaN(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    !isNaN(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function renderIframe(html) {
  return html.replace(
    /<app-youtube\s+[^>]*video-id=["']([\w-]{11})["'][^>]*>(?:<\/app-youtube>)?/g,
    (_, videoId) => {
      const src = `https://www.youtube-nocookie.com/embed/${videoId}`;
      return `
                <iframe
                    src="${src}"
                    title="YouTube video player"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin"
                    allowfullscreen
                    width="100%" height="315"
                    style="border:0;"
                ></iframe>
            `.trim();
    },
  );
}

function createNestedTokenizer(typeName) {
  const self = this.lexer;
  return {
    name: typeName,
    level: "block",
    start(src) {
      const re = new RegExp(`^:::${typeName}\\s`, "m");
      return src.match(re)?.index;
    },
    tokenizer(src, tokens) {
      if (!src.startsWith(`:::${typeName}`)) return null;

      const lines = src.split(/\r?\n/);
      let nestLevel = 0;
      let endIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^:::(\w+)/.test(line)) {
          nestLevel++;
        } else if (/^:::\s*$/.test(line)) {
          nestLevel--;
          if (nestLevel === 0) {
            endIndex = i;
            break;
          }
        }
      }

      if (endIndex === -1) return null;

      const rawLines = lines.slice(0, endIndex + 1);
      const raw = rawLines.join("\n");

      const titleMatch = lines[0].match(new RegExp(`^:::${typeName}\\s+(.+)`));
      const title = titleMatch ? titleMatch[1].trim() : typeName.toUpperCase();

      const content = lines.slice(1, endIndex).join("\n");

      return {
        type: typeName,
        raw,
        title,
        tokens: this.lexer.blockTokens(content),
      };
    },
    renderer(token) {
      const body = marked.parser(token.tokens);
      if (token.type === "details") {
        return `<details class="details">\n<summary>${token.title}</summary>\n${body}\n</details>\n`;
      } else {
        return `<div class="box ${token.type}">\n<summary>${token.title}</summary>\n${body}\n</div>\n`;
      }
    },
  };
}

function isLocalhost(url) {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1" ||
      parsedUrl.hostname === "[::1]"
    );
  } catch (e) {
    return false;
  }
}

function isPDF(filename) {
  return /\.pdf$/i.test(filename);
}

function setupDetailsLazyImages(root = document) {
  const detailsList = root.querySelectorAll(".details");

  detailsList.forEach((details) => {
    if (details.hasAttribute("data-lazy-img-initialized")) return;

    details.setAttribute("data-lazy-img-initialized", "true");

    // 初期化処理: src -> data-srcへ退避
    const resources = details.querySelectorAll("img[src], video[src]");
    resources.forEach((element) => {
      const src = element.getAttribute("src");
      if (src) {
        element.setAttribute("data-src", src);
        element.removeAttribute("src");
      }
    });

    // toggleイベントで開かれたとき、自分の直下（= ネストしたdetails内は含めない）だけを処理
    details.addEventListener("toggle", () => {
      if (!details.open) return;

      // 自分の中のすべてのimg/videoを取得するが、閉じたこのdetailsの中にあるものは除外
      const childDetails = details.querySelectorAll(".details");

      // 画像と動画の処理を共通化
      const loadVisibleMedia = (selector) => {
        const elements = details.querySelectorAll(selector);
        elements.forEach((el) => {
          // elが閉じた子detailsの中に含まれるならスキップ
          for (const child of childDetails) {
            if (!child.open && child.contains(el)) return;
          }
          if (!el.getAttribute("src") && el.getAttribute("data-src")) {
            el.setAttribute("src", el.getAttribute("data-src"));
          }
        });
      };

      loadVisibleMedia("img[data-src]");
      loadVisibleMedia("video[data-src]");
    });
  });
}

// 通常マップで最後に選択したタイルサーバーIDをブラウザに保存するためのキー
