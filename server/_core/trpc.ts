import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // Unexpected failures (e.g. the database host is unreachable: ENOTFOUND) must not leak driver
    // messages or SQL to the browser. Deliberate TRPCErrors keep their user-facing message.
    const unexpected = error.code === "INTERNAL_SERVER_ERROR" && error.cause !== undefined && !(error.cause instanceof TRPCError);
    if (!unexpected) return shape;
    console.error("[API] Unexpected error:", error.cause);
    return { ...shape, message: "The data store is unavailable. Please try again later.", data: { ...shape.data, stack: undefined } };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    // A Supabase outage must not look like "signed out" (the client would drop the session).
    if (ctx.authUnavailable) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The authentication service is temporarily unavailable." });
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
