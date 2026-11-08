import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import FormValueMarkdown from "../FormValueMarkdown.vue";

describe("登録値のMarkdown表示", () => {
  it("見出し・強調・リスト・リンク・コード・改行を表示する", () => {
    const w = mount(FormValueMarkdown, {
      props: {
        text: "## 見出し\n\n**太字**と*斜体*\n改行\n\n- 項目\n\n[資料](https://example.test/guide)\n\n```text\n<x>\n```",
      },
    });
    expect(w.get("h2").text()).toBe("見出し");
    expect(w.get("strong").text()).toBe("太字");
    expect(w.get("em").text()).toBe("斜体");
    expect(w.find("br").exists()).toBe(true);
    expect(w.get("li").text()).toBe("項目");
    expect(w.get("a").attributes("href")).toBe("https://example.test/guide");
    expect(w.get("pre code").element.textContent).toBe("<x>\n");
    w.unmount();
  });

  it("危険なURL・スクリプト・イベント属性を除去する", () => {
    const w = mount(FormValueMarkdown, {
      props: {
        text: '[危険](javascript:alert%281%29)\n\n<script>alert(1)</script><img src="/photo.png" onerror="alert(1)"><a href="data:text/html,bad" onclick="alert(1)">リンク</a><iframe src="https://example.test"></iframe>',
      },
    });
    expect(w.find("script").exists()).toBe(false);
    expect(w.find("iframe").exists()).toBe(false);
    expect(w.html()).not.toMatch(/javascript:|data:text\/html|onerror|onclick|alert\(1\)/);
    expect(w.get("img").attributes("src")).toBe("/photo.png");
    w.unmount();
  });

  it("通常の文字列を表示し、値の変更時に描画を更新する", async () => {
    const w = mount(FormValueMarkdown, { props: { text: "点検記録\n問題ありません。" } });
    expect(w.text()).toContain("点検記録");
    expect(w.text()).toContain("問題ありません。");
    await w.setProps({ text: "**更新済み**" });
    expect(w.get("strong").text()).toBe("更新済み");
    w.unmount();
  });

  it("JSONインポートや内部登録由来の未変換Markdownにも表示時の防御を適用する", () => {
    const imported = JSON.parse(
      JSON.stringify({
        text: '<a href="https://example.test/guide" target="named-report" rel="opener">資料</a><script>alert(1)</script><img src="/photo.png" onerror="alert(1)">',
      }),
    );
    const original = imported.text;
    const w = mount(FormValueMarkdown, { props: imported });
    expect(w.get("a").attributes("rel")).toBe("noopener noreferrer");
    expect(w.get("a").attributes("target")).toBe("named-report");
    expect(w.html()).not.toMatch(/<script|onerror|alert\(1\)/);
    expect(imported.text).toBe(original);
    w.unmount();
  });
});
