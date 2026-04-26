import { describe, expect, test } from "bun:test";
import {
  ADDITIONAL_FILE_NAME_REGEX,
  parseIncludes,
  runAllowlistChecks,
  stripComments,
  type AllowlistInput,
} from "../../pipeline/gates/library-allowlist.ts";

const baseInput: AllowlistInput = {
  archetype_id: "uno-ultrasonic-servo",
  main_ino: "#include <Servo.h>\n\nvoid setup() {}\nvoid loop() {}",
  additional_files: {},
  libraries: ["Servo"],
};

describe("stripComments", () => {
  test("strips line comments while preserving overall length", () => {
    const input = "int x = 1; // this is a comment\nint y = 2;";
    const stripped = stripComments(input);
    expect(stripped.length).toBe(input.length);
    expect(stripped).not.toContain("comment");
    expect(stripped).toContain("int x = 1;");
    expect(stripped).toContain("int y = 2;");
  });

  test("strips block comments across newlines", () => {
    const input = "int x = 1;\n/* this is\n a block comment */\nint y = 2;";
    const stripped = stripComments(input);
    expect(stripped).not.toContain("block comment");
    expect(stripped.split("\n").length).toBe(input.split("\n").length);
  });

  test("preserves strings (no string-literal handling needed for #include parsing)", () => {
    // We do not handle escaped quotes; the only consumer is #include parsing.
    expect(stripComments('Serial.println("hello world");')).toBe(
      'Serial.println("hello world");',
    );
  });
});

describe("parseIncludes", () => {
  test("extracts angle-bracket includes", () => {
    expect(parseIncludes("#include <Servo.h>")).toEqual(["Servo.h"]);
  });

  test("extracts quoted includes", () => {
    expect(parseIncludes('#include "myheader.h"')).toEqual(["myheader.h"]);
  });

  test("extracts multiple includes", () => {
    const src = "#include <Servo.h>\n#include <Wire.h>\nvoid setup(){}";
    expect(parseIncludes(src)).toEqual(["Servo.h", "Wire.h"]);
  });

  test("ignores commented-out includes", () => {
    const src =
      "// #include <Evil.h>\n#include <Servo.h>\n/* #include <AlsoEvil.h> */";
    expect(parseIncludes(src)).toEqual(["Servo.h"]);
  });

  test("tolerates whitespace variations", () => {
    expect(parseIncludes("#  include   <Servo.h>")).toEqual(["Servo.h"]);
  });
});

describe("ADDITIONAL_FILE_NAME_REGEX", () => {
  const valid = ["sketch.ino", "helper.h", "lib.cpp", "extra.c", "my-file_2.ino"];
  const invalid = [
    "",
    "../etc/passwd",
    "/etc/passwd",
    "sketch\0.ino", // actual null byte (was previously a misleading ASCII space)
    "sub/file.ino",
    "sub\\file.ino",
    "sketch", // no extension
    "sketch.txt",
    "arduino-cli.yaml",
    "hardware/foo.h",
    "platform.txt",
  ];

  for (const name of valid) {
    test(`accepts "${name}"`, () => {
      expect(ADDITIONAL_FILE_NAME_REGEX.test(name)).toBe(true);
    });
  }

  for (const name of invalid) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(ADDITIONAL_FILE_NAME_REGEX.test(name)).toBe(false);
    });
  }
});

describe("runAllowlistChecks — happy path", () => {
  test("canonical archetype-1 input passes with no violations", () => {
    expect(runAllowlistChecks(baseInput)).toEqual([]);
  });

  test("Arduino-core built-in headers (Wire.h, Arduino.h) do NOT need to be in libraries[]", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#include <Servo.h>\n#include <Wire.h>\n",
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });

  test("commented-out forbidden include does not violate", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "// #include <WiFi.h>\n#include <Servo.h>",
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });
});

describe("Phase 2 line-continuation splicing (security: SEC-001)", () => {
  test("'#include \\\\\\n<WiFi.h>' is caught as a forbidden library, not silently ignored", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#include \\\n<WiFi.h>\n",
    };
    const violations = runAllowlistChecks(input);
    expect(
      violations.some(
        (v) => v.kind === "library-not-in-allowlist" && v.library === "WiFi",
      ),
    ).toBe(true);
  });

  test("multi-segment line continuation '#in\\\\\\nclude <WiFi.h>' is also caught", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#in\\\nclude <WiFi.h>\n",
    };
    const violations = runAllowlistChecks(input);
    expect(
      violations.some(
        (v) => v.kind === "library-not-in-allowlist" && v.library === "WiFi",
      ),
    ).toBe(true);
  });

  test("CRLF line continuation '\\\\\\r\\n' also splices", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#include \\\r\n<WiFi.h>\n",
    };
    const violations = runAllowlistChecks(input);
    expect(
      violations.some(
        (v) => v.kind === "library-not-in-allowlist" && v.library === "WiFi",
      ),
    ).toBe(true);
  });
});

