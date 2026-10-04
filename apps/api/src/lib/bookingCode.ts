import { randomInt } from "node:crypto";

// No 0/O, 1/I/L: codes are read out over the phone.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Short human booking code, e.g. "K7QM2X". Uniqueness is enforced by the index (retry on clash). */
export function bookingCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}
