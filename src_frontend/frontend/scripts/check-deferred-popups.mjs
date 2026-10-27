// Real Leaflet/Marked/XSS regression checks for progressive popup content.
// Use --scroll-only for the position-retention cases, or --content-only
// for the content cases. --load-all-only checks load-all/layout/lifecycle cases.
// --playwright-path may point at the bundled runtime.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)),
);
const { chromium } = await import(
  args["playwright-path"] ? pathToFileURL(resolve(args["playwright-path"])).href : "playwright"
);
const vendors = {
  "/vendor/leaflet.js": "leaflet/dist/leaflet.js",
  "/vendor/leaflet.css": "leaflet/dist/leaflet.css",
  "/vendor/marked.js": "marked/lib/marked.umd.js",
  "/vendor/xss.js": "xss/dist/xss.min.js",
};
// JSON strings inside a script element must never contain a literal </script>.
// Keep the malicious fixture as data rather than letting the HTML parser run it.
const scriptJson = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const imagePath = (index, prefix = "photo-") => `/static/images/${prefix}${index}.svg`;
const photos = (count, prefix = "photo-", separator = "\n\n") =>
  Array.from({ length: count }, (_, index) =>
    index === 0 ? `![image 0][${prefix}shared]` : `![image ${index}](${imagePath(index, prefix)})`,
  ).join(separator) + `\n\n[${prefix}shared]: ${imagePath(0, prefix)}`;
const prose = (count, prefix = "Paragraph") =>
  Array.from(
    { length: count },
    (_, i) => `${prefix} ${String(i).padStart(4, "0")} **bold ${i}** [link ${i}](#row-${i}).`,
  ).join("\n\n");
