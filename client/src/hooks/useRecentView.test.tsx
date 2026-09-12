// @vitest-environment jsdom
import React from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { workspace: { recordRecent: { useMutation: () => mutation } } } }));

import { useRecentView } from "./useRecentView";

describe("useRecentView", () => {
  it("persists a real resource once when its detail view mounts", () => {
    mutation.mutate.mockClear();
    renderHook(() => useRecentView({ workspaceId: 9, entityType: "dataset", entityId: "42", entityLabel: "customers" }));
    expect(mutation.mutate).toHaveBeenCalledTimes(1);
    expect(mutation.mutate).toHaveBeenCalledWith({ workspaceId: 9, entityType: "dataset", entityId: "42", entityLabel: "customers" });
  });

  it("does not write a recent record without complete scoped identity", () => {
    mutation.mutate.mockClear();
    renderHook(() => useRecentView({ workspaceId: 9, entityType: "pipeline", entityId: "", entityLabel: "" }));
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});
