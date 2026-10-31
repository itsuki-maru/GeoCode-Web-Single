import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  post: vi.fn(),
  resize: vi.fn(),
  poster: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/axiosClient", () => ({ default: { post: deps.post } }));
vi.mock("@/composables/useImageResize", () => ({
  useImageResize: () => ({ resizeImageWithCanvas: deps.resize }),
}));
vi.mock("@/composables/useVideoPoster", () => ({
  useVideoPoster: () => ({ generateVideoPoster: deps.poster }),
}));
vi.mock("@/stores/images", () => ({ useImageStore: () => ({ initList: deps.refresh }) }));
vi.mock("@/settingMobile", () => ({ baseUrl: "https://app.example.test" }));
import Modal from "../ImageUploadModal.vue";
import { imageUploadUrl } from "@/router/urls";

const mobile = true;
enableAutoUnmount(afterEach);
beforeEach(() => {
  deps.resize.mockResolvedValue(new Blob(["optimized"], { type: "image/png" }));
  deps.poster.mockResolvedValue({
    blob: new Blob(["poster"], { type: "image/jpeg" }),
    fileName: "poster.jpg",
  });
  deps.post.mockResolvedValue({ data: { uuid_filename: "saved.png" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
function render(editing = true, https = true) {
  return mount(Modal, {
    props: {
      isOpen: true,
      isEditingMapObject: editing,
      ...(!mobile ? { isHttpsProtocol: https } : {}),
    },
  });
}
async function select(wrapper: ReturnType<typeof render>, file?: File) {
  const input = wrapper.get<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input.element, "value", {
    value: file ? `fake/${file.name}` : "",
    writable: true,
    configurable: true,
  });
  Object.defineProperty(input.element, "files", { value: file ? [file] : [], configurable: true });
  await input.trigger("change");
  await flushPromises();
}
const file = (type = "image/png", name = "photo.png") => new File(["raw"], name, { type });
const button = (wrapper: ReturnType<typeof render>) =>
  wrapper.get<HTMLButtonElement>(".btn-file-upload");
async function upload(wrapper: ReturnType<typeof render>) {
  await button(wrapper).trigger("click");
  await flushPromises();
}

describe("asset upload validation, lifecycle and output", () => {
  it("keeps upload disabled until a supported file is selected", async () => {
    const wrapper = render();
    expect(button(wrapper).element.disabled).toBe(true);
    await select(wrapper);
    expect(wrapper.emitted("message")).toContainEqual(["画像ファイルを選択してください。"]);
    expect(deps.post).not.toHaveBeenCalled();
  });
  it.each(["application/x-msdownload", "text/html", ""])(
    'rejects unsupported MIME type "%s" before uploading',
    async (type) => {
      const wrapper = render();
      await select(wrapper, file(type, "payload.png"));
      expect(wrapper.emitted("message")).toContainEqual(["許可されていない形式のファイルです。"]);
      expect(button(wrapper).element.disabled).toBe(true);
      expect(deps.resize).not.toHaveBeenCalled();
      expect(deps.post).not.toHaveBeenCalled();
    },
  );
  it("rejects files above 100MB before media preparation", async () => {
    const wrapper = render();
    const oversized = file();
    Object.defineProperty(oversized, "size", { value: 100 * 1024 * 1024 + 1 });
    await select(wrapper, oversized);
    expect(wrapper.emitted("message")).toContainEqual([
      "100MBを超えるファイルはアップロードできません。",
    ]);
    expect(deps.resize).not.toHaveBeenCalled();
    expect(button(wrapper).element.disabled).toBe(true);
  });
  it("accepts the exact size limit and can clear the selection without sending it", async () => {
    const wrapper = render();
    const boundary = file("application/pdf", "large.pdf");
    Object.defineProperty(boundary, "size", { value: 100 * 1024 * 1024 });
    await select(wrapper, boundary);
    expect(wrapper.text()).toContain("100.0 MB");
    expect(button(wrapper).element.disabled).toBe(false);
    await wrapper.get(".btn-secondary").trigger("click");
    expect(button(wrapper).element.disabled).toBe(true);
    expect(wrapper.text()).not.toContain("large.pdf");
    expect(deps.post).not.toHaveBeenCalled();
  });
  it.each([
    ["image/png", "photo.png", "saved.png", "image", "![photo.png]"],
    ["video/mp4", "clip.mp4", "saved.mp4", "video", "?[clip.mp4]"],
    ["application/pdf", "paper.pdf", "saved.pdf", "pdf", "[paper.pdf]"],
  ])(
    "uploads %s as multipart and inserts the correct media link",
    async (type, name, saved, kind, prefix) => {
      deps.post.mockResolvedValueOnce({ data: { uuid_filename: saved } });
      const wrapper = render();
      const selected = file(type, name);
      await select(wrapper, selected);
      expect(wrapper.text()).toContain(name);
      await upload(wrapper);
      const [url, body, config] = deps.post.mock.calls[0]!;
      expect(url).toBe(imageUploadUrl);
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("asset_kind")).toBe(kind);
      expect(body.get("upload_file").name).toBe(name);
      expect(body.get("poster_file")?.name ?? null).toBe(kind === "video" ? "poster.jpg" : null);
      expect(config.onUploadProgress).toBeTypeOf("function");
      expect(wrapper.emitted("uploaded")?.[0]?.[0]).toBe(
        `${prefix}(https://app.example.test/static/images/${saved})`,
      );
      expect(deps.refresh).toHaveBeenCalledOnce();
      expect(button(wrapper).element.disabled).toBe(true);
      expect(wrapper.text()).not.toContain(name);
      expect(wrapper.emitted("uploadProgressChange")?.at(-1)?.[0]).toMatchObject({
        isOpen: false,
        percent: null,
      });
    },
  );
  it("does not upload if image optimization fails", async () => {
    deps.resize.mockRejectedValueOnce(new Error("decode failed"));
    const wrapper = render();
    await select(wrapper, file());
    expect(button(wrapper).element.disabled).toBe(true);
    expect(deps.post).not.toHaveBeenCalled();
    expect(wrapper.emitted("uploadProgressChange")?.at(-1)?.[0]).toMatchObject({ isOpen: false });
  });
  it("uploads a video without a poster when poster generation fails and explains the fallback", async () => {
    deps.poster.mockRejectedValueOnce(new Error("unsupported decoder"));
    deps.post.mockResolvedValueOnce({ data: { uuid_filename: "saved.mp4" } });
    const wrapper = render();
    await select(wrapper, file("video/mp4", "clip.mp4"));
    expect(wrapper.emitted("message")).toContainEqual([
      "動画のposter画像生成に失敗したため、動画のみアップロードします。",
    ]);
    await upload(wrapper);
    expect(deps.post.mock.calls[0]![1].get("poster_file")).toBeNull();
    expect(wrapper.emitted("uploaded")?.[0]?.[0]).toContain("?[clip.mp4]");
  });
  it("prevents duplicate submissions and reports known and unknown upload progress", async () => {
    let resolve!: (value: any) => void;
    deps.post.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = render();
    await select(wrapper, file());
    await button(wrapper).trigger("click");
    expect(button(wrapper).element.disabled).toBe(true);
    await button(wrapper).trigger("click");
    expect(deps.post).toHaveBeenCalledOnce();
    const callback = deps.post.mock.calls[0]![2].onUploadProgress;
    for (event of [{ loaded: 25, total: 100 }, { loaded: 120, total: 100 }, {}]) callback(event);
    const progress = wrapper.emitted("uploadProgressChange")!.map((args) => args[0]);
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "uploading",
          percent: 25,
          loadedBytes: 25,
          totalBytes: 100,
        }),
        expect.objectContaining({ phase: "finalizing", percent: null }),
        expect.objectContaining({ phase: "uploading", percent: null, loadedBytes: 0 }),
      ]),
    );
    resolve({ data: { uuid_filename: "saved.png" } });
    await flushPromises();
    expect(wrapper.emitted("uploaded")).toHaveLength(1);
  });
  it("clears failed upload state and permits choosing another file for retry", async () => {
    deps.post.mockRejectedValueOnce(new Error("offline"));
    const wrapper = render();
    await select(wrapper, file());
    await upload(wrapper);
    expect(wrapper.emitted("uploaded")).toBeUndefined();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(wrapper.emitted("message")?.at(-1)?.[0]).toContain("アップロードエラー");
    expect(button(wrapper).element.disabled).toBe(true);
    await select(wrapper, file("application/pdf", "retry.pdf"));
    await upload(wrapper);
    expect(deps.post).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("uploaded")).toHaveLength(1);
  });
  if (!mobile) {
    it("copies a completed link outside the editor when HTTPS is available", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const wrapper = render(false, true);
      await select(wrapper, file());
      await upload(wrapper);
      expect(writeText).toHaveBeenCalledWith(
        "![photo.png](https://app.example.test/static/images/saved.png)",
      );
      expect(wrapper.emitted("uploaded")).toBeUndefined();
      expect(wrapper.emitted("message")?.at(-1)?.[0]).toContain("クリップボード");
    });
    it("offers a manual link when the clipboard cannot be used over HTTP", async () => {
      const wrapper = render(false, false);
      await select(wrapper, file());
      await upload(wrapper);
      expect(wrapper.emitted("showUploadedUrl")).toEqual([
        ["![photo.png](https://app.example.test/static/images/saved.png)", "saved.png"],
      ]);
    });
  }
});
