import { beforeEach, describe, expect, it } from "vitest";

import { readMarkerFormBootstrap } from "../src/marker-form/bootstrap";

describe("readMarkerFormBootstrap", () => {
  beforeEach(() => {
    delete window.__GEOCODE_MARKER_FORM__;
  });

  it("returns typed bootstrap data", () => {
    window.__GEOCODE_MARKER_FORM__ = {
      isPasswordProtected: false,
      schema: {
        fields: [
          {
            choices: [],
            id: "name",
            label: "名前",
            max_length: 100,
            required: true,
            type: "text",
          },
        ],
      },
      submissionPath: "/forms/example",
    };

    expect(readMarkerFormBootstrap().schema.fields[0]?.id).toBe("name");
  });

  it("rejects unsupported field types", () => {
    window.__GEOCODE_MARKER_FORM__ = {
      isPasswordProtected: false,
      schema: {
        fields: [
          {
            choices: [],
            id: "unsafe",
            label: "Unsupported",
            max_length: null,
            required: false,
            type: "html",
          },
        ],
      },
      submissionPath: "/forms/example",
    };

    expect(() => readMarkerFormBootstrap()).toThrow("field data is invalid");
  });
});
