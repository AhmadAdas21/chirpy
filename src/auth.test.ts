import { getAPIKey } from "./auth.js";
import {
  describe,
  it,
  expect,
  beforeAll,
} from "vitest";

import type { Request } from "express";

import {
  hashPassword,
  checkPasswordHash,
  makeJWT,
  validateJWT,
  getBearerToken,
} from "./auth.js";

describe("Password Hashing", () => {
  const password = "correctPassword123!";
  let hash: string;

  beforeAll(async () => {
    hash = await hashPassword(password);
  });

  it("accepts the correct password", async () => {
    expect(
      await checkPasswordHash(password, hash),
    ).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    expect(
      await checkPasswordHash("wrong", hash),
    ).toBe(false);
  });
});

describe("JWT Authentication", () => {
  const userID =
    "123e4567-e89b-12d3-a456-426614174000";

  it("creates and validates a JWT", () => {
    const token = makeJWT(
      userID,
      60,
      "secret",
    );

    expect(
      validateJWT(token, "secret"),
    ).toBe(userID);
  });

  it("rejects expired tokens", () => {
    const token = makeJWT(
      userID,
      -1,
      "secret",
    );

    expect(() =>
      validateJWT(token, "secret"),
    ).toThrow();
  });

  it("rejects the wrong secret", () => {
    const token = makeJWT(
      userID,
      60,
      "secret",
    );

    expect(() =>
      validateJWT(token, "wrong-secret"),
    ).toThrow();
  });
});

describe("Bearer Token", () => {
  it("extracts a bearer token", () => {
    const req = {
      get: () => "Bearer test-token",
    } as unknown as Request;

    expect(getBearerToken(req)).toBe(
      "test-token",
    );
  });

  it("rejects a missing header", () => {
    const req = {
      get: () => undefined,
    } as unknown as Request;

    expect(() =>
      getBearerToken(req),
    ).toThrow();
  });

  it("rejects a malformed header", () => {
    const req = {
      get: () => "Basic test-token",
    } as unknown as Request;

    expect(() =>
      getBearerToken(req),
    ).toThrow();
  });
});


describe("API Key", () => {
  it("extracts an API key", () => {
    const req = {
      get: () => "ApiKey test-key",
    } as any;

    expect(getAPIKey(req)).toBe("test-key");
  });

  it("rejects a malformed API key header", () => {
    const req = {
      get: () => "Bearer test-key",
    } as any;

    expect(() => getAPIKey(req)).toThrow();
  });
});