const cases = {
  prose: { markdown: prose(3000), paragraphs: 3000, strong: 3000, links: 3000 },
  dates: {
    markdown: Array.from(
      { length: 300 },
      (_, i) =>
        `### Date ${i}\n\n![image ${i * 2}](${imagePath(i * 2, "date-")})\n\n![image ${i * 2 + 1}](${imagePath(i * 2 + 1, "date-")})`,
    ).join("\n\n"),
    headings: 300,
    images: 600,
  },
  paragraph: {
    markdown: `Beginning **${Array.from({ length: 2400 }, (_, i) => `bold-${i} [link-${i}](#p-${i})`).join(" ")}** ending.`,
    paragraphs: 1,
    strong: 1,
    links: 2400,
  },
  inlineImages: { markdown: photos(401, "inline-", "  \n"), paragraphs: 1, images: 401 },
  list: {
    markdown: Array.from({ length: 3000 }, (_, i) => `${i + 1}. Item ${i} **bold ${i}**`).join(
      "\n",
    ),
    listItems: 3000,
    strong: 3000,
  },
  table: {
    markdown: `| Number | Label | Link |\n| --- | --- | --- |\n${Array.from({ length: 500 }, (_, i) => `| ${i} | **cell ${i}** | [row ${i}](#table-${i}) |`).join("\n")}`,
    rows: 501,
    cells: 1500,
    strong: 500,
    links: 500,
  },
  raw: {
    markdown: `<div class="raw-wrapper">${Array.from({ length: 3000 }, (_, i) => `<p>Raw ${i} <strong>bold ${i}</strong> <a href="#raw-${i}">link ${i}</a></p>`).join("")}</div>`,
    paragraphs: 3000,
    strong: 3000,
    links: 3000,
  },
  rawAcrossBlocks: {
    markdown: `<div class="raw-wrapper">\n\n${prose(500, "Inside raw wrapper")}\n\n</div>`,
    paragraphs: 500,
    strong: 500,
    links: 500,
  },
  code: {
    markdown: `~~~text\n${Array.from({ length: 3000 }, (_, i) => `code ${i}: <script>&value "quoted"`).join("\n")}\n~~~`,
    code: true,
  },
  notes: {
    markdown: `:::note Note title\n${prose(500, "Note paragraph")}\n\n:::warning Warning title\n${prose(500, "Warning paragraph")}\n:::\n:::`,
    paragraphs: 1000,
    strong: 1000,
    links: 1000,
  },
  details: {
    markdown: `Introduction.\n\n:::details Parent\n${prose(700, "Parent paragraph")}\n\n:::details Child\n${photos(301, "child-")}\n:::\n:::\n\nEnding.`,
  },
  manyDetails: {
    markdown: Array.from(
      { length: 300 },
      (_, i) => `:::details Section ${i}\n${prose(20, `Hidden ${i}`)}\n:::`,
    ).join("\n\n"),
  },
  security: {
    markdown: `<div class="raw-wrapper"><script>window.unsafe = true;</script><img src="${imagePath(0, "safe-")}" onerror="window.unsafe = true"><a href="javascript:window.unsafe=true">Blocked link</a></div>\n\n${prose(500, "Safe paragraph")}\n\n<script>window.unsafe = true;</script>`,
  },
  references: {
    markdown: `${Array.from({ length: 301 }, (_, i) => (i % 2 ? `[![image ${i}][shared]](#linked-${i})` : `![image ${i}][shared]`)).join("\n\n")}\n\n[shared]: ${imagePath(0, "shared-")} "Shared title"`,
    images: 301,
    links: 150,
  },
};

function fixture(name, scrollMode, outside) {
  let markdown = cases[name]?.markdown || cases.prose.markdown;
  if (scrollMode) {
    const images = photos(name === "loadAll" ? 605 : 205, "scroll-");
    markdown = outside ? images : `:::details Scroll images\n${images}\n:::`;
  }
  const popupOptions = scrollMode
    ? { maxWidth: 600, ...(scrollMode === "outer" ? { maxHeight: 440 } : {}) }
    : { maxWidth: 600 };
  const scrollStyles = scrollMode
    ? `.md-detail-contents{width:476px;min-width:0;max-width:476px;max-height:${scrollMode === "outer" ? "none" : "500px"};overflow-y:${scrollMode === "outer" ? "visible" : "auto"};padding-right:16px}img{display:block;width:240px;height:auto}.geocode-content-body p{margin:12px 0}.scroll-fixture-tail{min-height:600px}`
    : "";
  return `<!doctype html><html><head>
    <link rel="stylesheet" href="/vendor/leaflet.css">
    <style>#map{height:700px}.md-detail-contents{max-height:400px;overflow:auto}img{max-width:100%;width:32px;height:32px}${scrollStyles}</style>
    <script src="/vendor/leaflet.js"></script><script src="/vendor/marked.js"></script><script src="/vendor/xss.js"></script>
    </head><body><div id="map"></div><script type="module">
    import {bindDeferredPopupLayout,createNestedTokenizer,renderProgressiveMarkdown,releaseDeferredDetails,renderIframe,setupDetailsLazyImages} from "/src/map/common/content.ts";
    import {installMapMarkdownExtensions} from "/src/map/common/markdown-extensions.ts";
    import {installMapMarkdownRenderer} from "/src/map/common/markdown-renderer.ts";
    import {createPopupContentRuntime} from "/src/map/common/popup-content.ts";
    import {installMapContentActions} from "/src/map/common/content-actions.ts";
    import {CONTENT_ELEMENT_BUDGET,CONTENT_TEXT_BUDGET} from "/src/map/common/progressive-content.ts";
    const body=${scriptJson(markdown)};
    const counters={bodyRenders:0,deferredRenders:0,imageRenders:0};
    const safeHtml=(html)=>renderIframe(filterXSS(html,xssOptions));
    const safeRender=(text,links)=>renderProgressiveMarkdown(text,safeHtml,links);
    installMapMarkdownExtensions({marked,extractYouTubeId:()=>null,
      createNestedTokenizer:(type)=>createNestedTokenizer(type,{renderDeferredBody:(text,links)=>{
        counters.deferredRenders++;return safeRender(text,links);
      }})});
    const xssOptions=installMapMarkdownRenderer({marked,isLocalhost:()=>false,isPdf:()=>false});
    const image=marked.defaults.renderer.image.bind(marked.defaults.renderer);
    marked.defaults.renderer.image=(token)=>{counters.imageRenders++;return image(token)};
    const map=L.map("map",{fadeAnimation:false}).setView([35,139],14);
    const runtime=createPopupContentRuntime({map,
      renderMarkdown:(text,links)=>{counters.bodyRenders++;return safeRender(text,links)},
      sanitizeHtml:safeHtml,setupImages:setupDetailsLazyImages,
      loadBody:async()=>({body,free_text:"Free mode.\\n\\n"+body,managed_markdown:"Answers mode.\\n\\n"+body,sync_required:false})});
    const marker=L.marker([35,139],{icon:L.divIcon({html:"●"})}).addTo(map)
      .bindPopup(runtime.render({kind:"marker",id:"test",name:"Content",body}),${scriptJson(popupOptions)});
    installMapContentActions({previewImage:(path)=>{window.previewPath=path}});
    window.check={map,marker,counters,body,budgets:{elements:CONTENT_ELEMENT_BUDGET,text:CONTENT_TEXT_BUDGET},popupOptions:${scriptJson(popupOptions)},setup:setupDetailsLazyImages,bindLayout:bindDeferredPopupLayout,renderContent:safeRender,
      renderFull:(text)=>safeHtml(marked.parse(text)),release:releaseDeferredDetails};
    window.ready=true;
    </script></body></html>`;
}

const server = await createServer({
  root: resolve(root, "src_frontend/template-scripts"),
  configFile: false,
  publicDir: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "progressive-popup-check",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (url.pathname === "/check.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(
              fixture(
                url.searchParams.get("case"),
                url.searchParams.get("scroll") || "",
                url.searchParams.has("outside"),
              ),
            );
          } else if (vendors[url.pathname]) {
            res.setHeader(
              "Content-Type",
              url.pathname.endsWith("css") ? "text/css" : "text/javascript",
            );
            res.end(
              await readFile(
                resolve(root, "src_frontend/frontend/node_modules", vendors[url.pathname]),
              ),
            );
          } else if (url.pathname.startsWith("/static/images/")) {
            const image = /\/scroll-(\d+)\.svg$/.exec(url.pathname);
            if (image && Number(image[1]) >= 80)
              await new Promise((resolve) => setTimeout(resolve, 250));
            res.setHeader("Content-Type", "image/svg+xml");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="navy"/></svg>',
            );
          } else next();
        });
      },
    },
  ],
});

