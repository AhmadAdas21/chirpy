import { randomBytes } from "node:crypto";

import argon2 from "argon2";
import jwt from "jsonwebtoken";

import type { Request } from "express";
import type { JwtPayload } from "jsonwebtoken";

type TokenPayload = Pick<
  JwtPayload,
  "iss" | "sub" | "iat" | "exp"
>;

export async function hashPassword(
  password: string,
): Promise<string> {
  return await argon2.hash(password);
}

export async function checkPasswordHash(
  password: string,
  hash: string,
): Promise<boolean> {
  return await argon2.verify(hash, password);
}

export function makeJWT(
  userID: string,
  expiresIn: number,
  secret: string,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);

  const payload: TokenPayload = {
    iss: "chirpy",
    sub: userID,
    iat: issuedAt,
    exp: issuedAt + expiresIn,
  };

  return jwt.sign(payload, secret);
}

export function validateJWT(
  tokenString: string,
  secret: string,
): string {
  const decoded = jwt.verify(
    tokenString,
    secret,
  );

  if (
    typeof decoded === "string" ||
    !decoded.sub ||
    decoded.iss !== "chirpy"
  ) {
    throw new Error("Invalid token");
  }

  return decoded.sub;
}

export function getBearerToken(
  req: Request,
): string {
  const authorization = req.get("Authorization");

  if (!authorization) {
    throw new Error(
      "Authorization header is required",
    );
  }

  const match = authorization.match(
    /^Bearer\s+(.+)$/,
  );

  if (!match || !match[1]) {
    throw new Error(
      "Invalid authorization header",
    );
  }

  return match[1].trim();
}

export function makeRefreshToken(): string {
  return randomBytes(32).toString("hex");
}


export function getAPIKey(req: Request): string {
  const authorization = req.get("Authorization");

  if (!authorization) {
    throw new Error("Authorization header is required");
  }

  const parts = authorization.trim().split(/\s+/);

  if (parts.length !== 2 || parts[0] !== "ApiKey" || !parts[1]) {
    throw new Error("Invalid API key header");
  }

  return parts[1];
}
