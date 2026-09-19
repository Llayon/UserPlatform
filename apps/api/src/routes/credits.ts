import { Router } from "express";
import {
  creditCommitRequestSchema,
  creditReleaseRequestSchema,
  reserveRequestSchema,
  type ErrorCode,
} from "@user-platform/contracts";
import { commit, release, reserve, CreditError } from "@user-platform/credits";
import type { Db, DbReservation, Repos } from "@user-platform/db";
import type { ApiConfig } from "../config.js";
import { HttpError, requireServiceToken, resolveSessionUser } from "../auth.js";

export interface CreditRouteDeps {
  config: ApiConfig;
  db: Db;
  repos: Repos;
}

function toReservationPayload(
  r: DbReservation,
  operation: string,
  balance: { available: number; reserved: number },
) {
  return {
    reservation: {
      reservationId: r.id,
      requestId: r.requestId,
      operation,
      amount: r.amount,
      status: r.status,
      balance,
    },
  };
}

function mapCreditError(err: CreditError): { status: number; code: ErrorCode } {
  switch (err.code) {
    case "UNKNOWN_OPERATION":
      return { status: 404, code: "NOT_FOUND" };
    case "OPERATION_DISABLED":
      return { status: 403, code: "FORBIDDEN" };
    case "ACCOUNT_SUSPENDED":
      return { status: 403, code: "FORBIDDEN" };
    case "INSUFFICIENT_CREDITS":
      return { status: 402, code: "INSUFFICIENT_CREDITS" };
    case "RESERVATION_NOT_FOUND":
      return { status: 404, code: "NOT_FOUND" };
    case "RESERVATION_STATE":
      return { status: 409, code: "RESERVATION_CONFLICT" };
  }
}

export function createCreditsRouter(deps: CreditRouteDeps): Router {
  const router = Router();
  const { config, db, repos } = deps;
  const engine = { db, repos };

  /**
   * Dual binding (§23+§24): the caller's service credential AND the user's
   * session must both verify. The acting userId comes only from the session —
   * bodies carry no userId, so a service cannot name an arbitrary user.
   */
  const bind = async (req: import("express").Request): Promise<string> => {
    requireServiceToken(config, req.headers.authorization);
    const { userId } = await resolveSessionUser(deps, req.headers as Record<string, string>);
    return userId;
  };

  router.post("/reserve", async (req, res) => {
    try {
      const parsed = reserveRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
      }
      const userId = await bind(req);
      const out = await reserve(engine, {
        userId,
        operation: parsed.data.operation,
        requestId: parsed.data.requestId,
      });
      return res.json({
        ...toReservationPayload(out.reservation, parsed.data.operation, out.balance),
        reused: out.reused,
      });
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
      if (err instanceof CreditError) {
        const mapped = mapCreditError(err);
        return res.status(mapped.status).json({ error: err.message, code: mapped.code });
      }
      return res.status(500).json({ error: "Reserve failed", code: "INTERNAL_ERROR" });
    }
  });

  router.post("/commit", async (req, res) => {
    try {
      const parsed = creditCommitRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
      }
      const userId = await bind(req);
      const out = await commit(engine, { userId, reservationId: parsed.data.reservationId });
      const op = out.reservation.operationId
        ? await repos.registry.getOperationById(db, out.reservation.operationId)
        : null;
      return res.json({
        ...toReservationPayload(
          out.reservation,
          op?.operationKey ?? "unknown.operation",
          out.balance,
        ),
        reused: out.reused,
      });
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
      if (err instanceof CreditError) {
        const mapped = mapCreditError(err);
        return res.status(mapped.status).json({ error: err.message, code: mapped.code });
      }
      return res.status(500).json({ error: "Commit failed", code: "INTERNAL_ERROR" });
    }
  });

  router.post("/release", async (req, res) => {
    try {
      const parsed = creditReleaseRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
      }
      const userId = await bind(req);
      const out = await release(engine, { userId, reservationId: parsed.data.reservationId });
      const op = out.reservation.operationId
        ? await repos.registry.getOperationById(db, out.reservation.operationId)
        : null;
      return res.json({
        ...toReservationPayload(
          out.reservation,
          op?.operationKey ?? "unknown.operation",
          out.balance,
        ),
        reused: out.reused,
      });
    } catch (err) {
      if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
      if (err instanceof CreditError) {
        const mapped = mapCreditError(err);
        return res.status(mapped.status).json({ error: err.message, code: mapped.code });
      }
      return res.status(500).json({ error: "Release failed", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}
