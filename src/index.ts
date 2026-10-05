import express from "express";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import {
  createRefreshToken,
  getUserFromRefreshToken,
  revokeRefreshToken,
} from "./db/queries/refreshTokens.js";
import {
  hashPassword,
  checkPasswordHash,
  makeJWT,
  validateJWT,
  getBearerToken,
  makeRefreshToken,
} from "./auth.js";
import type { User } from "./db/schema.js";
import { getAPIKey } from "./auth.js";
import {
  createUser,
  getUserByEmail,
  updateUser,
  upgradeUserToChirpyRed,
  deleteAllUsers,
} from "./db/queries/users.js";
import {
  createChirp,
  getAllChirps,
  getChirp,
  deleteChirp,
} from "./db/queries/chirps.js";
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";

const migrationClient = postgres(config.db.url, {
  max: 1,
});

await migrate(
  drizzle(migrationClient),
  config.db.migrationConfig,
);

await migrationClient.end();

const app = express();
const PORT = config.api.port;

function middlewareLogResponses(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.log(
        `[NON-OK] ${req.method} ${req.url} - Status: ${res.statusCode}`,
      );
    }
  });

  next();
}

function middlewareMetricsInc(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  config.api.fileserverHits++;
  next();
}

function sendJSON(
  res: Response,
  statusCode: number,
  payload: object,
): void {
  res.set("Content-Type", "application/json");
  res.status(statusCode).send(JSON.stringify(payload));
}

function readRequestBody(req: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function cleanChirp(body: string): string {
  const profaneWords = new Set([
    "kerfuffle",
    "sharbert",
    "fornax",
  ]);

  return body
    .split(" ")
    .map((word) =>
      profaneWords.has(word.toLowerCase()) ? "****" : word,
    )
    .join(" ");
}

async function handlerDeleteChirp(
  req: Request,
  res: Response,
): Promise<void> {
  let authenticatedUserId: string;

  try {
    const token = getBearerToken(req);

    authenticatedUserId = validateJWT(
      token,
      config.api.jwtSecret,
    );
  } catch {
    throw new UnauthorizedError("Unauthorized");
  }

  const chirpId = req.params.chirpId;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    typeof chirpId !== "string" ||
    !uuidPattern.test(chirpId)
  ) {
    throw new NotFoundError("Chirp not found");
  }

  const chirp = await getChirp(chirpId);

  if (!chirp) {
    throw new NotFoundError("Chirp not found");
  }

  if (chirp.userId !== authenticatedUserId) {
    throw new ForbiddenError(
      "You cannot delete this chirp",
    );
  }

  const deletedChirp = await deleteChirp(
    chirpId,
  );

  if (!deletedChirp) {
    throw new NotFoundError("Chirp not found");
  }

  res.status(204).send();
}

async function handlerGetChirp(
  req: Request,
  res: Response,
): Promise<void> {
  const chirpId = req.params.chirpId;

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    typeof chirpId !== "string" ||
    !uuidPattern.test(chirpId)
  ) {
    throw new NotFoundError("Chirp not found");
  }

  const chirp = await getChirp(chirpId);

  if (!chirp) {
    throw new NotFoundError("Chirp not found");
  }

  res.status(200).json(chirp);
}

async function handlerGetAllChirps(
  req: Request,
  res: Response,
): Promise<void> {
  const authorId =
    typeof req.query.authorId === "string"
      ? req.query.authorId
      : undefined;

  const chirps = await getAllChirps(authorId);

  const sortDirection =
    req.query.sort === "desc" ? "desc" : "asc";

  chirps.sort((firstChirp, secondChirp) => {
    const firstTime = firstChirp.createdAt.getTime();
    const secondTime = secondChirp.createdAt.getTime();

    if (sortDirection === "desc") {
      return secondTime - firstTime;
    }

    return firstTime - secondTime;
  });

  res.status(200).json(chirps);
}

