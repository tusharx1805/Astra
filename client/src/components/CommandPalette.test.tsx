/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const setLocation = vi.fn();
const onOpenChange = vi.fn();
const mockSearchData = {
  projects: [{ id: 1, type: "project", title: "Customer Analytics", subtitle: "Production", href: "/projects" }],
  datasets: [{ id: 2, type: "dataset", title: "customers", subtitle: "PostgreSQL", href: "/datasets/explorer" }],
  pipelines: [{ id: 3, type: "pipeline", title: "customer_etl", subtitle: "Healthy", href: "/pipelines" }],
};

vi.mock("wouter", () => ({ useLocation: () => ["/", setLocation] }));
vi.mock("@/lib/trpc", () => ({ trpc: { workspace: { search: { useQuery: () => ({ isLoading: false, data: mockSearchData }) } } } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/input", () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock("lucide-react", () => ({ ChevronRight: () => <span />, Clock3: () => <span />, Loader2: () => <span />, Search: () => <span /> }));
vi.mock("@/components/SimulatedBadge", () => ({ SimulatedBadge: () => <span>SIMULATED</span> }));

describe("CommandPalette component", () => {
  it("moves selection with ArrowDown and routes the selected result on Enter", async () => {
    const { CommandPalette } = await import("./CommandPalette");
    render(<CommandPalette open onOpenChange={onOpenChange} workspaceId={7} onRecent={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search ASTRA...");
    fireEvent.change(input, { target: { value: "customer" } });
    await waitFor(() => expect(screen.getByText("Customer Analytics")).toBeTruthy());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByText("Customer Analytics").closest("button")?.className).toContain("selected");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(setLocation).toHaveBeenCalledWith("/projects");
  });
});
