import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { AUTH_UNAUTHORIZED_EVENT } from "./contexts/AuthContext";
import { getAccessToken } from "./lib/supabase";
import "./index.css";

/**
 * Retry only transient transport failures. Deliberate server answers
 * (UNAUTHORIZED, FORBIDDEN, NOT_FOUND, BAD_REQUEST, CONFLICT, or a data-store outage
 * reported as INTERNAL_SERVER_ERROR) are shown immediately instead of after
 * seconds of exponential back-off.
 */
const shouldRetry = (failureCount: number, error: unknown) => {
  if (error instanceof TRPCClientError && error.data?.code) return false;
  return failureCount < 2;
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG || error.data?.code === "UNAUTHORIZED";

  if (!isUnauthorized) return;

  // The AuthProvider decides: refresh the Supabase session once, or sign out and route to /login.
  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      async headers() {
        // Every API call carries the current Supabase access token; the server verifies it.
        const token = await getAccessToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