async function handlerCreateChirp(
  req: Request,
  res: Response,
): Promise<void> {
  let userId: string;

  try {
    const token = getBearerToken(req);

    userId = validateJWT(
      token,
      config.api.jwtSecret,
    );
  } catch {
    throw new UnauthorizedError("Unauthorized");
  }

  const body = await readRequestBody(req);

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new BadRequestError("Invalid JSON");
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("body" in parsedBody) ||
    typeof parsedBody.body !== "string"
  ) {
    throw new BadRequestError(
      "body is required",
    );
  }

  if (parsedBody.body.length > 140) {
    throw new BadRequestError(
      "Chirp is too long. Max length is 140",
    );
  }

  const cleanedBody = cleanChirp(
    parsedBody.body,
  );

  const newChirp = await createChirp({
    body: cleanedBody,
    userId,
  });

  res.status(201).json(newChirp);
}

function userToResponse(user: User) {
  return {
    id: user.id,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    email: user.email,
    isChirpyRed: user.isChirpyRed,
  };
}

async function handlerCreateUser(
  req: Request,
  res: Response,
): Promise<void> {
  const body = await readRequestBody(req);

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new BadRequestError("Invalid JSON");
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("email" in parsedBody) ||
    typeof parsedBody.email !== "string" ||
    !("password" in parsedBody) ||
    typeof parsedBody.password !== "string" ||
    parsedBody.email.trim() === "" ||
    parsedBody.password === ""
  ) {
    throw new BadRequestError(
      "Email and password are required",
    );
  }

  const hashedPassword = await hashPassword(
    parsedBody.password,
  );

  const newUser = await createUser({
    email: parsedBody.email,
    hashedPassword,
  });

  if (!newUser) {
    throw new BadRequestError(
      "A user with that email already exists",
    );
  }

  res.status(201).json(
    userToResponse(newUser),
  );
}

async function handlerUpdateUser(
  req: Request,
  res: Response,
): Promise<void> {
  let userId: string;

  try {
    const token = getBearerToken(req);

    userId = validateJWT(
      token,
      config.api.jwtSecret,
    );
  } catch {
    throw new UnauthorizedError("Unauthorized");
  }

  const body = await readRequestBody(req);

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new BadRequestError("Invalid JSON");
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("email" in parsedBody) ||
    typeof parsedBody.email !== "string" ||
    !("password" in parsedBody) ||
    typeof parsedBody.password !== "string" ||
    parsedBody.email.trim() === "" ||
    parsedBody.password === ""
  ) {
    throw new BadRequestError(
      "Email and password are required",
    );
  }

  const hashedPassword = await hashPassword(
    parsedBody.password,
  );

  const updatedUser = await updateUser(
    userId,
    parsedBody.email,
    hashedPassword,
  );

  if (!updatedUser) {
    throw new UnauthorizedError("Unauthorized");
  }

  res.status(200).json(
    userToResponse(updatedUser),
  );
}