describe("String-literal stripping (correctness: ADV-001)", () => {
  test("#include text inside a C string literal does NOT trigger a violation", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino:
        '#include <Servo.h>\nconst char msg[] = "Error: #include <WiFi.h> not supported";\n',
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });

  test("#include text inside a char literal does NOT trigger (single-quoted)", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino:
        "#include <Servo.h>\nchar c = '<';\nchar d = '>';\n", // tokens that could confuse a naive parser
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });

  test("escaped quote inside a string does not break literal stripping", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino:
        '#include <Servo.h>\nconst char* s = "He said \\"#include <WiFi.h>\\" loudly";\n',
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });

  test("real #include AFTER a string with bracketed text is still detected", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino:
        'const char msg[] = "<example>";\n#include <WiFi.h>\n',
    };
    const violations = runAllowlistChecks(input);
    expect(
      violations.some(
        (v) => v.kind === "library-not-in-allowlist" && v.library === "WiFi",
      ),
    ).toBe(true);
  });
});

describe("libraries[] vs #include cross-check (T-001 — plan-required)", () => {
  test("'#include <Servo.h>' with libraries: [] fails with include-without-libraries-declaration", () => {
    const input: AllowlistInput = {
      ...baseInput,
      libraries: [],
    };
    const violations = runAllowlistChecks(input);
    const violation = violations.find(
      (v) => v.kind === "include-without-libraries-declaration",
    );
    expect(violation).toBeDefined();
    if (violation && violation.kind === "include-without-libraries-declaration") {
      expect(violation.header).toBe("Servo.h");
      expect(violation.library).toBe("Servo");
      expect(violation.file).toBe("main_ino");
    }
  });

  test("Arduino-core built-in includes (Wire.h) do NOT trigger the cross-check", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#include <Servo.h>\n#include <Wire.h>\n",
      libraries: ["Servo"], // Wire is built-in; doesn't need declaration
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });

  test("declared Servo with #include <Servo.h> passes (the canonical case)", () => {
    expect(runAllowlistChecks(baseInput)).toEqual([]);
  });
});

describe("runAllowlistChecks — library not in allowlist", () => {
  test("libraries[] containing WiFi on archetype 1 fails", () => {
    const input: AllowlistInput = {
      ...baseInput,
      libraries: ["Servo", "WiFi"],
    };
    const violations = runAllowlistChecks(input);
    expect(violations).toContainEqual({
      kind: "library-not-in-allowlist",
      library: "WiFi",
      source: "libraries-field",
    });
  });

  test("#include <WiFi.h> in main_ino on archetype 1 fails", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#include <Servo.h>\n#include <WiFi.h>",
    };
    const violations = runAllowlistChecks(input);
    expect(violations).toContainEqual({
      kind: "library-not-in-allowlist",
      library: "WiFi",
      source: "include:main_ino",
    });
  });

  test("unknown header (not in HEADER_TO_LIBRARY map) reports unknown-header", () => {
    const input: AllowlistInput = {
      ...baseInput,
      main_ino: "#include <Mystery.h>",
    };
    const violations = runAllowlistChecks(input);
    expect(violations).toContainEqual({
      kind: "unknown-header",
      header: "Mystery.h",
      file: "main_ino",
    });
  });
});

describe("runAllowlistChecks — filename allowlist", () => {
  test("rejects arduino-cli.yaml in additional_files", () => {
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: { "arduino-cli.yaml": "#config" },
    };
    const violations = runAllowlistChecks(input);
    expect(violations.some((v) => v.kind === "filename-allowlist")).toBe(true);
  });

  test("rejects path traversal", () => {
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: { "../etc/passwd": "x" },
    };
    expect(
      runAllowlistChecks(input).some((v) => v.kind === "filename-allowlist"),
    ).toBe(true);
  });

  test("rejects absolute path", () => {
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: { "/etc/passwd": "x" },
    };
    expect(
      runAllowlistChecks(input).some((v) => v.kind === "filename-allowlist"),
    ).toBe(true);
  });

  test("rejects nested path", () => {
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: { "sub/file.ino": "// noop" },
    };
    expect(
      runAllowlistChecks(input).some((v) => v.kind === "filename-allowlist"),
    ).toBe(true);
  });

  test("rejects empty key", () => {
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: { "": "x" },
    };
    expect(
      runAllowlistChecks(input).some((v) => v.kind === "filename-allowlist"),
    ).toBe(true);
  });

  test("accepts a well-named additional file with valid contents", () => {
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: {
        "helper.h": "// just a noop\nvoid noop() {}",
      },
    };
    expect(runAllowlistChecks(input)).toEqual([]);
  });

  test("does NOT scan #includes inside files that fail the filename allowlist", () => {
    // The forbidden file would otherwise trip an unknown-header violation
    // for its include. We only flag the filename, not the contents.
    const input: AllowlistInput = {
      ...baseInput,
      additional_files: {
        "arduino-cli.yaml": "#include <SomethingForbidden.h>",
      },
    };
    const violations = runAllowlistChecks(input);
    const filenameViolations = violations.filter(
      (v) => v.kind === "filename-allowlist",
    );
    const headerViolations = violations.filter(
      (v) => v.kind === "unknown-header",
    );
    expect(filenameViolations.length).toBe(1);
    expect(headerViolations.length).toBe(0);
  });
});
