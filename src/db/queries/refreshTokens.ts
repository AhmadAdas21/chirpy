import { eq } from "drizzle-orm";

import { db } from "../index.js";
import {
  refreshTokens,
  users,
} from "../schema.js";

import type {
  NewRefreshToken,
} from "../schema.js";

export async function createRefreshToken(
  refreshToken: NewRefreshToken,
) {
  const [result] = await db
    .insert(refreshTokens)
    .values(refreshToken)
    .returning();

  return result;
}

export async function getUserFromRefreshToken(
  token: string,
) {
  const [result] = await db
    .select({
      userId: users.id,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .innerJoin(
      users,
      eq(refreshTokens.userId, users.id),
    )
    .where(eq(refreshTokens.token, token));

  return result;
}

export async function revokeRefreshToken(
  token: string,
) {
  const now = new Date();

  const [result] = await db
    .update(refreshTokens)
    .set({
      revokedAt: now,
      updatedAt: now,
    })
    .where(eq(refreshTokens.token, token))
    .returning();

  return result;
}
