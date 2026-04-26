// ============================================================
// Volteux — App hashchange integration test (U5)
// ============================================================
// Verifies that browser back/forward navigation re-decodes the URL hash
// and reconciles project state, without triggering a write loop.
//
// We mock `../lib/urlHash` because jsdom doesn't ship CompressionStream /
// DecompressionStream. The test is about App's reaction to hashchange
// events, not about codec internals (those are covered by Cluster C).
//
// We use history.replaceState (which does NOT fire hashchange) to set up
// hash state, then dispatch HashChangeEvent manually. This gives us
// 1-call-per-event control instead of doubling up with jsdom's implicit
// hashchange-on-`location.hash =` assignment.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import App from "../App";
import { decode } from "../lib/urlHash";
import { loadDefaultFixture } from "../data/fixtures";

vi.mock("../lib/urlHash", () => ({
  encode: vi.fn().mockResolvedValue("fakehash"),
  decode: vi.fn(),
}));

const decodeMock = vi.mocked(decode);

function setHashSilently(hash: string): void {
  // replaceState does NOT fire hashchange (per MDN). Use this to seed the
  // URL state before render or before a manual event dispatch.
  const target =
    hash === "" ? window.location.pathname : window.location.pathname + hash;
  window.history.replaceState(null, "", target);
}

function fireHashChange(): void {
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

describe("App hashchange listener", () => {
  beforeEach(() => {
    decodeMock.mockReset();
    setHashSilently("");
  });

  afterEach(() => {
    cleanup();
    setHashSilently("");
  });

  test("hashchange to a valid hash restores the project to result view", async () => {
    // Mount with no hash. Mount-restore is a no-op.
    render(<App />);

    // Now simulate browser nav to a valid hash.
    decodeMock.mockResolvedValueOnce(loadDefaultFixture());
    setHashSilently("#v1:somehash");
    fireHashChange();

    await screen.findByText(/waving robot arm/i);
  });

  test("hashchange to empty hash returns to landing", async () => {
    // Mount with a project already loaded via a hash.
    decodeMock.mockResolvedValueOnce(loadDefaultFixture());
    setHashSilently("#v1:initial");
    render(<App />);
    await screen.findByText(/waving robot arm/i);

    // Now simulate browser back-button to a hashless URL.
    setHashSilently("");
    fireHashChange();

    // Landing tagline reappears ("Type your idea.").
    await screen.findByText(/type your idea/i);
  });

  test("hashchange to invalid hash preserves current project state", async () => {
    decodeMock.mockResolvedValueOnce(loadDefaultFixture());
    setHashSilently("#v1:initial");
    render(<App />);
    await screen.findByText(/waving robot arm/i);

    const callsAfterMount = decodeMock.mock.calls.length;

    // hashchange to garbage — decode returns null.
    decodeMock.mockResolvedValueOnce(null);
    setHashSilently("#v1:garbage");
    fireHashChange();

    // Wait for the hashchange handler's decode call to complete.
    await waitFor(() => {
      expect(decodeMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });

    // Project state preserved: title still in the DOM.
    expect(screen.getByText(/waving robot arm/i)).toBeInTheDocument();
  });

  test("hashchange-triggered restore does not re-write the URL hash via replaceState", async () => {
    render(<App />);

    const replaceSpy = vi.spyOn(window.history, "replaceState");

    decodeMock.mockResolvedValueOnce(loadDefaultFixture());
    setHashSilently("#v1:somehash");
    replaceSpy.mockClear(); // setHashSilently itself uses replaceState — discount it.
    fireHashChange();

    await screen.findByText(/waving robot arm/i);

    // The loop guard should have prevented the project-write effect from
    // calling replaceState in response to the hashchange-induced setProject.
    expect(replaceSpy).not.toHaveBeenCalled();

    replaceSpy.mockRestore();
  });

  test("unmount removes the hashchange listener", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<App />);
    // Let any pending mount-effects flush so unmount cleanup runs cleanly
    // (silences React's "update not wrapped in act" warning).
    await act(async () => {});
    unmount();

    const hashchangeCleanup = removeSpy.mock.calls.find(
      ([type]) => type === "hashchange",
    );
    expect(hashchangeCleanup).toBeDefined();

    removeSpy.mockRestore();
  });
});
