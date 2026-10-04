import { describe, expect, it } from "vitest";
import { BrevoEmailSender, parseSender } from "../src/services/email.js";

function stubFetch(status: number, body = "{}") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  };
  return { fn, calls };
}

describe("Brevo email", () => {
  it("parses the sender", () => {
    expect(parseSender("Townplay <no-reply@townplay.in>")).toEqual({
      name: "Townplay",
      email: "no-reply@townplay.in",
    });
    expect(parseSender("no-reply@townplay.in")).toEqual({ email: "no-reply@townplay.in" });
  });

  it("posts the message to Brevo's transactional API", async () => {
    const stub = stubFetch(201, '{"messageId":"<x@brevo>"}');
    const sender = new BrevoEmailSender("xkeysib-test", "Townplay <no-reply@townplay.in>", stub.fn);
    await sender.send({ to: "asha@example.com", subject: "Your code", text: "123456" });
    expect(stub.calls).toHaveLength(1);
    const { url, init } = stub.calls[0]!;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-test");
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: "Townplay", email: "no-reply@townplay.in" },
      to: [{ email: "asha@example.com" }],
      subject: "Your code",
      textContent: "123456",
    });
  });

  it("throws on an error response so callers can log it", async () => {
    const stub = stubFetch(401, '{"code":"unauthorized"}');
    const sender = new BrevoEmailSender("bad", "no-reply@townplay.in", stub.fn);
    await expect(sender.send({ to: "a@b.com", subject: "s", text: "t" })).rejects.toThrow(
      /Brevo: 401/,
    );
  });
});
