import jwt, { SignOptions } from "jsonwebtoken";

export type TokenClaims = { id: string; sid: string };

const sign = (use: "access" | "refresh", claims: TokenClaims, expiresIn: string | undefined) =>
  jwt.sign({ ...claims, tokenUse: use }, process.env.JWT_SECRET!, {
    expiresIn: expiresIn as SignOptions["expiresIn"],
  });

export const generateAccessToken = (id: string, sid: string) =>
  sign("access", { id, sid }, process.env.JWT_ACCESS_EXPIRES_IN);

export const generateRefreshToken = (id: string, sid: string) =>
  sign("refresh", { id, sid }, process.env.JWT_REFRESH_EXPIRES_IN);

const verify = (token: string, use: "access" | "refresh"): TokenClaims | null => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ["HS256"] });
    if (
      typeof decoded === "string" ||
      decoded.tokenUse !== use ||
      typeof decoded.id !== "string" ||
      typeof decoded.sid !== "string"
    ) {
      return null;
    }
    return { id: decoded.id, sid: decoded.sid };
  } catch {
    return null;
  }
};

export const verifyRefreshToken = (token: string) => verify(token, "refresh");
export const verifyToken = (token: string) => verify(token, "access");
