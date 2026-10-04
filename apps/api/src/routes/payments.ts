import {
  createOrderRequestSchema,
  fakePayRequestSchema,
  verifyPaymentRequestSchema,
  type CreateOrderRequest,
  type PaymentsConfig,
  type VerifyPaymentRequest,
} from "@townplay/shared";
import { Router } from "express";
import type { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import type { PaymentGateway } from "../services/paymentGateway.js";
import type { PaymentsService } from "../services/payments.js";
import type { SettingsService } from "../services/settings.js";

/** Checkout endpoints (JSON). The webhook is mounted separately in app.ts with a raw body. */
export function paymentsRouter(
  auth: Auth,
  payments: PaymentsService,
  settings: SettingsService,
  gateway: PaymentGateway,
): Router {
  const router = Router();
  const signedIn = requireAuth(auth);

  router.get("/payments/config", async (_req, res) => {
    const body: PaymentsConfig = {
      provider: gateway.provider,
      keyId: gateway.keyId,
      convenienceFee: (await settings.get()).convenienceFee,
    };
    res.json(body);
  });

  router.post(
    "/payments/orders",
    signedIn,
    validate({ body: createOrderRequestSchema }),
    async (req, res) => {
      res.status(201).json(await payments.createOrder(req.user!, req.body as CreateOrderRequest));
    },
  );

  router.post(
    "/payments/verify",
    signedIn,
    validate({ body: verifyPaymentRequestSchema }),
    async (req, res) => {
      res.json(await payments.verify(req.user!, req.body as VerifyPaymentRequest));
    },
  );

  router.post(
    "/payments/fake-pay",
    signedIn,
    validate({ body: fakePayRequestSchema }),
    async (req, res) => {
      const { orderId, outcome } = req.body as z.infer<typeof fakePayRequestSchema>;
      res.json(await payments.fakePay(req.user!, orderId, outcome));
    },
  );

  return router;
}
