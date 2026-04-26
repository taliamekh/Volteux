import { describe, expect, test } from "bun:test";
import {
  ADDITIONAL_FILE_NAME_REGEX,
  parseIncludes,
  runAllowlistChecks,
  stripComments,
  validateAdditionalFileName,
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
  // The regex enforces: leading [A-Za-z0-9_], then [A-Za-z0-9_.-]*,
  // then `.` + one of {ino,h,cpp,c}. It does NOT police consecutive dots —
  // that lives in `validateAdditionalFileName`.
  const valid = [
    "sketch.ino",
    "helper.h",
    "lib.cpp",
    "extra.c",
    "my-file_2.ino",
    "_internal.h", // leading underscore allowed
    "1foo.ino", // leading digit allowed
    "a.b.ino", // single dot in stem (no consecutive) — boundary case for ADV-003
  ];
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
    // SEC-002: leading-dash filenames could collide with arduino-cli flag parsing
    "-flag.h",
    "--no-color.ino",
    // ADV-003 (regex layer): leading-dot hidden files are now rejected by the regex
    // (the consecutive-dots case is exercised by validateAdditionalFileName below)
    ".hidden.h",
    ".env.ino",
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

describe("validateAdditionalFileName (the predicate the Compile API also imports)", () => {
  test("returns null on a clean filename", () => {
    expect(validateAdditionalFileName("foo.h")).toBeNull();
    expect(validateAdditionalFileName("a.b.ino")).toBeNull();
  });

  test("rejects empty string with a clear reason", () => {
    expect(validateAdditionalFileName("")).toBe("empty filename");
  });

  test("rejects null byte (regardless of position)", () => {
    expect(validateAdditionalFileName("sketch\0.ino")).toBe("null byte in filename");
  });

  // ADV-003 — consecutive dots: previously dead code in `filenameViolationReason`
  // because the old regex accepted `test..h`, so the post-regex `..` check was
  // never reached. Now the `..` check runs as a primary check before the regex.
  test("rejects consecutive dots — `test..h` (ADV-003)", () => {
    expect(validateAdditionalFileName("test..h")).toBe(
      "consecutive dots not allowed (path traversal or extension obfuscation)",
    );
  });

  test("rejects consecutive dots — `..hidden.ino` (ADV-003)", () => {
    expect(validateAdditionalFileName("..hidden.ino")).toBe(
      "consecutive dots not allowed (path traversal or extension obfuscation)",
    );
  });

  test("rejects path traversal `../etc/passwd` (the consecutive-dot check fires first, which is fine)", () => {
    // The reason message is the consecutive-dot reason; either reason is
    // acceptable here — the policy is fail-closed and the user-facing
    // message still names "..". The rejection itself is the contract.
    expect(validateAdditionalFileName("../etc/passwd")).not.toBeNull();
  });

  test("rejects path separators with a clear reason", () => {
    expect(validateAdditionalFileName("sub/foo.ino")).toBe(
      "path separators not allowed (use a flat filename)",
    );
    expect(validateAdditionalFileName("sub\\foo.ino")).toBe(
      "path separators not allowed (use a flat filename)",
    );
  });

  test("rejects absolute path `/etc/passwd` with a path-separator reason (separator check fires first)", () => {
    // Either reason is acceptable; the rejection itself is the contract.
    expect(validateAdditionalFileName("/etc/passwd")).not.toBeNull();
  });

  // SEC-002 — leading-dash filenames could become CLI flag injections if
  // arduino-cli were ever invoked with shell interpolation.
  test("rejects leading-dash `-flag.h` (SEC-002)", () => {
    const reason = validateAdditionalFileName("-flag.h");
    expect(reason).not.toBeNull();
    expect(reason).toContain("does not match");
  });

  test("rejects double-dash `--no-color.ino` (SEC-002)", () => {
    const reason = validateAdditionalFileName("--no-color.ino");
    expect(reason).not.toBeNull();
    expect(reason).toContain("does not match");
  });

  // Sandbox bypass surface (arduino-cli #758): each is rejected by the
  // extension check (none ends in .ino|.h|.cpp|.c). These tests document
  // *why* the extension constraint must not be relaxed.
  test("rejects sandbox bypass: arduino-cli.yaml (#758)", () => {
    expect(validateAdditionalFileName("arduino-cli.yaml")).not.toBeNull();
  });

  test("rejects sandbox bypass: sketch.json (#758)", () => {
    expect(validateAdditionalFileName("sketch.json")).not.toBeNull();
  });

  test("rejects sandbox bypass: library.properties (#758)", () => {
    expect(validateAdditionalFileName("library.properties")).not.toBeNull();
  });

  test("rejects sandbox bypass: platform.txt (#758)", () => {
    expect(validateAdditionalFileName("platform.txt")).not.toBeNull();
  });

  test("returns null for legitimate boundary case `a.b.ino` (single dots in stem)", () => {
    // Important regression case for the ADV-003 fix: we must reject CONSECUTIVE
    // dots without rejecting all multi-dot stems.
    expect(validateAdditionalFileName("a.b.ino")).toBeNull();
  });
});

// Adversarial review #1 (T-002 follow-up): the single-source regex argument
// depends on the PREDICATE behaving identically AT THE SERVER'S CALL SITE,
// not just at re-import of the same module path (which Bun caches and
// always returns the same instance). To actually catch a refactor where
// `infra/server/sketch-fs.ts` shims or wraps the import differently in
// the Docker bundle, the test must drive the server-side code path —
// not just re-import the module the server imports.
//
// `createPerRequestSketchDir` is the only consumer of
// `validateAdditionalFileName` in `infra/server/sketch-fs.ts`. By calling
// it with each candidate filename and inspecting the rejection reason,
// the test exercises the predicate through the same import chain the
// running server uses. If a future refactor introduces a server-local
// shim or barrel that diverges, this test fails on the first divergent
// input.
describe("validateAdditionalFileName — predicate parity at the server's call site", () => {
  test("createPerRequestSketchDir rejects exactly the inputs validateAdditionalFileName rejects", async () => {
    const { createPerRequestSketchDir } = await import(
      "../../infra/server/sketch-fs.ts"
    );

    const inputs = [
      "sketch.ino", // post-fix: rejected (would overwrite main sketch)
      "_internal.h",
      "1foo.ino",
      "a.b.ino",
      "",
      "-flag.h",
      ".hidden.h",
      "test..h",
      "../etc/passwd",
      "sub/foo.ino",
      "sketch\0.ino",
      "arduino-cli.yaml",
      "library.properties",
      "platform.txt",
      "extra.cpp",
    ];

    for (const filename of inputs) {
      const directReason = validateAdditionalFileName(filename);
      const result = await createPerRequestSketchDir({
        main_ino: "void setup(){}\nvoid loop(){}",
        additional_files: { [filename]: "x" },
      });

      if (filename === "sketch.ino") {
        // Server-side guard layered on top of the predicate (ADV-002).
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe("filename-allowlist");
          expect(result.error.filename).toBe(filename);
        }
        continue;
      }

      if (directReason === null) {
        expect(result.ok).toBe(true);
        if (result.ok) await result.handle.cleanup();
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe("filename-allowlist");
          expect(result.error.filename).toBe(filename);
          expect(result.error.reason).toBe(directReason);
        }
      }
    }
  });
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
