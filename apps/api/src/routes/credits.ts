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
import {
  HttpError,
  resolveServicePrincipal,
  resolveSessionUser,
  type ServicePrincipal,
  type SessionPrincipal,
} from "../auth.js";

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

/**
 * Triple authority (SERVICE APP == SESSION APP == OPERATION APP).
 * - USER comes only from the validated session.
 * - APP comes only from the authenticated service credential.
 * - OPERATION cost/ownership comes only from the Platform registry
 *   (operation.app_id relation, never string-prefix checks).
 * Account sessions are READ-only: rejected here even with a valid service
 * credential. Any mismatch is 403 FORBIDDEN.
 */
async function bindServiceAndSession(
  deps: CreditRouteDeps,
  req: import("express").Request,
): Promise<{ service: ServicePrincipal; session: SessionPrincipal }> {
  const service = await resolveServicePrincipal(deps, req.headers.authorization);
  const session = await resolveSessionUser(deps, req.headers as Record<string, string>);
  if (session.sessionType !== "app" || !session.appId) {
    throw new HttpError(403, "FORBIDDEN", "Account sessions cannot mutate credits");
  }
  if (session.appId !== service.appId) {
    throw new HttpError(403, "FORBIDDEN", "Session does not belong to this application");
  }
  return { service, session };
}

export function createCreditsRouter(deps: CreditRouteDeps): Router {
  const router = Router();
  const { db, repos } = deps;
  const engine = { db, repos };

  router.post("/reserve", async (req, res) => {
    try {
      const parsed = reserveRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
      }
      const { service, session } = await bindServiceAndSession(deps, req);
      // Operation authority: registry relation is authoritative.
      const op = await repos.registry.findOperationByKey(db, parsed.data.operation);
      if (!op) {
        return res.status(404).json({ error: "Unknown operation", code: "NOT_FOUND" });
      }
      if (op.appId !== service.appId) {
        return res
          .status(403)
          .json({ error: "Operation does not belong to this application", code: "FORBIDDEN" });
      }
      const opApp = await repos.registry.getAppById(db, op.appId);
      if (!opApp || opApp.status === "disabled") {
        return res.status(403).json({ error: "Operation unavailable", code: "FORBIDDEN" });
      }
      const out = await reserve(engine, {
        userId: session.userId,
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

  /**
   * Reservation ownership: (user AND application). The reservation's
   * operation→app must equal the calling service app, otherwise 403 —
   * even when the caller guesses a valid UUID from another app.
   */
  async function checkReservationOwnership(
    reservationId: string,
    service: ServicePrincipal,
    session: SessionPrincipal,
  ): Promise<void> {
    const current = await repos.reservations.getById(db, reservationId);
    // Unknown or foreign-user: engine maps to 404; do not leak app info.
    // App mismatch for the SAME user must be 403 (explicit IDOR gate).
    if (!current) return;
    if (current.userId !== session.userId) return;
    if (!current.operationId) {
      throw new HttpError(403, "FORBIDDEN", "Reservation has no application scope");
    }
    const op = await repos.registry.getOperationById(db, current.operationId);
    if (!op || op.appId !== service.appId) {
      throw new HttpError(403, "FORBIDDEN", "Reservation does not belong to this application");
    }
  }

  router.post("/commit", async (req, res) => {
    try {
      const parsed = creditCommitRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
      }
      const { service, session } = await bindServiceAndSession(deps, req);
      await checkReservationOwnership(parsed.data.reservationId, service, session);
      const out = await commit(engine, {
        userId: session.userId,
        reservationId: parsed.data.reservationId,
      });
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
      const { service, session } = await bindServiceAndSession(deps, req);
      await checkReservationOwnership(parsed.data.reservationId, service, session);
      const out = await release(engine, {
        userId: session.userId,
        reservationId: parsed.data.reservationId,
      });
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
