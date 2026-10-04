import { randomBytes } from "node:crypto";
import type { PaymentProvider } from "@townplay/shared";
import { hmacSha256Hex, safeEqualHex } from "../lib/crypto.js";

export interface GatewayOrder {
  id: string;
}

export interface GatewayRefund {
  id: string;
  status: "pending" | "processed" | "failed";
}

export interface LinkedAccountInput {
  businessId: string;
  name: string;
  email: string;
  phone: string;
  legalName: string;
  accountHolderName: string;
  accountNumber: string;
  ifsc: string;
}

/**
 * Payment provider behind an interface: Razorpay (REST, no SDK) in production, a fake for dev
 * and tests. Signatures are real HMACs in both, so webhook and verify logic is exercised.
 */
export interface PaymentGateway {
  readonly provider: PaymentProvider;
  readonly keyId: string;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  refund(
    paymentId: string,
    amountPaise: number,
    notes: Record<string, string>,
  ): Promise<GatewayRefund>;
  /** Razorpay Checkout handler signature: HMAC(order_id|payment_id, key_secret). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Webhook signature: HMAC(raw body, webhook_secret). */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
  createLinkedAccount(
    input: LinkedAccountInput,
  ): Promise<{ id: string; status: "pending" | "active" }>;
  transfer(paymentId: string, accountId: string, amountPaise: number): Promise<{ id: string }>;
  reverseTransfer(transferId: string, amountPaise: number): Promise<void>;
}

abstract class SignedGateway {
  constructor(
    protected readonly keySecret: string,
    protected readonly webhookSecret: string,
  ) {}

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(hmacSha256Hex(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqualHex(hmacSha256Hex(this.webhookSecret, rawBody), signature);
  }
}

export class RazorpayGateway extends SignedGateway implements PaymentGateway {
  readonly provider = "razorpay" as const;

  constructor(
    readonly keyId: string,
    keySecret: string,
    webhookSecret: string,
    private readonly baseUrl = "https://api.razorpay.com",
  ) {
    super(keySecret, webhookSecret);
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } } & T;
    if (!res.ok)
      throw new Error(
        `Razorpay ${method} ${path} → ${res.status}: ${json.error?.description ?? "error"}`,
      );
    return json;
  }

  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }) {
    const order = await this.call<{ id: string }>("POST", "/v1/orders", {
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes,
    });
    return { id: order.id };
  }

  async refund(
    paymentId: string,
    amountPaise: number,
    notes: Record<string, string>,
  ): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>(
      "POST",
      `/v1/payments/${paymentId}/refund`,
      {
        amount: amountPaise,
        speed: "normal",
        notes,
      },
    );
    return {
      id: refund.id,
      status:
        refund.status === "processed"
          ? "processed"
          : refund.status === "failed"
            ? "failed"
            : "pending",
    };
  }

  async createLinkedAccount(input: LinkedAccountInput) {
    // Route linked accounts (v2). Activation is asynchronous; the account starts as pending.
    const account = await this.call<{ id: string; status: string }>("POST", "/v2/accounts", {
      email: input.email,
      phone: input.phone,
      type: "route",
      reference_id: input.businessId.slice(-20),
      legal_business_name: input.legalName,
      business_type: "individual",
      contact_name: input.name,
      profile: { category: "others", subcategory: "others" },
    });
    await this.call("POST", `/v2/accounts/${account.id}/products`, {
      product_name: "route",
      settlements: {
        account_number: input.accountNumber,
        ifsc_code: input.ifsc,
        beneficiary_name: input.accountHolderName,
      },
      tnc_accepted: true,
    });
    return {
      id: account.id,
      status: account.status === "activated" ? ("active" as const) : ("pending" as const),
    };
  }

  async transfer(paymentId: string, accountId: string, amountPaise: number) {
    const res = await this.call<{ items: { id: string }[] }>(
      "POST",
      `/v1/payments/${paymentId}/transfers`,
      {
        transfers: [{ account: accountId, amount: amountPaise, currency: "INR" }],
      },
    );
    const id = res.items[0]?.id;
    if (!id) throw new Error("Razorpay transfer returned no id");
    return { id };
  }

  async reverseTransfer(transferId: string, amountPaise: number) {
    await this.call("POST", `/v1/transfers/${transferId}/reversals`, { amount: amountPaise });
  }
}

/** Dev/test gateway: records calls; refunds settle immediately. */
export class FakeGateway extends SignedGateway implements PaymentGateway {
  readonly provider = "fake" as const;
  readonly keyId = "rzp_test_fake";
  readonly orders: { id: string; amountPaise: number; receipt: string }[] = [];
  readonly refunds: { id: string; paymentId: string; amountPaise: number }[] = [];
  readonly transfers: { id: string; paymentId: string; accountId: string; amountPaise: number }[] =
    [];
  readonly reversals: { transferId: string; amountPaise: number }[] = [];

  constructor(keySecret = "fake-key-secret", webhookSecret = "fake-webhook-secret") {
    super(keySecret, webhookSecret);
  }

  /** What the browser would receive from Razorpay Checkout for this order. */
  checkoutSignature(orderId: string, paymentId: string): string {
    return hmacSha256Hex(this.keySecret, `${orderId}|${paymentId}`);
  }

  webhookSignature(rawBody: string): string {
    return hmacSha256Hex(this.webhookSecret, rawBody);
  }

  createOrder(input: { amountPaise: number; receipt: string }) {
    const order = {
      id: `order_fake_${randomBytes(6).toString("hex")}`,
      amountPaise: input.amountPaise,
      receipt: input.receipt,
    };
    this.orders.push(order);
    return Promise.resolve({ id: order.id });
  }

  refund(paymentId: string, amountPaise: number) {
    const refund = { id: `rfnd_fake_${randomBytes(6).toString("hex")}`, paymentId, amountPaise };
    this.refunds.push(refund);
    return Promise.resolve({ id: refund.id, status: "processed" as const });
  }

  createLinkedAccount() {
    return Promise.resolve({
      id: `acc_fake_${randomBytes(6).toString("hex")}`,
      status: "active" as const,
    });
  }

  transfer(paymentId: string, accountId: string, amountPaise: number) {
    const t = {
      id: `trf_fake_${randomBytes(6).toString("hex")}`,
      paymentId,
      accountId,
      amountPaise,
    };
    this.transfers.push(t);
    return Promise.resolve({ id: t.id });
  }

  reverseTransfer(transferId: string, amountPaise: number) {
    this.reversals.push({ transferId, amountPaise });
    return Promise.resolve();
  }
}