let browser;
await server.listen();
try {
  browser = await chromium.launch({ channel: args.browser || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  let imageRequests = [];
  let revealedImages = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const requested = new URL(request.url());
    if (requested.pathname.startsWith("/static/images/"))
      imageRequests.push(`${requested.pathname}${requested.search}`);
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/check.html`;
  const rootSelector = ".geocode-progressive-content[data-progressive-content]";
  const ownBody = (content) => content.locator(":scope > .geocode-content-body");
  const ownButton = (content) =>
    content.locator(
      ":scope > .geocode-content-controls .geocode-content-load-more, :scope > .geocode-content-load-more",
    );
  const ownAllButton = (content) =>
    content.locator(":scope > .geocode-content-controls .geocode-content-load-all");
  const contentRoot = (publicPopup = false) =>
    page
      .locator(
        publicPopup
          ? `.leaflet-popup .md-detail-contents > ${rootSelector}`
          : `.leaflet-popup .popup-content-body > ${rootSelector}`,
      )
      .first();
  const flush = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const rememberImages = async () => {
    for (const source of await page
      .locator(".leaflet-popup img[src]")
      .evaluateAll((images) => images.map((image) => image.getAttribute("src"))))
      revealedImages.add(source);
    assert.ok(
      imageRequests.every((source) => revealedImages.has(source)),
      "Only materialized images may be requested",
    );
  };
  const snapshot = (content) =>
    ownBody(content).evaluate((element) => ({
      elements: element.querySelectorAll("*").length,
      chars: element.textContent.length,
      images: element.querySelectorAll("img").length,
      paragraphs: element.querySelectorAll("p").length,
    }));
  const waitForImages = async (scope) => {
    const element = await scope.elementHandle();
    await page.waitForFunction(
      (element) =>
        [...element.querySelectorAll("img[src]")].every(
          (image) => image.complete && image.naturalWidth === 32,
        ),
      element,
    );
    await element.dispose();
    await flush();
  };
  const append = async (content) => {
    const budget = await page.evaluate(() => check.budgets);
    const before = await snapshot(content);
    const first = await ownBody(content).evaluate((element) => {
      window.retainedContentNode = element.firstChild;
      return !!element.firstChild;
    });
    const button = ownButton(content);
    assert.equal(await button.count(), 1);
    assert.equal(await button.textContent(), "さらに読み込む");
    const buttonElement = await button.elementHandle();
    await button.click();
    if (buttonElement) {
      try {
        await page.waitForFunction(
          (element) => !element.isConnected || element.hidden || !element.disabled,
          buttonElement,
        );
      } finally {
        await buttonElement.dispose();
      }
    }
    const after = await snapshot(content);
    assert.ok(
      after.elements - before.elements <= budget.elements + 20,
      `One append must stay within the element budget: ${JSON.stringify({ before, after })}`,
    );
    assert.ok(
      after.chars - before.chars <= budget.text + 500,
      `One append must stay within the text budget: ${JSON.stringify({ before, after })}`,
    );
    if (first)
      assert.equal(
        await ownBody(content).evaluate(
          (element) =>
            element.firstChild === window.retainedContentNode && element.firstChild.isConnected,
        ),
        true,
        "Existing content must remain connected",
      );
    await rememberImages();
    return { before, after };
  };
  const drain = async (content, limit = 220) => {
    let batches = 1;
    for (; batches <= limit; batches++) {
      const button = ownButton(content);
      if (!(await button.count()) || !(await button.isVisible())) return batches;
      await append(content);
    }
    assert.fail(`Content did not finish within ${limit} appends`);
  };
  const loadRemaining = async (content) => {
    const button = ownAllButton(content);
    assert.equal(await button.count(), 1);
    assert.equal(await button.textContent(), "続きを全て読み込む");
    const previousFirst = await ownBody(content).evaluateHandle((body) => body.firstChild);
    const buttonElement = await button.elementHandle();
    try {
      await button.focus();
      await button.click();
      await page.waitForFunction((element) => element.hidden, buttonElement);
      assert.equal(await ownButton(content).evaluate((element) => element.hidden), true);
      assert.equal(
        await ownBody(content).evaluate((body, first) => body.firstChild === first, previousFirst),
        true,
        "Loading all must retain previously rendered nodes",
      );
      const status = content.locator(
        ":scope > .geocode-content-controls .geocode-content-progress",
      );
      assert.equal(await status.textContent(), "すべて表示しました");
      assert.equal(
        await status.evaluate((element) => element.ownerDocument.activeElement === element),
        true,
        "Focus must move from the completed action to the completion status",
      );
      await rememberImages();
    } finally {
      await previousFirst.dispose();
      await buttonElement.dispose();
    }
  };
  const assertButtonLayout = async (content) => {
    const controls = content.locator(":scope > .geocode-content-controls");
    const layouts = await controls.evaluate((element) => {
      const measure = () => {
        const more = element.querySelector(".geocode-content-load-more");
        const all = element.querySelector(".geocode-content-load-all");
        const a = more.getBoundingClientRect();
        const b = all.getBoundingClientRect();
        const style = getComputedStyle(element);
        const contentWidth =
          element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return {
          adjacent: more.nextElementSibling === all,
          contentWidth,
          requiredWidth: a.width + b.width + parseFloat(style.columnGap),
          moreWidth: a.width,
          allWidth: b.width,
          horizontalGap: b.left - a.right,
          verticalGap: b.top - a.bottom,
          aligned: Math.abs(a.top - b.top) < 1,
          display: style.display,
          flexWrap: style.flexWrap,
          columnGap: style.columnGap,
          rowGap: style.rowGap,
          status: element.querySelector(".geocode-content-progress").textContent,
        };
      };
      const originalWidth = element.style.width;
      const natural = measure();
      element.style.width = "400px";
      const wide = measure();
      element.style.width = "180px";
      const narrow = measure();
      element.style.width = originalWidth;
      return { natural, wide, narrow };
    });
    console.log(JSON.stringify({ buttonLayout: layouts }));
    assert.equal(layouts.natural.adjacent, true);
    assert.equal(layouts.natural.status, "", "The redundant continuation message must be absent");
    if (layouts.natural.contentWidth >= layouts.natural.requiredWidth)
      assert.equal(
        layouts.natural.aligned,
        true,
        "Natural layout must align buttons when space permits",
      );
    assert.equal(layouts.wide.contentWidth, 400);
    assert.equal(
      layouts.wide.aligned,
      true,
      "Buttons must sit beside each other in a wide container",
    );
    assert.ok(layouts.wide.horizontalGap >= 12, "Buttons must be separated by at least 12 pixels");
    assert.equal(layouts.narrow.contentWidth, 180);
    assert.equal(layouts.narrow.aligned, false, "Buttons must wrap in a narrow container");
    assert.ok(
      layouts.narrow.verticalGap >= 12,
      "Wrapped buttons must be separated by at least 12 pixels",
    );
  };
  const assertInitialBudget = async (content) => {
    const budget = await page.evaluate(() => check.budgets);
    const initial = await snapshot(content);
    assert.ok(initial.elements > 0, "Initial content must become visible");
    assert.ok(
      initial.elements <= budget.elements + 20,
      `Initial DOM must be bounded: ${JSON.stringify(initial)}`,
    );
    assert.ok(
      initial.chars <= budget.text + 500,
      `Initial text must be bounded: ${JSON.stringify(initial)}`,
    );
    await rememberImages();
    return initial;
  };
  const assertFreshProsePrefix = async (content, oldParagraph, total, prefix = "Paragraph") => {
    const initial = await assertInitialBudget(content);
    assert.ok(initial.paragraphs < total, "Reopening must defer the rest of the source");
    const paragraphs = await ownBody(content).locator("p").allTextContents();
    assert.ok(
      paragraphs[0]?.startsWith(`${prefix} 0000`),
      "Reopening must start at the source beginning",
    );
    for (const [index, paragraph] of paragraphs.entries()) {
      const expected = `${prefix} ${String(index).padStart(4, "0")} bold ${index} link ${index}.`;
      assert.ok(
        expected.startsWith(paragraph),
        `Reopened paragraph ${index} must be in source order without duplicates`,
      );
    }
    assert.deepEqual(
      await ownBody(content).evaluate(
        (body, oldParagraph) => ({
          connected: oldParagraph.isConnected,
          reused: body.contains(oldParagraph),
        }),
        oldParagraph,
      ),
      { connected: false, reused: false },
      "Reopening must discard previously materialized nodes",
    );
    await oldParagraph.dispose();
  };
  const openFixture = async (name, { scroll = "", outside = false, publicPopup = false } = {}) => {
    if (page.url() !== "about:blank") await page.waitForLoadState("networkidle");
    imageRequests = [];
    revealedImages = new Set();
    await page.goto(
      `${url}?case=${name}${scroll ? `&scroll=${scroll}` : ""}${outside ? "&outside" : ""}`,
    );
    await page.waitForFunction(() => window.ready);
    await page.locator(".leaflet-marker-icon").click();
    await page.waitForFunction(
      () => !document.querySelector('.leaflet-popup select option[value="free"]').disabled,
    );
    if (publicPopup)
      await page.evaluate(() => {
        check.map.closePopup();
        const popup = L.popup(check.popupOptions)
          .setLatLng([35, 139])
          .setContent(`<div class="md-detail-contents">${check.renderContent(check.body)}</div>`)
          .openOn(check.map);
        check.bindLayout(popup);
        check.setup(popup.getElement());
        window.publicPopup = popup;
      });
    const content = contentRoot(publicPopup);
    await content.waitFor();
    await assertInitialBudget(content);
    return content;
  };
  const compareFull = async (content) =>
    ownBody(content).evaluate((element) => {
      const normal = document.createElement("template");
      const html = check.renderFull(check.body);
      normal.innerHTML = html;
      const normalize = (text) => text.replace(/\s+/g, " ").trim();
      const result = {
        actual: normalize(element.textContent),
        expected: normalize(normal.content.textContent),
      };
      check.release(html);
      return result;
    });

  if (!("content-only" in args) && !("load-all-only" in args)) {
    // Delayed image decoding must not reset an inner or Leaflet outer scroller.
    for (const scroll of ["inner", "outer"])
      for (const publicPopup of [false, true])
        for (const outside of [false, true])
          for (const action of ["more", "all"]) {
            const totalImages = action === "all" ? 605 : 205;
            let content = await openFixture(action === "all" ? "loadAll" : "prose", {
              scroll,
              outside,
              publicPopup,
            });
            if (!outside) {
              const details = content.locator("details").first();
              assert.equal(await details.locator("img").count(), 0);
              await details.locator(":scope > summary").click();
              content = details.locator(`:scope > ${rootSelector}`);
              await content.waitFor();
              await assertInitialBudget(content);
            }
            await page.evaluate(() => {
              const md = document.querySelector(".leaflet-popup .md-detail-contents");
              const tail = document.createElement("div");
              tail.className = "scroll-fixture-tail";
              tail.textContent = "Content after the progressively rendered body.";
              md.append(tail);
              (window.publicPopup || check.marker.getPopup()).update();
            });
            await waitForImages(content);
            let clicks = 0;
            while (await ownButton(content).isVisible()) {
              const previousImages = await ownBody(content).locator("img").count();
              const button = action === "all" ? ownAllButton(content) : ownButton(content);
              await button.evaluate((element, mode) => {
                const scroller = element.closest(
                  mode === "outer" ? ".leaflet-popup-content" : ".md-detail-contents",
                );
                scroller.scrollTop +=
                  element.getBoundingClientRect().top -
                  scroller.getBoundingClientRect().top -
                  scroller.clientHeight / 2;
                window.scrollClickSnapshot = null;
                element.addEventListener(
                  "pointerdown",
                  () => {
                    window.scrollClickSnapshot = {
                      scrollTop: scroller.scrollTop,
                      buttonTop:
                        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
                    };
                  },
                  { once: true },
                );
              }, scroll);
              let after;
              if (action === "all") {
                await loadRemaining(content);
                after = await snapshot(content);
              } else after = (await append(content)).after;
              const clicked = await page.evaluate(() => window.scrollClickSnapshot);
              assert.ok(
                clicked?.scrollTop > 1000,
                "The scroll fixture must read well beyond the top",
              );
              assert.ok(after.images > previousImages, "This fixture must append more images");
              const read = () =>
                content.evaluate(
                  (element, { mode, index }) => {
                    const scroller = element.closest(
                      mode === "outer" ? ".leaflet-popup-content" : ".md-detail-contents",
                    );
                    return {
                      scrollTop: scroller.scrollTop,
                      imageTop:
                        element.querySelectorAll("img")[index].getBoundingClientRect().top -
                        scroller.getBoundingClientRect().top,
                    };
                  },
                  { mode: scroll, index: previousImages },
                );
              const immediate = await read();
              const context = `${scroll}/${publicPopup ? "public" : "owner"}/${outside ? "outside" : "details"}/${action}`;
              assert.ok(
                Math.abs(immediate.scrollTop - clicked.scrollTop) <= 2,
                `${context}: synchronous append position ${JSON.stringify({ clicked, immediate })}`,
              );
              await waitForImages(content);
              const settled = await read();
              assert.ok(
                Math.abs(settled.scrollTop - clicked.scrollTop) <= 2,
                `${context}: delayed image-load position ${JSON.stringify({ clicked, settled })}`,
              );
              assert.ok(
                Math.abs(settled.imageTop - clicked.buttonTop) <= 48,
                `${context}: new content starts at the clicked position`,
              );
              assert.ok(++clicks < 15, "The image scroll fixture must finish");
            }
            assert.equal(await ownBody(content).locator("img").count(), totalImages);
            console.log(
              JSON.stringify({
                scroll,
                publicPopup,
                outside,
                action,
                clicks,
                scrollPreserved: true,
              }),
            );
          }
  }

  if (!("scroll-only" in args)) {
    if (!("load-all-only" in args))
      for (const name of [
        "prose",
        "dates",
        "paragraph",
        "inlineImages",
        "list",
        "table",
        "raw",
        "rawAcrossBlocks",
        "code",
        "notes",
        "references",
        "security",
      ]) {
        const content = await openFixture(name);
        const initial = await snapshot(content);
        assert.equal(
          await ownButton(content).isVisible(),
          true,
          `${name}: long content needs a continuation`,
        );
        assert.equal(
          await page.evaluate(() => check.counters.bodyRenders),
          1,
          "Opening and the body API must reuse prepared source",
        );
        const batches = await drain(content);
        const full = await compareFull(content);
        assert.equal(
          full.actual,
          full.expected,
          `${name}: final content must preserve source order and text`,
        );
        const body = ownBody(content);
        const expected = cases[name];
        for (const [field, selector] of [
          ["paragraphs", "p"],
          ["strong", "strong"],
          ["links", "a"],
          ["headings", "h3"],
          ["images", "img"],
          ["listItems", "li"],
          ["rows", "tr"],
          ["cells", "td"],
        ])
          if (expected[field] !== undefined)
            assert.equal(
              await body.locator(selector).count(),
              expected[field],
              `${name}: preserve ${field}`,
            );
        if (expected.code) assert.equal(await body.locator("pre code").count(), 1);
        if (name === "rawAcrossBlocks")
          assert.equal(
            await body.locator(".raw-wrapper p").count(),
            500,
            "Raw wrappers can span Markdown blocks",
          );
        if (name === "references") {
          assert.ok(
            (
              await body
                .locator("img")
                .evaluateAll((images) => images.map((image) => image.getAttribute("src")))
            ).every((source) => source === `${imagePath(0, "shared-")}?thumb=true`),
          );
          const first = body.locator("img").first();
          await first.click();
          assert.equal(await page.evaluate(() => window.previewPath), imagePath(0, "shared-"));
        }
        assert.equal(await body.locator("script,[onerror],a[href^='javascript:']").count(), 0);
        assert.notEqual(await page.evaluate(() => window.unsafe), true);
        await rememberImages();
        console.log(
          JSON.stringify({
            name,
            initial,
            batches,
            finalElements: (await snapshot(content)).elements,
          }),
        );
      }

    for (const publicPopup of [false, true]) {
      const content = await openFixture("prose", { publicPopup });
      await assertButtonLayout(content);
      await loadRemaining(content);
      const full = await compareFull(content);
      assert.equal(full.actual, full.expected, "Loading all must preserve full text and order");
      assert.equal(await ownBody(content).locator("p").count(), 3000);
      console.log(JSON.stringify({ publicPopup, loadAll: true, sourceOrder: true }));
    }

    // Loading the root to the end must leave closed details bodies deferred.
    let content = await openFixture("manyDetails");
    assert.ok((await ownBody(content).locator("details").count()) < 300);
    assert.equal(await ownBody(content).locator("details p").count(), 0);
    await loadRemaining(content);
    assert.equal(await ownBody(content).locator("details").count(), 300);
    assert.equal(await ownBody(content).locator("details p").count(), 0);
    assert.equal(await page.evaluate(() => check.counters.deferredRenders), 0);

    content = await openFixture("details");
    const parent = ownBody(content).locator("details").first();
    assert.equal(await parent.locator("p,img").count(), 0);
    await parent.locator(":scope > summary").click();
    const parentContent = parent.locator(`:scope > ${rootSelector}`);
    await parentContent.waitFor();
    await assertInitialBudget(parentContent);
    assert.equal(
      await parent.locator("details").count(),
      0,
      "Child sections beyond the root batch remain unmaterialized",
    );
    await loadRemaining(parentContent);
    assert.equal(await ownBody(parentContent).locator("p").count(), 700);
    const child = parent.locator("details").first();
    assert.equal(await child.locator("img").count(), 0);
    await child.locator(":scope > summary").click();
    const childContent = child.locator(`:scope > ${rootSelector}`);
    await childContent.waitFor();
    const childInitial = await assertInitialBudget(childContent);
    await append(childContent);
    const childLoaded = (await snapshot(childContent)).images;
    assert.ok(childLoaded > childInitial.images);
    await parent.locator(":scope > summary").click();
    await parent.locator(":scope > summary").click();
    assert.equal(
      (await snapshot(childContent)).images,
      childLoaded,
      "Closing and reopening a section retains materialized content",
    );
    const beforePrint = (await snapshot(childContent)).images;
    await page.emulateMedia({ media: "print" });
    assert.equal(
      await ownButton(childContent).evaluate((button) => getComputedStyle(button).display),
      "none",
    );
    assert.equal(
      await ownAllButton(childContent).evaluate((button) => getComputedStyle(button).display),
      "none",
    );
    assert.equal(
      (await snapshot(childContent)).images,
      beforePrint,
      "Print must not materialize hidden content",
    );
    await page.emulateMedia({ media: "screen" });
    if (await ownAllButton(childContent).isVisible()) await loadRemaining(childContent);
    assert.equal(await ownBody(childContent).locator("img").count(), 301);

    // Modes and popup reopen must use a fresh, bounded view of their source.
    content = await openFixture("prose");
    await append(content);
    for (const mode of ["answers", "free", "normal"]) {
      await page.locator(".leaflet-popup select").selectOption(mode);
      content = contentRoot();
      await assertInitialBudget(content);
      assert.ok((await snapshot(content)).elements < 1000);
      if (mode !== "normal")
        assert.ok(
          (await ownBody(content).textContent()).includes(
            mode === "answers" ? "Answers mode." : "Free mode.",
          ),
        );
      await append(content);
    }
    const oldParagraph = await ownBody(content).locator("p").first().elementHandle();
    await page.evaluate(() => check.map.closePopup());
    await page.locator(".leaflet-marker-icon").click();
    await page.waitForFunction(
      () => !document.querySelector('.leaflet-popup select option[value="free"]').disabled,
    );
    await assertFreshProsePrefix(contentRoot(), oldParagraph, cases.prose.paragraphs);

    for (const outside of [false, true]) {
      content = await openFixture(outside ? "prose" : "details", { publicPopup: true });
      let readRoot = content;
      if (!outside) {
        const details = ownBody(content).locator("details").first();
        assert.equal(await details.locator("p,img").count(), 0);
        await details.locator(":scope > summary").click();
        readRoot = details.locator(`:scope > ${rootSelector}`);
        await readRoot.waitFor();
      }
      await assertInitialBudget(readRoot);
      await append(readRoot);
      const oldParagraph = await ownBody(readRoot).locator("p").first().elementHandle();
      await page.evaluate(() => {
        check.map.closePopup(window.publicPopup);
        const template = document.createElement("template");
        template.innerHTML = window.publicPopup.getContent();
        window.closedPublicSnapshot = {
          connected: window.publicPopup.getElement().isConnected,
          materializedParagraphs: window.publicPopup.getElement().querySelectorAll("p").length,
          materializedImages: window.publicPopup.getElement().querySelectorAll("img").length,
          paragraphs: template.content.querySelectorAll("p").length,
          images: template.content.querySelectorAll("img").length,
        };
      });
      assert.deepEqual(await page.evaluate(() => window.closedPublicSnapshot), {
        connected: false,
        materializedParagraphs: 0,
        materializedImages: 0,
        paragraphs: 0,
        images: 0,
      });
      await page.evaluate(() => {
        window.publicPopup.openOn(check.map);
        check.bindLayout(window.publicPopup);
        check.setup(window.publicPopup.getElement());
      });
      content = contentRoot(true);
      if (!outside) {
        const details = ownBody(content).locator("details").first();
        await details.locator(":scope > summary").click();
        readRoot = details.locator(`:scope > ${rootSelector}`);
      } else readRoot = content;
      await assertFreshProsePrefix(
        readRoot,
        oldParagraph,
        outside ? cases.prose.paragraphs : 700,
        outside ? "Paragraph" : "Parent paragraph",
      );
      console.log(JSON.stringify({ publicPopup: true, outside, boundedReopen: true }));
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