async function handlerLogin(
  req: Request,
  res: Response,
): Promise<void> {
  const body = await readRequestBody(req);

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new UnauthorizedError(
      "incorrect email or password",
    );
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("email" in parsedBody) ||
    typeof parsedBody.email !== "string" ||
    !("password" in parsedBody) ||
    typeof parsedBody.password !== "string"
  ) {
    throw new UnauthorizedError(
      "incorrect email or password",
    );
  }

  try {
    const user = await getUserByEmail(
      parsedBody.email,
    );

    if (!user) {
      throw new Error("User not found");
    }

    const passwordMatches =
      await checkPasswordHash(
        parsedBody.password,
        user.hashedPassword,
      );

    if (!passwordMatches) {
      throw new Error("Invalid password");
    }

    const accessToken = makeJWT(
      user.id,
      60 * 60,
      config.api.jwtSecret,
    );

    const refreshToken = makeRefreshToken();

    await createRefreshToken({
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(
        Date.now() +
        60 * 24 * 60 * 60 * 1000,
      ),
      revokedAt: null,
    });

    res.status(200).json({
      ...userToResponse(user),
      token: accessToken,
      refreshToken,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    throw new UnauthorizedError(
      "incorrect email or password",
    );
  }
}

async function handlerRefresh(
  req: Request,
  res: Response,
): Promise<void> {
  let token: string;

  try {
    token = getBearerToken(req);
  } catch {
    throw new UnauthorizedError("Unauthorized");
  }

  const storedToken =
    await getUserFromRefreshToken(token);

  if (
    !storedToken ||
    storedToken.revokedAt !== null ||
    storedToken.expiresAt <= new Date()
  ) {
    throw new UnauthorizedError("Unauthorized");
  }

  const accessToken = makeJWT(
    storedToken.userId,
    60 * 60,
    config.api.jwtSecret,
  );

  res.status(200).json({
    token: accessToken,
  });
}

async function handlerRevoke(
  req: Request,
  res: Response,
): Promise<void> {
  let token: string;

  try {
    token = getBearerToken(req);
  } catch {
    throw new UnauthorizedError("Unauthorized");
  }

  const revokedToken =
    await revokeRefreshToken(token);

  if (!revokedToken) {
    throw new UnauthorizedError("Unauthorized");
  }

  res.status(204).send();
}

async function handlerPolkaWebhook(
  req: Request,
  res: Response,
): Promise<void> {
    let apiKey: string;

  try {
    apiKey = getAPIKey(req);
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (apiKey !== config.api.polkaKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

const body = await readRequestBody(req);

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(body);
  } catch {
    throw new BadRequestError("Invalid JSON");
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("event" in parsedBody) ||
    typeof parsedBody.event !== "string"
  ) {
    throw new BadRequestError(
      "Event is required",
    );
  }

  if (parsedBody.event !== "user.upgraded") {
    res.status(204).send();
    return;
  }

  if (
    !("data" in parsedBody) ||
    typeof parsedBody.data !== "object" ||
    parsedBody.data === null ||
    !("userId" in parsedBody.data) ||
    typeof parsedBody.data.userId !== "string"
  ) {
    throw new BadRequestError(
      "User ID is required",
    );
  }

  const upgradedUser =
    await upgradeUserToChirpyRed(
      parsedBody.data.userId,
    );

  if (!upgradedUser) {
    throw new NotFoundError("User not found");
  }

  res.status(204).send();
}

async function handlerReadiness(
  req: Request,
  res: Response,
): Promise<void> {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send("OK");
}

async function handlerMetrics(
  req: Request,
  res: Response,
): Promise<void> {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<html>
  <body>
    <h1>Welcome, Chirpy Admin</h1>
    <p>Chirpy has been visited ${config.api.fileserverHits} times!</p>
  </body>
</html>`);
}

async function handlerReset(
  req: Request,
  res: Response,
): Promise<void> {
  if (config.api.platform !== "dev") {
    throw new ForbiddenError(
      "Reset is only allowed in development",
    );
  }

  await deleteAllUsers();
  config.api.fileserverHits = 0;

  res.set(
    "Content-Type",
    "text/plain; charset=utf-8",
  );
  res.send("Users and hits reset successfully");
}

function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  let statusCode = 500;
  let message = "Something went wrong on our end";

  if (err instanceof BadRequestError) {
    statusCode = 400;
    message = err.message;
  } else if (err instanceof UnauthorizedError) {
    statusCode = 401;
    message = err.message;
  } else if (err instanceof ForbiddenError) {
    statusCode = 403;
    message = err.message;
  } else if (err instanceof NotFoundError) {
    statusCode = 404;
    message = err.message;
  } else {
    console.log(err);
  }

  res.status(statusCode).json({
    error: message,
  });
}

app.use(middlewareLogResponses);
app.get("/api/healthz", handlerReadiness);
app.post("/api/users", handlerCreateUser);
app.put("/api/users", handlerUpdateUser);
app.post("/api/login", handlerLogin);
app.post("/api/refresh", handlerRefresh);
app.post("/api/revoke", handlerRevoke);
app.post("/api/polka/webhooks", handlerPolkaWebhook);
app.post("/api/chirps", handlerCreateChirp);
app.get("/api/chirps", handlerGetAllChirps);
app.get("/api/chirps/:chirpId", handlerGetChirp);
app.delete("/api/chirps/:chirpId", handlerDeleteChirp);
app.get("/admin/metrics", handlerMetrics);
app.post("/admin/reset", handlerReset);
app.use("/app", middlewareMetricsInc, express.static("./src/app"));

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
